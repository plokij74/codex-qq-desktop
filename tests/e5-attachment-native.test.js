'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { LIMITS, createAttachmentBudget } = require('../src/ai/attachment-contract');
const { createAttachmentReader, extractText } = require('../src/ai/attachment-reader');
const { inspectNativeBuild } = require('../src/ai/native-isolation-build');
const { getVerifiedNativeLauncher, helperEnvironment } = require('../src/ai/windows-isolation');
const native = process.platform === 'win32';
const nativeTest = (name, fn, options = {}) => test(name, { skip: !native, ...options }, fn);
let base;
before(() => {
  if (!native) return;
  assert.equal(inspectNativeBuild().available, true, 'Run the authorized native build before this suite');
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e5-native-test-'));
  assert.equal(fs.realpathSync.native(base), base);
});
after(() => {
  if (!base) return;
  assert.equal(path.dirname(base), fs.realpathSync.native(os.tmpdir()));
  assert.ok(path.basename(base).startsWith('codex-e5-native-test-'));
  assert.equal(fs.realpathSync.native(base), base);
  fs.rmSync(base, { recursive: true, force: true });
});
function fixture(label) {
  const root = path.join(base, label), project = path.join(root, 'project'), protectedRoot = path.join(root, 'protected');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(protectedRoot);
  const source = path.join(project, 'note.txt'); fs.writeFileSync(source, '中文😀\r\nsecond\n');
  return { root, project, protectedRoot, source, reader: createAttachmentReader({ protectedPaths: [protectedRoot], budget: createAttachmentBudget() }) };
}
const rejected = (action, codes = ['ATTACHMENT_READ_DENIED', 'ATTACHMENT_SOURCE_CHANGED']) => assert.rejects(action, error => codes.includes(error.code));
const packageBytes = value => Buffer.from(JSON.stringify({ formatVersion: 1, cipher: 'electron-safeStorage', payload: Buffer.from(value).toString('base64') }));

