'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./pr-audit-state');
const S = require('./pr-audit-repair-state');

class PrAuditRepairStore {
  constructor(options = {}) {
    this.fs = options.fs || fs; this.safeStorage = options.safeStorage;
    this.file = options.storePath || (options.userDataPath ? path.join(options.userDataPath, 'engineering-pr-audit-repairs.json') : '');
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
        const row = S.normalizeSnapshot(raw);
        if (loaded.has(row.auditRepairRef)) throw S.fail();
        const count = (counts.get(row.projectKey) || 0) + 1; if (count > 50) throw S.fail();
        counts.set(row.projectKey, count); loaded.set(row.auditRepairRef, row);
      }
      this.rows = loaded;
    } catch { this.corrupt = true; this.error = 'PR_AUDIT_REPAIR_STORE_CORRUPT'; }
  }
  protected(row) {
    const expires = this.leases.get(row.auditRepairRef);
    if (expires && expires <= this.now()) this.leases.delete(row.auditRepairRef);
    return (expires || 0) > this.now() || this.isProtected(row.auditRepairRef, row);
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
      this.fs.renameSync(temp, this.file); return true;
    } catch {
      this.mode = 'memory'; this.error = 'PR_AUDIT_REPAIR_STORE_MEMORY';
      if (temp) { try { this.fs.unlinkSync(temp); } catch {} } return false;
    }
  }
  get(ref, projectKey) { const row = this.rows.get(ref); return row && row.projectKey === projectKey ? structuredClone(row) : null; }
  list(projectKey) { return [...this.rows.values()].filter((row) => !projectKey || row.projectKey === projectKey).map((row) => structuredClone(row)); }
  put(raw) {
    if (this.corrupt) throw S.fail('REPAIR_STORE_CORRUPT');
    const row = S.normalizeSnapshot(raw); const old = this.rows.get(row.auditRepairRef);
    if (old && JSON.stringify(old) !== JSON.stringify(row)) throw S.fail();
    const duplicate = [...this.rows.values()].find((r) => S.sourceFingerprint(r) === S.sourceFingerprint(row));
    if (duplicate) { this.lease(duplicate.auditRepairRef); return structuredClone(duplicate); }
    const next = new Map(this.rows);
    const trim = (rows, max) => {
      while (rows.length >= max) {
        const candidate = rows.filter((r) => !this.protected(r)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!candidate) throw S.fail('REPAIR_LIMIT');
        next.delete(candidate.auditRepairRef); rows = rows.filter((r) => r.auditRepairRef !== candidate.auditRepairRef);
      }
    };
    trim([...next.values()].filter((r) => r.projectKey === row.projectKey), 50); trim([...next.values()], 200);
    next.set(row.auditRepairRef, row); this.rows = next; this.lease(row.auditRepairRef); this.write();
    return structuredClone(row);
  }
  persistenceStatus() { return { persistence: this.mode, durable: this.mode === 'encrypted' && !this.corrupt, error: this.error, corrupt: this.corrupt }; }
  close() { this.write(); this.leases.clear(); }
}
module.exports = { PrAuditRepairStore, createPrAuditRepairStore: (options) => new PrAuditRepairStore(options) };
