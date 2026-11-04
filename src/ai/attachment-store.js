'use strict';

// This module owns only controlled copies. All filesystem access is through the
// main-only, branded managed-package reader. There is intentionally no fs/path
// fallback and no SecretManager/machine-key/plaintext persistence fallback.
const crypto = require('node:crypto');
const {
  LIMITS, attachmentError, sanitizeName, publicAttachmentRef, assertFields,
  checkedInteger, canonicalBase64Length, parseBoundedJson, createAttachmentBudget,
} = require('./attachment-contract');

const VERSION = 1;
const NS = /^ans_[a-f0-9]{32}$/;
const ID = /^att_[a-f0-9]{32}$/;
const BLOB = /^blob_[a-f0-9]{32}$/;
const LOCATOR = /^[a-f0-9]{32}\.enc\.json$/;
const TEMP = /^\.stage-[a-f0-9]{32}\.enc\.json$/;
const HASH = /^[a-f0-9]{64}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ENVELOPE_FIELDS = ['formatVersion', 'cipher', 'payload'];
const BLOB_FIELDS = ['formatVersion', 'profileNamespace', 'blobId', 'rawDigest', 'rawByteLength', 'decodeVersion', 'extractVersion', 'rawBytesBase64'];
const MANIFEST_FIELDS = ['formatVersion', 'profileNamespace', 'namespaces', 'blobs', 'records'];
const NAMESPACE_FIELDS = ['namespaceRef', 'sessionId', 'createdAt', 'lastAccessAt', 'draftRevision', 'messageRevision'];
const BLOB_META_FIELDS = ['blobId', 'locator', 'rawDigest', 'rawByteLength', 'decodeVersion', 'extractVersion', 'packageBytes'];
const CAPTURE_FIELDS = ['name', 'mimeType', 'sourceKind', 'rawBytes', 'rawDigest', 'decodeVersion', 'extractVersion', 'extractedChars', 'selectedChars', 'sourceInfo', 'selectedAt'];
const ROW_FIELDS = ['recordVersion', 'attachmentId', 'profileNamespace', 'logicalSessionId', 'sessionNamespaceRef', 'blobKey', 'name', 'mimeType', 'sourceKind', 'rawDigest', 'rawByteLength', 'decodeVersion', 'extractVersion', 'extractedChars', 'selectedChars', 'sourceInfo', 'selectedAt', 'createdAt', 'lastAccessAt', 'expiresAt', 'refGeneration', 'draftLinked', 'messageLinked', 'status', 'storageMode'];
const nativeAdapters = new WeakMap();
const sharedBudget = createAttachmentBudget();
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const random = (prefix) => `${prefix}${crypto.randomBytes(16).toString('hex')}`;
const error = (code) => attachmentError(code);
const integer = (n, max = Number.MAX_SAFE_INTEGER, code = 'ATTACHMENT_CORRUPT') => checkedInteger(n, { min: 0, max, code });
const abort = (signal) => { if (signal?.aborted) throw error('ABORTED'); };
const release = (handle) => { handle?.release(); };
const clone = (value) => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  const result = {}; for (const [key, item] of Object.entries(value)) result[key] = clone(item); return result;
};
function sameData(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a); if (keys.length !== Object.keys(b).length) return false;
  return keys.every(key => Object.hasOwn(b, key) && sameData(a[key], b[key]));
}

/**
 * Only the actual Electron 33.2.1 Win32 safeStorage singleton is admitted. A
 * supplied fake, basic_text backend, unknown Electron implementation, or an API
 * whose output bound cannot be established is memory-only. The Windows backend
 * uses DPAPI (no compression); decrypt output bytes <= input ciphertext bytes,
 * UTF-16 storage <= 2*cipher bytes. The supported encrypt envelope reserves an
 * additional 64 KiB and is also hard-checked against the package cipher limit.
 * These are implementation admission bounds, not a claim that this module's
 * Node tests establish OS key availability or near-limit Electron behavior.
 */
function createElectronSafeStorageAdapter(raw, { platform = process.platform, electronVersion = process.versions.electron } = {}) {
  let singleton;
  try { singleton = require('electron').safeStorage; } catch { /* not Electron */ }
  let available = false;
  try {
    available = platform === 'win32' && process.platform === 'win32' &&
      electronVersion === '33.2.1' && process.versions.electron === '33.2.1' &&
      !!raw && raw === singleton && typeof raw.encryptString === 'function' &&
      typeof raw.decryptString === 'function' && raw.isEncryptionAvailable() === true;
  } catch { available = false; }
  const adapter = Object.freeze({
    isEncryptionAvailable() {
      if (!available) return false;
      try { return raw.isEncryptionAvailable() === true; } catch { return false; }
    },
    getSelectedStorageBackend() { return available ? 'windows-dpapi' : 'unknown'; },
    encryptString(text) { if (!available) throw error('ATTACHMENT_STORAGE_UNAVAILABLE'); return raw.encryptString(text); },
    decryptString(bytes) { if (!available) throw error('ATTACHMENT_STORAGE_UNAVAILABLE'); return raw.decryptString(bytes); },
    attachmentBounds: available ? Object.freeze({
      verified: true, kind: 'electron-win32-dpapi', backend: 'electron-safeStorage',
      evidence: 'Electron 33.2.1 actual Win32 singleton; DPAPI no-compression byte bound; OS near-limit verification is separate',
      encryptMaxBytes: (plainBytes) => integer(plainBytes, LIMITS.MAX_ATTACHMENT_WORK_BYTES) + 65536,
      decryptMaxBytes: (cipherBytes) => integer(cipherBytes, LIMITS.MAX_BLOB_CIPHER_BYTES),
      decryptMaxCodeUnits: (cipherBytes) => integer(cipherBytes, LIMITS.MAX_BLOB_CIPHER_BYTES),
    }) : undefined,
  });
  if (available) nativeAdapters.set(adapter, adapter.attachmentBounds);
  return adapter;
}

function safeBounds(safeStorage) {
  try {
    if (!safeStorage || safeStorage.isEncryptionAvailable() !== true ||
        typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') return null;
    const backend = safeStorage.getSelectedStorageBackend?.();
    if (backend === 'basic_text' || backend === 'plaintext' || backend === 'unknown') return null;
    const bounds = nativeAdapters.get(safeStorage) || safeStorage.attachmentBounds;
    const fixture = !!process.env.NODE_TEST_CONTEXT && bounds?.kind === 'unit-fixture';
    if ((!nativeAdapters.has(safeStorage) && !fixture) || bounds?.verified !== true ||
        bounds.backend !== 'electron-safeStorage' || typeof bounds.evidence !== 'string' ||
        typeof bounds.encryptMaxBytes !== 'function' || typeof bounds.decryptMaxBytes !== 'function' ||
        typeof bounds.decryptMaxCodeUnits !== 'function') return null;
    // Admission itself must establish finite bounds, before opening a package.
    integer(bounds.encryptMaxBytes(LIMITS.MAX_BLOB_PLAIN_BYTES), LIMITS.MAX_ATTACHMENT_WORK_BYTES);
    integer(bounds.decryptMaxBytes(LIMITS.MAX_BLOB_CIPHER_BYTES), LIMITS.MAX_ATTACHMENT_WORK_BYTES);
    integer(bounds.decryptMaxCodeUnits(LIMITS.MAX_BLOB_CIPHER_BYTES), LIMITS.MAX_ATTACHMENT_WORK_BYTES / 2);
    return bounds;
  } catch { return null; }
}

function text(value, max = 128) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw error('ATTACHMENT_CORRUPT');
  return value;
}
function opaque(value) { if (typeof value !== 'string' || !OPAQUE.test(value)) throw error('ATTACHMENT_REFERENCE_INVALID'); return value; }
function version(value) { if (value !== VERSION) throw error('ATTACHMENT_CORRUPT'); return value; }
function digest(value) { if (typeof value !== 'string' || !HASH.test(value)) throw error('ATTACHMENT_CORRUPT'); return value; }
function id(value, regex) { if (typeof value !== 'string' || !regex.test(value)) throw error('ATTACHMENT_CORRUPT'); return value; }
function boolean(value) { if (typeof value !== 'boolean') throw error('ATTACHMENT_CORRUPT'); return value; }

