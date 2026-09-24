'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeSnapshot, sourceFingerprint, fail } = require('./pr-review-state');

class PrReviewStore {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.safeStorage = options.safeStorage;
    this.storePath = options.storePath || (options.userDataPath ? path.join(options.userDataPath, 'engineering-pr-reviews.json') : '');
    this.isProtected = options.isProtected || (() => false);
    this.snapshots = new Map();
    this.corrupt = false;
    this.error = null;
    this.mode = 'memory';
    try { if (this.storePath && this.safeStorage?.isEncryptionAvailable?.()) this.mode = 'encrypted'; } catch {}
    if (this.mode !== 'encrypted' || !this.fs.existsSync(this.storePath)) return;
    try {
      const envelope = JSON.parse(this.fs.readFileSync(this.storePath, 'utf8'));
      if (envelope.version !== 1 || envelope.cipher !== 'electron-safeStorage' || typeof envelope.payload !== 'string') throw fail();
      const rows = JSON.parse(this.safeStorage.decryptString(Buffer.from(envelope.payload, 'base64')));
      if (!Array.isArray(rows) || rows.length > 200) throw fail();
      const loaded = new Map();
      for (const raw of rows) {
        const item = Object.freeze(normalizeSnapshot(raw));
        if (loaded.has(item.reviewRef)) throw fail();
        loaded.set(item.reviewRef, item);
      }
      this.snapshots = loaded;
    } catch { this.corrupt = true; this.error = 'PR_REVIEW_STORE_CORRUPT'; }
  }
  _write() {
    if (this.mode !== 'encrypted' || this.corrupt) return;
    let temp;
    try {
      this.fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      const payload = this.safeStorage.encryptString(JSON.stringify([...this.snapshots.values()]));
      temp = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
      this.fs.writeFileSync(temp, JSON.stringify({ version: 1, cipher: 'electron-safeStorage', payload: Buffer.from(payload).toString('base64') }), 'utf8');
      const envelope = JSON.parse(this.fs.readFileSync(temp, 'utf8'));
      JSON.parse(this.safeStorage.decryptString(Buffer.from(envelope.payload, 'base64'))).forEach(normalizeSnapshot);
      this.fs.renameSync(temp, this.storePath);
    } catch {
      this.mode = 'memory'; this.error = 'PR_REVIEW_STORE_UNAVAILABLE';
      if (temp) { try { this.fs.unlinkSync(temp); } catch {} }
    }
  }
  get(reference, projectKey) {
    const item = this.snapshots.get(reference);
    return item && item.projectKey === projectKey ? item : null;
  }
  list(projectKey) { return [...this.snapshots.values()].filter((item) => !projectKey || item.projectKey === projectKey); }
  put(raw) {
    if (this.corrupt) throw fail('PR_REVIEW_STORE_CORRUPT');
    const item = Object.freeze(normalizeSnapshot(raw));
    const existing = this.snapshots.get(item.reviewRef);
    if (existing && JSON.stringify(existing) !== JSON.stringify(item)) throw fail();
    const duplicate = this.list(item.projectKey).find((row) => sourceFingerprint(row) === sourceFingerprint(item));
    if (duplicate) return duplicate;
    // Reserve capacity before changing the authoritative map. Protected worktree
    // and repair sources must not disappear while making room for a snapshot.
    const next = new Map(this.snapshots);
    const trim = (rows, max) => {
      const candidates = rows.filter((row) => !this.isProtected(row.reviewRef, row)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      while (rows.length >= max) {
        const remove = candidates.shift();
        if (!remove) throw fail('PR_REVIEW_LIMIT');
        next.delete(remove.reviewRef); rows = rows.filter((row) => row.reviewRef !== remove.reviewRef);
      }
    };
    trim([...next.values()].filter((row) => row.projectKey === item.projectKey), 50);
    trim([...next.values()], 200);
    next.set(item.reviewRef, item); this.snapshots = next; this._write(); return item;
  }
  persistenceStatus() { return { persistence: this.mode, durable: this.mode === 'encrypted' && !this.corrupt, error: this.error, corrupt: this.corrupt }; }
  close() { this._write(); }
}
module.exports = { PrReviewStore, createPrReviewStore: (options) => new PrReviewStore(options) };
