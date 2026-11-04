'use strict';

// Main-process private byte capabilities. Neither a renderer DTO nor a source
// path can be promoted to a managed-package capability. No JS filesystem read
// fallback is provided: production IO always uses the hash-verified launcher.
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');
const {
  LIMITS, ATTACHMENT_ERRORS, attachmentError, checkedInteger, assertFields,
  countCodePoints, prefixCodePoints, sanitizeName, normalizeRelativePath,
  normalizeLineRange, parseBoundedJson, canonicalBase64Length, createAttachmentBudget,
} = require('./attachment-contract');

const applicationBudget = createAttachmentBudget();
let activeNativeOperation = false;
const MAGIC = Buffer.from('E5IO0001');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const inside = (root, value) => samePath(root, value) || value.toLowerCase().startsWith(root.replace(/\\$/, '').toLowerCase() + '\\');
const failure = (code = 'ATTACHMENT_READ_DENIED') => attachmentError(code);
const checkSignal = signal => { if (signal?.aborted) throw failure('ABORTED'); };
const nativeIdentity = value => typeof value === 'string' && /^\d+:\d+$/.test(value) && value.length <= 128;
const devices = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\..*)?$/i;
const extensions = new Set('.txt .md .markdown .json .jsonc .csv .tsv .js .cjs .mjs .jsx .ts .tsx .py .java .c .h .cpp .hpp .cs .go .rs .rb .php .sh .ps1 .bat .cmd .css .html .htm .xml .yaml .yml .toml .ini .conf .log .sql'.split(' '));
const extensionless = new Set(['readme', 'license', 'makefile', 'dockerfile', '.gitignore']);
const binaryPrefixes = [
  '89504e470d0a1a0a', 'ffd8ff', '474946383761', '474946383961', '424d',
  '49492a00', '4d4d002a', '00000100', '255044462d', '504b0304', '504b0506', '504b0708',
  'd0cf11e0a1b11ae1', '1f8b', '377abcaf271c', '526172211a0700', '526172211a070100',
  '425a68', 'fd377a585a00', '28b52ffd', '494433', '664c6143', '4f676753',
  '4d5a', '7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe',
].map(hex => Buffer.from(hex, 'hex'));

function absoluteWindowsPath(value, { directory = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > 32768 || !/^[A-Za-z]:[\\/]/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) throw failure();
  const normalized = value.replace(/\//g, '\\');
  let rest = normalized.slice(3);
  if (directory && rest.endsWith('\\')) rest = rest.slice(0, -1);
  if (rest.includes(':') || (!rest && !directory)) throw failure();
  const components = rest ? rest.split('\\') : [];
  if (components.some(component => !component || component === '.' || component === '..' || /[. ]$/.test(component) || devices.test(component))) throw failure();
  const result = normalized.slice(0, 1).toUpperCase() + ':\\' + components.join('\\');
  if (!samePath(path.win32.resolve(result), result)) throw failure();
  return result;
}

function validateTextType(name, bytes) {
  if (typeof name !== 'string' || !Buffer.isBuffer(bytes)) throw failure('ATTACHMENT_TYPE_UNSUPPORTED');
  const base = path.win32.basename(name).toLowerCase();
  if (!extensions.has(path.win32.extname(base)) && !extensionless.has(base)) throw failure('ATTACHMENT_TYPE_UNSUPPORTED');
  for (const signature of binaryPrefixes) if (bytes.length >= signature.length && bytes.subarray(0, signature.length).equals(signature)) throw failure('ATTACHMENT_TYPE_UNSUPPORTED');
  if (bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && ['WEBP', 'WAVE', 'AVI '].includes(bytes.toString('ascii', 8, 12))) throw failure('ATTACHMENT_TYPE_UNSUPPORTED');
  if (bytes.length >= 8 && bytes.toString('ascii', 4, 8) === 'ftyp') throw failure('ATTACHMENT_TYPE_UNSUPPORTED');
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) throw failure('ATTACHMENT_TYPE_UNSUPPORTED');
  return true;
}