// Conservative JSON-string/AST allocation bounds, scanned without an AST or
// substring allocations. The contract performs the structural scan before
// JSON.parse. Keys, strings, scalar tokens, arrays and objects are all counted
// here for allocation accounting (keys are not contract value-nodes).
function jsonFootprint(input) {
  let nodes = 0, quoted = false, escape = false, token = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { nodes++; quoted = true; token = false; }
    else if (c === '{' || c === '[') { nodes++; token = false; }
    else if (c === '}' || c === ']' || c === ',' || c === ':' || /\s/.test(c)) token = false;
    else if (!token) { nodes++; token = true; }
    if (nodes > LIMITS.MAX_PACKAGE_JSON_NODES * 2 + 1) throw error('ATTACHMENT_CORRUPT');
  }
  return input.length * 2 + nodes * 64 + 128;
}
function parseWork(input, maxBytes, work) {
  const hold = work.reserve(jsonFootprint(input));
  try {
    return { value: parseBoundedJson(input, { maxBytes, maxDepth: LIMITS.MAX_PACKAGE_JSON_DEPTH, maxNodes: LIMITS.MAX_PACKAGE_JSON_NODES }), release: () => hold.release() };
  } catch (e) { hold.release(); throw e; }
}
// All caller-controlled metadata has already been structurally bounded. Six
// bytes per UTF-16 code unit bounds JSON escaping and UTF-8 encoding.
function jsonUpper(value) {
  if (typeof value === 'string') return value.length * 6 + 2;
  if (value === null) return 4;
  if (typeof value === 'number') return 32;
  if (typeof value === 'boolean') return 5;
  if (Array.isArray(value)) return 2 + value.reduce((sum, item) => sum + jsonUpper(item) + 1, 0);
  return 2 + Object.entries(value).reduce((sum, [key, item]) => sum + jsonUpper(key) + jsonUpper(item) + 2, 0);
}
function metadataBytes(value) { return jsonUpper(value) * 2 + 512; }

function cleanIdentity(value) {
  if (typeof value === 'string') {
    if (value.length > 128 || !/^\d+:\d+$/.test(value)) throw error('ATTACHMENT_CORRUPT');
    return value;
  }
  assertFields(value, ['dev', 'ino', 'deviceId', 'fileId', 'volumeSerial', 'size', 'nlink', 'mode', 'type', 'isFile', 'isDirectory', 'mtimeMs', 'ctimeMs', 'birthtimeMs', 'lastWriteTime', 'birthTime', 'attributes', 'reparseTag']);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[key] = text(item, 128);
    else if (typeof item === 'boolean') result[key] = item;
    else result[key] = integer(item);
  }
  return result;
}
function cleanSourceInfo(value, sourceKind) {
  if (value == null) return null;
  if (sourceKind === 'user_upload') {
    assertFields(value, ['sourceIdentity', 'selectedAt']);
    return { ...(value.sourceIdentity ? { sourceIdentity: cleanIdentity(value.sourceIdentity) } : {}), ...(value.selectedAt !== undefined ? { selectedAt: integer(value.selectedAt) } : {}) };
  }
  assertFields(value, ['projectId', 'relativePath', 'range', 'rootIdentity', 'sourceIdentity', 'ancestorIdentities', 'grantGeneration']);
  const result = {};
  if (value.projectId !== undefined) result.projectId = opaque(value.projectId);
  const relativePath = text(value.relativePath, 4096);
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\\') || relativePath.includes(':') || relativePath.split('/').some(p => !p || p === '.' || p === '..')) throw error('ATTACHMENT_CORRUPT');
  result.relativePath = relativePath;
  if (value.range != null) {
    assertFields(value.range, ['startLine', 'endLine']);
    const startLine = integer(value.range.startLine, Number.MAX_SAFE_INTEGER);
    const endLine = integer(value.range.endLine, Number.MAX_SAFE_INTEGER);
    if (startLine < 1 || endLine < startLine) throw error('ATTACHMENT_CORRUPT');
    result.range = { startLine, endLine };
  }
  for (const key of ['rootIdentity', 'sourceIdentity']) if (value[key] !== undefined) result[key] = cleanIdentity(value[key]);
  if (value.ancestorIdentities !== undefined) {
    if (!Array.isArray(value.ancestorIdentities) || value.ancestorIdentities.length > 32) throw error('ATTACHMENT_CORRUPT');
    result.ancestorIdentities = value.ancestorIdentities.map(cleanIdentity);
  }
  if (value.grantGeneration !== undefined) result.grantGeneration = integer(value.grantGeneration);
  return result;
}

