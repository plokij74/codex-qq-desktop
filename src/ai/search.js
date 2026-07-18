const fs = require('fs');
const path = require('path');
const { loadGitignoreRules, isIgnored } = require('./gitignore');

// Duplicated from project-fs (not exported there)
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage',
  '.cache', '.turbo', 'out', 'vendor', '__pycache__', '.venv', 'venv',
  '.idea', '.vscode', '.npm-cache',
]);

const DEFAULT_MAX_RESULTS = 50;
const HARD_CAP_MAX_RESULTS = 200;
const GREP_MAX_FILE_BYTES = Math.floor(1.5 * 1024 * 1024);

function clampMaxResults(n) {
  const v = n == null ? DEFAULT_MAX_RESULTS : Number(n);
  if (!Number.isFinite(v) || v < 1) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.floor(v), HARD_CAP_MAX_RESULTS);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Simple glob → RegExp source.
 * Supports ** (any path including /), * (within segment), ? (one char in segment).
 */
function globToRegExp(pattern) {
  const p = String(pattern || '').replace(/\\/g, '/');
  let src = '^';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        // ** optionally followed by /
        if (p[i + 2] === '/') {
          src += '(?:.*/)?';
          i += 2;
        } else {
          src += '.*';
          i += 1;
        }
      } else {
        src += '[^/]*';
      }
    } else if (ch === '?') {
      src += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      src += '\\' + ch;
    } else {
      src += ch;
    }
  }
  src += '$';
  return new RegExp(src);
}

function matchGlob(relPath, pattern) {
  const p = String(relPath || '').replace(/\\/g, '/');
  const g = String(pattern || '').replace(/\\/g, '/');
  try {
    return globToRegExp(g).test(p);
  } catch {
    return false;
  }
}

function compileGrepPattern(pattern, literal) {
  const raw = String(pattern ?? '');
  if (literal) {
    return new RegExp(escapeRegExp(raw));
  }
  try {
    return new RegExp(raw);
  } catch (e) {
    throw new Error(`无效的正则表达式: ${raw} (${e.message})`);
  }
}

/**
 * Walk project files under root (or subpath), applying SKIP_DIRS + gitignore.
 * Yields relative posix paths for files only.
 * @param {string} projectRoot
 * @param {{startRel?: string, ignoreRules?: object[], onFile?: (rel: string, full: string, stat: fs.Stats) => boolean|void}} opts
 *   onFile return false to stop walk early
 */
function walkFiles(projectRoot, opts = {}) {
  const root = path.resolve(projectRoot);
  const ignoreRules = opts.ignoreRules || loadGitignoreRules(root);
  const startRel = (opts.startRel || '.').replace(/\\/g, '/').replace(/^\.\//, '');
  const startFull = startRel === '.' || startRel === ''
    ? root
    : path.resolve(root, startRel);

  // path safety
  const relCheck = path.relative(root, startFull);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error(`路径越界，禁止访问项目外文件: ${opts.startRel}`);
  }

  if (!fs.existsSync(startFull)) {
    return;
  }

  function relFromRoot(full) {
    return path.relative(root, full).replace(/\\/g, '/');
  }

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory: skip it only; do not abort the whole walk.
      return true;
    }

    for (const ent of entries) {
      const name = ent.name;
      const full = path.join(dir, name);
      const rel = relFromRoot(full);

      // Never follow symlinks (prevents escaping project root).
      if (ent.isSymbolicLink()) {
        continue;
      }

      if (ignoreRules && isIgnored(rel, ignoreRules)) {
        continue;
      }

      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        // Only onFile returning false should abort early (max-results cap).
        if (walk(full) === false) return false;
      } else if (ent.isFile()) {
        let st;
        try {
          st = fs.lstatSync(full);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue;
        if (opts.onFile && opts.onFile(rel, full, st) === false) {
          return false;
        }
      }
    }
    return true;
  }

  const st0 = fs.statSync(startFull);
  if (st0.isFile()) {
    const rel = relFromRoot(startFull);
    if (!(ignoreRules && isIgnored(rel, ignoreRules))) {
      if (opts.onFile) opts.onFile(rel, startFull, st0);
    }
    return;
  }

  walk(startFull);
}

/**
 * @param {string} projectRoot
 * @param {{ pattern: string, path?: string, glob?: string, maxResults?: number, literal?: boolean }} opts
 * @returns {{ ok: boolean, matches: {path:string,line:number,text:string}[], truncated: boolean, scannedFiles: number, skippedFiles: number }}
 */
function grepFiles(projectRoot, opts = {}) {
  const maxResults = clampMaxResults(opts.maxResults);
  const re = compileGrepPattern(opts.pattern, opts.literal === true);
  const globPat = opts.glob || null;
  const startRel = opts.path || '.';

  const matches = [];
  let scannedFiles = 0;
  let skippedFiles = 0;
  let truncated = false;

  const ignoreRules = loadGitignoreRules(projectRoot);

  walkFiles(projectRoot, {
    startRel,
    ignoreRules,
    onFile(rel, full, st) {
      if (globPat && !matchGlob(rel, globPat)) {
        return true;
      }
      if (st.size > GREP_MAX_FILE_BYTES) {
        skippedFiles += 1;
        return true;
      }
      scannedFiles += 1;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        skippedFiles += 1;
        return true;
      }
      // skip obvious binary (NUL)
      if (text.includes('\0')) {
        skippedFiles += 1;
        return true;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push({
            path: rel,
            line: i + 1,
            text: lines[i],
          });
          if (matches.length >= maxResults) {
            truncated = true;
            return false;
          }
        }
        // reset lastIndex for global regexes if any — we create non-global by default
        if (re.global) re.lastIndex = 0;
      }
      return true;
    },
  });

  return {
    ok: true,
    matches,
    truncated,
    scannedFiles,
    skippedFiles,
  };
}

/**
 * @param {string} projectRoot
 * @param {{ pattern: string, maxResults?: number }} opts
 * @returns {{ ok: boolean, files: string[], truncated: boolean }}
 */
function globFiles(projectRoot, opts = {}) {
  const maxResults = clampMaxResults(opts.maxResults);
  const pattern = opts.pattern || '**/*';
  const ignoreRules = loadGitignoreRules(projectRoot);

  const files = [];
  let truncated = false;

  walkFiles(projectRoot, {
    startRel: '.',
    ignoreRules,
    onFile(rel) {
      if (matchGlob(rel, pattern)) {
        files.push(rel);
        if (files.length >= maxResults) {
          truncated = true;
          return false;
        }
      }
      return true;
    },
  });

  return {
    ok: true,
    files,
    truncated,
  };
}

module.exports = {
  grepFiles,
  globFiles,
  // exported for tests / reuse if needed
  SKIP_DIRS,
  matchGlob,
  clampMaxResults,
  GREP_MAX_FILE_BYTES,
};