/** Pure extraction; callers that own an active work lease pass it for copies. */
function extractText(captured, options = {}) {
  assertFields(options, ['startLine', 'endLine', 'prefixCodePoints', 'redact', 'work'], 'ATTACHMENT_TEXT_LIMIT');
  if (!captured || !Buffer.isBuffer(captured.bytes)) throw failure();
  const bytes = captured.bytes;
  if (bytes.length > LIMITS.MAX_FILE_BYTES) throw failure('ATTACHMENT_FILE_LIMIT');
  if ((bytes.length >= 2 && (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff)) || (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)) throw failure('ATTACHMENT_ENCODING_INVALID');
  validateTextType(captured.name, bytes);
  const reservations = [];
  const reserve = n => { if (options.work) reservations.push(options.work.reserve(n)); };
  let text;
  try {
    // Fatal decoding covers the complete raw bytes, not the requested range.
    reserve(bytes.length * 2);
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw failure('ATTACHMENT_ENCODING_INVALID'); }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw failure('ATTACHMENT_ENCODING_INVALID');
    const rawDigest = digest(bytes);
    if (captured.rawDigest !== undefined && captured.rawDigest !== rawDigest) throw failure('ATTACHMENT_SOURCE_CHANGED');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const extractedChars = countCodePoints(text);
    let range;
    try { range = normalizeLineRange({ startLine: options.startLine ?? captured.range?.startLine, endLine: options.endLine ?? captured.range?.endLine }); }
    catch (error) { throw failure(error.code === 'ATTACHMENT_TEXT_LIMIT' ? error.code : 'ATTACHMENT_REFERENCE_INVALID'); }
    const explicit = range.startLine !== undefined;
    let lineCount = 0, index = 0, selectionStart = 0, selectionEnd = text.length;
    const isProject = captured.sourceKind === 'at_project_ref';
    const first = explicit ? range.startLine : 1;
    const last = explicit ? range.endLine : isProject ? LIMITS.MAX_DEFAULT_RANGE_LINES : Number.MAX_SAFE_INTEGER;
    while (index < text.length) {
      lineCount++;
      const newline = text.indexOf('\n', index);
      const end = newline < 0 ? text.length : newline + 1;
      if (lineCount === first) selectionStart = index;
      if (lineCount === last) selectionEnd = end;
      index = end;
    }
    if (explicit && (!lineCount || first > lineCount || last > lineCount)) throw failure('ATTACHMENT_TEXT_LIMIT');
    if ((explicit || isProject) && lineCount) range = { startLine: first, endLine: Math.min(last, lineCount) };
    else range = undefined;
    reserve(Math.max(0, selectionEnd - selectionStart) * 2);
    const candidate = text.slice(selectionStart, selectionEnd);
    if (explicit && candidate.length === 0) throw failure('ATTACHMENT_TEXT_LIMIT');
    const candidateChars = countCodePoints(candidate);
    let redacted = candidate;
    if (options.redact !== undefined) {
      if (typeof options.redact !== 'function') throw failure('ATTACHMENT_TEXT_LIMIT');
      // The redactor is host-owned, but its explicit output is still bounded.
      const outputUnits = options.redact.attachmentMaxOutputCodeUnits
        ? checkedInteger(options.redact.attachmentMaxOutputCodeUnits(candidate.length), { max: LIMITS.MAX_FILE_BYTES * 3, code: 'ATTACHMENT_TEXT_LIMIT' })
        : LIMITS.MAX_FILE_BYTES;
      const outputBytes = options.redact.attachmentMaxOutputBytes
        ? checkedInteger(options.redact.attachmentMaxOutputBytes(Buffer.byteLength(candidate, 'utf8')), { max: LIMITS.MAX_FILE_BYTES * 3, code: 'ATTACHMENT_TEXT_LIMIT' })
        : LIMITS.MAX_FILE_BYTES;
      reserve(outputUnits * 2 + (options.redact.attachmentWorkspaceBytes || 0));
      try { redacted = options.redact(candidate); } catch { throw failure('ATTACHMENT_TEXT_LIMIT'); }
      if (typeof redacted !== 'string' || redacted.length > outputUnits || Buffer.byteLength(redacted, 'utf8') > outputBytes) throw failure('ATTACHMENT_TEXT_LIMIT');
    }
    const prefix = checkedInteger(options.prefixCodePoints ?? LIMITS.MAX_FILE_TEXT_CODEPOINTS, { min: 0, max: LIMITS.MAX_FILE_TEXT_CODEPOINTS, code: 'ATTACHMENT_TEXT_LIMIT' });
    const availableChars = countCodePoints(redacted);
    reserve(Math.min(redacted.length, prefix * 2) * 2);
    const prefixText = prefixCodePoints(redacted, prefix);
    reserve(Buffer.byteLength(prefixText, 'utf8'));
    const selectedBuffer = Buffer.allocUnsafeSlow(Buffer.byteLength(prefixText, 'utf8'));
    selectedBuffer.write(prefixText, 'utf8');
    const selected = selectedBuffer.toString('utf8'); selectedBuffer.fill(0);
    const selectedChars = countCodePoints(selected);
    const selectedBytes = Buffer.byteLength(selected, 'utf8');
    if (selectedBytes > LIMITS.MAX_FILE_BYTES) throw failure('ATTACHMENT_TEXT_LIMIT');
    return {
      text: selected, name: sanitizeName(captured.name), mimeType: 'text/plain',
      rawByteLength: bytes.length, rawDigest, extractedChars, candidateChars, availableChars,
      selectedChars, selectedBytes, selectedDigest: digest(selected), estimatedTokens: Math.ceil(selected.length / 4),
      empty: text.length === 0, truncated: selectionStart > 0 || selectionEnd < text.length || selectedChars < availableChars,
      omittedChars: Math.max(0, extractedChars - candidateChars) + availableChars - selectedChars,
      ...(range ? { range } : {}),
    };
  } finally { for (const reservation of reservations) reservation.release(); }
}

