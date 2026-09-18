'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createRemoteCiRef,
  normalizeDecimalId,
  normalizeRemoteCiSnapshot,
  publicRemoteCiSummary,
  repositoryKey,
  remoteCiDedupeKey,
  remoteCiSourceFingerprint,
} = require('../src/ai/remote-ci-state');
const { createRemoteCiStore, MAX_PROJECT_SNAPSHOTS } = require('../src/ai/remote-ci-store');

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text, 'utf8'),
  decryptString: (buffer) => Buffer.from(buffer).toString('utf8'),
};

function snapshot(overrides = {}) {
  return {
    remoteCiRef: createRemoteCiRef(),
    projectKey: 'a'.repeat(32),
    repoKey: repositoryKey('github.com', 'Acme/Widget'),
    prNumber: 7,
    headSha: 'b'.repeat(40),
    headRefName: 'feature/fix-ci',
    checkRunId: '90071992547409931',
    runId: '90071992547409932',
    jobId: '90071992547409933',
    runAttempt: 2,
    workflowName: 'CI',
    jobName: 'unit tests',
    conclusion: 'failure',
    completedAt: '2026-09-16T01:00:00.000Z',
    annotationCount: 4,
    annotationsTruncated: false,
    logsAvailable: true,
    createdAt: '2026-09-16T01:01:00.000Z',
    lastVerifiedAt: '2026-09-16T01:01:00.000Z',
    ...overrides,
  };
}

describe('D14 remote CI state and store', () => {
  it('keeps GitHub numeric ids as decimal strings and rejects injected fields', () => {
    assert.equal(normalizeDecimalId('90071992547409931'), '90071992547409931');
    assert.equal(normalizeDecimalId(Number.MAX_SAFE_INTEGER + 10), '');
    assert.equal(normalizeDecimalId('01'), '');
    const item = normalizeRemoteCiSnapshot(snapshot());
    assert.equal(typeof item.jobId, 'string');
    assert.throws(() => normalizeRemoteCiSnapshot({ ...snapshot(), log: 'secret' }), /字段无效/);
    assert.throws(() => normalizeRemoteCiSnapshot({ ...snapshot(), conclusion: 'cancelled' }), /内容无效/);
  });

  it('builds stable repo, dedupe, and source fingerprints', () => {
    const first = snapshot({ remoteCiRef: 'rci_' + '1'.repeat(24) });
    const second = snapshot({ remoteCiRef: 'rci_' + '2'.repeat(24), createdAt: '2026-09-17T00:00:00.000Z' });
    assert.equal(repositoryKey('GITHUB.COM', 'acme/widget'), first.repoKey);
    assert.equal(remoteCiDedupeKey(first), remoteCiDedupeKey(second));
    assert.equal(remoteCiSourceFingerprint(first), remoteCiSourceFingerprint(second));
    assert.notEqual(remoteCiSourceFingerprint(first), remoteCiSourceFingerprint({ ...first, runAttempt: 3 }));
  });

  it('publishes only bounded metadata and dynamic capability', () => {
    const publicValue = publicRemoteCiSummary({ ...snapshot(), token: 'secret', annotations: ['private'] }, { capability: 'available' });
    assert.equal(publicValue.canRepair, true);
    assert.equal(publicValue.canRerun, true);
    assert.equal(publicValue.projectKey, undefined);
    assert.equal(publicValue.repoKey, undefined);
    assert.equal(publicValue.runId, undefined);
    assert.equal(publicValue.jobId, undefined);
    assert.equal(publicValue.annotations, undefined);
    assert.doesNotMatch(JSON.stringify(publicValue), /secret|private/);
  });

  it('uses encrypted immutable storage and never persists CI bodies', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d14-store-'));
    const file = path.join(dir, 'remote.json');
    try {
      const store = createRemoteCiStore({ storePath: file, safeStorage });
      const item = store.put(snapshot());
      assert.equal(store.findDuplicate({ ...item, remoteCiRef: createRemoteCiRef() }).remoteCiRef, item.remoteCiRef);
      assert.throws(() => store.put({ ...item, jobName: 'changed' }), (error) => error.code === 'REMOTE_CI_INVALID');
      const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
      const plaintext = safeStorage.decryptString(Buffer.from(envelope.payload, 'base64'));
      assert.match(plaintext, /remoteCiRef/);
      assert.doesNotMatch(plaintext, /"annotations"|"steps"|stdout|stderr|signed_url|Authorization|patch/);
      const restored = createRemoteCiStore({ storePath: file, safeStorage });
      assert.equal(restored.get(item.remoteCiRef).jobId, item.jobId);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps memory-only mode off disk, preserves corrupt files, and skips protected refs during pruning', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d14-store-mode-'));
    const memoryFile = path.join(dir, 'memory.json');
    const corruptFile = path.join(dir, 'corrupt.json');
    try {
      const memory = createRemoteCiStore({ storePath: memoryFile, safeStorage: null });
      memory.put(snapshot());
      assert.equal(fs.existsSync(memoryFile), false);

      fs.writeFileSync(corruptFile, '{broken', 'utf8');
      const corrupt = createRemoteCiStore({ storePath: corruptFile, safeStorage });
      assert.equal(corrupt.persistenceStatus().error, 'REMOTE_CI_STORE_CORRUPT');
      assert.throws(() => corrupt.put(snapshot()), (error) => error.code === 'REMOTE_CI_STORE_CORRUPT');
      assert.equal(fs.readFileSync(corruptFile, 'utf8'), '{broken');

      let protectedRef = '';
      const store = createRemoteCiStore({ safeStorage: null, isProtected: (ref) => ref === protectedRef });
      for (let index = 0; index < MAX_PROJECT_SNAPSHOTS + 4; index += 1) {
        const item = snapshot({
          remoteCiRef: `rci_${index.toString(16).padStart(24, '0')}`,
          checkRunId: String(index + 1),
          createdAt: new Date(index * 1000).toISOString(),
          lastVerifiedAt: new Date(index * 1000).toISOString(),
        });
        if (index === 0) protectedRef = item.remoteCiRef;
        store.put(item);
      }
      assert.ok(store.get(protectedRef));
      assert.ok(store.list('a'.repeat(32)).length <= MAX_PROJECT_SNAPSHOTS);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
