'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeRepair,
  publicRepairSummary,
  ACTIVE_REPAIR_STATES,
  TERMINAL_REPAIR_STATES,
} = require('./repair-state');

const STORE_VERSION = 1;
const MAX_PROJECT_REPAIRS = 50;
const MAX_REPAIRS = 200;

class RepairStore {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.safeStorage = options.safeStorage;
    this.repairPath = options.repairPath || (options.userDataPath ? path.join(options.userDataPath, 'engineering-repairs.json') : '');
    // Encryption without a destination is not durable storage. Treat that
    // configuration as memory-only instead of reporting a misleading
    // encrypted-but-unwritable store.
    this.mode = this.canEncrypt() && this.repairPath ? 'encrypted' : 'memory';
    this.error = null;
    this.corrupt = false;
    this.lastWriteOk = this.mode !== 'encrypted';
    this.repairs = new Map();
    this.load();
  }

  canEncrypt() {
    try { return !!(this.safeStorage?.isEncryptionAvailable?.() && this.safeStorage.encryptString && this.safeStorage.decryptString); } catch { return false; }
  }

  _read() {
    if (this.mode !== 'encrypted' || !this.repairPath || !this.fs.existsSync(this.repairPath)) return null;
    try {
      const envelope = JSON.parse(this.fs.readFileSync(this.repairPath, 'utf8'));
      if (envelope.version !== STORE_VERSION || envelope.cipher !== 'electron-safeStorage' || !envelope.payload) throw new Error('invalid envelope');
      const parsed = JSON.parse(this.safeStorage.decryptString(Buffer.from(String(envelope.payload), 'base64')));
      if (!Array.isArray(parsed)) throw new Error('invalid repair store');
      return parsed;
    } catch {
      this.corrupt = true;
      this.error = 'REPAIR_STORE_CORRUPT';
      return null;
    }
  }

  load() {
    const rows = this._read();
    if (!rows) return;
    const loaded = new Map();
    try {
      for (const raw of rows) {
        const item = normalizeRepair(raw);
        if (loaded.has(item.repairRef)) throw new Error('duplicate repair ref');
        loaded.set(item.repairRef, item);
      }
    } catch {
      this.corrupt = true;
      this.error = 'REPAIR_STORE_CORRUPT';
      return;
    }
    this.repairs = loaded;
    this._prune();
  }

  _write() {
    if (this.mode !== 'encrypted' || !this.repairPath || this.corrupt) return this.mode === 'memory';
    let temp = '';
    try {
      const payload = this.safeStorage.encryptString(JSON.stringify([...this.repairs.values()]));
      this.fs.mkdirSync(path.dirname(this.repairPath), { recursive: true });
      temp = `${this.repairPath}.${process.pid}.${Date.now()}.tmp`;
      this.fs.writeFileSync(temp, JSON.stringify({ version: STORE_VERSION, cipher: 'electron-safeStorage', payload: Buffer.from(payload).toString('base64') }), 'utf8');
      // Read back the temporary envelope before replacing the authoritative file.
      const verify = JSON.parse(this.fs.readFileSync(temp, 'utf8'));
      const decoded = JSON.parse(this.safeStorage.decryptString(Buffer.from(String(verify.payload), 'base64')));
      if (!Array.isArray(decoded)) throw new Error('write verification failed');
      decoded.forEach((item) => normalizeRepair(item));
      this.fs.renameSync(temp, this.repairPath);
      this.lastWriteOk = true;
      return true;
    } catch {
      this.error = 'REPAIR_STORE_UNAVAILABLE';
      // Continue explicitly in memory-only mode. This keeps the current
      // process authoritative without ever falling back to plaintext.
      this.mode = 'memory';
      this.lastWriteOk = false;
      if (temp) { try { this.fs.unlinkSync(temp); } catch {} }
      return false;
    }
  }

  _prune() {
    const byProject = new Map();
    for (const item of this.repairs.values()) {
      const list = byProject.get(item.projectKey) || [];
      list.push(item); byProject.set(item.projectKey, list);
    }
    const removeOldest = (list, count) => {
      const candidates = list.filter((item) => TERMINAL_REPAIR_STATES.has(item.status) && !item.resultId)
        .sort((a, b) => String(a.finishedAt || a.createdAt).localeCompare(String(b.finishedAt || b.createdAt)));
      for (const item of candidates.slice(0, Math.max(0, count))) this.repairs.delete(item.repairRef);
    };
    for (const list of byProject.values()) if (list.length > MAX_PROJECT_REPAIRS) removeOldest(list, list.length - MAX_PROJECT_REPAIRS);
    if (this.repairs.size > MAX_REPAIRS) removeOldest([...this.repairs.values()], this.repairs.size - MAX_REPAIRS);
  }

  put(raw) {
    const item = normalizeRepair(raw);
    if (this.corrupt) {
      const error = new Error('repair store is corrupt');
      error.code = 'REPAIR_STORE_CORRUPT';
      throw error;
    }
    this.repairs.set(item.repairRef, item);
    this._prune();
    this.lastWriteOk = this._write();
    return item;
  }
  save(raw) { return this.put(raw); }
  update(raw) { return this.put(raw); }
  delete(repairRef) { const removed = this.repairs.delete(String(repairRef || '')); if (removed) this._write(); return removed; }
  get(repairRef, projectKey) {
    const item = this.repairs.get(String(repairRef || ''));
    return item && (!projectKey || item.projectKey === String(projectKey)) ? item : null;
  }
  list(projectKey, limit) {
    if (projectKey && typeof projectKey === 'object') { limit = projectKey.limit; projectKey = projectKey.projectKey; }
    const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(MAX_REPAIRS, Math.floor(Number(limit)))) : MAX_REPAIRS;
    return [...this.repairs.values()]
      .filter((item) => !projectKey || item.projectKey === String(projectKey))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, max);
  }
  listPublic(projectKey, limit) { return this.list(projectKey, limit).map(publicRepairSummary).filter(Boolean); }
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

function createRepairStore(options) { return new RepairStore(options); }

module.exports = {
  RepairStore,
  createRepairStore,
  STORE_VERSION,
  MAX_PROJECT_REPAIRS,
  MAX_REPAIRS,
};
