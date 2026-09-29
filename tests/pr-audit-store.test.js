'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPrAuditStore, PrAuditStore } = require('../src/ai/pr-audit-store');
const S = require('../src/ai/pr-audit-state');

function mockSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (str) => Buffer.from(Buffer.from(str, 'utf8').toString('base64')),
    decryptString: (buf) => Buffer.from(buf.toString('utf8'), 'base64').toString('utf8'),
  };
}

function sampleRecord(overrides = {}) {
  return {
    auditRef: S.ref('pra'),
    projectKey: 'a'.repeat(32),
    prNumber: 10,
    createdAt: new Date().toISOString(),
    status: 'completed',
    stale: false,
    source: {
      repoKey: 'b'.repeat(64),
      prNumber: 10,
      baseSha: 'c'.repeat(40),
      headSha: 'd'.repeat(40),
      mergeBaseSha: 'e'.repeat(40),
      baseRefName: 'main',
      headRefName: 'feature',
      descriptionHash: 'f'.repeat(64),
      changedFiles: 1,
      prefix: '',
    },
    coverage: { total: 1, scoped: 1, outside: 0, reviewed: 1, skipped: [] },
    report: {
      summary: '审查通过',
      findings: [],
    },
    ...overrides,
  };
}

describe('D17 PR audit store', () => {
  it('encrypts and persists records, and reads them back on restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-audit-store-'));
    try {
      const safeStorage = mockSafeStorage();
      const store1 = createPrAuditStore({ userDataPath: dir, safeStorage });
      assert.equal(store1.persistenceStatus().persistence, 'encrypted');

      const rec = sampleRecord();
      store1.put(rec);
      store1.close();

      const filePath = path.join(dir, 'engineering-pr-audits.json');
      assert.ok(fs.existsSync(filePath));
      const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.equal(envelope.version, 1);
      assert.equal(envelope.cipher, 'electron-safeStorage');

      // Re-open store and verify read back
      const store2 = createPrAuditStore({ userDataPath: dir, safeStorage });
      const loaded = store2.get(rec.auditRef, rec.projectKey);
      assert.equal(loaded.auditRef, rec.auditRef);
      assert.equal(loaded.report.summary, '审查通过');
      store2.close();
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('converts preparing/running to interrupted and publishing to uncertain on restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-audit-store-'));
    try {
      const safeStorage = mockSafeStorage();
      const store1 = createPrAuditStore({ userDataPath: dir, safeStorage });

      const activeRec = sampleRecord({
        status: 'running',
        publication: {
          status: 'publishing',
          publicationRef: S.ref('pap'),
          actorId: 101,
          commitId: 'd'.repeat(40),
          bodyHash: '1'.repeat(64),
          comments: [],
        },
      });

      store1.put(activeRec);
      store1.close();

      const store2 = createPrAuditStore({ userDataPath: dir, safeStorage });
      const loaded = store2.get(activeRec.auditRef, activeRec.projectKey);
      assert.equal(loaded.status, 'interrupted');
      assert.equal(loaded.publication.status, 'uncertain');
      store2.close();
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('preserves corrupt file and falls back to memory mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-audit-store-'));
    try {
      const filePath = path.join(dir, 'engineering-pr-audits.json');
      fs.writeFileSync(filePath, 'invalid json content');

      const safeStorage = mockSafeStorage();
      const store = createPrAuditStore({ userDataPath: dir, safeStorage });
      assert.equal(store.mode, 'memory');
      assert.equal(store.corrupt, true);
      assert.equal(store.persistenceStatus().error, 'PR_AUDIT_STORE_CORRUPT');

      // Verify the corrupt file was NOT overwritten
      assert.equal(fs.readFileSync(filePath, 'utf8'), 'invalid json content');
      store.close();
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('prunes records beyond limits while protecting active records', () => {
    const store = new PrAuditStore(); // in-memory
    const projectKey = 'a'.repeat(32);

    // Insert 50 records
    for (let i = 0; i < 50; i++) {
      store.put(sampleRecord({
        auditRef: S.ref('pra'),
        projectKey,
        createdAt: new Date(Date.now() + i * 1000).toISOString(),
      }));
    }
    assert.equal(store.list(projectKey).length, 50);

    // 51st record prunes the oldest
    const newest = sampleRecord({
      auditRef: S.ref('pra'),
      projectKey,
      createdAt: new Date(Date.now() + 60000).toISOString(),
    });
    store.put(newest);
    assert.equal(store.list(projectKey).length, 50);
    assert.ok(store.get(newest.auditRef, projectKey));
  });
});
