'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { LIMITS, createAttachmentBudget } = require('../src/ai/attachment-contract');
const reader = () => require('../src/ai/attachment-reader');
const captured = (value, name = 'note.txt', sourceKind = 'user_upload') => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return { bytes, name, sourceKind, rawDigest: crypto.createHash('sha256').update(bytes).digest('hex') };
};
const throwsCode = (fn, code) => assert.throws(fn, error => error.code === code);
const rejectsCode = (fn, code) => assert.rejects(fn, error => error.code === code);

// Fixture evidence only: the native suite separately exercises the real handles.
test('E5 text: fatal UTF-8, BOM removed only after hashing, Chinese and emoji preserved', () => {
  const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文😀\r\n  x\n')]);
  const result = reader().extractText(captured(raw));
  assert.equal(result.text, '中文😀\r\n  x\n');
  assert.equal(result.rawDigest, captured(raw).rawDigest);
  assert.equal(result.rawByteLength, raw.length);
  assert.equal(result.selectedChars, 9);
});
test('E5 text: empty UTF-8 and UTF-8 BOM-only files remain explicit empty files', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([0xef, 0xbb, 0xbf])]) {
    const result = reader().extractText(captured(bytes));
    assert.equal(result.text, ''); assert.equal(result.empty, true); assert.equal(result.truncated, false);
  }
});
test('E5 text: allowlisted JSON/CSV/source are inert and need not parse', () => {
  for (const name of ['broken.JSON', 'formula.csv', 'source.ps1', 'README', 'LICENSE', 'Makefile', 'Dockerfile', '.gitignore']) {
    const text = '{ bad JSON, @outside.txt, =HYPERLINK("x"), <script>throw 1</script> }';
    assert.equal(reader().extractText(captured(text, name)).text, text);
  }
});
test('E5 text: unsupported extension and disguised binary magic reject', () => {
  throwsCode(() => reader().extractText(captured('text', 'a.pdf')), 'ATTACHMENT_TYPE_UNSUPPORTED');
  for (const bytes of [Buffer.from('%PDF-1.7\n'), Buffer.from('MZxxxx'), Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), Buffer.from('GIF89a'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])]) {
    throwsCode(() => reader().extractText(captured(bytes)), 'ATTACHMENT_TYPE_UNSUPPORTED');
  }
});
test('E5 text: UTF-16/UTF-32 BOM, broken tail UTF-8 and all forbidden C0 reject', () => {
  for (const bytes of [Buffer.from([0xff, 0xfe, 65, 0]), Buffer.from([0xfe, 0xff, 0, 65]), Buffer.from([0, 0, 0xfe, 0xff]), Buffer.from([0xff, 0xfe, 0, 0]), Buffer.from([0xe2, 0x82])]) {
    throwsCode(() => reader().extractText(captured(bytes)), 'ATTACHMENT_ENCODING_INVALID');
  }
  for (let code = 0; code < 32; code++) {
    if ([9, 10, 13].includes(code)) continue;
    throwsCode(() => reader().extractText(captured('safe' + String.fromCharCode(code))), 'ATTACHMENT_ENCODING_INVALID');
  }
  assert.equal(reader().extractText(captured('\t\r\n\x7f')).text, '\t\r\n\x7f');
});
test('E5 text: full file validated and hashed even when selected range omits invalid tail', () => {
  const bytes = Buffer.concat([Buffer.from('good\n'), Buffer.from([0xff])]);
  throwsCode(() => reader().extractText(captured(bytes, 'a.txt', 'at_project_ref'), { startLine: 1, endLine: 1 }), 'ATTACHMENT_ENCODING_INVALID');
  const full = captured('one\r\ntwo\r\nthree\n', 'a.txt', 'at_project_ref');
  const result = reader().extractText(full, { startLine: 2, endLine: 2 });
  assert.equal(result.text, 'two\r\n'); assert.equal(result.rawDigest, full.rawDigest);
  assert.deepEqual(result.range, { startLine: 2, endLine: 2 });
  assert.equal(result.truncated, true);
});
test('E5 text: ranges are positive integral, bounded, never clamp or fall back to whole file', () => {
  const raw = captured('one\ntwo\n', 'a.txt', 'at_project_ref');
  for (const options of [{ startLine: 0 }, { startLine: 1.5 }, { startLine: 2, endLine: 1 }, { startLine: 3 }, { endLine: 2 }, { startLine: 1, endLine: LIMITS.MAX_EXPLICIT_RANGE_LINES + 1 }]) {
    assert.throws(() => reader().extractText(raw, options), error => ['ATTACHMENT_TEXT_LIMIT', 'ATTACHMENT_REFERENCE_INVALID'].includes(error.code));
  }
  throwsCode(() => reader().extractText(captured('', 'a.txt', 'at_project_ref'), { startLine: 1 }), 'ATTACHMENT_TEXT_LIMIT');
});
test('E5 text: default project range is 2000 lines with original terminators', () => {
  const raw = captured('x\r\n'.repeat(LIMITS.MAX_DEFAULT_RANGE_LINES + 1), 'a.txt', 'at_project_ref');
  const result = reader().extractText(raw);
  assert.equal(result.text, 'x\r\n'.repeat(LIMITS.MAX_DEFAULT_RANGE_LINES));
  assert.equal(result.truncated, true); assert.deepEqual(result.range, { startLine: 1, endLine: LIMITS.MAX_DEFAULT_RANGE_LINES });
});
test('E5 text: prefix uses Unicode codepoints, includes all budget information, redacts candidate first', () => {
  const raw = captured('a😀secret-tail');
  let seen;
  const result = reader().extractText(raw, { prefixCodePoints: 3, redact(text) { seen = text; return text.replace('secret-tail', '[MASKED]'); } });
  assert.equal(seen, 'a😀secret-tail'); assert.equal(result.text, 'a😀[');
  assert.equal(result.selectedChars, 3); assert.equal(result.selectedBytes, 6); assert.equal(result.truncated, true);
  assert.equal(result.selectedDigest, crypto.createHash('sha256').update('a😀[').digest('hex'));
  assert.equal(result.extractedChars, Array.from('a😀secret-tail').length);
});
test('E5 text: hard byte boundary and codepoint boundary plus one are distinct', () => {
  assert.equal(reader().extractText(captured(Buffer.alloc(LIMITS.MAX_FILE_BYTES, 0x61))).selectedChars, LIMITS.MAX_FILE_TEXT_CODEPOINTS);
  throwsCode(() => reader().extractText(captured(Buffer.alloc(LIMITS.MAX_FILE_BYTES + 1, 0x61))), 'ATTACHMENT_FILE_LIMIT');
  assert.equal(reader().extractText(captured('😀'.repeat(LIMITS.MAX_FILE_TEXT_CODEPOINTS))).truncated, false);
  assert.equal(reader().extractText(captured('😀'.repeat(LIMITS.MAX_FILE_TEXT_CODEPOINTS + 1))).truncated, true);
  throwsCode(() => reader().extractText(captured('a'), { prefixCodePoints: LIMITS.MAX_FILE_TEXT_CODEPOINTS + 1 }), 'ATTACHMENT_TEXT_LIMIT');
});

