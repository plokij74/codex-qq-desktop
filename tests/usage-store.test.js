'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  usageFilePath,
  appendRecord,
  readRecords,
  pruneRecords,
  clearRecords,
} = require('../src/ai/usage-store');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
  return usageFilePath(dir);
}

function record(ts, extra = {}) {
  return {
    ts,
    session: 's',
    model: 'm',
    kind: 'main',
    in: 10,
    out: 1,
    cached: 0,
    est: false,
    cost: null,
    cur: '$',
    ...extra,
  };
}

describe('usage-store', () => {
  it('resolves usage.jsonl below userData', () => {
    assert.equal(usageFilePath(path.join('a', 'b')), path.join('a', 'b', 'usage.jsonl'));
  });

  it('appends and reads records', () => {
    const file = tempFile();
    appendRecord(file, record(1));
    appendRecord(file, record(2));
    const { records, skipped } = readRecords(file);
    assert.equal(records.length, 2);
    assert.equal(records[1].ts, 2);
    assert.equal(skipped, 0);
  });

  it('treats a missing file as empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-missing-'));
    assert.deepEqual(readRecords(path.join(dir, 'missing', 'usage.jsonl')), {
      records: [],
      skipped: 0,
    });
  });

  it('skips corrupt and incomplete lines', () => {
    const file = tempFile();
    appendRecord(file, record(1));
    fs.appendFileSync(file, '{oops\n');
    fs.appendFileSync(file, '{"noTs":true}\n');
    fs.appendFileSync(file, JSON.stringify(record(3, { in: 'Infinity' })) + '\n');
    fs.appendFileSync(file, JSON.stringify(record(4, { cost: -1 })) + '\n');
    appendRecord(file, record(2));
    const { records, skipped } = readRecords(file);
    assert.equal(records.length, 2);
    assert.equal(skipped, 4);
  });

  it('prunes to the newest timestamps atomically', () => {
    const file = tempFile();
    for (let ts = 10; ts >= 1; ts -= 1) appendRecord(file, record(ts));
    pruneRecords(file, 3);
    assert.deepEqual(readRecords(file).records.map((row) => row.ts), [8, 9, 10]);
    assert.deepEqual(
      fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp')),
      [],
    );
  });

  it('does not rewrite a file below the limit', () => {
    const file = tempFile();
    appendRecord(file, record(1));
    pruneRecords(file, 100);
    assert.equal(readRecords(file).records.length, 1);
  });

  it('clears all records', () => {
    const file = tempFile();
    appendRecord(file, record(1));
    clearRecords(file);
    assert.deepEqual(readRecords(file), { records: [], skipped: 0 });
  });

  it('surfaces non-ENOENT read errors', () => {
    const originalRead = fs.readFileSync;
    fs.readFileSync = () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    try {
      assert.throws(() => readRecords(tempFile()), /denied/);
    } finally {
      fs.readFileSync = originalRead;
    }
  });

  it('removes its unique temp file when an atomic rename fails', () => {
    const file = tempFile();
    appendRecord(file, record(1));
    appendRecord(file, record(2));
    const originalRename = fs.renameSync;
    fs.renameSync = () => { throw new Error('rename failed'); };
    try {
      assert.throws(() => pruneRecords(file, 1), /rename failed/);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.deepEqual(
      fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp')),
      [],
    );
    assert.equal(readRecords(file).records.length, 2);
  });
});
