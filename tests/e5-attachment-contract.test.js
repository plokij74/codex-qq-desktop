'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LIMITS, attachmentError, publicAttachmentError, newAttachmentId, randomOpaqueId,
  countCodePoints, prefixCodePoints, sanitizeName, publicAttachmentRef, normalizePublicAttachment,
  assertFields, checkedInteger, canonicalBase64Length, parseBoundedJson, createAttachmentBudget,
} = require('../src/ai/attachment-contract');

const code = expected => error => error?.code === expected;
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

// FR-01/06/13; AC-01/03/04/13. These are contract tests, not OS/crypto evidence.
test('E5 contract fixes every public hard limit and does not permit widening', () => {
  const expected = {
    MAX_FILE_BYTES: 2 * 1024 * 1024, MAX_SELECTION_FILES: 8,
    MAX_SELECTION_RAW_BYTES: 8 * 1024 * 1024, MAX_FILE_TEXT_CODEPOINTS: 65536,
    MAX_SELECTION_TEXT_CODEPOINTS: 262144, MAX_REQUEST_BYTES: 4 * 1024 * 1024,
    UNKNOWN_CONTEXT_APPROX_LIMIT: 32000, MAX_CACHE_DISK_BYTES: 64 * 1024 * 1024,
    MAX_CACHE_RECORDS: 512, MAX_CACHE_MEMORY_BYTES: 16 * 1024 * 1024,
    MAX_ATTACHMENT_WORK_BYTES: 48 * 1024 * 1024, MAX_BYTE_OPERATION_CONCURRENCY: 1,
    MAX_CAPTURE_CONCURRENCY: 1, CAPTURE_TIMEOUT_MS: 30000, PREVIEW_TTL_MS: 300000,
    CACHE_IDLE_TTL_MS: 30 * 24 * 60 * 60 * 1000, MAX_PREVIEWS: 16,
    PREVIEW_PAGE_CODEPOINTS: 16384, MAX_COMPACT_ATTACHMENT_REFS: 128,
    MAX_BLOB_PACKAGE_BYTES: 4 * 1024 * 1024, MAX_BLOB_CIPHER_BYTES: 3 * 1024 * 1024,
    MAX_BLOB_PLAIN_BYTES: 3 * 1024 * 1024, MAX_MANIFEST_PACKAGE_BYTES: 4 * 1024 * 1024,
    MAX_MANIFEST_CIPHER_BYTES: 3 * 1024 * 1024, MAX_MANIFEST_PLAIN_BYTES: 2 * 1024 * 1024,
    MAX_PACKAGE_JSON_DEPTH: 8, MAX_PACKAGE_JSON_NODES: 65536,
    MAX_EXPLICIT_RANGE_LINES: 500, MAX_DEFAULT_RANGE_LINES: 2000,
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(LIMITS[key], value, key);
  assert.ok(Object.isFrozen(LIMITS));
  assert.throws(() => { LIMITS.MAX_FILE_BYTES++; }, TypeError);
});

test('E5 attachment IDs use independent cryptographic randomness, never names or hashes', () => {
  const ids = Array.from({ length: 128 }, () => newAttachmentId());
  assert.equal(new Set(ids).size, 128);
  for (const id of ids) assert.match(id, /^att_[a-f0-9]{32}$/);
  assert.match(randomOpaqueId('apv'), /^apv_[a-f0-9]{32}$/);
  assert.throws(() => randomOpaqueId('../../'), code('ATTACHMENT_REFERENCE_INVALID'));
});

test('E5 code point limits preserve complete UTF-16 pairs and distinguish UTF-8 bytes', () => {
  const value = 'A🚀中B';
  assert.equal(countCodePoints(value), 4);
  assert.equal(value.length, 5);
  assert.equal(Buffer.byteLength(value), 9);
  assert.equal(prefixCodePoints(value, 3), 'A🚀中');
  assert.equal(prefixCodePoints(value, 0), '');
  assert.equal(prefixCodePoints('', 4), '');
  assert.equal(prefixCodePoints('🚀'.repeat(65537), 65536).length, 131072);
  assert.throws(() => prefixCodePoints(value, -1), code('ATTACHMENT_TEXT_LIMIT'));
});

test('E5 public metadata is a positive allowlist, not a reference capability', () => {
  const id = newAttachmentId();
  const result = publicAttachmentRef({
    attachmentId: id, name: 'C:\\private\\note.txt', mimeType: 'text/plain', rawByteLength: 9,
    sourceKind: 'user_upload', status: 'ready', storageMode: 'memory',
    budget: { extractedChars: 4, selectedChars: 4, selectedBytes: 9, estimatedTokens: 2, truncated: false },
    storagePath: 'C:\\private', localAbsPath: 'C:\\private', blobKey: 'secret',
    rawDigest: 'secret', hash: 'secret', bytes: Buffer.from('CANARY'), text: 'CANARY',
    dataUrl: 'data:text/plain;base64,Q0FOQVJZ', windowGrant: 'secret', previewId: 'secret',
  });
  assert.equal(result.attachmentId, id);
  assert.equal(result.name, 'note.txt');
  assert.equal(result.size, 9);
  assert.equal(result.refVersion, 1);
  assert.deepEqual(Object.keys(result).sort(), ['attachmentId', 'budget', 'mimeType', 'name', 'refVersion', 'size', 'source', 'status', 'storageMode']);
  assert.equal(JSON.stringify(result).includes('CANARY'), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('E5 legacy metadata keeps navigation without inventing a ready host record', () => {
  const result = normalizePublicAttachment({ attachmentId: 'legacy-ref', name: 'old.txt', size: 4, status: 'ready', storagePath: 'C:\\secret' });
  assert.equal(result.attachmentId, 'legacy-ref');
  assert.equal(result.status, 'legacy_unavailable');
  assert.equal(result.storageMode, 'unavailable');
  assert.equal(result.storagePath, undefined);
  const anonymous = normalizePublicAttachment({ name: 'old.txt', status: 'ready' });
  assert.equal(anonymous.attachmentId, '');
  assert.equal(anonymous.status, 'legacy_unavailable');
});

test('E5 display names remove path, controls and bidi/format tricks and cap code points', () => {
  assert.equal(sanitizeName('../../x\u202etxt\0.md'), 'xtxt.md');
  assert.ok(countCodePoints(sanitizeName('🚀'.repeat(256) + '.txt')) <= 255);
  assert.equal(sanitizeName(''), 'unnamed_file');
});

test('E5 payload field and integer checks reject authority injection and getters', () => {
  assertFields({ sessionId: 's' }, ['sessionId']);
  for (const extra of ['senderId', 'bytes', 'path', 'status', 'hash', 'modelBinding']) {
    assert.throws(() => assertFields({ sessionId: 's', [extra]: 'forged' }, ['sessionId']), code('ATTACHMENT_REFERENCE_INVALID'));
  }
  let getterCalls = 0;
  const getter = { get sessionId() { getterCalls++; return 's'; } };
  assert.throws(() => assertFields(getter, ['sessionId']), code('ATTACHMENT_REFERENCE_INVALID'));
  assert.equal(getterCalls, 0);
  for (const bad of [-1, 1.5, Infinity, NaN, '1', 11]) assert.throws(() => checkedInteger(bad, { min: 0, max: 10 }), code('ATTACHMENT_REFERENCE_INVALID'));
  assert.equal(checkedInteger(10, { min: 0, max: 10 }), 10);
});

test('E5 canonical base64 checks decoded length and padding bits before allocation', () => {
  for (let n = 0; n <= 16; n++) {
    const s = Buffer.alloc(n, 255).toString('base64');
    assert.equal(canonicalBase64Length(s, n), n);
    if (n) assert.throws(() => canonicalBase64Length(s, n - 1), code('ATTACHMENT_CORRUPT'));
  }
  // A single linear pass must support the actual raw/cipher package limits.
  for (const length of [2 * 1024 * 1024, LIMITS.MAX_BLOB_CIPHER_BYTES]) {
    const encoded = Buffer.alloc(length, 255).toString('base64');
    assert.equal(canonicalBase64Length(encoded, length), length);
    assert.throws(() => canonicalBase64Length(encoded, length - 1), code('ATTACHMENT_CORRUPT'));
  }
  for (const bad of ['AB==', 'AAB=', 'A===', 'AAAA=', 'AAAA\n', '____', 'AAAA====', 'AA']) {
    assert.throws(() => canonicalBase64Length(bad, 100), code('ATTACHMENT_CORRUPT'), bad);
  }
});

test('E5 private JSON is byte/depth/node bounded before full parse', () => {
  const options = { maxBytes: 1000, maxDepth: 8, maxNodes: 100 };
  assert.deepEqual(parseBoundedJson('{"x":[1,true,null,"\\\"{[]}"]}', options), { x: [1, true, null, '\"{[]}'] });
  const nested = depth => '['.repeat(depth) + '0' + ']'.repeat(depth);
  assert.deepEqual(parseBoundedJson(nested(8), options), [[[[[[[[0]]]]]]]]);
  assert.throws(() => parseBoundedJson(nested(9), options), code('ATTACHMENT_CORRUPT'));
  assert.throws(() => parseBoundedJson(JSON.stringify('中'.repeat(20)), { ...options, maxBytes: 61 }), code('ATTACHMENT_CORRUPT'));
  assert.throws(() => parseBoundedJson('[1,2,3]', { ...options, maxNodes: 3 }), code('ATTACHMENT_CORRUPT'));
  assert.throws(() => parseBoundedJson('{"__proto__":{}}', options), code('ATTACHMENT_CORRUPT'));
  assert.throws(() => parseBoundedJson('{not JSON}', options), code('ATTACHMENT_CORRUPT'));
});

test('E5 public errors never reflect paths, bodies, hashes or error stacks', () => {
  const error = Object.assign(new Error('C:\\secret CANARY'), { code: 'ATTACHMENT_CORRUPT', stack: 'secret', hash: 'secret' });
  const result = publicAttachmentError(error);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ATTACHMENT_CORRUPT');
  assert.equal(JSON.stringify(result).includes('CANARY'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(attachmentError('forged').code, 'ATTACHMENT_REFERENCE_INVALID');
});

test('E5 retained and temporary accounts enforce exact independent hard limits', async () => {
  const budget = createAttachmentBudget();
  const retained = budget.reserveRetained(LIMITS.MAX_CACHE_MEMORY_BYTES);
  assert.throws(() => budget.reserveRetained(1), code('ATTACHMENT_CACHE_LIMIT'));
  await budget.withWork({}, async work => {
    const hold = work.reserve(LIMITS.MAX_ATTACHMENT_WORK_BYTES);
    assert.throws(() => work.reserve(1), code('ATTACHMENT_CACHE_LIMIT'));
    assert.deepEqual(budget.snapshot(), { retainedBytes: LIMITS.MAX_CACHE_MEMORY_BYTES, workBytes: LIMITS.MAX_ATTACHMENT_WORK_BYTES, activeWork: 1 });
    hold.release();
    assert.equal(budget.snapshot().workBytes, 0);
  });
  retained.release(); retained.release();
  assert.deepEqual(budget.snapshot(), { retainedBytes: 0, workBytes: 0, activeWork: 0 });
});

test('E5 work slots are nonqueued, branded, and held until actual callback cleanup', async () => {
  const budget = createAttachmentBudget(), begun = deferred(), done = deferred();
  const controller = new AbortController();
  const first = budget.withWork({ signal: controller.signal }, async work => {
    work.reserve(1234); begun.resolve(work); await done.promise;
  });
  const work = await begun.promise;
  await assert.rejects(budget.withWork({}, async () => {}), code('ATTACHMENT_WORK_BUSY'));
  await assert.rejects(budget.withWork({ work: {} }, async () => {}), code('ATTACHMENT_REFERENCE_INVALID'));
  assert.equal(await budget.withWork({ work }, async nested => nested === work), true);
  controller.abort();
  assert.equal(budget.snapshot().workBytes, 1234);
  assert.equal(budget.snapshot().activeWork, 1);
  assert.throws(() => work.check(), code('ABORTED'));
  done.resolve(); await first;
  assert.deepEqual(budget.snapshot(), { retainedBytes: 0, workBytes: 0, activeWork: 0 });
  assert.throws(() => work.reserve(1), code('ATTACHMENT_REFERENCE_INVALID'));
  await assert.rejects(budget.withWork({ signal: controller.signal }, async () => {}), code('ABORTED'));
});

test('E5 cancelled work permits only branded nested cleanup without releasing its admission slot', async () => {
  const budget = createAttachmentBudget(), controller = new AbortController(); let staleCleanup;
  await budget.withWork({ signal: controller.signal }, async work => {
    work.reserve(31); controller.abort();
    assert.throws(() => work.check(), code('ABORTED'));
    await assert.rejects(budget.withCleanupWork({ work: {} }, async () => {}), code('ATTACHMENT_REFERENCE_INVALID'));
    await budget.withCleanupWork({ work }, async cleanup => {
      staleCleanup = cleanup; cleanup.check(); cleanup.reserve(17);
      assert.equal(budget.snapshot().activeWork, 1);
      assert.equal(budget.snapshot().workBytes, 48);
      assert.equal(await budget.withWork({ work: cleanup }, async nested => nested === cleanup), true);
      await assert.rejects(budget.withWork({}, async () => {}), code('ATTACHMENT_WORK_BUSY'));
    });
    assert.equal(budget.snapshot().workBytes, 31);
    assert.throws(() => work.reserve(1), code('ABORTED'));
    assert.throws(() => staleCleanup.check(), code('ATTACHMENT_REFERENCE_INVALID'));
  });
  assert.deepEqual(budget.snapshot(), { retainedBytes: 0, workBytes: 0, activeWork: 0 });
});
