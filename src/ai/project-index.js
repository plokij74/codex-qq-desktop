'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { walkFiles, matchGlob } = require('./search');
const { loadGitignoreRules } = require('./gitignore');
const { resolveSafe } = require('./project-fs');

const MAX_FILE_BYTES = Math.floor(1.5 * 1024 * 1024);
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 25000;
const MAX_SYMBOLS = 250000;
const MAX_TERM_POSITIONS = 500000;
const MAX_QUERY_LENGTH = 256;
const MAX_RESULTS = 100;
const MAX_SNIPPET = 240;
const MAX_LOCATION_BYTES = 32 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const STORE_VERSION = 1;

const LANGUAGE_BY_EXT = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.json': 'json', '.css': 'css', '.scss': 'css', '.md': 'markdown', '.markdown': 'markdown',
  '.yaml': 'yaml', '.yml': 'yaml', '.html': 'html', '.htm': 'html', '.sql': 'sql',
  '.sh': 'shell', '.bash': 'shell', '.ps1': 'shell', '.txt': 'text',
};
const CODE_LANGUAGES = new Set(['javascript', 'typescript', 'python', 'go', 'rust', 'java']);

function canonicalProjectPath(projectPath) {
  const raw = String(projectPath || '').trim();
  if (!raw) return '';
  const resolved = path.resolve(raw);
  let canonical;
  try { canonical = fs.realpathSync.native(resolved); } catch { canonical = resolved; }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function projectKey(projectPath) {
  const canonical = canonicalProjectPath(projectPath);
  return canonical ? crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32) : '';
}

function fingerprintFile(fullPath, includeHash = false) {
  const st = fs.statSync(fullPath);
  const fp = { size: st.size, mtimeMs: Number(st.mtimeMs) || 0 };
  if (includeHash) fp.sha256 = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
  return fp;
}

function lineColumn(text, offset) {
  const before = text.slice(0, offset);
  const line = (before.match(/\n/g) || []).length + 1;
  const last = before.lastIndexOf('\n');
  return { line, column: offset - (last < 0 ? 0 : last + 1) + 1 };
}

function declaration(text, name, kind, role, offset) {
  const p = lineColumn(text, offset);
  return { name, kind, role, line: p.line, column: p.column, confidence: 'lexical' };
}

