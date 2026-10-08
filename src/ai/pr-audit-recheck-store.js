'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./pr-audit-state');
const S = require('./pr-audit-recheck-state');
class PrAuditRecheckStore {
  constructor(options = {}) {
    this.fs = options.fs || fs; this.safeStorage = options.safeStorage;
    this.file = options.storePath || (options.userDataPath ? path.join(options.userDataPath, 'engineering-pr-audit-rechecks.json') : '');
    this.rows = new Map(); this.mode = 'memory'; this.corrupt = false; this.error = null;
    try { if (this.file && this.safeStorage?.isEncryptionAvailable?.()) this.mode = 'encrypted'; } catch {}
    if (this.mode !== 'encrypted' || !this.fs.existsSync(this.file)) return;
    try {
      const env = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      if (env.version !== 1 || env.cipher !== 'electron-safeStorage' || typeof env.payload !== 'string') throw A.fail();
      const rows = JSON.parse(this.safeStorage.decryptString(Buffer.from(env.payload, 'base64')));
      if (!Array.isArray(rows) || rows.length > 200) throw A.fail();
      const loaded = new Map(); const counts = new Map();
      for (const raw of rows) {
        const row = S.record(raw); const count = (counts.get(row.projectKey) || 0) + 1;
        if (loaded.has(row.recheckRef) || count > 50) throw A.fail(); counts.set(row.projectKey, count);
        if (S.ACTIVE.has(row.status)) { row.status = 'interrupted'; row.errorCode = 'PR_AUDIT_CANCELLED'; }
        row.freshness = 'unknown'; loaded.set(row.recheckRef, row);
      }
      this.rows = loaded; this.write();
    } catch { this.corrupt = true; this.mode = 'memory'; this.error = 'PR_AUDIT_RECHECK_STORE_CORRUPT'; }
  }
  write() {
    if (this.mode !== 'encrypted' || this.corrupt) return false;
    let temp;
    try {
      this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const plain = JSON.stringify([...this.rows.values()].map(S.record));
      temp = `${this.file}.${process.pid}.${A.ref('tmp')}.tmp`;
      this.fs.writeFileSync(temp, JSON.stringify({ version: 1, cipher: 'electron-safeStorage', payload: Buffer.from(this.safeStorage.encryptString(plain)).toString('base64') }));
      const check = JSON.parse(this.fs.readFileSync(temp, 'utf8'));
      if (this.safeStorage.decryptString(Buffer.from(check.payload, 'base64')) !== plain) throw A.fail();
      this.fs.renameSync(temp, this.file); return true;
    } catch {
      this.mode = 'memory'; this.error = 'PR_AUDIT_RECHECK_STORE_MEMORY';
      if (temp) { try { this.fs.unlinkSync(temp); } catch {} } return false;
    }
  }
  put(raw) {
    const row = S.record(raw); const next = new Map(this.rows);
    if (!next.has(row.recheckRef)) {
      const trim = (rows, max) => {
        while (rows.length >= max) {
          const old = rows.filter((r) => !S.ACTIVE.has(r.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
          if (!old) throw A.fail('LIMIT'); next.delete(old.recheckRef); rows = rows.filter((r) => r !== old);
        }
      };
      trim([...next.values()].filter((r) => r.projectKey === row.projectKey), 50); trim([...next.values()], 200);
    }
    next.set(row.recheckRef, row); this.rows = next; this.write(); return structuredClone(row);
  }
  get(ref, key) { const row = this.rows.get(ref); return row && row.projectKey === key ? structuredClone(row) : null; }
  referencesUnknown() {
    // An unreadable or older durable history may still refer to either source store.
    try { return !!this.file && (this.corrupt || this.mode !== 'encrypted') && this.fs.existsSync(this.file); }
    catch { return true; }
  }
  list(key) { return [...this.rows.values()].filter((r) => !key || r.projectKey === key).map((r) => structuredClone(r)); }
  persistenceStatus() { return { persistence: this.mode, durable: this.mode === 'encrypted', corrupt: this.corrupt, error: this.error }; }
  close() { this.write(); }
}
module.exports = { PrAuditRecheckStore };