function createAttachmentStore({ cacheRoot, profileNamespace, safeStorage, reader, budget = sharedBudget, now = Date.now } = {}) {
  opaque(profileNamespace);
  if (typeof now !== 'function' || !budget || typeof budget.withWork !== 'function' || typeof budget.reserveRetained !== 'function') throw error('ATTACHMENT_STORAGE_UNAVAILABLE');
  let bounds = safeBounds(safeStorage);
  let mode = bounds ? 'encrypted' : 'memory';
  let initialized = false, closed = false, closing = null, scope = null;
  let manifestFile = null, manifestIdentity = null, manifestBytes = 0, manifestTrusted = false;
  let diskBytes = 0, diskReserved = 0, dirty = false, epoch = 0;
  let unavailableReason = bounds ? null : 'ATTACHMENT_STORAGE_UNAVAILABLE';
  let retryableFailures = 0, clearRequested = false;
  const namespaces = new Map(), records = new Map(), blobs = new Map(), dedupe = new Map();
  const inventory = new Map(), protectedPackages = new Set(), operations = new Set(), leases = new Set(), readHandles = new Set();
  const lifecycle = new AbortController();
  const clock = () => integer(Math.floor(now()), Number.MAX_SAFE_INTEGER, 'ATTACHMENT_STORAGE_UNAVAILABLE');
  const assertOpen = (signal) => { if (closed) throw error('ABORTED'); abort(signal); };
  const checkReady = () => { assertOpen(); if (!initialized) throw error('ATTACHMENT_STORAGE_UNAVAILABLE'); };
  const key = (rawDigest, decodeVersion, extractVersion) => `${rawDigest}:${decodeVersion}:${extractVersion}`;
  function namespaceRef(locator) { const ref = typeof locator === 'string' ? locator : locator?.namespaceRef; if (typeof ref !== 'string' || !NS.test(ref)) throw error('ATTACHMENT_REFERENCE_INVALID'); return ref; }
  function namespaceFor(locator, sessionId) {
    checkReady();
    const ns = namespaces.get(namespaceRef(locator));
    if (!ns || (sessionId !== undefined && ns.sessionId !== sessionId) || (typeof locator === 'object' && locator.sessionId !== undefined && locator.sessionId !== ns.sessionId)) throw error('ATTACHMENT_REFERENCE_INVALID');
    return ns;
  }
  function nsSnapshot(ns) { return Object.freeze({ namespaceRef: ns.namespaceRef, sessionId: ns.sessionId, storageMode: mode === 'encrypted' && ns.durable ? 'encrypted' : 'memory' }); }
  function rowSnapshot(row) { const result = {}; for (const field of ROW_FIELDS) result[field] = row[field]; return clone(result); }
  function authoritative(idValue, locator, { ready = false } = {}) {
    const ns = namespaceFor(locator), row = records.get(idValue);
    if (typeof idValue !== 'string' || !ID.test(idValue) || !row || row.sessionNamespaceRef !== ns.namespaceRef || row.logicalSessionId !== ns.sessionId || (ready && row.status !== 'ready')) throw error('ATTACHMENT_REFERENCE_INVALID');
    return row;
  }
  function track(promise) {
    operations.add(promise);
    promise.then(() => operations.delete(promise), () => operations.delete(promise));
    return promise;
  }
  function withWork(options, fn) {
    assertOpen(options?.signal);
    const signal = options?.signal ? AbortSignal.any([options.signal, lifecycle.signal]) : lifecycle.signal;
    return track(budget.withWork({ signal, work: options?.work }, (work) => fn(work, signal)));
  }
  function ioAvailable() {
    if (mode !== 'encrypted') return false;
    if (!safeBounds(safeStorage) || !bounds || !reader || !['createManagedScope', 'createManagedFile', 'managedLocator', 'readManaged', 'atomicWriteManaged', 'deleteManaged', 'listManaged'].every(name => typeof reader[name] === 'function')) {
      degrade(); return false;
    }
    return true;
  }
  function degrade(reason = 'ATTACHMENT_STORAGE_UNAVAILABLE', preserve = true) {
    mode = 'memory'; unavailableReason = reason; bounds = null;
    if (preserve) for (const locator of inventory.keys()) protectedPackages.add(locator);
    for (const row of records.values()) if (row.storageMode === 'encrypted' && row.status === 'ready') { row.status = 'missing'; row.refGeneration++; }
  }
  function manage(kind, locator, identity) {
    const file = reader.createManagedFile(scope, { kind, ...(locator ? { locator } : {}), ...(identity ? { expectedIdentity: identity } : {}) });
    const actual = reader.managedLocator(file);
    if ((kind === 'manifest' && actual !== 'manifest.enc.json') || (kind === 'blob' && (!LOCATOR.test(actual) || (locator && actual !== locator))) || (kind === 'temporary' && (!TEMP.test(actual) || actual !== locator))) throw error('ATTACHMENT_READ_DENIED');
    return file;
  }
  function reserveDisk(bytes) {
    integer(bytes, LIMITS.MAX_BLOB_PACKAGE_BYTES, 'ATTACHMENT_CACHE_LIMIT');
    if (diskBytes + diskReserved + bytes > LIMITS.MAX_CACHE_DISK_BYTES) throw error('ATTACHMENT_CACHE_LIMIT');
    diskReserved += bytes;
    let active = true;
    return { release() { if (active) { active = false; diskReserved -= bytes; } } };
  }
  async function managedRead(file, work, signal) {
    assertOpen(signal);
    const value = await reader.readManaged(file, { signal, work });
    try {
      assertOpen(signal);
      if (!Buffer.isBuffer(value?.bytes) || value.bytes.length > LIMITS.MAX_BLOB_PACKAGE_BYTES || value.bytes.buffer.byteLength !== value.bytes.length) throw error('ATTACHMENT_CORRUPT');
      return value;
    } catch (e) { await value?.release?.(); throw e; }
  }

  async function decryptPackage(bytes, kind, expected, work, signal, { retained = false, selfValidate = false } = {}) {
    if (!bounds || !ioAvailable()) throw error('ATTACHMENT_STORAGE_UNAVAILABLE');
    if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.MAX_BLOB_PACKAGE_BYTES) throw error('ATTACHMENT_CORRUPT');
    let outerText = null, outer = null, cipher = null, plain = null, parsed = null, raw = null;
    let textHold, outerHold, cipherHold, plainHold, parsedHold, rawHold;
    let transferred = false;
    try {
      assertOpen(signal);
      textHold = work.reserve(bytes.length * 2);
      outerText = bytes.toString('utf8');
      if (Buffer.byteLength(outerText, 'utf8') !== bytes.length || outerText.includes('\ufffd')) throw error('ATTACHMENT_CORRUPT');
      outerHold = parseWork(outerText, LIMITS.MAX_BLOB_PACKAGE_BYTES, work); outer = outerHold.value;
      outerText = null; release(textHold); textHold = null;
      assertFields(outer, ENVELOPE_FIELDS); version(outer.formatVersion);
      if (outer.cipher !== 'electron-safeStorage') throw error('ATTACHMENT_CORRUPT');
      const predicted = canonicalBase64Length(outer.payload, LIMITS.MAX_BLOB_CIPHER_BYTES);
      const plainMax = integer(bounds.decryptMaxBytes(predicted), LIMITS.MAX_ATTACHMENT_WORK_BYTES);
      const codeUnitsMax = integer(bounds.decryptMaxCodeUnits(predicted), LIMITS.MAX_ATTACHMENT_WORK_BYTES / 2);
      cipherHold = work.reserve(predicted);
      cipher = Buffer.alloc(predicted);
      cipher.write(outer.payload, 'base64');
      if (cipher.length !== predicted) throw error('ATTACHMENT_CORRUPT');
      outer = null; outerHold.value = null; outerHold.release(); outerHold = null;
      plainHold = work.reserve(codeUnitsMax * 2);
      assertOpen(signal);
      plain = await safeStorage.decryptString(cipher);
      assertOpen(signal);
      if (typeof plain !== 'string' || plain.length > codeUnitsMax || Buffer.byteLength(plain, 'utf8') > plainMax) throw error('ATTACHMENT_CORRUPT');
      cipher.fill(0); cipher = null; release(cipherHold); cipherHold = null;
      const maxPlain = kind === 'manifest' ? LIMITS.MAX_MANIFEST_PLAIN_BYTES : LIMITS.MAX_BLOB_PLAIN_BYTES;
      if (Buffer.byteLength(plain, 'utf8') > maxPlain) throw error('ATTACHMENT_CORRUPT');
      parsedHold = parseWork(plain, maxPlain, work); parsed = parsedHold.value;
      plain = null; release(plainHold); plainHold = null;
      if (kind === 'manifest') {
        validateManifest(parsed);
        // The caller reserves retained metadata before this temporary AST exits
        // the work slot, and discards it after converting to authoritative rows.
        transferred = true;
        return { value: parsed, release() { parsed = null; parsedHold.value = null; parsedHold.release(); parsedHold = null; } };
      }
      assertFields(parsed, BLOB_FIELDS); version(parsed.formatVersion);
      if (parsed.profileNamespace !== profileNamespace || parsed.blobId !== expected.blobId ||
          (!selfValidate && (parsed.rawDigest !== expected.rawDigest || parsed.rawByteLength !== expected.rawByteLength ||
          parsed.decodeVersion !== expected.decodeVersion || parsed.extractVersion !== expected.extractVersion))) throw error('ATTACHMENT_CORRUPT');
      digest(parsed.rawDigest); id(parsed.blobId, BLOB); version(parsed.decodeVersion); version(parsed.extractVersion);
      const rawLength = integer(parsed.rawByteLength, LIMITS.MAX_FILE_BYTES);
      if (canonicalBase64Length(parsed.rawBytesBase64, LIMITS.MAX_FILE_BYTES) !== rawLength) throw error('ATTACHMENT_CORRUPT');
      rawHold = retained ? budget.reserveRetained(rawLength) : work.reserve(rawLength);
      raw = Buffer.alloc(rawLength);
      raw.write(parsed.rawBytesBase64, 'base64');
      if (raw.length !== rawLength || hash(raw) !== parsed.rawDigest) throw error('ATTACHMENT_CORRUPT');
      assertOpen(signal);
      parsed = null; parsedHold.value = null; parsedHold.release(); parsedHold = null;
      transferred = true;
      const result = { bytes: raw, reservation: rawHold };
      raw = null; rawHold = null;
      return result;
    } catch (e) {
      if (e.code === 'ABORTED' || e.code === 'ATTACHMENT_WORK_BUSY' || e.code === 'ATTACHMENT_CACHE_LIMIT') throw e;
      throw error('ATTACHMENT_CORRUPT');
    } finally {
      if (outerHold) { outerHold.value = null; outerHold.release(); }
      if (parsedHold && kind !== 'manifest') { parsedHold.value = null; parsedHold.release(); }
      if (raw && !transferred) raw.fill(0);
      if (cipher) cipher.fill(0);
      outerText = outer = plain = parsed = raw = cipher = null;
      release(textHold); release(cipherHold); release(plainHold); release(rawHold);
      if (kind === 'manifest' && parsedHold && !transferred) { parsedHold.value = null; parsedHold.release(); parsedHold = null; }
    }
  }

  async function encryptPackage(value, kind, rawBytes, work, signal) {
    if (!ioAvailable()) throw error('ATTACHMENT_STORAGE_UNAVAILABLE');
    let plain = null, rawBase64 = null, cipher = null, payload = null, outerText = null, output = null;
    let plainHold, rawHold, cipherHold, payloadHold, outerHold, outputHold;
    try {
      assertOpen(signal);
      const base64Length = rawBytes ? Math.ceil(rawBytes.length / 3) * 4 : 0;
      const plainUpper = jsonUpper(value) + base64Length;
      plainHold = work.reserve(plainUpper * 2);
      if (rawBytes) { rawHold = work.reserve(base64Length * 2); rawBase64 = rawBytes.toString('base64'); value.rawBytesBase64 = rawBase64; }
      plain = JSON.stringify(value);
      if (rawBytes) { value.rawBytesBase64 = ''; rawBase64 = null; release(rawHold); rawHold = null; }
      const maxPlain = kind === 'manifest' ? LIMITS.MAX_MANIFEST_PLAIN_BYTES : LIMITS.MAX_BLOB_PLAIN_BYTES;
      const plainLength = Buffer.byteLength(plain, 'utf8');
      if (plainLength > maxPlain) throw error('ATTACHMENT_CORRUPT');
      const cipherMax = integer(bounds.encryptMaxBytes(plainLength), LIMITS.MAX_ATTACHMENT_WORK_BYTES);
      cipherHold = work.reserve(cipherMax);
      assertOpen(signal); cipher = await safeStorage.encryptString(plain); assertOpen(signal);
      if (!Buffer.isBuffer(cipher) || cipher.length > cipherMax || cipher.buffer.byteLength > cipherMax || cipher.length > LIMITS.MAX_BLOB_CIPHER_BYTES) throw error('ATTACHMENT_STORAGE_UNAVAILABLE');
      plain = null; release(plainHold); plainHold = null;
      const payloadChars = Math.ceil(cipher.length / 3) * 4;
      payloadHold = work.reserve(payloadChars * 2); payload = cipher.toString('base64');
      cipher.fill(0); cipher = null; release(cipherHold); cipherHold = null;
      const outerUpper = payloadChars + 96;
      outerHold = work.reserve(outerUpper * 2);
      outerText = JSON.stringify({ formatVersion: VERSION, cipher: 'electron-safeStorage', payload });
      payload = null; release(payloadHold); payloadHold = null;
      const packageLength = Buffer.byteLength(outerText, 'utf8');
      if (packageLength > LIMITS.MAX_BLOB_PACKAGE_BYTES) throw error('ATTACHMENT_CORRUPT');
      outputHold = work.reserve(packageLength);
      output = Buffer.alloc(packageLength); output.write(outerText, 'utf8');
      outerText = null; release(outerHold); outerHold = null;
      const result = { bytes: output, release() { output = null; release(outputHold); outputHold = null; } };
      output = null;
      return result;
    } catch (e) {
      if (e.code === 'ABORTED' || e.code === 'ATTACHMENT_CACHE_LIMIT' || e.code === 'ATTACHMENT_WORK_BUSY' || e.code === 'ATTACHMENT_CORRUPT') throw e;
      throw error('ATTACHMENT_STORAGE_UNAVAILABLE');
    } finally {
      if (cipher) cipher.fill(0);
      plain = rawBase64 = cipher = payload = outerText = null;
      release(plainHold); release(rawHold); release(cipherHold); release(payloadHold); release(outerHold);
      if (output) { output = null; release(outputHold); }
    }
  }

  function validateManifest(value) {
    assertFields(value, MANIFEST_FIELDS); version(value.formatVersion);
    if (value.profileNamespace !== profileNamespace || !Array.isArray(value.namespaces) || !Array.isArray(value.blobs) || !Array.isArray(value.records) ||
        value.records.length > LIMITS.MAX_CACHE_RECORDS || value.blobs.length > LIMITS.MAX_CACHE_RECORDS || value.namespaces.length > LIMITS.MAX_CACHE_RECORDS) throw error('ATTACHMENT_CORRUPT');
    const nsMap = new Map(), blobMap = new Map(), ids = new Set();
    for (const ns of value.namespaces) {
      assertFields(ns, NAMESPACE_FIELDS); id(ns.namespaceRef, NS); opaque(ns.sessionId);
      integer(ns.createdAt); integer(ns.lastAccessAt); integer(ns.draftRevision); integer(ns.messageRevision);
      if (nsMap.has(ns.namespaceRef)) throw error('ATTACHMENT_CORRUPT'); nsMap.set(ns.namespaceRef, ns);
    }
    for (const blob of value.blobs) {
      assertFields(blob, BLOB_META_FIELDS); id(blob.blobId, BLOB); id(blob.locator, LOCATOR); digest(blob.rawDigest);
      if (blob.locator !== `${blob.blobId.slice(5)}.enc.json`) throw error('ATTACHMENT_CORRUPT');
      integer(blob.rawByteLength, LIMITS.MAX_FILE_BYTES); integer(blob.packageBytes, LIMITS.MAX_BLOB_PACKAGE_BYTES); version(blob.decodeVersion); version(blob.extractVersion);
      if (blobMap.has(blob.blobId)) throw error('ATTACHMENT_CORRUPT'); blobMap.set(blob.blobId, blob);
    }
    for (const row of value.records) {
      assertFields(row, ROW_FIELDS); version(row.recordVersion); id(row.attachmentId, ID); id(row.sessionNamespaceRef, NS); id(row.blobKey, BLOB);
      const ns = nsMap.get(row.sessionNamespaceRef), blob = blobMap.get(row.blobKey);
      if (!ns || ns.sessionId !== row.logicalSessionId || row.profileNamespace !== profileNamespace || ids.has(row.attachmentId) || row.storageMode !== 'encrypted') throw error('ATTACHMENT_CORRUPT');
      ids.add(row.attachmentId);
      if (!['ready', 'deleted', 'missing'].includes(row.status) || !['user_upload', 'at_project_ref'].includes(row.sourceKind)) throw error('ATTACHMENT_CORRUPT');
      digest(row.rawDigest); integer(row.rawByteLength, LIMITS.MAX_FILE_BYTES); version(row.decodeVersion); version(row.extractVersion);
      if (row.status !== 'deleted' && (!blob || blob.rawDigest !== row.rawDigest || blob.rawByteLength !== row.rawByteLength || blob.decodeVersion !== row.decodeVersion || blob.extractVersion !== row.extractVersion)) throw error('ATTACHMENT_CORRUPT');
      if (blob && (blob.rawDigest !== row.rawDigest || blob.rawByteLength !== row.rawByteLength || blob.decodeVersion !== row.decodeVersion || blob.extractVersion !== row.extractVersion)) throw error('ATTACHMENT_CORRUPT');
      const name = text(row.name, 160); if (sanitizeName(name) !== name) throw error('ATTACHMENT_CORRUPT');
      text(row.mimeType, 128); integer(row.extractedChars, LIMITS.MAX_FILE_BYTES); integer(row.selectedChars, LIMITS.MAX_FILE_TEXT_CODEPOINTS);
      if (row.selectedChars > row.extractedChars) throw error('ATTACHMENT_CORRUPT');
      cleanSourceInfo(row.sourceInfo, row.sourceKind);
      for (const field of ['selectedAt', 'createdAt', 'lastAccessAt', 'expiresAt', 'refGeneration']) integer(row[field]);
      if (row.refGeneration < 1) throw error('ATTACHMENT_CORRUPT');
      boolean(row.draftLinked); boolean(row.messageLinked);
      if (row.status === 'deleted' && (row.draftLinked || row.messageLinked)) throw error('ATTACHMENT_CORRUPT');
    }
    for (const blob of value.blobs) if (!value.records.some(row => row.blobKey === blob.blobId)) throw error('ATTACHMENT_CORRUPT');
  }
  function makeManifest(extraRows = [], extraBlobs = [], durableNs = new Set()) {
    const allRows = [...records.values(), ...extraRows].filter(row => row.storageMode === 'encrypted');
    const allBlobs = [...blobs.values(), ...extraBlobs].filter(blob => blob.durable && !blob.deleted && allRows.some(row => row.blobKey === blob.blobId));
    const nsIds = new Set(allRows.map(row => row.sessionNamespaceRef));
    return { formatVersion: VERSION, profileNamespace,
      namespaces: [...namespaces.values()].filter(ns => (ns.durable || durableNs.has(ns.namespaceRef)) && nsIds.has(ns.namespaceRef)).map(ns => { const value = {}; for (const field of NAMESPACE_FIELDS) value[field] = ns[field]; return value; }),
      blobs: allBlobs.map(blob => { const value = {}; for (const field of BLOB_META_FIELDS) value[field] = blob[field]; return value; }),
      records: allRows.map(rowSnapshot),
    };
  }
  async function persist(work, signal, { extraRows = [], extraBlobs = [], durableNs = new Set(), expectedEpoch = epoch } = {}) {
    if (!ioAvailable() || !scope || (!manifestTrusted && manifestBytes)) throw error('ATTACHMENT_STORAGE_UNAVAILABLE');
    const value = makeManifest(extraRows, extraBlobs, durableNs); validateManifest(value);
    let encoded, diskHold;
    try {
      // The full hard package bound is reserved before any encoding/encryption.
      diskHold = reserveDisk(LIMITS.MAX_BLOB_PACKAGE_BYTES);
      encoded = await encryptPackage(value, 'manifest', null, work, signal);
      diskHold.release(); diskHold = reserveDisk(encoded.bytes.length);
      const file = manage('manifest', null, manifestIdentity);
      const identity = await reader.atomicWriteManaged(file, encoded.bytes, {
        signal, work,
        beforeCommit() { assertOpen(signal); if (epoch !== expectedEpoch) throw error('ATTACHMENT_PREVIEW_STALE'); },
        async verify({ bytes }) {
          assertOpen(signal);
          const decoded = await decryptPackage(bytes, 'manifest', null, work, signal);
          try { if (!sameData(decoded.value, value)) throw error('ATTACHMENT_CORRUPT'); }
          finally { decoded.release(); }
        },
      });
      // Atomic commit is the publication linearization point. No later async
      // flush is scheduled. A close racing the native completion never causes
      // a second write, a reopen, or deletion of newly referenced committed data.
      const oldBytes = manifestBytes;
      manifestFile = file; manifestIdentity = identity; manifestBytes = encoded.bytes.length;
      diskBytes += manifestBytes - oldBytes;
      inventory.set('manifest.enc.json', { kind: 'manifest', locator: 'manifest.enc.json', identity, size: manifestBytes, file });
      manifestTrusted = true; dirty = false;
      return { committed: true };
    } finally { encoded?.release(); diskHold?.release(); }
  }

  async function initialize(options = {}) {
    if (closed) throw error('ABORTED');
    if (initialized) return cacheStatus();
    return withWork(options, async (work, signal) => {
      if (initialized) return cacheStatus();
      if (!ioAvailable()) { degrade(); initialized = true; return cacheStatus(); }
      let manifestRead = null, decoded = null;
      const stagedReservations = [];
      try {
        scope = await reader.createManagedScope(cacheRoot, { signal, work }); assertOpen(signal);
        const entries = await reader.listManaged(scope, { maxEntries: LIMITS.MAX_CACHE_RECORDS * 2 + 1, signal, work }); assertOpen(signal);
        if (!Array.isArray(entries) || entries.length > LIMITS.MAX_CACHE_RECORDS * 2 + 1) throw error('ATTACHMENT_CORRUPT');
        for (const entry of entries) {
          assertFields(entry, ['kind', 'locator', 'identity', 'size']);
          const file = manage(entry.kind, entry.locator, entry.identity);
          if (inventory.has(entry.locator)) throw error('ATTACHMENT_CORRUPT');
          integer(entry.size, LIMITS.MAX_BLOB_PACKAGE_BYTES);
          diskBytes += entry.size;
          if (diskBytes > LIMITS.MAX_CACHE_DISK_BYTES) throw error('ATTACHMENT_CACHE_LIMIT');
          inventory.set(entry.locator, { ...entry, file });
        }
        const entry = inventory.get('manifest.enc.json');
        if (!entry) {
          // Without an authoritative manifest, all pre-existing packages are
          // unknown originals. Do not reclaim or overwrite them automatically.
          for (const locator of inventory.keys()) protectedPackages.add(locator);
          if (inventory.size) degrade('ATTACHMENT_CORRUPT');
          manifestTrusted = inventory.size === 0;
          initialized = true; return cacheStatus();
        }
        manifestFile = entry.file; manifestIdentity = entry.identity; manifestBytes = entry.size;
        manifestRead = await managedRead(manifestFile, work, signal);
        decoded = await decryptPackage(manifestRead.bytes, 'manifest', null, work, signal);
        assertOpen(signal);
        const value = decoded.value;
        for (const nsValue of value.namespaces) {
          const allocation = budget.reserveRetained(metadataBytes(nsValue)); stagedReservations.push(allocation);
          namespaces.set(nsValue.namespaceRef, { ...clone(nsValue), durable: true, allocation });
        }
        for (const blobValue of value.blobs) {
          const item = inventory.get(blobValue.locator);
          if (item && (item.kind !== 'blob' || item.size !== blobValue.packageBytes)) throw error('ATTACHMENT_CORRUPT');
          const allocation = budget.reserveRetained(metadataBytes(blobValue)); stagedReservations.push(allocation);
          const blob = { ...clone(blobValue), durable: true, deleted: !item, file: item?.file || manage('blob', blobValue.locator), identity: item?.identity, allocation, raw: null, rawAllocation: null };
          blobs.set(blob.blobId, blob); dedupe.set(key(blob.rawDigest, blob.decodeVersion, blob.extractVersion), blob.blobId);
        }
        for (const rowValue of value.records) {
          const allocation = budget.reserveRetained(metadataBytes(rowValue)); stagedReservations.push(allocation);
          const blob = blobs.get(rowValue.blobKey);
          const row = { ...clone(rowValue), allocation, leaseCount: 0 };
          if (row.status === 'ready' && (!blob || blob.deleted)) { row.status = 'missing'; row.refGeneration++; dirty = true; }
          records.set(row.attachmentId, row);
        }
        stagedReservations.length = 0;
        manifestTrusted = true; initialized = true;
        // Reclaim only known, identity-verified controlled orphan packages, and
        // only after the complete manifest has passed all bounded validation.
        const expected = new Set(['manifest.enc.json', ...value.blobs.map(blob => blob.locator)]);
        for (const [locator, item] of [...inventory]) if (!expected.has(locator)) {
          // A stage package has no committed logical authority. Preserve it
          // instead of guessing whether it is a future or lost-key original.
          if (item.kind !== 'blob') { protectedPackages.add(locator); continue; }
          let orphanRead, orphanDecoded;
          try {
            orphanRead = await managedRead(item.file, work, signal);
            orphanDecoded = await decryptPackage(orphanRead.bytes, 'blob', { blobId: `blob_${locator.slice(0, 32)}` }, work, signal, { selfValidate: true });
            orphanDecoded.bytes.fill(0); orphanDecoded.reservation.release(); orphanDecoded = null;
            await orphanRead.release?.(); orphanRead = null;
            await reader.deleteManaged(item.file, { signal, work }); assertOpen(signal);
            inventory.delete(locator); diskBytes -= item.size;
          } catch (e) { if (e.code === 'ABORTED' || closed || signal?.aborted) throw error('ABORTED'); protectedPackages.add(locator); retryableFailures++; }
          finally { if (orphanDecoded) { orphanDecoded.bytes.fill(0); orphanDecoded.reservation.release(); } await orphanRead?.release?.(); }
        }
        await collect(work, signal, { persistChanges: true });
        return cacheStatus();
      } catch (e) {
        if (e.code === 'ABORTED' || closed || signal?.aborted) throw error('ABORTED');
        for (const allocation of stagedReservations) allocation.release();
        if (stagedReservations.length) { namespaces.clear(); records.clear(); blobs.clear(); dedupe.clear(); }
        degrade(e.code === 'ATTACHMENT_CACHE_LIMIT' ? 'ATTACHMENT_CACHE_LIMIT' : 'ATTACHMENT_CORRUPT');
        initialized = true; return cacheStatus();
      } finally { decoded?.release(); await manifestRead?.release?.(); }
    });
  }
  function createNamespace({ sessionId } = {}) {
    checkReady(); opaque(sessionId);
    if (namespaces.size >= LIMITS.MAX_CACHE_RECORDS) throw error('ATTACHMENT_CACHE_LIMIT');
    const at = clock();
    const value = { namespaceRef: random('ans_'), sessionId, createdAt: at, lastAccessAt: at, draftRevision: 0, messageRevision: 0 };
    const allocation = budget.reserveRetained(metadataBytes(value));
    const ns = { ...value, durable: false, allocation }; namespaces.set(ns.namespaceRef, ns);
    return nsSnapshot(ns);
  }
  function getNamespace(locator, sessionId) { return nsSnapshot(namespaceFor(locator, sessionId)); }
  function getLinkRevisions(locator) {
    const ns = namespaceFor(locator);
    return Object.freeze({ draftRevision: ns.draftRevision, messageRevision: ns.messageRevision });
  }
  function getRecord(idValue, locator) { return rowSnapshot(authoritative(idValue, locator)); }
  function publicRef(row) { return publicAttachmentRef({ ...row, byteLength: row.rawByteLength, budget: { extractedChars: row.extractedChars, selectedChars: row.selectedChars, selectedBytes: row.selectedBytes ?? 0, estimatedTokens: row.estimatedTokens ?? 0, truncated: row.selectedChars < row.extractedChars } }); }
  function list(locator) { const ns = namespaceFor(locator); return [...records.values()].filter(row => row.sessionNamespaceRef === ns.namespaceRef && row.status !== 'deleted').map(publicRef); }

  function validateCaptures(captures) {
    if (!Array.isArray(captures) || captures.length < 1 || captures.length > LIMITS.MAX_SELECTION_FILES) throw error('ATTACHMENT_REFERENCE_INVALID');
    let bytes = 0;
    for (const capture of captures) {
      assertFields(capture, CAPTURE_FIELDS);
      if (!Buffer.isBuffer(capture.rawBytes)) throw error('ATTACHMENT_REFERENCE_INVALID');
      integer(capture.rawBytes.length, LIMITS.MAX_FILE_BYTES, 'ATTACHMENT_FILE_LIMIT');
      bytes += capture.rawBytes.length;
      if (bytes > LIMITS.MAX_SELECTION_RAW_BYTES) throw error('ATTACHMENT_SELECTION_LIMIT');
      if (!['user_upload', 'at_project_ref'].includes(capture.sourceKind)) throw error('ATTACHMENT_REFERENCE_INVALID');
      text(capture.name, 4096); text(capture.mimeType || 'text/plain', 128);
      version(capture.decodeVersion ?? VERSION); version(capture.extractVersion ?? VERSION);
      integer(capture.extractedChars, LIMITS.MAX_FILE_BYTES, 'ATTACHMENT_REFERENCE_INVALID');
      const selectedChars = capture.selectedChars ?? Math.min(capture.extractedChars, LIMITS.MAX_FILE_TEXT_CODEPOINTS);
      integer(selectedChars, LIMITS.MAX_FILE_TEXT_CODEPOINTS, 'ATTACHMENT_REFERENCE_INVALID');
      if (selectedChars > capture.extractedChars) throw error('ATTACHMENT_REFERENCE_INVALID');
      if (capture.rawDigest !== undefined) digest(capture.rawDigest);
      cleanSourceInfo(capture.sourceInfo, capture.sourceKind);
      if (capture.selectedAt !== undefined) integer(capture.selectedAt);
    }
  }
  function makeRow(capture, ns, blob, at, storageMode) {
    return { recordVersion: VERSION, attachmentId: random('att_'), profileNamespace, logicalSessionId: ns.sessionId,
      sessionNamespaceRef: ns.namespaceRef, blobKey: blob.blobId, name: sanitizeName(capture.name), mimeType: capture.mimeType || 'text/plain', sourceKind: capture.sourceKind,
      rawDigest: blob.rawDigest, rawByteLength: blob.rawByteLength, decodeVersion: blob.decodeVersion, extractVersion: blob.extractVersion,
      extractedChars: capture.extractedChars, selectedChars: capture.selectedChars ?? Math.min(capture.extractedChars, LIMITS.MAX_FILE_TEXT_CODEPOINTS),
      sourceInfo: cleanSourceInfo(capture.sourceInfo, capture.sourceKind), selectedAt: capture.selectedAt ?? at, createdAt: at, lastAccessAt: at, expiresAt: at + LIMITS.CACHE_IDLE_TTL_MS,
      refGeneration: 1, draftLinked: true, messageLinked: false, status: 'ready', storageMode,
    };
  }
  async function rollbackNew(newBlobs, work) {
    for (const blob of newBlobs) {
      if (!blob.createdOnDisk) continue;
      try {
        // Cleanup of this transaction's own brand/identity, never a deduped old
        // blob. Cleanup remains owned until the real unlink has completed.
        if (typeof budget.withCleanupWork !== 'function') throw error('ATTACHMENT_STORAGE_UNAVAILABLE');
        await budget.withCleanupWork({ work }, cleanupWork => reader.deleteManaged(blob.file, { work: cleanupWork }));
        inventory.delete(blob.locator); diskBytes -= blob.packageBytes; blob.createdOnDisk = false;
      } catch { protectedPackages.add(blob.locator); retryableFailures++; }
    }
  }
  function disposeBlob(blob) {
    if (blob.raw) { blob.raw.fill(0); blob.raw = null; }
    release(blob.rawAllocation); blob.rawAllocation = null;
    release(blob.allocation); blob.allocation = null;
  }
  async function importBatch({ namespace, sessionId, captures } = {}, options = {}) {
    const ns = namespaceFor(namespace, sessionId);
    if (sessionId !== ns.sessionId) throw error('ATTACHMENT_REFERENCE_INVALID');
    validateCaptures(captures);
    return withWork(options, async (work, signal) => {
      assertOpen(signal);
      await collect(work, signal, { persistChanges: false });
      if (records.size + captures.length > LIMITS.MAX_CACHE_RECORDS) throw error('ATTACHMENT_CACHE_LIMIT');
      const initialEpoch = epoch, at = clock();
      const newBlobs = [], newRows = [], rowAllocations = [], blobAllocations = [], rawInputHolds = [];
      const backing = new Set(), stagedDedupe = new Map();
      let committed = false;
      try {
        // Reserve the whole underlying input buffer once, not each view. A
        // small slice of a large buffer cannot hide its retained parent.
        for (const capture of captures) if (!backing.has(capture.rawBytes.buffer)) {
          backing.add(capture.rawBytes.buffer); rawInputHolds.push(work.reserve(capture.rawBytes.buffer.byteLength));
        }
        for (const capture of captures) {
          assertOpen(signal);
          const rawDigest = hash(capture.rawBytes);
          if (capture.rawDigest !== undefined && capture.rawDigest !== rawDigest) throw error('ATTACHMENT_SOURCE_CHANGED');
          const decodeVersion = capture.decodeVersion ?? VERSION, extractVersion = capture.extractVersion ?? VERSION;
          const contentKey = key(rawDigest, decodeVersion, extractVersion);
          let blob = stagedDedupe.get(contentKey) || blobs.get(dedupe.get(contentKey));
          if (blob && (blob.deleted || (mode === 'memory' && blob.durable) || protectedPackages.has(blob.locator))) blob = null;
          if (blob && blob.durable && !newBlobs.includes(blob)) {
            let cachedRead, cachedDecoded;
            try {
              cachedRead = await managedRead(blob.file, work, signal);
              cachedDecoded = await decryptPackage(cachedRead.bytes, 'blob', blob, work, signal);
              if (!cachedDecoded.bytes.equals(capture.rawBytes)) throw error('ATTACHMENT_CORRUPT');
            } catch (e) { if (e.code !== 'ABORTED') protectedPackages.add(blob.locator); throw e; }
            finally { if (cachedDecoded) { cachedDecoded.bytes.fill(0); cachedDecoded.reservation.release(); } await cachedRead?.release?.(); }
          }
          if (blob && !blob.durable && blob.raw && !blob.raw.equals(capture.rawBytes)) throw error('ATTACHMENT_CORRUPT');
          if (!blob) {
            const blobId = random('blob_');
            blob = { blobId, locator: `${blobId.slice(5)}.enc.json`, rawDigest, rawByteLength: capture.rawBytes.length, decodeVersion, extractVersion, packageBytes: 0,
              durable: mode === 'encrypted', deleted: false, raw: null, rawAllocation: null, file: null, identity: null, createdOnDisk: false };
            blob.allocation = budget.reserveRetained(metadataBytes({ blobId, rawDigest, rawByteLength: blob.rawByteLength, locator: blob.locator })); blobAllocations.push(blob.allocation);
            newBlobs.push(blob); stagedDedupe.set(contentKey, blob);
          }
          const row = makeRow(capture, ns, blob, at, mode);
          row.allocation = budget.reserveRetained(metadataBytes(row)); rowAllocations.push(row.allocation); row.leaseCount = 0;
          newRows.push(row);
        }
        if (mode === 'encrypted') {
          try {
            for (const blob of newBlobs) {
              const capture = captures[newRows.findIndex(row => row.blobKey === blob.blobId)];
              let encoded, diskHold;
              try {
                diskHold = reserveDisk(LIMITS.MAX_BLOB_PACKAGE_BYTES);
                encoded = await encryptPackage({ formatVersion: VERSION, profileNamespace, blobId: blob.blobId, rawDigest: blob.rawDigest, rawByteLength: blob.rawByteLength,
                  decodeVersion: blob.decodeVersion, extractVersion: blob.extractVersion, rawBytesBase64: '' }, 'blob', capture.rawBytes, work, signal);
                diskHold.release(); diskHold = reserveDisk(encoded.bytes.length);
                blob.file = manage('blob', blob.locator);
                const identity = await reader.atomicWriteManaged(blob.file, encoded.bytes, {
                  signal, work,
                  beforeCommit() { assertOpen(signal); if (epoch !== initialEpoch) throw error('ATTACHMENT_PREVIEW_STALE'); },
                  async verify({ bytes }) {
                    assertOpen(signal);
                    const decoded = await decryptPackage(bytes, 'blob', blob, work, signal);
                    try { if (!decoded.bytes.equals(capture.rawBytes)) throw error('ATTACHMENT_CORRUPT'); }
                    finally { decoded.bytes.fill(0); decoded.reservation.release(); }
                  },
                });
                blob.identity = identity; blob.packageBytes = encoded.bytes.length; blob.createdOnDisk = true;
                diskBytes += blob.packageBytes;
                inventory.set(blob.locator, { kind: 'blob', locator: blob.locator, identity, size: blob.packageBytes, file: blob.file });
                assertOpen(signal);
              } finally { encoded?.release(); diskHold?.release(); }
            }
            assertOpen(signal);
            if (epoch !== initialEpoch) throw error('ATTACHMENT_PREVIEW_STALE');
            await persist(work, signal, { extraRows: newRows, extraBlobs: newBlobs, durableNs: new Set([ns.namespaceRef]), expectedEpoch: initialEpoch });
            committed = true; ns.durable = true;
          } catch (e) {
            if (e.code === 'ABORTED' || closed || signal?.aborted || e.code === 'ATTACHMENT_PREVIEW_STALE' || e.code === 'ATTACHMENT_CACHE_LIMIT' || e.code === 'ATTACHMENT_WORK_BUSY') throw e;
            await rollbackNew(newBlobs, work);
            degrade('ATTACHMENT_STORAGE_UNAVAILABLE');
            for (const row of newRows) row.storageMode = 'memory';
            for (const blob of newBlobs) { blob.durable = false; blob.packageBytes = 0; blob.file = null; }
            // An existing encrypted dedupe target cannot be used after crypto
            // becomes unsafe. Replace only this new batch's logical targets.
            for (const row of newRows) if (!newBlobs.some(blob => blob.blobId === row.blobKey)) {
              const capture = captures[newRows.indexOf(row)], blobId = random('blob_');
              const blob = { blobId, locator: `${blobId.slice(5)}.enc.json`, rawDigest: row.rawDigest, rawByteLength: row.rawByteLength, decodeVersion: row.decodeVersion, extractVersion: row.extractVersion,
                packageBytes: 0, durable: false, deleted: false, raw: null, rawAllocation: null, createdOnDisk: false };
              blob.allocation = budget.reserveRetained(metadataBytes({ blobId, rawDigest: row.rawDigest })); blobAllocations.push(blob.allocation);
              newBlobs.push(blob); row.blobKey = blobId; stagedDedupe.set(key(blob.rawDigest, blob.decodeVersion, blob.extractVersion), blob);
              void capture;
            }
          }
        }
        if (mode === 'memory') {
          for (const blob of newBlobs) {
            assertOpen(signal);
            const capture = captures[newRows.findIndex(row => row.blobKey === blob.blobId)];
            blob.rawAllocation = budget.reserveRetained(blob.rawByteLength);
            blob.raw = Buffer.alloc(blob.rawByteLength); capture.rawBytes.copy(blob.raw);
          }
          if (epoch !== initialEpoch && !committed) throw error('ATTACHMENT_PREVIEW_STALE');
          committed = true;
        }
        if (closed) throw error('ABORTED');
        // No await between publication and returning refs. Atomic manifest
        // commit has already passed beforeCommit's final lifecycle/epoch check.
        for (const blob of newBlobs) { blobs.set(blob.blobId, blob); dedupe.set(key(blob.rawDigest, blob.decodeVersion, blob.extractVersion), blob.blobId); }
        for (const row of newRows) records.set(row.attachmentId, row);
        ns.lastAccessAt = at;
        const sameOwnerShared = newRows.filter(row => [...records.values()].some(old => old.attachmentId !== row.attachmentId && old.sessionNamespaceRef === ns.namespaceRef && old.blobKey === row.blobKey)).length;
        return { refs: newRows.map(publicRef), namespace: nsSnapshot(ns), storageMode: mode, deduplicated: sameOwnerShared };
      } catch (e) {
        if (!committed) await rollbackNew(newBlobs, work);
        for (const allocation of rowAllocations) allocation.release();
        for (const blob of newBlobs) disposeBlob(blob);
        if (e.code === 'ABORTED' || closed || signal?.aborted) throw error('ABORTED');
        throw e.code ? error(e.code) : error('ATTACHMENT_STORAGE_UNAVAILABLE');
      } finally { for (const hold of rawInputHolds) hold.release(); }
    });
  }

  function protectedBlob(blob) {
    return [...records.values()].some(row => row.blobKey === blob.blobId && (row.status === 'ready' || row.leaseCount > 0));
  }
  function disposeRow(row) { release(row.allocation); row.allocation = null; }
  async function collect(work, signal, { persistChanges = true } = {}) {
    assertOpen(signal);
    const at = clock(); let changed = false;
    for (const row of records.values()) if (row.status !== 'deleted' && !row.draftLinked && !row.messageLinked && !row.leaseCount && at - row.lastAccessAt >= LIMITS.CACHE_IDLE_TTL_MS) {
      row.status = 'deleted'; row.refGeneration++; dirty = true; changed = true; epoch++;
    }
    for (const blob of [...blobs.values()]) {
      if (blob.deleted || protectedBlob(blob)) continue;
      if (blob.durable) {
        if (!ioAvailable() || protectedPackages.has(blob.locator)) continue;
        let value, decoded;
        try {
          value = await managedRead(blob.file, work, signal);
          decoded = await decryptPackage(value.bytes, 'blob', blob, work, signal);
          decoded.bytes.fill(0); decoded.reservation.release(); decoded = null;
          await value.release?.(); value = null;
          assertOpen(signal);
          await reader.deleteManaged(blob.file, { signal, work }); assertOpen(signal);
          inventory.delete(blob.locator); diskBytes -= blob.packageBytes;
        } catch (e) {
          if (e.code === 'ABORTED' || closed || signal?.aborted) throw error('ABORTED');
          if (e.code === 'ATTACHMENT_CORRUPT') protectedPackages.add(blob.locator);
          retryableFailures++; continue;
        } finally { if (decoded) { decoded.bytes.fill(0); decoded.reservation.release(); } await value?.release?.(); }
      }
      blob.deleted = true; changed = true; dirty = true;
      const contentKey = key(blob.rawDigest, blob.decodeVersion, blob.extractVersion);
      if (dedupe.get(contentKey) === blob.blobId) dedupe.delete(contentKey);
      if (blob.raw) { blob.raw.fill(0); blob.raw = null; }
      release(blob.rawAllocation); blob.rawAllocation = null;
    }
    // Tombstones count toward 512 until their logical metadata expires (or an
    // explicit clear), and no lease can observe them. They are not discarded to
    // evade the row budget while a shared/protected blob remains active.
    for (const [idValue, row] of [...records]) if (row.status === 'deleted' && !row.leaseCount && (clearRequested || at - row.lastAccessAt >= LIMITS.CACHE_IDLE_TTL_MS) && (!blobs.get(row.blobKey) || blobs.get(row.blobKey).deleted)) {
      records.delete(idValue); disposeRow(row); dirty = true; changed = true;
    }
    for (const [blobId, blob] of [...blobs]) if (blob.deleted && ![...records.values()].some(row => row.blobKey === blobId)) { blobs.delete(blobId); disposeBlob(blob); }
    if (persistChanges && dirty && ioAvailable()) await persist(work, signal);
    return { changed };
  }
  async function maybeCollect() {
    if (closed) { cleanupClosed(); return { deferred: false }; }
    try { return await withWork({}, (work, signal) => collect(work, signal)); }
    catch (e) {
      if (e.code === 'ATTACHMENT_WORK_BUSY') return { deferred: true };
      if (e.code === 'ABORTED') return { deferred: true };
      retryableFailures++; return { deferred: true };
    }
  }
  function hold(ids, locator, { kind = 'preview' } = {}) {
    namespaceFor(locator);
    if (!Array.isArray(ids) || ids.length > LIMITS.MAX_CACHE_RECORDS || !['preview', 'run', 'draft', 'message', 'read'].includes(kind)) throw error('ATTACHMENT_REFERENCE_INVALID');
    const unique = [...new Set(ids)], rows = unique.map(idValue => authoritative(idValue, locator, { ready: true }));
    const allocation = budget.reserveRetained(256 + rows.reduce((sum, row) => sum + metadataBytes(row), 0));
    let snapshots;
    try { snapshots = rows.map(rowSnapshot); } catch (e) { allocation.release(); throw e; }
    for (const row of rows) row.leaseCount++;
    let active = true;
    const lease = { records: snapshots, async release() {
      if (!active) return { deferred: false }; active = false; leases.delete(lease);
      for (const row of rows) row.leaseCount--;
      try { return await maybeCollect(); }
      finally { snapshots.length = 0; rows.length = 0; allocation.release(); }
    } };
    leases.add(lease); return lease;
  }
  async function read(idValue, locator, options = {}) {
    const row = authoritative(idValue, locator, { ready: true }), blob = blobs.get(row.blobKey);
    if (!blob || blob.deleted || (blob.durable && !ioAvailable())) throw error('ATTACHMENT_REFERENCE_INVALID');
    const generation = row.refGeneration, lease = hold([idValue], locator, { kind: 'read' });
    let bytes = null, allocation = null;
    try {
      return await withWork(options, async (work, signal) => {
        let value = null, decoded = null;
        try {
          assertOpen(signal);
          if (blob.durable) {
            value = await managedRead(blob.file, work, signal);
            if (value.bytes.length !== blob.packageBytes) throw error('ATTACHMENT_CORRUPT');
            decoded = await decryptPackage(value.bytes, 'blob', blob, work, signal, { retained: true });
            bytes = decoded.bytes; allocation = decoded.reservation; decoded = null;
          } else {
            if (!blob.raw || hash(blob.raw) !== row.rawDigest) throw error('ATTACHMENT_CORRUPT');
            allocation = budget.reserveRetained(blob.raw.length);
            bytes = Buffer.alloc(blob.raw.length); blob.raw.copy(bytes);
          }
          assertOpen(signal);
          if (row.status !== 'ready' || row.refGeneration !== generation) throw error('ATTACHMENT_PREVIEW_STALE');
          row.lastAccessAt = clock(); row.expiresAt = row.lastAccessAt + LIMITS.CACHE_IDLE_TTL_MS; dirty = true;
          let active = true;
          const ownedBytes = bytes, ownedAllocation = allocation; bytes = allocation = null;
          const handle = { record: rowSnapshot(row), bytes: ownedBytes, async release() {
            if (!active) return; active = false; readHandles.delete(handle); ownedBytes.fill(0); ownedAllocation.release(); await lease.release();
          } };
          readHandles.add(handle); return handle;
        } catch (e) {
          if (e.code === 'ATTACHMENT_CORRUPT') {
            protectedPackages.add(blob.locator); row.status = 'missing'; row.refGeneration++; dirty = true; epoch++;
          }
          throw e;
        } finally { if (decoded) { decoded.bytes.fill(0); decoded.reservation.release(); } await value?.release?.(); }
      });
    } catch (e) {
      if (bytes) bytes.fill(0); bytes = null; release(allocation); allocation = null;
      await lease.release();
      if (e.code === 'ABORTED' || options.signal?.aborted || closed) throw error('ABORTED');
      throw e.code ? error(e.code) : error('ATTACHMENT_CORRUPT');
    }
  }

  function validateLinks(locator, revision, ids) {
    const ns = namespaceFor(locator); integer(revision, Number.MAX_SAFE_INTEGER, 'ATTACHMENT_REFERENCE_INVALID');
    if (!Array.isArray(ids) || ids.length > LIMITS.MAX_CACHE_RECORDS || new Set(ids).size !== ids.length) throw error('ATTACHMENT_REFERENCE_INVALID');
    for (const idValue of ids) authoritative(idValue, locator, { ready: true });
    return ns;
  }
  async function syncLinks(locator, { revision, ids } = {}, field, revisionField, options = {}) {
    const ns = validateLinks(locator, revision, ids);
    if (revision < ns[revisionField]) return { ignored: true, revision: ns[revisionField] };
    const selected = new Set(ids);
    const rows = [...records.values()].filter(row => row.sessionNamespaceRef === ns.namespaceRef);
    const nextChanged = rows.filter(row => row[field] !== (row.status === 'ready' && selected.has(row.attachmentId)));
    if (revision === ns[revisionField] && nextChanged.length) throw error('ATTACHMENT_PREVIEW_STALE');
    const revisionChanged = revision !== ns[revisionField];
    ns[revisionField] = revision;
    for (const row of nextChanged) { row[field] = row.status === 'ready' && selected.has(row.attachmentId); row.refGeneration++; row.lastAccessAt = clock(); }
    if (nextChanged.length || revisionChanged) { epoch++; dirty = true; }
    try { await withWork(options, (work, signal) => collect(work, signal)); return { revision, changed: nextChanged.length, deferred: false }; }
    catch (e) { if (e.code === 'ATTACHMENT_WORK_BUSY') return { revision, changed: nextChanged.length, deferred: true }; throw e; }
  }
  function syncDraftLinks(locator, links, options) { return syncLinks(locator, links, 'draftLinked', 'draftRevision', options); }
  function syncMessageLinks(locator, links, options) { return syncLinks(locator, links, 'messageLinked', 'messageRevision', options); }
  async function removeFromDraft(idValue, locator, { revision } = {}, options = {}) {
    const row = authoritative(idValue, locator), ns = namespaceFor(locator);
    if (revision !== undefined) {
      integer(revision, Number.MAX_SAFE_INTEGER, 'ATTACHMENT_REFERENCE_INVALID');
      if (revision < ns.draftRevision) return { ignored: true, ref: publicRef(row) };
      ns.draftRevision = revision;
    }
    row.draftLinked = false; row.refGeneration++; row.lastAccessAt = clock(); epoch++; dirty = true;
    try { await withWork(options, (work, signal) => collect(work, signal)); return { ref: publicRef(row), deferred: false }; }
    catch (e) { if (e.code === 'ATTACHMENT_WORK_BUSY') return { ref: publicRef(row), deferred: true }; throw e; }
  }
  async function deleteCopy(idValue, locator, options = {}) {
    const row = authoritative(idValue, locator), blob = blobs.get(row.blobKey);
    if (row.status !== 'deleted') { row.status = 'deleted'; row.draftLinked = false; row.messageLinked = false; row.refGeneration++; row.lastAccessAt = clock(); epoch++; dirty = true; }
    let busy = false;
    try { await withWork(options, (work, signal) => collect(work, signal)); }
    catch (e) { if (e.code === 'ATTACHMENT_WORK_BUSY') busy = true; else throw e; }
    return { deleted: true, deferred: busy || !!(blob && !blob.deleted), protected: !!(blob && protectedBlob(blob)), retryable: !!(blob && !blob.deleted && !protectedBlob(blob)) };
  }
  async function clear(locator, options = {}) {
    checkReady();
    if (locator !== undefined && locator !== null) namespaceFor(locator);
    const selectedNs = locator == null ? null : namespaceRef(locator);
    for (const row of records.values()) if (!selectedNs || row.sessionNamespaceRef === selectedNs) {
      if (row.status !== 'deleted') { row.status = 'deleted'; row.draftLinked = false; row.messageLinked = false; row.refGeneration++; row.lastAccessAt = clock(); dirty = true; epoch++; }
    }
    clearRequested = true;
    let busy = false;
    try { await withWork(options, (work, signal) => collect(work, signal)); }
    catch (e) { if (e.code === 'ATTACHMENT_WORK_BUSY') busy = true; else throw e; }
    const pending = [...blobs.values()].filter(blob => !blob.deleted && ![...records.values()].some(row => row.blobKey === blob.blobId && row.status === 'ready')).length;
    return { cleared: !busy && pending === 0 && protectedPackages.size === 0, deferred: busy || pending > 0, pendingDeletionCount: pending, preservedPackageCount: protectedPackages.size, retryable: pending > 0 || retryableFailures > 0 };
  }
  function cacheStatus() {
    if (!closed && mode === 'encrypted') ioAvailable();
    return { storageMode: mode, durable: mode === 'encrypted', initialized, closed, diskBytes, reservedDiskBytes: diskReserved,
      recordCount: records.size, namespaceCount: namespaces.size, blobCount: [...blobs.values()].filter(blob => !blob.deleted).length,
      activeLeases: leases.size, pendingDeletionCount: [...blobs.values()].filter(blob => !blob.deleted && !protectedBlob(blob)).length,
      protectedPackageCount: protectedPackages.size, retryableFailures, unavailableReason,
      encryptionEvidence: mode !== 'encrypted' ? 'unavailable' : bounds?.kind === 'unit-fixture' ? 'unit-fixture' : 'electron-win32-dpapi-length-bounds',
      retainedBytes: budget.snapshot?.().retainedBytes ?? null, workBytes: budget.snapshot?.().workBytes ?? null,
      activeWork: budget.snapshot?.().activeWork ?? null };
  }
  function cleanupClosed() {
    if (!closed) return;
    for (const [idValue, row] of records) if (!row.leaseCount) { records.delete(idValue); disposeRow(row); }
    for (const [blobId, blob] of blobs) if (![...records.values()].some(row => row.blobKey === blobId && row.leaseCount)) { blobs.delete(blobId); disposeBlob(blob); }
    for (const ns of namespaces.values()) { release(ns.allocation); ns.allocation = null; }
    namespaces.clear(); dedupe.clear();
  }
  async function close() {
    if (closing) return closing;
    closed = true; lifecycle.abort();
    // No flush, timers, scheduled deletion, or late fallback write on close.
    closing = (async () => { await Promise.allSettled([...operations]); cleanupClosed(); return cacheStatus(); })();
    return closing;
  }
  return Object.freeze({ initialize, createNamespace, getNamespace, getLinkRevisions, importBatch, getRecord, read, list, hold, syncDraftLinks, syncMessageLinks, removeFromDraft, deleteCopy, clear, cacheStatus, close });
}

module.exports = { createAttachmentStore, createElectronSafeStorageAdapter };
