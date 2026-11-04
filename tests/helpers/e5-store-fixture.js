'use strict';

// This is a unit-only bounded crypto/managed-IO fixture. It is deliberately not
// evidence of Electron safeStorage, DPAPI, or native ancestor pinning.
const fs = require('node:fs/promises');
const fss = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PACKAGE_MAX = 4 * 1024 * 1024;
const scopes = new WeakMap();
const files = new WeakMap();
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fail(code) { const e = new Error(code); e.code = code; return e; }
function check(signal) { if (signal?.aborted) throw fail('ATTACHMENT_CANCELLED'); }
function identity(info) {
  return { dev: String(info.dev), ino: String(info.ino), size: Number(info.size), birthtimeMs: Number(info.birthtimeMs) };
}
function same(a, b) { return !a || (a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs); }
function unitSafeStorage({ available = true, backend = 'unit-fixture', key = crypto.randomBytes(32), hooks = {}, bounds = {} } = {}) {
  const header = Buffer.from('E5unit1:');
  const adapter = {
    isEncryptionAvailable() { if (hooks.available) return hooks.available(); return available; },
    getSelectedStorageBackend() { return backend; },
    attachmentBounds: Object.freeze({
      kind: 'unit-fixture', verified: true, backend: 'electron-safeStorage', evidence: 'UNIT FIXTURE ONLY; AES-GCM output is input + 36 bytes, no OS claim',
      encryptMaxBytes: bounds.encryptMaxBytes || ((n) => n + 65536),
      decryptMaxBytes: bounds.decryptMaxBytes || ((n) => n),
      decryptMaxCodeUnits: bounds.decryptMaxCodeUnits || ((n) => n),
    }),
    encryptString(text) {
      if (hooks.encrypt) return hooks.encrypt(text, encrypt);
      return encrypt(text);
    },
    decryptString(bytes) {
      if (hooks.decrypt) return hooks.decrypt(bytes, decrypt);
      return decrypt(bytes);
    },
  };
  function encrypt(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([header, iv, cipher.getAuthTag(), encrypted]);
  }
  function decrypt(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 36 || !bytes.subarray(0, 8).equals(header)) throw fail('UNIT_KEY_INVALID');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(8, 20));
    decipher.setAuthTag(bytes.subarray(20, 36));
    return Buffer.concat([decipher.update(bytes.subarray(36)), decipher.final()]).toString('utf8');
  }
  return adapter;
}
function envelope(safeStorage, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const encrypted = safeStorage.encryptString(text);
  if (encrypted?.then) throw new Error('Fixture envelope requires synchronous crypto');
  return Buffer.from(JSON.stringify({ formatVersion: 1, cipher: 'electron-safeStorage', payload: encrypted.toString('base64') }), 'utf8');
}
function unpack(safeStorage, bytes) {
  return JSON.parse(safeStorage.decryptString(Buffer.from(JSON.parse(bytes.toString('utf8')).payload, 'base64')));
}
function capture(text = 'hello\n', extras = {}) {
  const rawBytes = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  return { name: 'note.txt', mimeType: 'text/plain', sourceKind: 'user_upload', rawBytes, rawDigest: digest(rawBytes), decodeVersion: 1, extractVersion: 1, extractedChars: [...rawBytes.toString('utf8')].length, ...extras };
}
async function createStoreFixture({ hooks = {}, safeStorage = unitSafeStorage() } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'e5-store-unit-'));
  const cacheRoot = path.join(root, 'attachments-v1');
  const events = [];
  const reader = {
    async createManagedScope(suppliedRoot, { signal } = {}) {
      check(signal);
      if (path.resolve(suppliedRoot) !== cacheRoot) throw fail('ATTACHMENT_READ_DENIED');
      const scope = Object.freeze({}); scopes.set(scope, { root: cacheRoot });
      events.push({ op: 'scope' }); return scope;
    },
    createManagedFile(scope, { kind, locator, expectedIdentity } = {}) {
      const s = scopes.get(scope); if (!s) throw fail('ATTACHMENT_READ_DENIED');
      const relative = kind === 'manifest' ? 'manifest.enc.json' : `blobs/${locator || `${crypto.randomBytes(16).toString('hex')}.enc.json`}`;
      if (!/^(?:manifest\.enc\.json|blobs\/(?:[a-f0-9]{32}|\.stage-[a-f0-9]{32})\.enc\.json)$/.test(relative)) throw fail('ATTACHMENT_READ_DENIED');
      const file = Object.freeze({}); files.set(file, { scope, relative, expectedIdentity }); return file;
    },
    managedLocator(file) { const f = files.get(file); if (!f) throw fail('ATTACHMENT_READ_DENIED'); return path.posix.basename(f.relative); },
    async readManaged(file, { signal, work } = {}) {
      const f = files.get(file), s = f && scopes.get(f.scope); if (!s) throw fail('ATTACHMENT_READ_DENIED');
      check(signal); if (hooks.read) await hooks.read({ file, locator: f.relative, events, signal }); check(signal);
      const absolute = path.join(s.root, ...f.relative.split('/'));
      let handle, reservation, outputReservation;
      try {
        handle = await fs.open(absolute, 'r');
        const before = await handle.stat();
        if (!before.isFile() || before.nlink > 1 || !same(f.expectedIdentity, identity(before))) throw fail('ATTACHMENT_READ_DENIED');
        reservation = work?.reserve(PACKAGE_MAX + 1);
        let buffer = Buffer.alloc(PACKAGE_MAX + 1), offset = 0;
        while (offset < buffer.length) {
          check(signal);
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break; offset += bytesRead;
        }
        const after = await handle.stat();
        if (!same(identity(before), identity(after)) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw fail('ATTACHMENT_SOURCE_CHANGED');
        if (offset > PACKAGE_MAX) { events.push({ op: 'oversize-read', locator: f.relative, bytes: offset, maxRead: PACKAGE_MAX + 1 }); throw fail('ATTACHMENT_CORRUPT'); }
        outputReservation = work?.reserve(offset);
        const bytes = Buffer.alloc(offset); buffer.copy(bytes, 0, 0, offset); buffer = null;
        events.push({ op: 'read', locator: f.relative, bytes: offset, maxRead: PACKAGE_MAX + 1 });
        await handle.close(); handle = null; reservation?.release(); reservation = null;
        let released = false;
        return { bytes, identity: identity(before), release() { if (!released) { released = true; outputReservation?.release(); outputReservation = null; } } };
      } finally { if (handle) await handle.close(); reservation?.release(); if (handle) outputReservation?.release(); }
    },
    async atomicWriteManaged(file, bytes, { verify, beforeCommit, signal, work } = {}) {
      const f = files.get(file), s = f && scopes.get(f.scope); if (!s) throw fail('ATTACHMENT_READ_DENIED');
      if (!Buffer.isBuffer(bytes) || bytes.length > PACKAGE_MAX) throw fail('ATTACHMENT_CORRUPT');
      check(signal);
      if (hooks.write) await hooks.write({ file, locator: f.relative, bytes, events, signal }); check(signal);
      await fs.mkdir(path.join(s.root, 'blobs'), { recursive: true });
      const absolute = path.join(s.root, ...f.relative.split('/'));
      const temporary = path.join(s.root, 'blobs', `.stage-${crypto.randomBytes(16).toString('hex')}.enc.json`);
      let committed = false;
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx' });
        events.push({ op: 'temp', locator: path.basename(temporary), bytes: bytes.length, encrypted: Buffer.from(bytes) });
        if (hooks.temp) await hooks.temp({ file, locator: f.relative, bytes, events, signal }); check(signal);
        const tempHandle = await fs.open(temporary, 'r');
        const hold = work?.reserve(bytes.length + 1);
        let tempBytes;
        try {
          tempBytes = Buffer.alloc(bytes.length + 1);
          const { bytesRead } = await tempHandle.read(tempBytes, 0, bytes.length + 1, 0);
          if (bytesRead !== bytes.length) throw fail('ATTACHMENT_CORRUPT');
          const exact = Buffer.alloc(bytes.length); tempBytes.copy(exact, 0, 0, bytesRead); tempBytes = null;
          const exactHold = work?.reserve(exact.length);
          try { await verify?.({ bytes: exact, identity: identity(await tempHandle.stat()) }); }
          finally { exactHold?.release(); }
        } finally { await tempHandle.close(); hold?.release(); }
        if (hooks.verify) await hooks.verify({ file, locator: f.relative, events, signal }); check(signal);
        if (f.expectedIdentity) {
          const target = await fs.open(absolute, 'r');
          try { if (!same(f.expectedIdentity, identity(await target.stat()))) throw fail('ATTACHMENT_SOURCE_CHANGED'); } finally { await target.close(); }
        } else if (fss.existsSync(absolute)) throw fail('ATTACHMENT_SOURCE_CHANGED');
        if (hooks.rename) await hooks.rename({ file, locator: f.relative, events, signal }); check(signal);
        if (beforeCommit) { if (await beforeCommit() === false) throw fail('ABORTED'); check(signal); }
        await fs.rename(temporary, absolute); committed = true;
        const handle = await fs.open(absolute, 'r');
        try { f.expectedIdentity = identity(await handle.stat()); }
        finally { await handle.close(); }
        events.push({ op: 'commit', locator: f.relative, bytes: bytes.length });
        return f.expectedIdentity;
      } finally {
        if (!committed) { await fs.unlink(temporary).catch((e) => { if (e.code !== 'ENOENT') throw e; }); events.push({ op: 'cleanup-temp', locator: path.basename(temporary) }); }
      }
    },
    async deleteManaged(file, { signal } = {}) {
      const f = files.get(file), s = f && scopes.get(f.scope); if (!s) throw fail('ATTACHMENT_READ_DENIED');
      check(signal); if (hooks.delete) await hooks.delete({ file, locator: f.relative, events, signal }); check(signal);
      const absolute = path.join(s.root, ...f.relative.split('/'));
      let handle;
      try {
        handle = await fs.open(absolute, 'r');
        if (!same(f.expectedIdentity, identity(await handle.stat()))) throw fail('ATTACHMENT_SOURCE_CHANGED');
      } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
      finally { if (handle) await handle.close(); }
      await fs.unlink(absolute); events.push({ op: 'delete', locator: f.relative }); return true;
    },
    async listManaged(scope, { maxEntries = 1025, signal, work } = {}) {
      const s = scopes.get(scope); if (!s) throw fail('ATTACHMENT_READ_DENIED'); check(signal);
      const result = [];
      const names = [];
      for (const [base, prefix] of [[s.root, ''], [path.join(s.root, 'blobs'), 'blobs/']]) {
        let entries;
        try { entries = await fs.readdir(base, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const locator = `${prefix}${entry.name}`;
          if (!/^(?:manifest\.enc\.json|blobs\/(?:[a-f0-9]{32}|\.stage-[a-f0-9]{32})\.enc\.json)$/.test(locator)) continue;
          names.push(locator); if (names.length > maxEntries) throw fail('ATTACHMENT_CACHE_LIMIT');
        }
      }
      for (const locator of names) {
        const kind = locator === 'manifest.enc.json' ? 'manifest' : path.posix.basename(locator).startsWith('.stage-') ? 'temporary' : 'blob';
        const file = reader.createManagedFile(scope, { kind, locator: path.posix.basename(locator) });
        const value = await reader.readManaged(file, { signal, work });
        try { result.push({ kind, locator: path.posix.basename(locator), identity: value.identity, size: value.bytes.length }); }
        finally { await value.release?.(); }
      }
      events.push({ op: 'list', count: result.length }); return result;
    },
  };
  async function cleanup() {
    const target = path.resolve(root);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('e5-store-unit-')) throw new Error('Unsafe fixture cleanup path');
    await fs.rm(target, { recursive: true, force: true });
  }
  return { root, cacheRoot, reader, safeStorage, hooks, events, cleanup,
    async diskFiles() { const result = []; for (const base of [cacheRoot, path.join(cacheRoot, 'blobs')]) { let names; try { names = await fs.readdir(base); } catch (e) { if (e.code === 'ENOENT') continue; throw e; } for (const name of names) { const full = path.join(base, name); if ((await fs.lstat(full)).isFile()) result.push({ path: full, bytes: await fs.readFile(full) }); } } return result; },
    async writePackage(locator, bytes) { const target = path.join(cacheRoot, ...locator.split('/')); if (!/^(?:manifest\.enc\.json|blobs\/(?:[a-f0-9]{32}|\.stage-[a-f0-9]{32})\.enc\.json)$/.test(locator)) throw new Error('Unsafe fixture package path'); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); },
  };
}

module.exports = { createStoreFixture, unitSafeStorage, deferred, envelope, unpack, capture, digest, PACKAGE_MAX };