function fixtureBackend(bytes = Buffer.from('hello')) {
  const ancestors = [{ path: 'C:\\', identity: '1:1' }, { path: 'C:\\fixture', identity: '1:2' }];
  const backend = async request => {
    if (request.operation === 'inspect') return { physicalPath: request.root, rootIdentity: '1:2', ancestors };
    return { bytes, physicalPath: request.path, name: 'note.txt', identity: '1:3', rootIdentity: '1:2', ancestors, rawDigest: crypto.createHash('sha256').update(bytes).digest('hex') };
  };
  return { backend, ancestors };
}
test('E5 grants: other platform and absent verified native fail closed without JS byte fallback', async () => {
  const instance = reader().createAttachmentReader({ platform: 'linux' });
  await rejectsCode(() => instance.inspectRoot('/tmp'), 'ATTACHMENT_READ_DENIED');
  const grant = instance.createExternalGrant('C:\\fixture\\note.txt');
  await rejectsCode(() => instance.capture(grant), 'ATTACHMENT_READ_DENIED');
});
test('E5 grants: serialized, forged, and foreign factory grants cannot authorize bytes', async () => {
  const a = reader().createAttachmentReader({ platform: 'win32', ...fixtureBackend() });
  const b = reader().createAttachmentReader({ platform: 'win32', ...fixtureBackend() });
  const grant = a.createExternalGrant('C:\\fixture\\note.txt');
  for (const fake of [{}, JSON.parse(JSON.stringify(grant))]) await rejectsCode(() => a.capture(fake), 'ATTACHMENT_REFERENCE_INVALID');
  await rejectsCode(() => b.capture(grant), 'ATTACHMENT_REFERENCE_INVALID');
  assert.equal((await a.capture(grant)).bytes.toString(), 'hello');
  await rejectsCode(() => a.capture(grant), 'ATTACHMENT_REFERENCE_INVALID');
});
test('E5 grants: project root identity separate from relative path and source snapshots', async () => {
  const { backend, ancestors } = fixtureBackend();
  const instance = reader().createAttachmentReader({ platform: 'win32', backend });
  const root = await instance.inspectRoot('C:\\fixture');
  const grant = instance.createProjectGrant({ projectRoot: 'C:\\fixture', relativePath: 'note.txt', rootIdentity: root.rootIdentity, expectedAncestors: ancestors });
  const first = await instance.capture(grant);
  assert.equal(first.sourceKind, 'at_project_ref'); assert.equal(first.rootIdentity, '1:2'); assert.equal(first.relativePath, 'note.txt');
  assert.equal((await instance.capture(grant)).rawDigest, first.rawDigest);
  const changed = instance.createProjectGrant({ projectRoot: 'C:\\fixture', relativePath: 'note.txt', rootIdentity: '1:changed' });
  await rejectsCode(() => instance.capture(changed), 'ATTACHMENT_SOURCE_CHANGED');
});
test('E5 grants: paths reject traversal, ADS, UNC, devices, DOS aliases, and protected sources', async () => {
  const instance = reader().createAttachmentReader({ platform: 'win32', protectedPaths: ['C:\\private'], ...fixtureBackend() });
  for (const source of ['\\\\server\\share\\a.txt', '\\\\?\\C:\\fixture\\a.txt', '\\\\.\\C:\\a.txt', 'C:\\fixture\\a.txt:secret', 'C:\\fixture\\NUL.txt', 'C:\\fixture\\a.txt.', 'C:\\private\\a.txt']) {
    throwsCode(() => instance.createExternalGrant(source), 'ATTACHMENT_READ_DENIED');
  }
  for (const relativePath of ['../x.txt', 'C:\\outside.txt', 'a/../x.txt', 'a.txt:secret', 'NUL.txt']) {
    throwsCode(() => instance.createProjectGrant({ projectRoot: 'C:\\fixture', relativePath, rootIdentity: '1:2' }), 'ATTACHMENT_READ_DENIED');
  }
});
test('E5 grants: native capture is shared-work nested and reservations leave no busy slot', async () => {
  const budget = createAttachmentBudget();
  const instance = reader().createAttachmentReader({ platform: 'win32', budget, ...fixtureBackend() });
  await budget.withWork({}, async work => {
    const result = await instance.capture(instance.createExternalGrant('C:\\fixture\\note.txt'), { work });
    assert.equal(budget.snapshot().activeWork, 1); result.release?.();
  });
  assert.deepEqual(budget.snapshot(), { retainedBytes: 0, workBytes: 0, activeWork: 0 });
});
test('E5 text: empty project has no invalid range and frozen grant range is honored', () => {
  const empty = reader().extractText(captured('', 'a.txt', 'at_project_ref')); assert.equal(empty.empty, true); assert.equal(Object.hasOwn(empty, 'range'), false);
  const raw = { ...captured('one\r\ntwo😀\nthree', 'a.txt', 'at_project_ref'), range: { startLine: 2, endLine: 2 } };
  assert.equal(reader().extractText(raw).text, 'two😀\n');
});
test('E5 metadata: source/listing grants are distinct, prefix and root ancestors stay private', async () => {
  const { ancestors } = fixtureBackend(); let request;
  const instance = reader().createAttachmentReader({ platform: 'win32', backend: async input => {
    request = input; if (input.operation === 'inspect') return { physicalPath: input.root, rootIdentity: '1:2', ancestors };
    return { physicalPath: input.path, rootIdentity: '1:2', ancestors: [...ancestors, { path: input.path, identity: '1:4' }], entries: [{ name: 'note.txt', isDirectory: false }], truncated: false };
  } });
  const root = await instance.inspectRoot('C:\\fixture'); const grant = instance.createProjectListingGrant({ projectRoot: 'C:\\fixture', rootIdentity: root.rootIdentity, prefix: 'sub/n' });
  assert.deepEqual(await instance.listProject(grant), { entries: [{ name: 'note.txt', isDirectory: false }], truncated: false });
  assert.equal(request.path, 'C:\\fixture\\sub'); assert.equal(request.namePrefix, 'n'); assert.deepEqual(request.expectedAncestors, ancestors);
  await rejectsCode(() => instance.capture(grant), 'ATTACHMENT_REFERENCE_INVALID'); await rejectsCode(() => instance.listProject({}), 'ATTACHMENT_REFERENCE_INVALID');
  throwsCode(() => instance.createProjectListingGrant({ projectRoot: 'C:\\fixture', rootIdentity: root.rootIdentity, prefix: '../' }), 'ATTACHMENT_READ_DENIED');
});
test('E5 grants: cancelled work cannot open a source; external attempt is spent after failure', async () => {
  let calls = 0;
  const instance = reader().createAttachmentReader({ platform: 'win32', backend: async () => { calls++; throw Object.assign(new Error('do not expose source path'), { code: 'ATTACHMENT_READ_DENIED' }); } });
  const controller = new AbortController(); controller.abort();
  const aborted = instance.createExternalGrant('C:\\fixture\\note.txt');
  await rejectsCode(() => instance.capture(aborted, { signal: controller.signal }), 'ABORTED'); assert.equal(calls, 0);
  const failed = instance.createExternalGrant('C:\\fixture\\note.txt');
  await rejectsCode(() => instance.capture(failed), 'ATTACHMENT_READ_DENIED');
  await rejectsCode(() => instance.capture(failed), 'ATTACHMENT_REFERENCE_INVALID');
});