function rawCapture(request) {
  const text = Buffer.from(JSON.stringify({ mode: 'capture', operation: 'read', maxBytes: LIMITS.MAX_FILE_BYTES, protectedPaths: [], ...request }));
  const header = Buffer.alloc(4); header.writeUInt32LE(text.length);
  const result = spawnSync(getVerifiedNativeLauncher(), ['--capture-file'], { input: Buffer.concat([header, text]), env: helperEnvironment(), shell: false, windowsHide: true, timeout: LIMITS.CAPTURE_TIMEOUT_MS, maxBuffer: LIMITS.MAX_REQUEST_BYTES + LIMITS.MAX_FILE_BYTES + 16 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.equal(result.stderr.length, 0);
  assert.ok(result.stdout.subarray(0, 8).equals(Buffer.from('E5IO0001')));
  assert.equal(result.stdout.readUInt32LE(12), 0, 'denial contains no source body');
  const metaSize = result.stdout.readUInt32LE(8); assert.equal(result.stdout.length, 16 + metaSize);
  return JSON.parse(result.stdout.toString('utf8', 16));
}

nativeTest('E5 native: real GENERIC_READ snapshot, full hash, empty file and no source writes', async () => {
  const f = fixture('read'); const original = fs.readFileSync(f.source); const before = fs.statSync(f.source, { bigint: true });
  const filesBefore = fs.readdirSync(f.project);
  const readHandle = fs.openSync(f.source, 'r');
  try {
    const result = await f.reader.capture(f.reader.createExternalGrant(f.source));
    assert.deepEqual(result.bytes, original); assert.equal(result.bytes.byteOffset, 0); assert.equal(result.bytes.buffer.byteLength, original.length);
    assert.equal(result.rawDigest, crypto.createHash('sha256').update(original).digest('hex'));
    assert.match(result.identity, /^\d+:\d+$/); assert.ok(result.ancestors.length >= 3);
    assert.equal(extractText(result).text, original.toString('utf8')); result.release();
  } finally { fs.closeSync(readHandle); }
  assert.deepEqual(fs.readdirSync(f.project), filesBefore); assert.deepEqual(fs.readFileSync(f.source), original);
  const after = fs.statSync(f.source, { bigint: true }); assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
  fs.writeFileSync(f.source, ''); const empty = await f.reader.capture(f.reader.createExternalGrant(f.source)); assert.equal(empty.bytes.length, 0); assert.equal(extractText(empty).empty, true); empty.release();
});
nativeTest('E5 native: existing writer handle denies capture while an ordinary reader was allowed', async () => {
  const f = fixture('writer'); const handle = fs.openSync(f.source, 'r+');
  try { await rejected(() => f.reader.capture(f.reader.createExternalGrant(f.source)), ['ATTACHMENT_READ_DENIED']); }
  finally { fs.closeSync(handle); }
  const result = await f.reader.capture(f.reader.createExternalGrant(f.source)); result.release();
});
nativeTest('E5 native: source 2 MiB boundary passes and boundary plus one fails', async () => {
  const f = fixture('limit'); fs.writeFileSync(f.source, Buffer.alloc(LIMITS.MAX_FILE_BYTES, 0x61));
  const result = await f.reader.capture(f.reader.createExternalGrant(f.source)); assert.equal(result.bytes.length, LIMITS.MAX_FILE_BYTES); result.release();
  fs.writeFileSync(f.source, Buffer.alloc(LIMITS.MAX_FILE_BYTES + 1, 0x61)); await rejected(() => f.reader.capture(f.reader.createExternalGrant(f.source)), ['ATTACHMENT_FILE_LIMIT']);
});
nativeTest('E5 native: root and ancestor junctions plus hardlinks and ADS are rejected', async () => {
  const f = fixture('links'); const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'note.txt'), 'synthetic outside');
  const junction = path.join(f.root, 'junction'); fs.symlinkSync(outside, junction, 'junction');
  await rejected(() => f.reader.inspectRoot(junction));
  await rejected(() => f.reader.capture(f.reader.createExternalGrant(path.join(junction, 'note.txt'))));
  const hardlink = path.join(f.project, 'linked.txt'); fs.linkSync(path.join(outside, 'note.txt'), hardlink);
  await rejected(() => f.reader.capture(f.reader.createExternalGrant(hardlink)), ['ATTACHMENT_READ_DENIED']);
  fs.writeFileSync(f.source + ':secret', 'synthetic ADS');
  await rejected(() => f.reader.capture(f.reader.createExternalGrant(f.source)), ['ATTACHMENT_READ_DENIED']);
});
nativeTest('E5 native: direct private protocol rejects UNC/device/ADS/protected and source-cap escalation', () => {
  const f = fixture('protocol-denials'); const protectedFile = path.join(f.protectedRoot, 'test-vault.txt'); fs.writeFileSync(protectedFile, 'synthetic not a credential');
  for (const request of [
    { root: f.project, path: '\\\\server\\share\\note.txt' },
    { root: f.project, path: '\\\\?\\' + f.source },
    { root: f.project, path: '\\\\.\\NUL' },
    { root: f.project, path: f.source + ':secret' },
    { root: f.protectedRoot, path: protectedFile, protectedPaths: [f.protectedRoot] },
    { root: f.project, path: f.source, maxBytes: LIMITS.MAX_BLOB_PACKAGE_BYTES },
  ]) {
    const value = rawCapture(request); assert.equal(value.ok, false); assert.equal(value.cleanupComplete, true); assert.equal(value.code, 'ATTACHMENT_READ_DENIED');
  }
});
nativeTest('E5 native: project snapshots revalidate full source hash and remain frozen after capture', async () => {
  const f = fixture('hash'); const root = await f.reader.inspectRoot(f.project);
  const grant = f.reader.createProjectGrant({ projectRoot: f.project, relativePath: 'note.txt', rootIdentity: root.rootIdentity, expectedAncestors: root.ancestors });
  const first = await f.reader.capture(grant); const frozen = Buffer.from(first.bytes); fs.writeFileSync(f.source, 'changed in place');
  await rejected(() => f.reader.capture(grant), ['ATTACHMENT_SOURCE_CHANGED']); assert.deepEqual(first.bytes, frozen); first.release();
});
nativeTest('E5 native: source replacement and root replacement reject old identities', async () => {
  const f = fixture('identity'); let root = await f.reader.inspectRoot(f.project);
  const grant = f.reader.createProjectGrant({ projectRoot: f.project, relativePath: 'note.txt', rootIdentity: root.rootIdentity, expectedAncestors: root.ancestors });
  const first = await f.reader.capture(grant); first.release(); fs.renameSync(f.source, f.source + '.old'); fs.writeFileSync(f.source, 'new object');
  await rejected(() => f.reader.capture(grant), ['ATTACHMENT_SOURCE_CHANGED']);
  const rootGrant = f.reader.createProjectGrant({ projectRoot: f.project, relativePath: 'note.txt', rootIdentity: root.rootIdentity, expectedAncestors: root.ancestors });
  fs.renameSync(f.project, f.project + '-old'); fs.mkdirSync(f.project); fs.writeFileSync(f.source, 'new root');
  await rejected(() => f.reader.capture(rootGrant), ['ATTACHMENT_SOURCE_CHANGED']);
});
nativeTest('E5 native: parent replacement is detected even when original root/file identities are moved back', async () => {
  const f = fixture('ancestors'); const root = await f.reader.inspectRoot(f.project);
  const grant = f.reader.createProjectGrant({ projectRoot: f.project, relativePath: 'note.txt', rootIdentity: root.rootIdentity, expectedAncestors: root.ancestors });
  const first = await f.reader.capture(grant); first.release();
  fs.renameSync(f.root, f.root + '-old'); fs.mkdirSync(f.root); fs.renameSync(path.join(f.root + '-old', 'project'), f.project); fs.mkdirSync(f.protectedRoot);
  await rejected(() => f.reader.capture(grant), ['ATTACHMENT_SOURCE_CHANGED']);
});
nativeTest('E5 native: branded managed encrypted write/read/list/delete is disjoint from public source', async () => {
  const f = fixture('managed'); const cache = path.join(f.protectedRoot, 'attachments-v1'); const scope = await f.reader.createManagedScope(cache);
  const file = f.reader.createManagedFile(scope, { kind: 'blob' }); const bytes = packageBytes('synthetic cipher, not plaintext source'); let verified = 0, commitChecks = 0;
  const identity = await f.reader.atomicWriteManaged(file, bytes, { verify: async result => { assert.deepEqual(result.bytes, bytes); verified++; }, beforeCommit() { commitChecks++; return true; } }); assert.match(identity, /^\d+:\d+$/); assert.equal(verified, 1); assert.equal(commitChecks, 1);
  const result = await f.reader.readManaged(file); assert.deepEqual(result.bytes, bytes); assert.equal(result.identity, identity); result.release();
  const entries = await f.reader.listManaged(scope); assert.deepEqual(entries, [{ kind: 'blob', locator: f.reader.managedLocator(file), identity, size: bytes.length }]);
  assert.throws(() => f.reader.createExternalGrant(path.join(cache, 'blobs', f.reader.managedLocator(file))), error => error.code === 'ATTACHMENT_READ_DENIED');
  await rejected(() => f.reader.capture(file), ['ATTACHMENT_REFERENCE_INVALID']);
  await f.reader.deleteManaged(file); assert.deepEqual(await f.reader.listManaged(scope), []);
});
nativeTest('E5 native: manifest replace is atomic and bad/cancelled temp verify keeps old ciphertext', async () => {
  const f = fixture('managed-atomic'); const cache = path.join(f.protectedRoot, 'attachments-v1'); const scope = await f.reader.createManagedScope(cache); const file = f.reader.createManagedFile(scope, { kind: 'manifest' });
  const a = packageBytes('a'), b = packageBytes('b'); await f.reader.atomicWriteManaged(file, a, { verify: async result => assert.deepEqual(result.bytes, a) });
  await rejected(() => f.reader.atomicWriteManaged(file, b, { verify: async () => { throw Object.assign(new Error('no raw error text'), { code: 'ATTACHMENT_CORRUPT' }); } }), ['ATTACHMENT_CORRUPT']);
  let result = await f.reader.readManaged(file); assert.deepEqual(result.bytes, a); result.release();
  const controller = new AbortController(); await rejected(() => f.reader.atomicWriteManaged(file, b, { signal: controller.signal, verify: async () => controller.abort() }), ['ABORTED']);
  assert.equal((await f.reader.listManaged(scope)).length, 1);
  await f.reader.atomicWriteManaged(file, b, { verify: async captured => assert.deepEqual(captured.bytes, b) }); result = await f.reader.readManaged(file); assert.deepEqual(result.bytes, b); result.release();
  assert.deepEqual(fs.readdirSync(path.join(cache, 'blobs')), []);
});
nativeTest('E5 native: managed 4 MiB bounded read is separate from source 2 MiB and rejects plus one', async () => {
  const f = fixture('managed-limit'); const cache = path.join(f.protectedRoot, 'attachments-v1'); const scope = await f.reader.createManagedScope(cache); const locator = '1'.repeat(32) + '.enc.json'; const source = path.join(cache, 'blobs', locator);
  fs.writeFileSync(source, Buffer.alloc(LIMITS.MAX_BLOB_PACKAGE_BYTES, 0x61)); const file = f.reader.createManagedFile(scope, { kind: 'blob', locator });
  const result = await f.reader.readManaged(file); assert.equal(result.bytes.length, LIMITS.MAX_BLOB_PACKAGE_BYTES); assert.equal(result.bytes.buffer.byteLength, result.bytes.length); result.release();
  fs.writeFileSync(source, Buffer.alloc(LIMITS.MAX_BLOB_PACKAGE_BYTES + 1, 0x61)); await rejected(() => f.reader.readManaged(file), ['ATTACHMENT_CORRUPT', 'ATTACHMENT_FILE_LIMIT']);
});
nativeTest('E5 native: managed scope/objects refuse junction, hardlink, ADS and changed deletion identity', async () => {
  const f = fixture('managed-unsafe'); const cache = path.join(f.protectedRoot, 'attachments-v1'); const scope = await f.reader.createManagedScope(cache); const file = f.reader.createManagedFile(scope, { kind: 'blob' }); const bytes = packageBytes('synthetic'); await f.reader.atomicWriteManaged(file, bytes, { verify: async () => {} });
  const source = path.join(cache, 'blobs', f.reader.managedLocator(file)); fs.renameSync(source, source + '.old'); fs.writeFileSync(source, bytes);
  await rejected(() => f.reader.deleteManaged(file), ['ATTACHMENT_CORRUPT']); assert.deepEqual(fs.readFileSync(source), bytes);
  const locator = '2'.repeat(32) + '.enc.json'; const unsafe = f.reader.createManagedFile(scope, { kind: 'blob', locator }); fs.linkSync(source, path.join(cache, 'blobs', locator));
  await rejected(() => f.reader.readManaged(unsafe), ['ATTACHMENT_READ_DENIED', 'ATTACHMENT_CORRUPT']); fs.unlinkSync(path.join(cache, 'blobs', locator));
  fs.writeFileSync(source + ':ads', 'synthetic'); await rejected(() => f.reader.readManaged(f.reader.createManagedFile(scope, { kind: 'blob', locator: f.reader.managedLocator(file) })), ['ATTACHMENT_READ_DENIED', 'ATTACHMENT_CORRUPT']);
  const f2 = fixture('managed-junction'); fs.symlinkSync(cache, path.join(f2.protectedRoot, 'attachments-v1'), 'junction'); await rejected(() => f2.reader.createManagedScope(path.join(f2.protectedRoot, 'attachments-v1')), ['ATTACHMENT_READ_DENIED', 'ATTACHMENT_SOURCE_CHANGED']);
});
nativeTest('E5 native: cancellation awaits actual helper close and holds shared slot through cleanup', async () => {
  const f = fixture('cancel'); const controller = new AbortController(); const budget = createAttachmentBudget(); let child, closeSeen = false;
  const instance = createAttachmentReader({ protectedPaths: [f.protectedRoot], budget, spawnFn(exe, args, opts) {
    child = spawn(exe, args, opts); child.on('close', () => { closeSeen = true; });
    const original = child.stdin.write.bind(child.stdin); child.stdin.write = (bytes, ...rest) => bytes.length === 1 ? original(bytes, ...rest) : true; // actual helper deliberately waits for request
    return child;
  } });
  const pending = instance.capture(instance.createExternalGrant(f.source), { signal: controller.signal });
  assert.equal(budget.snapshot().activeWork, 1); await rejected(() => instance.inspectRoot(f.project), ['ATTACHMENT_WORK_BUSY']); controller.abort();
  await rejected(() => pending, ['ABORTED']); assert.equal(closeSeen, true); assert.notEqual(child.exitCode === null && child.signalCode === null, true);
  assert.deepEqual(budget.snapshot(), { retainedBytes: 0, workBytes: 0, activeWork: 0 });
});
nativeTest('E5 native: alternate/unverified executable override fails closed and is never spawned', async () => {
  const f = fixture('integrity'); const executable = path.join(f.root, 'unverified.exe'); fs.writeFileSync(executable, 'synthetic non-executable'); let spawned = false;
  const instance = createAttachmentReader({ protectedPaths: [f.protectedRoot], launcherPath: executable, spawnFn() { spawned = true; throw new Error('must not run'); } });
  await rejected(() => instance.capture(instance.createExternalGrant(f.source)), ['ATTACHMENT_READ_DENIED']); assert.equal(spawned, false);
});
nativeTest('E5 native: metadata listing is branded, lazy bounded, skips unsafe entries and never reads bodies', async () => {
  const f = fixture('metadata'); const nested = path.join(f.project, 'nested'); fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, 'note.txt'), 'child text');
  fs.writeFileSync(path.join(f.project, 'document.pdf'), Buffer.alloc(LIMITS.MAX_FILE_BYTES + 1, 0xcc));
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'target.txt'), 'outside synthetic');
  fs.symlinkSync(outside, path.join(f.project, 'unsafe-junction'), 'junction'); fs.linkSync(path.join(outside, 'target.txt'), path.join(f.project, 'unsafe-hard.txt'));
  fs.writeFileSync(path.join(f.project, 'unsafe-ads.txt'), 'plain'); fs.writeFileSync(path.join(f.project, 'unsafe-ads.txt') + ':ads', 'synthetic');
  const root = await f.reader.inspectRoot(f.project); const grant = f.reader.createProjectListingGrant({ projectRoot: f.project, rootIdentity: root.rootIdentity, expectedAncestors: root.ancestors });
  const result = await f.reader.listProject(grant); assert.equal(result.truncated, false);
  assert.ok(result.entries.some(entry => entry.name === 'nested' && entry.isDirectory)); assert.ok(result.entries.some(entry => entry.name === 'document.pdf' && !entry.isDirectory));
  assert.equal(result.entries.some(entry => entry.name.startsWith('unsafe-')), false); assert.ok(result.entries.every(entry => Object.keys(entry).sort().join(',') === 'isDirectory,name'));
  await rejected(() => f.reader.capture(grant), ['ATTACHMENT_REFERENCE_INVALID']); await rejected(() => f.reader.listProject({}), ['ATTACHMENT_REFERENCE_INVALID']);
  const partial = f.reader.createProjectListingGrant({ projectRoot: f.project, rootIdentity: root.rootIdentity, prefix: 'nested/n' });
  assert.deepEqual((await f.reader.listProject(partial)).entries, [{ name: 'note.txt', isDirectory: false }]);
  const bytes = await f.reader.capture(f.reader.createProjectGrant({ projectRoot: f.project, rootIdentity: root.rootIdentity, expectedAncestors: root.ancestors, relativePath: 'nested/note.txt' })); assert.equal(bytes.bytes.toString(), 'child text'); bytes.release();
  const bounded = await f.reader.listProject(grant, { maxEntries: 1, maxScanned: 1 }); assert.ok(bounded.entries.length <= 1); assert.equal(bounded.truncated, true);
  const other = createAttachmentReader({ protectedPaths: [f.protectedRoot] }); await rejected(() => other.listProject(grant), ['ATTACHMENT_REFERENCE_INVALID']);
});
nativeTest('E5 native: metadata directory ancestor replacement and traversal cannot reuse a listing grant', async () => {
  const f = fixture('metadata-replace'); const nested = path.join(f.project, 'nested'); fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, 'note.txt'), 'synthetic');
  const root = await f.reader.inspectRoot(f.project), grant = f.reader.createProjectListingGrant({ projectRoot: f.project, rootIdentity: root.rootIdentity, prefix: 'nested/' });
  assert.equal((await f.reader.listProject(grant)).entries.length, 1);
  fs.renameSync(nested, nested + '-old'); fs.mkdirSync(nested); await rejected(() => f.reader.listProject(grant), ['ATTACHMENT_SOURCE_CHANGED']);
  for (const prefix of ['../', 'nested/../', '/outside/', 'C:\\outside', 'nested:ads/']) assert.throws(() => f.reader.createProjectListingGrant({ projectRoot: f.project, rootIdentity: root.rootIdentity, prefix }), error => error.code === 'ATTACHMENT_READ_DENIED');
});
nativeTest('E5 native: managed blobs ancestor identity replacement is denied before package read/delete', async () => {
  const f = fixture('managed-blobs-identity'); const cache = path.join(f.protectedRoot, 'attachments-v1'); const scope = await f.reader.createManagedScope(cache), file = f.reader.createManagedFile(scope, { kind: 'blob' });
  const bytes = packageBytes('synthetic'); await f.reader.atomicWriteManaged(file, bytes, { verify: async () => {} });
  fs.renameSync(path.join(cache, 'blobs'), path.join(cache, 'blobs-old')); fs.mkdirSync(path.join(cache, 'blobs'));
  await rejected(() => f.reader.readManaged(file), ['ATTACHMENT_SOURCE_CHANGED']); await rejected(() => f.reader.deleteManaged(file), ['ATTACHMENT_SOURCE_CHANGED']); await rejected(() => f.reader.listManaged(scope), ['ATTACHMENT_SOURCE_CHANGED']);
  assert.deepEqual(fs.readFileSync(path.join(cache, 'blobs-old', f.reader.managedLocator(file))), bytes);
});
nativeTest('E5 native: actual 30-second private-channel timeout awaits helper cleanup and releases the slot', async () => {
  const f = fixture('wall-timeout'); const budget = createAttachmentBudget(); let child, closeSeen = false;
  const instance = createAttachmentReader({ protectedPaths: [f.protectedRoot], budget, spawnFn(exe, args, opts) {
    child = spawn(exe, args, opts); child.on('close', () => { closeSeen = true; }); const original = child.stdin.write.bind(child.stdin);
    child.stdin.write = (bytes, ...rest) => bytes.length === 1 ? original(bytes, ...rest) : true; return child;
  } });
  const started = Date.now(); await rejected(() => instance.capture(instance.createExternalGrant(f.source)), ['ATTACHMENT_CAPTURE_TIMEOUT']);
  assert.ok(Date.now() - started >= LIMITS.CAPTURE_TIMEOUT_MS - 200); assert.ok(Date.now() - started < LIMITS.CAPTURE_TIMEOUT_MS + 5000);
  assert.equal(closeSeen, true); assert.notEqual(child.exitCode === null && child.signalCode === null, true); assert.deepEqual(budget.snapshot(), { retainedBytes: 0, workBytes: 0, activeWork: 0 });
}, { timeout: LIMITS.CAPTURE_TIMEOUT_MS + 8000 });
nativeTest('E5 native: copied integrity-chain fixtures reject changed source, executable and manifest', () => {
  const f = fixture('integrity-fixture'); const ai = path.join(f.root, 'src', 'ai'), directory = path.join(f.root, 'src', 'native', 'windows-isolation'); fs.mkdirSync(ai, { recursive: true }); fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(require.resolve('../src/ai/native-isolation-build'), path.join(ai, 'native-isolation-build.js'));
  const build = inspectNativeBuild(), originalDir = path.dirname(build.executablePath);
  for (const name of ['Launcher.cs', 'Launcher.exe', 'Launcher.manifest.json']) fs.copyFileSync(path.join(originalDir, name), path.join(directory, name));
  const copied = require(path.join(ai, 'native-isolation-build.js')); assert.equal(copied.inspectNativeBuild().available, true);
  for (const name of ['Launcher.cs', 'Launcher.exe', 'Launcher.manifest.json']) {
    const target = path.join(directory, name); fs.appendFileSync(target, 'synthetic tamper'); const result = copied.inspectNativeBuild(); assert.equal(result.available, false); assert.ok(['Native launcher integrity check failed', 'Native launcher has not been built'].includes(result.reason)); fs.copyFileSync(path.join(originalDir, name), target);
  }
});
