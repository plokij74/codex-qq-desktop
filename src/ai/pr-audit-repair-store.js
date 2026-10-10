'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./pr-audit-state');
const S = require('./pr-audit-repair-state');

function replaceFileSync(fsImpl, source, target) {
  try {
    fsImpl.renameSync(source, target);
  } catch (err) {
    if ((err?.code === 'EPERM' || err?.code === 'EBUSY') && process.platform === 'win32') {
      for (let i = 0; i < 10; i++) {
        try {
          const waitTill = Date.now() + 5;
          while (Date.now() < waitTill) {}
          fsImpl.renameSync(source, target);
          return;
        } catch {}
      }
    }
    throw err;
  }
}

class PrAuditRepairStore {
  constructor(options = {}) {
    this.fs = options.fs || fs; this.safeStorage = options.safeStorage;
    this.schema = options.schema || S; this.refField = options.refField || 'auditRepairRef';
    this.file = options.storePath || (options.userDataPath ? path.join(options.userDataPath, options.storeName || 'engineering-pr-audit-repairs.json') : '');
    this.isProtected = options.isProtected || (() => false); this.now = options.now || Date.now;
    this.rows = new Map(); this.leases = new Map(); this.mode = 'memory'; this.corrupt = false; this.error = null;
    try { if (this.file && this.safeStorage?.isEncryptionAvailable?.()) this.mode = 'encrypted'; } catch {}
    if (this.mode !== 'encrypted' || !this.fs.existsSync(this.file)) return;
    try {
      const envelope = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      if (envelope.version !== 1 || envelope.cipher !== 'electron-safeStorage' || typeof envelope.payload !== 'string') throw S.fail();
      const rows = JSON.parse(this.safeStorage.decryptString(Buffer.from(envelope.payload, 'base64')));
      if (!Array.isArray(rows) || rows.length > 200) throw S.fail();
      const loaded = new Map(); const counts = new Map();
      for (const raw of rows) {
        const row = this.schema.normalizeSnapshot(raw);
        if (loaded.has(row[this.refField])) throw S.fail();
        const count = (counts.get(row.projectKey) || 0) + 1; if (count > 50) throw S.fail();
        counts.set(row.projectKey, count); loaded.set(row[this.refField], row);
      }
      this.rows = loaded;
    } catch { this.corrupt = true; this.error = 'PR_AUDIT_REPAIR_STORE_CORRUPT'; }
  }
  protected(row) {
    const expires = this.leases.get(row[this.refField]);
    if (expires && expires <= this.now()) this.leases.delete(row[this.refField]);
    return (expires || 0) > this.now() || this.isProtected(row[this.refField], row);
  }
  lease(ref) { this.leases.set(ref, this.now() + 15 * 60000); }
  write() {
    if (this.mode !== 'encrypted' || this.corrupt) return false;
    let temp;
    try {
      this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const plain = JSON.stringify([...this.rows.values()]);
      temp = `${this.file}.${process.pid}.${A.ref('tmp')}.tmp`;
      this.fs.writeFileSync(temp, JSON.stringify({ version: 1, cipher: 'electron-safeStorage', payload: Buffer.from(this.safeStorage.encryptString(plain)).toString('base64') }));
      const verify = JSON.parse(this.fs.readFileSync(temp, 'utf8'));
      if (this.safeStorage.decryptString(Buffer.from(verify.payload, 'base64')) !== plain) throw S.fail();
      replaceFileSync(this.fs, temp, this.file); return true;
    } catch {
      this.mode = 'memory'; this.error = 'PR_AUDIT_REPAIR_STORE_MEMORY';
      if (temp) { try { this.fs.unlinkSync(temp); } catch {} } return false;
    }
  }
  get(ref, projectKey) { const row = this.rows.get(ref); return row && row.projectKey === projectKey ? structuredClone(row) : null; }
  list(projectKey) { return [...this.rows.values()].filter((row) => !projectKey || row.projectKey === projectKey).map((row) => structuredClone(row)); }
  put(raw) {
    if (this.corrupt) throw S.fail('REPAIR_STORE_CORRUPT');
    const row = this.schema.normalizeSnapshot(raw); const old = this.rows.get(row[this.refField]);
    if (old && JSON.stringify(old) !== JSON.stringify(row)) throw S.fail();
    const duplicate = [...this.rows.values()].find((r) => this.schema.sourceFingerprint(r) === this.schema.sourceFingerprint(row));
    if (duplicate) { this.lease(duplicate[this.refField]); return structuredClone(duplicate); }
    const next = new Map(this.rows);
    const trim = (rows, max) => {
      while (rows.length >= max) {
        const candidate = rows.filter((r) => !this.protected(r)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!candidate) throw S.fail('REPAIR_LIMIT');
        next.delete(candidate[this.refField]); rows = rows.filter((r) => r[this.refField] !== candidate[this.refField]);
      }
    };
    trim([...next.values()].filter((r) => r.projectKey === row.projectKey), 50); trim([...next.values()], 200);
    next.set(row[this.refField], row); this.rows = next; this.lease(row[this.refField]); this.write();
    return structuredClone(row);
  }
  persistenceStatus() { return { persistence: this.mode, durable: this.mode === 'encrypted' && !this.corrupt, error: this.error, corrupt: this.corrupt }; }
  referencesUnknown() {
    try { return !!this.file && (this.corrupt || this.mode !== 'encrypted') && this.fs.existsSync(this.file); }
    catch { return true; }
  }
  close() { this.write(); this.leases.clear(); }
}
module.exports = { PrAuditRepairStore, createPrAuditRepairStore: (options) => new PrAuditRepairStore(options) };