function extractSymbols(text, language) {
  const out = [];
  const add = (re, kind, role = 'definition', group = 1) => {
    let m;
    while ((m = re.exec(text))) {
      const name = m[group];
      if (!name) continue;
      const at = m.index + m[0].indexOf(name);
      out.push(declaration(text, name, kind, role, at));
    }
  };
  if (language === 'javascript' || language === 'typescript') {
    add(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, 'function');
    add(/\bclass\s+([A-Za-z_$][\w$]*)/g, 'class');
    add(/\binterface\s+([A-Za-z_$][\w$]*)/g, 'interface');
    add(/\btype\s+([A-Za-z_$][\w$]*)/g, 'type');
    add(/\benum\s+([A-Za-z_$][\w$]*)/g, 'enum');
    add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g, 'variable');
    add(/\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g, 'import', 'import');
    add(/\bimport\s+(?:type\s+)?(?:\{\s*)?([A-Za-z_$][\w$]*)/g, 'import', 'import');
    add(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)?\s*([A-Za-z_$][\w$]*)/g, 'export', 'export');
  } else if (language === 'python') {
    add(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, 'function');
    add(/^\s*class\s+([A-Za-z_]\w*)/gm, 'class');
    add(/^\s*(?:from\s+\S+\s+)?import\s+([A-Za-z_]\w*)/gm, 'import', 'import');
  } else if (language === 'go') {
    add(/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g, 'function');
    add(/\btype\s+([A-Za-z_]\w*)\s+(?:struct|interface)/g, 'type');
    add(/^\s*package\s+([A-Za-z_]\w*)/gm, 'package');
    add(/^\s*import\s+"([^"]+)"/gm, 'import', 'import');
    add(/^\s*(?:[A-Za-z_]\w*\s+)?"([^"]+)"/gm, 'import', 'import');
  } else if (language === 'rust') {
    add(/\b(?:pub\s+)?fn\s+([A-Za-z_]\w*)/g, 'function');
    add(/\b(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/g, 'type');
    add(/\bmod\s+([A-Za-z_]\w*)/g, 'module');
    add(/\buse\s+([^;\s]+)/g, 'import', 'import');
  } else if (language === 'java') {
    add(/\b(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/g, 'type');
    add(/\b(?:public|private|protected|static|final|abstract|synchronized|native|strictfp|\s)+[A-Za-z_][\w<>\[\], ?]*\s+([A-Za-z_]\w*)\s*\(/g, 'method');
    add(/^\s*package\s+([\w.]+)/gm, 'package');
    add(/^\s*import\s+([\w.]+)/gm, 'import', 'import');
  }
  return out.slice(0, MAX_SYMBOLS);
}

function extractTerms(text) {
  const terms = [];
  // Keep the lexical index useful for source files and human-authored docs:
  // Unicode identifiers/words are terms too, while punctuation remains a
  // separator. This is deliberately still lexical, not tokenization/AST.
  const re = /[\p{L}\p{N}_$][\p{L}\p{N}_$-]*/gu;
  let m;
  while ((m = re.exec(text)) && terms.length < MAX_TERM_POSITIONS) {
    const p = lineColumn(text, m.index);
    terms.push({ term: m[0].toLowerCase(), line: p.line, column: p.column });
  }
  return terms;
}

function fileLanguage(rel) {
  return LANGUAGE_BY_EXT[path.extname(rel).toLowerCase()] || 'text';
}

function resolveIndexedFile(root, relPath) {
  try {
    const full = resolveSafe(root, relPath);
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink()) return '';
    const real = canonicalProjectPath(full);
    const canonicalRoot = canonicalProjectPath(root);
    const rel = path.relative(canonicalRoot, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return '';
    return full;
  } catch { return ''; }
}

function safeSnippet(root, relPath, line, max = MAX_SNIPPET) {
  try {
    const fullPath = resolveIndexedFile(root, relPath);
    if (!fullPath) return '';
    const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
    return String(lines[Math.max(0, Number(line) - 1)] || '').slice(0, max);
  } catch { return ''; }
}

function cleanRecord(record) {
  const symbols = Array.isArray(record.symbols) ? record.symbols.slice(0, MAX_SYMBOLS).map((item) => ({
    name: String(item?.name || '').slice(0, 240),
    kind: String(item?.kind || 'symbol').slice(0, 40),
    role: ['definition', 'reference', 'import', 'export'].includes(item?.role) ? item.role : 'reference',
    line: Math.max(1, Math.floor(Number(item?.line) || 1)),
    column: Math.max(1, Math.floor(Number(item?.column) || 1)),
    ...(Number.isFinite(Number(item?.endLine)) ? { endLine: Math.max(1, Math.floor(Number(item.endLine))) } : {}),
    ...(Number.isFinite(Number(item?.endColumn)) ? { endColumn: Math.max(1, Math.floor(Number(item.endColumn))) } : {}),
    confidence: 'lexical',
  })).filter((item) => item.name) : [];
  const terms = Array.isArray(record.terms) ? record.terms.slice(0, MAX_TERM_POSITIONS).map((item) => ({
    term: String(item?.term || '').slice(0, 240).toLowerCase(),
    line: Math.max(1, Math.floor(Number(item?.line) || 1)),
    column: Math.max(1, Math.floor(Number(item?.column) || 1)),
  })).filter((item) => item.term) : [];
  return {
    path: String(record.path || '').replace(/\\/g, '/'),
    language: String(record.language || 'text'),
    fingerprint: { size: Number(record.fingerprint?.size) || 0, mtimeMs: Number(record.fingerprint?.mtimeMs) || 0, ...(record.fingerprint?.sha256 ? { sha256: String(record.fingerprint.sha256) } : {}) },
    symbols,
    terms,
  };
}

function makeError(code, message) { const e = new Error(message || code); e.code = code; return e; }

class ProjectIndex {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.root = options.projectPath ? canonicalProjectPath(options.projectPath) : '';
    this.key = this.root ? projectKey(this.root) : '';
    this.enabled = options.enabled !== false;
    this.records = new Map();
    this.state = 'idle';
    this.error = null; this.errorCode = null;
    this.truncated = false;
    this.counts = { files: 0, symbols: 0, terms: 0, skipped: 0, bytes: 0 };
    this.buildPromise = null;
    this.watcher = null;
    this.watchTimer = null;
    this.lastUpdatedAt = null;
    this.gitignoreMtimeMs = 0;
    this.storePath = options.storePath || '';
    this.safeStorage = options.safeStorage === undefined ? (() => { try { return require('electron').safeStorage; } catch { return null; } })() : options.safeStorage;
    this.persistenceMode = this.canEncrypt() ? 'encrypted' : 'memory';
    this.closed = false;
    this._loadCache();
  }

  canEncrypt() { try { const s = this.safeStorage; return !!(s && s.isEncryptionAvailable?.() && s.encryptString && s.decryptString); } catch { return false; } }

  _loadCache() {
    if (!this.storePath || this.persistenceMode !== 'encrypted') return;
    if (!this.fs.existsSync(this.storePath)) return;
    try {
      const env = JSON.parse(this.fs.readFileSync(this.storePath, 'utf8'));
      if (env.version !== STORE_VERSION || env.cipher !== 'electron-safeStorage') throw makeError('INDEX_STORE_CORRUPT', '索引缓存损坏');
      const payload = this.safeStorage.decryptString(Buffer.from(String(env.payload || ''), 'base64'));
      const parsed = JSON.parse(payload);
      if (parsed.projectKey !== this.key) return;
      this.gitignoreMtimeMs = Number(parsed.gitignoreMtimeMs) || 0;
      let loadedSymbols = 0; let loadedTerms = 0; let loadedBytes = 0;
      for (const item of (Array.isArray(parsed.records) ? parsed.records : []).slice(0, MAX_FILES)) {
        const record = cleanRecord(item);
        if (!record.path || record.path.startsWith('/') || record.path.split('/').includes('..')) continue;
        if (loadedBytes + record.fingerprint.size > MAX_TOTAL_BYTES) { this.truncated = true; break; }
        const nextSymbols = loadedSymbols + record.symbols.length;
        const nextTerms = loadedTerms + record.terms.length;
        if (nextSymbols > MAX_SYMBOLS || nextTerms > MAX_TERM_POSITIONS) { this.truncated = true; break; }
        this.records.set(record.path, record);
        loadedSymbols = nextSymbols; loadedTerms = nextTerms; loadedBytes += record.fingerprint.size;
      }
      this._recount(); this.state = this.records.size ? 'stale' : 'idle';
    } catch (e) {
      this.errorCode = 'INDEX_STORE_CORRUPT';
      this.error = e.code === 'INDEX_STORE_CORRUPT' ? e.message : '索引缓存不可用';
      this.state = 'error';
      // Preserve the unreadable envelope for diagnosis. This index can still
      // rebuild and serve from memory, but must not replace the corrupt file.
      this.persistenceMode = 'memory';
    }
  }

  _persist() {
    // A build that was already in flight when the app quit must not write to
    // the store afterwards; the record it holds is no longer authoritative.
    if (this.closed || !this.storePath || this.persistenceMode !== 'encrypted') return;
    try {
      const plain = JSON.stringify({ version: STORE_VERSION, projectKey: this.key, gitignoreMtimeMs: this.gitignoreMtimeMs, records: [...this.records.values()].map(cleanRecord) });
      if (Buffer.byteLength(plain, 'utf8') > MAX_CACHE_BYTES) { this.truncated = true; if (this.state === 'ready') this.state = 'stale'; return; }
      const encrypted = this.safeStorage.encryptString(plain);
      const temp = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        this.fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
        this.fs.writeFileSync(temp, JSON.stringify({ version: STORE_VERSION, cipher: 'electron-safeStorage', payload: Buffer.from(encrypted).toString('base64') }), 'utf8');
        this.fs.renameSync(temp, this.storePath);
      } finally {
        try { if (this.fs.existsSync(temp)) this.fs.unlinkSync(temp); } catch {}
      }
    } catch { this.persistenceMode = 'memory'; this.errorCode = 'INDEX_STORE_UNAVAILABLE'; this.error = '索引缓存不可用'; }
  }

  _recount() {
    this.counts = { files: this.records.size, symbols: 0, terms: 0, skipped: this.counts.skipped || 0, bytes: 0 };
    for (const r of this.records.values()) { this.counts.symbols += r.symbols.length; this.counts.terms += r.terms.length; this.counts.bytes += r.fingerprint.size; }
  }

  _buildSync(force = false) {
    if (!this.enabled) throw makeError('INDEX_DISABLED', '代码索引未启用');
    if (!this.root || !this.fs.existsSync(this.root)) throw makeError('ENGINEERING_PROJECT_BINDING_INVALID', '项目绑定无效');
    this.state = 'building'; this.error = null; this.errorCode = null; this.truncated = false; this.counts.skipped = 0;
    const next = force ? new Map() : new Map(this.records);
    const seen = new Set(); let total = 0; let files = 0; let symbols = 0; let terms = 0;
    const rules = loadGitignoreRules(this.root);
    try { this.gitignoreMtimeMs = Number(this.fs.statSync(path.join(this.root, '.gitignore')).mtimeMs) || 0; } catch { this.gitignoreMtimeMs = 0; }
    const completed = walkFiles(this.root, { ignoreRules: rules, onFile: (rel, full, st) => {
      if (files >= MAX_FILES || total >= MAX_TOTAL_BYTES || total + Number(st.size || 0) > MAX_TOTAL_BYTES) { this.truncated = true; return false; }
      seen.add(rel); files += 1;
      if (st.size > MAX_FILE_BYTES) { this.counts.skipped += 1; next.delete(rel); return true; }
      let buffer; let fp;
      try {
        buffer = this.fs.readFileSync(full);
        fp = {
          size: buffer.length,
          mtimeMs: Number(st.mtimeMs) || 0,
          sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        };
      } catch { this.counts.skipped += 1; next.delete(rel); return true; }
      total += fp.size;
      const old = this.records.get(rel);
      if (!force && old?.fingerprint?.sha256 === fp.sha256) {
        next.set(rel, { ...old, fingerprint: fp });
        symbols += old.symbols.length;
        terms += old.terms.length;
        return true;
      }
      const text = buffer.toString('utf8');
      // Node replaces malformed UTF-8 with U+FFFD when decoding; treat that
      // as binary/undecodable rather than indexing replacement text.
      if (text.includes('\0') || text.includes('\ufffd')) { this.counts.skipped += 1; next.delete(rel); return true; }
      const language = fileLanguage(rel);
      const parsedSymbols = extractSymbols(text, language);
      const parsedTerms = extractTerms(text);
      // Add lexical references for names declared in this file. This is
      // deliberately token-based and does not claim semantic binding.
      const definitions = new Map(parsedSymbols.filter((s) => s.role === 'definition').map((s) => [s.name.toLowerCase(), s]));
      for (const term of parsedTerms) {
        const def = definitions.get(term.term); if (!def) continue;
        if (def.line === term.line && def.column === term.column) continue;
        parsedSymbols.push({ name: def.name, kind: def.kind, role: 'reference', line: term.line, column: term.column, confidence: 'lexical' });
        if (parsedSymbols.length >= MAX_SYMBOLS) break;
      }
      const availableSymbols = Math.max(0, MAX_SYMBOLS - symbols);
      const availableTerms = Math.max(0, MAX_TERM_POSITIONS - terms);
      const rec = { path: rel, language, fingerprint: fp, symbols: parsedSymbols.slice(0, availableSymbols), terms: parsedTerms.slice(0, availableTerms) };
      next.set(rel, rec); symbols += rec.symbols.length; terms += rec.terms.length;
      if (rec.symbols.length < parsedSymbols.length || rec.terms.length < parsedTerms.length || symbols >= MAX_SYMBOLS || terms >= MAX_TERM_POSITIONS) this.truncated = true;
      return !this.truncated;
    }});
    if (completed !== false) for (const rel of next.keys()) if (!seen.has(rel)) next.delete(rel);
    this.records = next; this._recount();
    if (this.counts.symbols > MAX_SYMBOLS || this.counts.terms > MAX_TERM_POSITIONS) this.truncated = true;
    this.state = this.truncated ? 'stale' : 'ready'; this.lastUpdatedAt = new Date().toISOString(); this._persist();
    return this.status();
  }

  _startBuild(force) {
    this.buildPromise = Promise.resolve()
      .then(() => this._buildSync(force))
      .catch((e) => {
        this.state = 'error';
        this.errorCode = e.code || 'INDEX_BUILDING';
        this.error = String(e.message || e).slice(0, 500);
        throw e;
      })
      .finally(() => { this.buildPromise = null; });
    return this.buildPromise;
  }

  ensure(projectPath) {
    if (projectPath) this.setProject(projectPath);
    if (this.buildPromise) return this.buildPromise;
    let force = false;
    try { force = (Number(this.fs.statSync(path.join(this.root, '.gitignore')).mtimeMs) || 0) !== this.gitignoreMtimeMs; } catch { force = this.gitignoreMtimeMs !== 0; }
    return this._startBuild(force);
  }
  rebuild(projectPath) { if (projectPath) this.setProject(projectPath); if (this.buildPromise) return this.buildPromise; return this._startBuild(true); }
  clear() { this.stopWatcher(); this.records.clear(); this._recount(); this.state = 'idle'; this.truncated = false; this.error = null; this.errorCode = null; if (this.storePath && this.persistenceMode === 'encrypted') { try { this.fs.unlinkSync(this.storePath); } catch {} } return this.status(); }

  startWatcher() {
    if (this.watcher || !this.root || !this.fs.watch) return;
    try { this.watcher = this.fs.watch(this.root, { recursive: true }, (_event, filename) => { clearTimeout(this.watchTimer); this.watchTimer = setTimeout(() => { this.state = 'stale'; const changedIgnore = String(filename || '').replace(/\\/g, '/') === '.gitignore'; (changedIgnore ? this.rebuild() : this.ensure()).catch(() => {}); }, 500); }); } catch { this.watcher = null; }
  }
  stopWatcher() { if (this.watchTimer) clearTimeout(this.watchTimer); this.watchTimer = null; try { this.watcher?.close(); } catch {} this.watcher = null; }

  status() { return { ok: true, state: this.state, counts: { ...this.counts }, files: this.counts.files, symbols: this.counts.symbols, terms: this.counts.terms, truncated: this.truncated, lastUpdatedAt: this.lastUpdatedAt, error: this.error, errorCode: this.errorCode, persistence: this.persistenceMode }; }

  search({ mode = 'text', query = '', pathGlob, language, maxResults = MAX_RESULTS } = {}) {
    if (!['definitions', 'references', 'text'].includes(mode)) throw makeError('INDEX_QUERY_INVALID', '查询模式无效');
    const q = String(query || '').trim(); if (!q || q.length > MAX_QUERY_LENGTH) throw makeError('INDEX_QUERY_INVALID', '查询字符串无效');
    const max = Math.max(1, Math.min(MAX_RESULTS, Number(maxResults) || MAX_RESULTS)); const needle = q.toLowerCase(); const out = []; const seen = new Set();
    const addResult = (result) => {
      const key = `${result.path}\0${result.line}\0${result.column}`;
      if (!seen.has(key)) { seen.add(key); out.push(result); }
    };
    for (const rec of this.records.values()) {
      if (pathGlob && !matchGlob(rec.path, pathGlob)) continue; if (language && rec.language !== String(language)) continue;
      if (mode === 'text') {
        for (const t of rec.terms) {
          if (t.term.includes(needle)) {
            addResult({ path: rec.path, line: t.line, column: t.column, name: t.term, role: 'reference', confidence: 'lexical', snippet: safeSnippet(this.root, rec.path, t.line) });
          }
        }
      } else if (mode === 'definitions') {
        for (const s of rec.symbols) {
          if (s.name.toLowerCase().includes(needle) && s.role === 'definition') addResult({ ...s, path: rec.path, snippet: safeSnippet(this.root, rec.path, s.line) });
        }
      } else {
        for (const s of rec.symbols) {
          if (s.name.toLowerCase().includes(needle) && s.role !== 'definition') addResult({ ...s, path: rec.path, snippet: safeSnippet(this.root, rec.path, s.line) });
        }
        const definitionPositions = new Set(rec.symbols.filter((s) => s.role === 'definition').map((s) => `${s.line}:${s.column}:${s.name.toLowerCase()}`));
        for (const t of rec.terms) {
          if (!t.term.includes(needle) || definitionPositions.has(`${t.line}:${t.column}:${t.term}`)) continue;
          addResult({ path: rec.path, line: t.line, column: t.column, name: t.term, role: 'reference', confidence: 'lexical', snippet: safeSnippet(this.root, rec.path, t.line) });
        }
      }
    }
    out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column || String(a.name || '').localeCompare(String(b.name || '')));
    return { ok: true, indexState: this.state, results: out.slice(0, max), truncated: this.truncated || out.length > max, totalMatches: out.length };
  }

  location({ path: relPath, line = 1, column = 1, context = 2 } = {}) {
    const rel = String(relPath || '').replace(/\\/g, '/');
    if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) throw makeError('INDEX_LOCATION_INVALID', '定位路径无效');
    const full = resolveIndexedFile(this.root, rel);
    if (!full) throw makeError('INDEX_LOCATION_INVALID', '定位文件不存在');
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    const lineNumber = Number(line);
    const contextNumber = Number(context);
    const columnNumber = Number(column);
    const center = Math.max(1, Math.min(lines.length || 1, Number.isFinite(lineNumber) ? Math.floor(lineNumber) : 1));
    const radius = Math.max(0, Math.min(20, Number.isFinite(contextNumber) ? Math.floor(contextNumber) : 2));
    const from = Math.max(1, center - radius); const to = Math.min(lines.length, center + radius);
    let content = lines.slice(from - 1, to).map((v, i) => `${from + i}|${v.slice(0, 2000)}`).join('\n');
    if (Buffer.byteLength(content, 'utf8') > MAX_LOCATION_BYTES) content = Buffer.from(content, 'utf8').subarray(0, MAX_LOCATION_BYTES).toString('utf8');
    return { ok: true, path: rel, line: center, column: Math.max(1, Number.isFinite(columnNumber) ? Math.floor(columnNumber) : 1), startLine: from, endLine: to, content, truncated: content.length < lines.slice(from - 1, to).join('\n').length };
  }
  setProject(projectPath) { const next = canonicalProjectPath(projectPath); if (next === this.root) return this.root; this.stopWatcher(); this.root = next; this.key = projectKey(this.root); this.records.clear(); this.state = 'idle'; this.error = null; this.errorCode = null; this.persistenceMode = this.canEncrypt() ? 'encrypted' : 'memory'; this._loadCache(); return this.root; }
  close() {
    this.stopWatcher();
    // Flush a ready index that has not been persisted since its last change,
    // then refuse further writes so a late build cannot resurrect the file.
    if (!this.closed && this.records.size && this.state !== 'idle') this._persist();
    this.closed = true;
  }
  getStatus() { return this.status(); }
  persistenceStatus() { return { persistence: this.persistenceMode, error: this.error }; }
  persistence() { return this.persistenceStatus(); }
  query(options) { return this.search(options); }
  readLocation(options) { return this.location(options); }
  ensureIndex() { return this.ensure(); }
  rebuildIndex() { return this.rebuild(); }
  build(projectPath) { return this.rebuild(projectPath); }
}

