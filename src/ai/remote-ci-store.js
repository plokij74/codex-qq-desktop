'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeRemoteCiSnapshot,
  publicRemoteCiSummary,
  remoteCiDedupeKey,
} = require('./remote-ci-state');

const STORE_VERSION = 1;
const MAX_PROJECT_SNAPSHOTS = 50;
const MAX_SNAPSHOTS = 200;

class RemoteCiStore {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.safeStorage = options.safeStorage;
    this.storePath = options.storePath || (options.userDataPath ? path.join(options.userDataPath, 'engineering-remote-ci.json') : '');
    this.isProtected = typeof options.isProtected === 'function' ? options.isProtected : (() => false);
    this.mode = this.canEncrypt() && this.storePath ? 'encrypted' : 'memory';
    this.error = null;
    this.corrupt = false;
    this.lastWriteOk = this.mode !== 'encrypted';
    this.snapshots = new Map();
    this.load();
  }

  canEncrypt() {
    try { return !!(this.safeStorage?.isEncryptionAvailable?.() && this.safeStorage.encryptString && this.safeStorage.decryptString); } catch { return false; }
  }

  _read() {
    if (this.mode !== 'encrypted' || !this.storePath || !this.fs.existsSync(this.storePath)) return null;
    try {
      const envelope = JSON.parse(this.fs.readFileSync(this.storePath, 'utf8'));
      if (envelope.version !== STORE_VERSION || envelope.cipher !== 'electron-safeStorage' || !envelope.payload) throw new Error('invalid envelope');
      const decoded = JSON.parse(this.safeStorage.decryptString(Buffer.from(String(envelope.payload), 'base64')));
      if (!Array.isArray(decoded)) throw new Error('invalid store');
      return decoded;
    } catch {
      this.corrupt = true;
      this.error = 'REMOTE_CI_STORE_CORRUPT';
      return null;
    }
  }

  load() {
    const rows = this._read();
    if (!rows) return;
    const loaded = new Map();
    try {
      for (const raw of rows) {
        const item = normalizeRemoteCiSnapshot(raw);
        if (loaded.has(item.remoteCiRef)) throw new Error('duplicate ref');
        loaded.set(item.remoteCiRef, item);
      }
    } catch {
      this.corrupt = true;
      this.error = 'REMOTE_CI_STORE_CORRUPT';
      return;
    }
    this.snapshots = loaded;
    this._prune();
  }

  _write() {
    if (this.mode !== 'encrypted' || !this.storePath || this.corrupt) return this.mode === 'memory';
    let temp = '';
    try {
      const payload = this.safeStorage.encryptString(JSON.stringify([...this.snapshots.values()]));
      this.fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      temp = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
      this.fs.writeFileSync(temp, JSON.stringify({ version: STORE_VERSION, cipher: 'electron-safeStorage', payload: Buffer.from(payload).toString('base64') }), 'utf8');
      const verify = JSON.parse(this.fs.readFileSync(temp, 'utf8'));
      const decoded = JSON.parse(this.safeStorage.decryptString(Buffer.from(String(verify.payload), 'base64')));
      if (!Array.isArray(decoded)) throw new Error('write verification failed');
      decoded.forEach((item) => normalizeRemoteCiSnapshot(item));
      this.fs.renameSync(temp, this.storePath);
      this.lastWriteOk = true;
      return true;
    } catch {
      this.error = 'REMOTE_CI_STORE_UNAVAILABLE';
      this.mode = 'memory';
      this.lastWriteOk = false;
      if (temp) { try { this.fs.unlinkSync(temp); } catch {} }
      return false;
    }
  }

  _protected(item) {
    try { return this.isProtected(item.remoteCiRef, item) === true; } catch { return true; }
  }

  _removeOldest(list, count) {
    const candidates = list.filter((item) => !this._protected(item))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const item of candidates.slice(0, Math.max(0, count))) this.snapshots.delete(item.remoteCiRef);
  }

  _prune() {
    const byProject = new Map();
    for (const item of this.snapshots.values()) {
      const rows = byProject.get(item.projectKey) || [];
      rows.push(item);
      byProject.set(item.projectKey, rows);
    }
    for (const rows of byProject.values()) {
      if (rows.length > MAX_PROJECT_SNAPSHOTS) this._removeOldest(rows, rows.length - MAX_PROJECT_SNAPSHOTS);
    }
    if (this.snapshots.size > MAX_SNAPSHOTS) {
      this._removeOldest([...this.snapshots.values()], this.snapshots.size - MAX_SNAPSHOTS);
    }
  }

  put(raw) {
    if (this.corrupt) {
      const error = new Error('remote CI store is corrupt');
      error.code = 'REMOTE_CI_STORE_CORRUPT';
      throw error;
    }
    const item = normalizeRemoteCiSnapshot(raw);
    const current = this.snapshots.get(item.remoteCiRef);
    if (current && JSON.stringify(current) !== JSON.stringify(item)) {
      const error = new Error('remote CI snapshot is immutable');
      error.code = 'REMOTE_CI_INVALID';
      throw error;
    }
    this.snapshots.set(item.remoteCiRef, item);
    this._prune();
    this.lastWriteOk = this._write();
    return item;
  }

  get(remoteCiRef, projectKey) {
    const item = this.snapshots.get(String(remoteCiRef || ''));
    return item && (!projectKey || item.projectKey === String(projectKey)) ? item : null;
  }

  findDuplicate(snapshot) {
    const key = remoteCiDedupeKey(snapshot);
    return [...this.snapshots.values()].find((item) => remoteCiDedupeKey(item) === key) || null;
  }

  list(projectKey, limit) {
    const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(MAX_SNAPSHOTS, Math.floor(Number(limit)))) : MAX_SNAPSHOTS;
    return [...this.snapshots.values()]
      .filter((item) => !projectKey || item.projectKey === String(projectKey))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, max);
  }

  listPublic(projectKey, limit) {
    return this.list(projectKey, limit).map((item) => publicRemoteCiSummary(item)).filter(Boolean);
  }

  persistenceStatus() {
    return {
      persistence: this.mode,
      error: this.error,
      durable: this.mode === 'encrypted' && this.lastWriteOk,
      ...(this.corrupt ? { corrupt: true } : {}),
    };
  }

  close() { this._write(); }
}

function createRemoteCiStore(options) { return new RemoteCiStore(options); }

module.exports = {
  RemoteCiStore,
  createRemoteCiStore,
  STORE_VERSION,
  MAX_PROJECT_SNAPSHOTS,
  MAX_SNAPSHOTS,
};