function copyAncestors(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > LIMITS.MAX_PACKAGE_JSON_NODES) throw failure();
  return Object.freeze(raw.map(value => {
    assertFields(value, ['path', 'identity'], 'ATTACHMENT_READ_DENIED');
    if (!nativeIdentity(value.identity)) throw failure();
    return Object.freeze({ path: absoluteWindowsPath(value.path, { directory: true }), identity: value.identity });
  }));
}
function compareAncestors(expected, actual) {
  if (expected && (expected.length > actual.length || expected.some((entry, index) => !samePath(entry.path, actual[index]?.path) || entry.identity !== actual[index]?.identity))) throw failure('ATTACHMENT_SOURCE_CHANGED');
}
function boundedPackage(bytes, kind) {
  if (!Buffer.isBuffer(bytes) || bytes.length > (kind === 'manifest' ? LIMITS.MAX_MANIFEST_PACKAGE_BYTES : LIMITS.MAX_BLOB_PACKAGE_BYTES)) throw failure('ATTACHMENT_CACHE_LIMIT');
  let text; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw failure('ATTACHMENT_CORRUPT'); }
  const value = parseBoundedJson(text, { maxBytes: kind === 'manifest' ? LIMITS.MAX_MANIFEST_PACKAGE_BYTES : LIMITS.MAX_BLOB_PACKAGE_BYTES });
  assertFields(value, ['formatVersion', 'cipher', 'payload'], 'ATTACHMENT_CORRUPT');
  if (value.formatVersion !== 1 || value.cipher !== 'electron-safeStorage') throw failure('ATTACHMENT_CORRUPT');
  canonicalBase64Length(value.payload, kind === 'manifest' ? LIMITS.MAX_MANIFEST_CIPHER_BYTES : LIMITS.MAX_BLOB_CIPHER_BYTES);
}
function jsonUpperBound(value) {
  if (value === null || value === undefined) return 4;
  if (typeof value === 'string') return 2 + Buffer.byteLength(value, 'utf8') * 6;
  if (typeof value === 'number' || typeof value === 'boolean') return 32;
  if (Array.isArray(value)) return 2 + value.reduce((sum, item) => sum + jsonUpperBound(item) + 1, 0);
  return 2 + Object.entries(value).reduce((sum, [key, item]) => sum + jsonUpperBound(key) + jsonUpperBound(item) + 2, 0);
}