function createProjectIndex(options) { return new ProjectIndex(options); }

class ProjectIndexManager {
  constructor(options = {}) { this.options = { ...options }; this.indexes = new Map(); }
  get(projectPath) { const root = canonicalProjectPath(projectPath); let index = this.indexes.get(root); if (!index) { index = createProjectIndex({ ...this.options, projectPath: root, storePath: this.options.storePathFor ? this.options.storePathFor(root) : this.options.storePath }); this.indexes.set(root, index); } return index; }
  ensure(projectPath) { return this.get(projectPath).ensure(); }
  status(projectPath) { return this.get(projectPath).status(); }
  rebuild(projectPath) { return this.get(projectPath).rebuild(); }
  clear(projectPath) { return this.get(projectPath).clear(); }
  search(projectPath, query) { return this.get(projectPath).search(query); }
  location(projectPath, query) { return this.get(projectPath).location(query); }
  unbind(projectPath) { const root = canonicalProjectPath(projectPath); const index = this.indexes.get(root); index?.close(); this.indexes.delete(root); }
  close() { for (const index of this.indexes.values()) index.close(); this.indexes.clear(); }
}
const createProjectIndexManager = (options) => new ProjectIndexManager(options);
async function buildProjectIndex(projectPath, options = {}) { const index = createProjectIndex({ ...options, projectPath }); await index.ensure(); return index; }

module.exports = { ProjectIndex, ProjectIndexManager, createProjectIndex, createProjectIndexManager, buildProjectIndex, canonicalProjectPath, projectKey, fingerprintFile, fileFingerprint: fingerprintFile, extractSymbols, extractTerms, fileLanguage, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_FILES, MAX_SYMBOLS, MAX_TERM_POSITIONS, MAX_RESULTS, MAX_QUERY_LENGTH, MAX_CACHE_BYTES, MAX_SCAN_FILES: MAX_FILES, MAX_SCAN_BYTES: MAX_TOTAL_BYTES };
