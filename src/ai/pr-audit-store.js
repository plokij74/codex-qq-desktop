'use strict';
const fs = require('node:fs');
const path = require('node:path');
const S = require('./pr-audit-state');

const pick = (value, fields) => Object.fromEntries(fields.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
function durableRecord(raw) {
  const row = pick(raw, ['auditRef', 'projectKey', 'prNumber', 'createdAt', 'finishedAt', 'status', 'stale', 'errorCode', 'turns', 'model']);
  if (raw.coverage) row.coverage = { ...pick(raw.coverage, ['total', 'scoped', 'outside', 'reviewed']),
    skipped: raw.coverage.skipped.map((s) => pick(s, ['path', 'reason'])) };
  if (raw.usage) row.usage = pick(raw.usage, ['inputTokens', 'outputTokens', 'estimated']);
  if (raw.source) row.source = pick(raw.source, ['repoKey', 'prNumber', 'baseSha', 'headSha', 'mergeBaseSha', 'baseRefName', 'headRefName', 'descriptionHash', 'changedFiles', 'prefix']);
  if (raw.report) row.report = { summary: raw.report.summary, findings: raw.report.findings.map((f) => pick(f, ['findingId', 'priority', 'title', 'body', 'path', 'contextPath', 'side', 'line', 'startLine'])) };
  if (raw.publication) row.publication = { ...pick(raw.publication, ['status', 'publicationRef', 'actorId', 'commitId', 'bodyHash', 'reviewId', 'createdAt', 'confirmedAt', 'errorCode']),
    comments: raw.publication.comments.map((c) => pick(c, ['path', 'side', 'line', 'startLine', 'bodyHash'])) };
  return S.normalizeRecord(row);
}
class PrAuditStore {
  constructor(options = {}) {
    this.fs = options.fs || fs; this.safeStorage = options.safeStorage;
    this.file = options.storePath || (options.userDataPath ? path.join(options.userDataPath, 'engineering-pr-audits.json') : '');
    this.records = new Map(); this.mode = 'memory'; this.error = null; this.corrupt = false;
    try { if (this.file && this.safeStorage?.isEncryptionAvailable?.()) this.mode = 'encrypted'; } catch {}
    this.requiresDurableIntents = this.mode === 'encrypted' || !!(this.file && this.fs.existsSync(this.file));
    if (this.mode === 'encrypted' && this.fs.existsSync(this.file)) {
      try {
        const envelope = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
        if (envelope.version !== 1 || envelope.cipher !== 'electron-safeStorage' || typeof envelope.payload !== 'string') throw S.fail();
        const rows = JSON.parse(this.safeStorage.decryptString(Buffer.from(envelope.payload, 'base64')));
        if (!Array.isArray(rows) || rows.length > 200) throw S.fail();
        const restored = new Map();
        for (const raw of rows) {
          const row = durableRecord(raw); if (restored.has(row.auditRef)) throw S.fail();
          if (S.ACTIVE.has(row.status)) { row.status = 'interrupted'; row.errorCode = 'PR_AUDIT_CANCELLED'; }
          if (row.publication?.status === 'publishing') row.publication.status = 'uncertain';
          restored.set(row.auditRef, row);
        }
        this.records = restored; this.write();
      } catch { this.mode = 'memory'; this.corrupt = true; this.error = 'PR_AUDIT_STORE_CORRUPT'; }
    }
  }
  write() {
    if (this.mode !== 'encrypted' || this.corrupt) return false;
    let temp;
    try {
      this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const plain = JSON.stringify([...this.records.values()].map(durableRecord));
      const payload = this.safeStorage.encryptString(plain);
      temp = `${this.file}.${process.pid}.${S.ref('tmp')}.tmp`;
      this.fs.writeFileSync(temp, JSON.stringify({ version: 1, cipher: 'electron-safeStorage', payload: Buffer.from(payload).toString('base64') }));
      const verify = JSON.parse(this.fs.readFileSync(temp, 'utf8'));
      if (this.safeStorage.decryptString(Buffer.from(verify.payload, 'base64')) !== plain) throw S.fail();
      this.fs.renameSync(temp, this.file); return true;
    } catch {
      this.mode = 'memory'; this.error = 'PR_AUDIT_STORE_MEMORY';
      if (temp) { try { this.fs.unlinkSync(temp); } catch {} } return false;
    }
  }
  protected(row) { return S.ACTIVE.has(row.status) || ['publishing', 'uncertain'].includes(row.publication?.status); }
  put(raw, { intent = false } = {}) {
    const row = durableRecord(raw); const next = new Map(this.records);
    if (!next.has(row.auditRef)) {
      const trim = (rows, max) => {
        while (rows.length >= max) {
          const candidate = rows.filter((r) => !this.protected(r)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
          if (!candidate) throw S.fail('LIMIT'); next.delete(candidate.auditRef); rows = rows.filter((r) => r.auditRef !== candidate.auditRef);
        }
      };
      trim([...next.values()].filter((r) => r.projectKey === row.projectKey), 50); trim([...next.values()], 200);
    }
    next.set(row.auditRef, row); this.records = next;
    const written = this.write();
    if (intent && this.requiresDurableIntents && !written) throw S.fail('STORE_MEMORY');
    return structuredClone(row);
  }
  get(ref, projectKey) { const row = this.records.get(ref); return row && row.projectKey === projectKey ? structuredClone(row) : null; }
  list(projectKey) { return [...this.records.values()].filter((row) => !projectKey || row.projectKey === projectKey).map((r) => structuredClone(r)); }
  persistenceStatus() { return { persistence: this.mode, durable: this.mode === 'encrypted' && !this.corrupt, error: this.error }; }
  close() { this.write(); }
}
module.exports = { PrAuditStore, durableRecord, createPrAuditStore: (options) => new PrAuditStore(options) };