function createAttachmentReader({ protectedPaths = [], budget = applicationBudget, backend, platform = process.platform, spawnFn = spawn, launcherPath } = {}) {
  const grants = new WeakMap(), listingGrants = new WeakMap(), scopes = new WeakMap(), files = new WeakMap();
  let inspectedRoot;
  if (!Array.isArray(protectedPaths) || typeof budget?.withWork !== 'function' || backend !== undefined && typeof backend !== 'function') throw failure();
  const protectedRoots = Object.freeze(protectedPaths.map(value => absoluteWindowsPath(value, { directory: true })));
  function denyProtected(value, root = false) {
    if (protectedRoots.some(protectedRoot => inside(protectedRoot, value) || root && inside(value, protectedRoot))) throw failure();
  }
  function sourceRequest(grant) {
    const record = grants.get(grant);
    if (!record) throw failure('ATTACHMENT_REFERENCE_INVALID');
    if (record.kind === 'external') grants.delete(grant);
    return record;
  }
  function requireScope(scope) { const record = scopes.get(scope); if (!record) throw failure('ATTACHMENT_REFERENCE_INVALID'); return record; }
  function requireFile(file) { const record = files.get(file); if (!record) throw failure('ATTACHMENT_REFERENCE_INVALID'); requireScope(record.scope); return record; }
  function fileRequest(file, operation) {
    const record = requireFile(file), scope = requireScope(record.scope);
    return { mode: 'managed', operation, root: scope.root, rootIdentity: scope.rootIdentity, expectedAncestors: scope.ancestors, blobsIdentity: scope.blobsIdentity, kind: record.kind, locator: record.locator, expectedIdentity: record.identity || '', maxBytes: record.kind === 'manifest' ? LIMITS.MAX_MANIFEST_PACKAGE_BYTES : LIMITS.MAX_BLOB_PACKAGE_BYTES };
  }
  async function invoke(request, { signal, work, inputBytes, verify, beforeCommit } = {}) {
    if (platform !== 'win32') throw failure(request.mode === 'managed' ? 'ATTACHMENT_STORAGE_UNAVAILABLE' : 'ATTACHMENT_READ_DENIED');
    checkSignal(signal); work.check();
    if (activeNativeOperation) throw failure('ATTACHMENT_CAPTURE_BUSY');
    activeNativeOperation = true;
    try {
      if (backend) {
        const nativeBuffer = work.reserve((request.maxBytes || 0) + 1);
        try { const result = await backend(request, { signal, work, inputBytes, verify, beforeCommit }); checkSignal(signal); return result; }
        catch (error) { throw failure(Object.hasOwn(ATTACHMENT_ERRORS, error?.code) ? error.code : request.mode === 'managed' ? 'ATTACHMENT_STORAGE_UNAVAILABLE' : 'ATTACHMENT_READ_DENIED'); }
        finally { nativeBuffer.release(); }
      }
      return await nativeOperation(request, { signal, work, inputBytes, verify, beforeCommit, spawnFn, launcherPath });
    } finally { activeNativeOperation = false; }
  }
  function validatedRoot(result, expectedRoot, expectedIdentity, expectedAncestors) {
    if (!samePath(result?.physicalPath, expectedRoot) || !nativeIdentity(result?.rootIdentity)) throw failure(expectedIdentity ? 'ATTACHMENT_SOURCE_CHANGED' : 'ATTACHMENT_READ_DENIED');
    if (expectedIdentity && result.rootIdentity !== expectedIdentity) throw failure('ATTACHMENT_SOURCE_CHANGED');
    const ancestors = copyAncestors(result.ancestors);
    compareAncestors(expectedAncestors, ancestors);
    if (!ancestors.some(entry => samePath(entry.path, expectedRoot) && entry.identity === result.rootIdentity)) throw failure();
    return { rootIdentity: result.rootIdentity, ancestors, physicalPath: expectedRoot };
  }
  function ownBytes(result, work, nested) {
    if (!Buffer.isBuffer(result?.bytes)) throw failure();
    let reservation;
    if (result.release) reservation = { release: result.release };
    else reservation = work.reserve(result.bytes.length);
    let retained;
    try { if (!nested) retained = budget.reserveRetained(result.bytes.length); }
    catch (error) { reservation.release(); throw error; }
    let released = false;
    return () => { if (released) return; released = true; reservation.release(); retained?.release(); };
  }
  function createProjectListingGrant(options = {}) {
    assertFields(options, ['projectRoot', 'rootIdentity', 'expectedAncestors', 'prefix', 'signal', 'work']); checkSignal(options.signal);
    const root = absoluteWindowsPath(options.projectRoot, { directory: true }); denyProtected(root, true);
    if (!nativeIdentity(options.rootIdentity)) throw failure();
    const prefix = options.prefix ?? '';
    if (typeof prefix !== 'string' || prefix.length > 32768 || /^[\\/]/.test(prefix) || /[:\u0000-\u001f\u007f]/.test(prefix)) throw failure();
    const normalized = prefix.replace(/\\/g, '/'), slash = normalized.lastIndexOf('/');
    const directoryPart = slash < 0 ? '' : normalized.slice(0, slash), namePrefix = normalized.slice(slash + 1);
    if (countCodePoints(namePrefix) > LIMITS.MAX_NAME_CODEPOINTS || /[\uD800-\uDFFF]/u.test(namePrefix)) throw failure();
    const relative = directoryPart ? normalizeRelativePath(directoryPart) : '';
    if (slash === 0 || directoryPart.endsWith('/')) throw failure();
    const directory = relative ? absoluteWindowsPath(root.replace(/\\$/, '') + '\\' + relative.replace(/\//g, '\\'), { directory: true }) : root;
    if (!inside(root, directory)) throw failure(); denyProtected(directory, true);
    const inspected = samePath(inspectedRoot?.physicalPath, root) ? inspectedRoot : undefined;
    const ancestors = options.expectedAncestors || (inspected?.rootIdentity === options.rootIdentity ? inspected.ancestors : undefined);
    const grant = Object.freeze({}); listingGrants.set(grant, { root, directory, namePrefix, rootIdentity: options.rootIdentity, ancestors: ancestors ? copyAncestors(ancestors) : undefined }); return grant;
  }
  async function listProject(grant, options = {}) {
    assertFields(options, ['signal', 'work', 'maxEntries', 'maxScanned']);
    const record = listingGrants.get(grant); if (!record) throw failure('ATTACHMENT_REFERENCE_INVALID');
    const maxEntries = checkedInteger(options.maxEntries ?? LIMITS.MAX_DIRECTORY_LIST_ENTRIES, { min: 1, max: LIMITS.MAX_DIRECTORY_LIST_ENTRIES, code: 'ATTACHMENT_READ_DENIED' });
    const maxScanned = checkedInteger(options.maxScanned ?? LIMITS.MAX_DIRECTORY_SCAN_ENTRIES, { min: 1, max: LIMITS.MAX_DIRECTORY_SCAN_ENTRIES, code: 'ATTACHMENT_READ_DENIED' });
    return budget.withWork(options, async work => {
      const metadataReservation = work.reserve(maxEntries * (LIMITS.MAX_NAME_CODEPOINTS * 4 + 128) * 4);
      try {
        const result = await invoke({ mode: 'capture', operation: 'list', root: record.root, path: record.directory, rootIdentity: record.rootIdentity, expectedAncestors: record.ancestors || [], protectedPaths: protectedRoots, namePrefix: record.namePrefix, maxEntries, maxScanned, maxBytes: 0 }, { ...options, work });
        if (!samePath(result.physicalPath, record.directory) || result.rootIdentity !== record.rootIdentity) throw failure('ATTACHMENT_SOURCE_CHANGED');
        const ancestors = copyAncestors(result.ancestors); compareAncestors(record.ancestors, ancestors);
        if (!ancestors.some(entry => samePath(entry.path, record.root) && entry.identity === record.rootIdentity) || !ancestors.some(entry => samePath(entry.path, record.directory))) throw failure('ATTACHMENT_SOURCE_CHANGED');
        if (!Array.isArray(result.entries) || result.entries.length > maxEntries || typeof result.truncated !== 'boolean') throw failure();
        const entries = result.entries.map(entry => {
          assertFields(entry, ['name', 'isDirectory'], 'ATTACHMENT_READ_DENIED');
          if (typeof entry.name !== 'string' || !entry.name || countCodePoints(entry.name) > LIMITS.MAX_NAME_CODEPOINTS || sanitizeName(entry.name) !== entry.name || entry.name !== path.win32.basename(entry.name) || entry.name === '.' || entry.name === '..' || /[:\\/]/.test(entry.name) || /[. ]$/.test(entry.name) || devices.test(entry.name) || typeof entry.isDirectory !== 'boolean') throw failure();
          return { name: entry.name, isDirectory: entry.isDirectory };
        });
        record.ancestors = ancestors; return { entries, truncated: result.truncated };
      } finally { metadataReservation.release(); }
    });
  }
  async function inspectRoot(root, options = {}) {
    const canonical = absoluteWindowsPath(root, { directory: true }); denyProtected(canonical, true);
    return budget.withWork(options, async work => {
      const result = await invoke({ mode: 'capture', operation: 'inspect', root: canonical, protectedPaths: protectedRoots, maxBytes: 0 }, { ...options, work });
      const checked = Object.freeze(validatedRoot(result, canonical));
      inspectedRoot = checked;
      return checked;
    });
  }
  function createExternalGrant(source, options = {}) {
    assertFields(options, ['signal', 'work']); checkSignal(options.signal);
    const canonical = absoluteWindowsPath(source); denyProtected(canonical);
    const grant = Object.freeze({}); grants.set(grant, { kind: 'external', path: canonical, root: path.win32.dirname(canonical) }); return grant;
  }
  function createProjectGrant(options) {
    assertFields(options, ['projectRoot', 'relativePath', 'rootIdentity', 'expectedIdentity', 'expectedAncestors', 'ancestors', 'expectedDigest', 'rawDigest', 'startLine', 'endLine', 'signal', 'work']);
    checkSignal(options.signal);
    const root = absoluteWindowsPath(options.projectRoot, { directory: true }); denyProtected(root, true);
    if (typeof options.rootIdentity !== 'string' || !options.rootIdentity || options.rootIdentity.length > 128) throw failure();
    const relativePath = normalizeRelativePath(options.relativePath);
    const source = absoluteWindowsPath(root.replace(/\\$/, '') + '\\' + relativePath.replace(/\//g, '\\'));
    if (!inside(root, source) || samePath(root, source)) throw failure(); denyProtected(source);
    const range = normalizeLineRange({ startLine: options.startLine, endLine: options.endLine });
    if (options.expectedIdentity !== undefined && !nativeIdentity(options.expectedIdentity)) throw failure();
    const expectedDigest = options.expectedDigest ?? options.rawDigest;
    if (expectedDigest !== undefined && !/^[a-f0-9]{64}$/.test(expectedDigest)) throw failure();
    const inspected = samePath(inspectedRoot?.physicalPath, root) ? inspectedRoot : undefined;
    const ancestors = options.expectedAncestors || options.ancestors || (inspected?.rootIdentity === options.rootIdentity ? inspected.ancestors : undefined);
    const grant = Object.freeze({});
    grants.set(grant, { kind: 'project', root, path: source, relativePath, rootIdentity: options.rootIdentity, identity: options.expectedIdentity, ancestors: ancestors ? copyAncestors(ancestors) : undefined, rawDigest: expectedDigest, range });
    return grant;
  }
  async function capture(grant, options = {}) {
    assertFields(options, ['signal', 'work', 'maxBytes']);
    const record = sourceRequest(grant);
    const maxBytes = checkedInteger(options.maxBytes ?? LIMITS.MAX_FILE_BYTES, { min: 0, max: LIMITS.MAX_FILE_BYTES, code: 'ATTACHMENT_FILE_LIMIT' });
    return budget.withWork(options, async work => {
      const result = await invoke({ mode: 'capture', operation: 'read', path: record.path, root: record.root, rootIdentity: record.rootIdentity || '', expectedIdentity: record.identity || '', expectedAncestors: record.ancestors || [], expectedDigest: record.rawDigest || '', protectedPaths: protectedRoots, maxBytes }, { ...options, work });
      let release;
      try {
        if (!Buffer.isBuffer(result.bytes) || result.bytes.length > maxBytes) throw failure('ATTACHMENT_FILE_LIMIT');
        if (!samePath(result.physicalPath, record.path) || !nativeIdentity(result.identity) || !nativeIdentity(result.rootIdentity)) throw failure('ATTACHMENT_READ_DENIED');
        const ancestors = copyAncestors(result.ancestors); compareAncestors(record.ancestors, ancestors);
        if (record.rootIdentity && record.rootIdentity !== result.rootIdentity || record.identity && record.identity !== result.identity) throw failure('ATTACHMENT_SOURCE_CHANGED');
        const rawDigest = digest(result.bytes);
        if (result.rawDigest !== rawDigest || record.rawDigest && record.rawDigest !== rawDigest) throw failure('ATTACHMENT_SOURCE_CHANGED');
        if (!ancestors.some(entry => samePath(entry.path, record.root) && entry.identity === result.rootIdentity)) throw failure();
        release = ownBytes(result, work, options.work !== undefined && options.work !== null);
        // The first project snapshot fixes every source ancestor and full hash.
        if (record.kind === 'project') { record.identity = result.identity; record.ancestors = ancestors; record.rawDigest = rawDigest; }
        return { bytes: result.bytes, name: sanitizeName(path.win32.basename(record.path)), identity: result.identity, ancestors, rootIdentity: result.rootIdentity, rawDigest, rawByteLength: result.bytes.length, sourceKind: record.kind === 'external' ? 'user_upload' : 'at_project_ref', ...(record.kind === 'project' ? { relativePath: record.relativePath, projectRoot: record.root, range: record.range } : {}), release };
      } catch (error) { release?.(); if (!release) result.release?.(); throw error; }
    });
  }
  async function createManagedScope(root, options = {}) {
    const canonical = absoluteWindowsPath(root, { directory: true });
    if (path.win32.basename(canonical).toLowerCase() !== 'attachments-v1') throw failure('ATTACHMENT_STORAGE_UNAVAILABLE');
    return budget.withWork(options, async work => {
      const result = await invoke({ mode: 'managed', operation: 'scope', root: canonical, maxBytes: 0 }, { ...options, work });
      const checked = validatedRoot(result, canonical);
      if (result.durableAtomic !== true || !nativeIdentity(result.blobsIdentity)) throw failure('ATTACHMENT_STORAGE_UNAVAILABLE');
      const scope = Object.freeze({}); scopes.set(scope, { root: canonical, ...checked, blobsIdentity: result.blobsIdentity }); return scope;
    });
  }
  function createManagedFile(scope, options = {}) {
    const checked = requireScope(scope); assertFields(options, ['kind', 'locator', 'expectedIdentity']);
    const kind = options.kind;
    if (!['blob', 'manifest', 'temporary'].includes(kind)) throw failure('ATTACHMENT_REFERENCE_INVALID');
    const locator = options.locator ?? (kind === 'manifest' ? 'manifest.enc.json' : crypto.randomBytes(16).toString('hex') + '.enc.json');
    if (kind === 'manifest' ? locator !== 'manifest.enc.json' : kind === 'temporary' ? !/^\.stage-[a-f0-9]{32}\.enc\.json$/.test(locator) : !/^[a-f0-9]{32}\.enc\.json$/.test(locator)) throw failure('ATTACHMENT_REFERENCE_INVALID');
    if (options.expectedIdentity !== undefined && !nativeIdentity(options.expectedIdentity)) throw failure('ATTACHMENT_REFERENCE_INVALID');
    const file = Object.freeze({}); files.set(file, { scope, kind, locator, identity: options.expectedIdentity, rootIdentity: checked.rootIdentity }); return file;
  }
  function managedLocator(file) { return requireFile(file).locator; }
  async function readManaged(file, options = {}) {
    const request = fileRequest(file, 'read');
    return budget.withWork(options, async work => {
      const result = await invoke(request, { ...options, work });
      if (!Buffer.isBuffer(result.bytes) || result.bytes.length > request.maxBytes || !nativeIdentity(result.identity)) { result.release?.(); throw failure('ATTACHMENT_CORRUPT'); }
      if (request.expectedIdentity && request.expectedIdentity !== result.identity) { result.release?.(); throw failure('ATTACHMENT_CORRUPT'); }
      const release = ownBytes(result, work, options.work !== undefined && options.work !== null);
      requireFile(file).identity = result.identity;
      return { bytes: result.bytes, identity: result.identity, release };
    });
  }
  async function atomicWriteManaged(file, bytes, options = {}) {
    assertFields(options, ['verify', 'signal', 'work', 'beforeCommit']);
    const request = fileRequest(file, 'write');
    if (typeof options.verify !== 'function') throw failure('ATTACHMENT_STORAGE_UNAVAILABLE');
    return budget.withWork(options, async work => {
      checkSignal(options.signal); work.check();
      const packageCopies = work.reserve(bytes?.length ? bytes.length * 3 : 0);
      try {
        boundedPackage(bytes, request.kind);
        const result = await invoke({ ...request, bodyLength: bytes.length }, { ...options, work, inputBytes: bytes, verify: async captured => {
          checkSignal(options.signal); work.check();
          await options.verify(captured);
          checkSignal(options.signal); work.check();
          if (options.beforeCommit) { if (await options.beforeCommit() === false) throw failure('ABORTED'); checkSignal(options.signal); work.check(); }
        } });
        if (!nativeIdentity(result?.identity)) throw failure('ATTACHMENT_STORAGE_UNAVAILABLE');
        requireFile(file).identity = result.identity; return result.identity;
      } finally { packageCopies.release(); }
    });
  }
  async function deleteManaged(file, options = {}) {
    const request = fileRequest(file, 'delete');
    if (!request.expectedIdentity) throw failure('ATTACHMENT_REFERENCE_INVALID');
    return budget.withWork(options, async work => { await invoke(request, { ...options, work }); requireFile(file).identity = undefined; return true; });
  }
  async function listManaged(scope, options = {}) {
    const record = requireScope(scope);
    const maxEntries = checkedInteger(options.maxEntries ?? LIMITS.MAX_CACHE_RECORDS, { min: 1, max: LIMITS.MAX_PACKAGE_JSON_NODES, code: 'ATTACHMENT_CACHE_LIMIT' });
    return budget.withWork(options, async work => {
      const result = await invoke({ mode: 'managed', operation: 'list', root: record.root, rootIdentity: record.rootIdentity, expectedAncestors: record.ancestors, blobsIdentity: record.blobsIdentity, maxEntries, maxBytes: 0 }, { ...options, work });
      if (!Array.isArray(result.entries) || result.entries.length > maxEntries) throw failure('ATTACHMENT_CACHE_LIMIT');
      return result.entries.map(entry => {
        assertFields(entry, ['kind', 'locator', 'identity', 'size'], 'ATTACHMENT_CORRUPT');
        const file = createManagedFile(scope, { kind: entry.kind, locator: entry.locator, expectedIdentity: entry.identity });
        checkedInteger(entry.size, { min: 0, max: Number.MAX_SAFE_INTEGER, code: 'ATTACHMENT_CACHE_LIMIT' });
        return { kind: entry.kind, locator: managedLocator(file), identity: entry.identity, size: entry.size };
      });
    });
  }
  return Object.freeze({ inspectRoot, createProjectListingGrant, listProject, createExternalGrant, createProjectGrant, capture, createManagedScope, createManagedFile, managedLocator, readManaged, atomicWriteManaged, deleteManaged, listManaged });
}

async function nativeOperation(request, { signal, work, inputBytes, verify, spawnFn, launcherPath }) {
  const managed = request.mode === 'managed';
  const defaultCode = managed ? 'ATTACHMENT_STORAGE_UNAVAILABLE' : 'ATTACHMENT_READ_DENIED';
  let executable, environment;
  try {
    const native = require('./windows-isolation');
    executable = native.getVerifiedNativeLauncher(); environment = native.helperEnvironment();
    if (launcherPath !== undefined && !samePath(path.win32.resolve(launcherPath), path.win32.resolve(executable))) throw failure(defaultCode);
  } catch { throw failure(defaultCode); }
  const maximum = request.maxBytes || 0;
  const requestBound = jsonUpperBound(request);
  if (requestBound > LIMITS.MAX_REQUEST_BYTES) throw failure(defaultCode);
  const inputReservation = work.reserve(requestBound * 3 + 4);
  const nativeReservation = work.reserve(maximum + 1);
  let encoded;
  try {
    const text = JSON.stringify(request);
    if (Buffer.byteLength(text) > LIMITS.MAX_REQUEST_BYTES) throw failure(defaultCode);
    encoded = Buffer.from(text, 'utf8');
  } catch (error) { inputReservation.release(); nativeReservation.release(); throw error; }
  return new Promise((resolve, reject) => {
    let child, closed = false, stoppedCode, protocolCode, final, staged = false, processing = false;
    let header = Buffer.alloc(16), headerUsed = 0, metadata, metadataUsed = 0, body, bodyUsed = 0, metaReservation, bodyReservation;
    let parsed, verifying = Promise.resolve(), receivedBytes = 0, stderrBytes = 0;
    const pendingReleases = [];
    let cleanupTimer;
    const discardCurrent = () => { metaReservation?.release(); bodyReservation?.release(); metaReservation = bodyReservation = undefined; metadata = body = parsed = undefined; headerUsed = metadataUsed = bodyUsed = 0; };
    const stop = code => {
      stoppedCode ||= code;
      try { child?.stdin.write(Buffer.from([0])); } catch { /* close owns resolution */ }
      // Capture has no children, ACL changes, shell, or source writes. The OS
      // closes every pin on process termination; staged ciphertext is native
      // delete-on-close until the commit handshake has completed.
      cleanupTimer ||= setTimeout(() => { try { child?.kill(); } catch { /* await close */ } }, 250);
    };
    const onAbort = () => stop('ABORTED');
    const timeout = setTimeout(() => stop('ATTACHMENT_CAPTURE_TIMEOUT'), LIMITS.CAPTURE_TIMEOUT_MS);
    const failProtocol = () => { protocolCode ||= defaultCode; stop(protocolCode); };
    const acceptFrame = () => {
      const frame = parsed, frameBytes = body || Buffer.alloc(0), reservation = bodyReservation;
      const release = () => reservation?.release();
      metaReservation?.release(); metaReservation = bodyReservation = undefined;
      metadata = body = parsed = undefined; headerUsed = metadataUsed = bodyUsed = 0;
      if (frame?.version !== 1 || frame.mode !== request.mode || frame.operation !== request.operation || typeof frame.ok !== 'boolean') { release(); failProtocol(); return; }
      if (frame.type === 'staged' && managed && request.operation === 'write' && !staged && frame.ok && typeof verify === 'function' && frameBytes.length === inputBytes.length && frame.rawDigest === digest(frameBytes) && nativeIdentity(frame.identity)) {
        staged = true; processing = true;
        verifying = Promise.resolve().then(async () => {
          checkSignal(signal); work.check();
          await verify({ bytes: frameBytes, identity: frame.identity, rawDigest: frame.rawDigest });
          checkSignal(signal); work.check();
          if (stoppedCode || closed) throw failure(stoppedCode || 'ABORTED');
          child.stdin.write(Buffer.from([1]));
        }).catch(error => { protocolCode ||= Object.hasOwn(ATTACHMENT_ERRORS, error?.code) ? error.code : 'ATTACHMENT_CORRUPT'; stop(protocolCode); }).finally(() => { release(); processing = false; });
        return;
      }
      if (frame.type !== 'result' || final || frame.cleanupComplete !== true || request.operation === 'write' && frame.ok && !staged) { release(); failProtocol(); return; }
      if (!frame.ok && frameBytes.length) { release(); failProtocol(); return; }
      final = { ...frame, bytes: frameBytes, release };
      pendingReleases.push(release);
    };
    const consume = chunk => {
      if (stoppedCode || final || processing) { if (chunk.length && !stoppedCode) failProtocol(); return; }
      receivedBytes += chunk.length;
      // A write has two metadata frames but only one bounded package body.
      if (receivedBytes > maximum + 2 * LIMITS.MAX_REQUEST_BYTES + 32) { failProtocol(); return; }
      let offset = 0;
      while (offset < chunk.length && !stoppedCode) {
        if (headerUsed < 16) {
          const count = Math.min(16 - headerUsed, chunk.length - offset); chunk.copy(header, headerUsed, offset, offset + count); headerUsed += count; offset += count;
          if (headerUsed < 16) continue;
          if (!header.subarray(0, 8).equals(MAGIC)) { failProtocol(); break; }
          const metaLength = header.readUInt32LE(8), bodyLength = header.readUInt32LE(12);
          if (!metaLength || metaLength > LIMITS.MAX_REQUEST_BYTES || bodyLength > maximum) { failProtocol(); break; }
          try { metaReservation = work.reserve(metaLength * 4); bodyReservation = work.reserve(bodyLength); metadata = Buffer.alloc(metaLength); body = Buffer.alloc(bodyLength); }
          catch (error) { protocolCode = error.code || defaultCode; stop(protocolCode); break; }
        }
        if (metadataUsed < metadata.length) {
          const count = Math.min(metadata.length - metadataUsed, chunk.length - offset); chunk.copy(metadata, metadataUsed, offset, offset + count); metadataUsed += count; offset += count;
          if (metadataUsed < metadata.length) continue;
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(metadata);
            parsed = parseBoundedJson(text, { maxBytes: LIMITS.MAX_REQUEST_BYTES });
          } catch { failProtocol(); break; }
        }
        if (bodyUsed < body.length) {
          const count = Math.min(body.length - bodyUsed, chunk.length - offset); chunk.copy(body, bodyUsed, offset, offset + count); bodyUsed += count; offset += count;
          if (bodyUsed < body.length) continue;
        }
        acceptFrame();
        if (processing || final) { if (offset < chunk.length) failProtocol(); break; }
      }
    };
    const settle = async (exit, launchError) => {
      if (closed) return; closed = true;
      clearTimeout(timeout); clearTimeout(cleanupTimer); signal?.removeEventListener('abort', onAbort);
      await verifying;
      inputReservation.release(); nativeReservation.release(); discardCurrent();
      const code = stoppedCode || protocolCode || (launchError || exit !== 0 || !final ? defaultCode : !final.ok ? Object.hasOwn(ATTACHMENT_ERRORS, final.code) ? final.code : defaultCode : undefined);
      if (code) { for (const release of pendingReleases) release(); reject(failure(code)); }
      else resolve(final);
    };
    try {
      child = spawnFn(executable, [managed ? '--managed-file' : '--capture-file'], { cwd: path.win32.dirname(executable), env: environment, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => {}); child.stdout.on('data', consume);
      child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > LIMITS.MAX_REQUEST_BYTES) failProtocol(); });
      child.on('error', error => { protocolCode ||= defaultCode; if (!child.pid) void settle(null, error); else stop(defaultCode); });
      child.on('close', exit => { void settle(exit); });
      const length = Buffer.alloc(4); length.writeUInt32LE(encoded.length); child.stdin.write(length); child.stdin.write(encoded);
      if (inputBytes) child.stdin.write(inputBytes);
      signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort();
    } catch (error) { void settle(null, error); }
  });
}

module.exports = { createAttachmentReader, extractText, validateTextType, validateLineRange: normalizeLineRange };
