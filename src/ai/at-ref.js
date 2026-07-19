'use strict';

const fs = require('fs');
const path = require('path');
const { resolveSafe, listTree } = require('./project-fs');
const { loadGitignoreRules, isIgnored } = require('./gitignore');
const { isProbablyText } = require('./diff');

const DEFAULT_CAPS = {
  maxFileBytes: 64 * 1024,
  maxFileLines: 2000,
  maxRangeLines: 500,
  maxRefs: 20,
  maxTotalBytes: 200 * 1024,
  maxTreeEntries: 200,
  dirPreviewFiles: 5,
  dirPreviewBytes: 2048,
  completeLimit: 20,
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage',
  '.cache', '.turbo', 'out', 'vendor', '__pycache__', '.venv', 'venv',
  '.idea', '.vscode', '.npm-cache',
]);

/**
 * Build a set of character indices that lie inside ``` fences or `inline code`.
 * Unclosed fence treats the rest of the text as fenced.
 */
function buildCodeMask(text) {
  const n = text.length;
  const masked = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    // triple fence
    if (text[i] === '`' && text[i + 1] === '`' && text[i + 2] === '`') {
      // mask opening fence
      masked[i] = 1;
      masked[i + 1] = 1;
      masked[i + 2] = 1;
      i += 3;
      // optional language tag on same line — keep scanning until closing ```
      while (i < n) {
        if (text[i] === '`' && text[i + 1] === '`' && text[i + 2] === '`') {
          masked[i] = 1;
          masked[i + 1] = 1;
          masked[i + 2] = 1;
          i += 3;
          break;
        }
        masked[i] = 1;
        i += 1;
      }
      continue;
    }
    // inline code: single backtick (not part of triple — already handled)
    if (text[i] === '`') {
      masked[i] = 1;
      i += 1;
      while (i < n && text[i] !== '`' && text[i] !== '\n') {
        // stop at newline so unclosed inline doesn't swallow rest of line block poorly;
        // still mask until end of line if no closer
        masked[i] = 1;
        i += 1;
      }
      if (i < n && text[i] === '`') {
        masked[i] = 1;
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return masked;
}

/**
 * Path token after @: relative path chars + optional :start-end line range.
 * Path may include / . - _ letters digits and common path chars.
 */
const AT_REF_RE = /@((?:[\w./\\-]|%20)+?)(?::(\d+)(?:-(\d+))?)?(?=[\s,;:!?)\]}'"`]|$)/g;

/**
 * @param {string|null|undefined} text
 * @returns {{ raw: string, path: string, startLine?: number, endLine?: number, index: number }[]}
 */
function parseAtRefs(text) {
  if (text == null || text === '') return [];
  const s = String(text);
  const mask = buildCodeMask(s);
  const refs = [];
  AT_REF_RE.lastIndex = 0;
  let m;
  while ((m = AT_REF_RE.exec(s)) !== null) {
    const index = m.index;
    if (mask[index]) continue;
    // Email / word@word: if '@' is immediately after a word char, not a path ref.
    if (index > 0 && /[\w]/.test(s[index - 1])) continue;
    const pathPart = m[1].replace(/\\/g, '/');
    if (!pathPart || pathPart === '@') continue;
    // Reject pure empty / lone dots as path? allow "./x"
    const ref = {
      raw: m[0],
      path: pathPart,
      index,
    };
    if (m[2] != null) {
      ref.startLine = Number(m[2]);
      if (m[3] != null) {
        ref.endLine = Number(m[3]);
      } else {
        ref.endLine = ref.startLine;
      }
    }
    refs.push(ref);
  }
  return refs;
}

function normalizeRel(rel) {
  return String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/**
 * @param {string} projectRoot
 * @param {string} prefix
 * @param {{ limit?: number }} [opts]
 * @returns {{ path: string, type: 'file'|'dir' }[]}
 */
function completeAtPath(projectRoot, prefix, opts = {}) {
  const limit = opts.limit != null ? Math.max(0, Number(opts.limit)) : DEFAULT_CAPS.completeLimit;
  if (!projectRoot || limit === 0) return [];

  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];

  let pref = String(prefix || '').replace(/\\/g, '/');
  // Block obvious traversal
  if (pref.includes('..') || path.isAbsolute(pref) || /^[a-zA-Z]:/.test(pref)) {
    return [];
  }

  const ignoreRules = loadGitignoreRules(root);
  const results = [];

  // Split into directory part + name prefix
  const endsWithSlash = pref.endsWith('/');
  let dirRel = '';
  let namePrefix = pref;
  if (endsWithSlash) {
    dirRel = pref.slice(0, -1);
    namePrefix = '';
  } else {
    const lastSlash = pref.lastIndexOf('/');
    if (lastSlash >= 0) {
      dirRel = pref.slice(0, lastSlash);
      namePrefix = pref.slice(lastSlash + 1);
    }
  }

  let dirFull;
  try {
    dirFull = resolveSafe(root, dirRel || '.');
  } catch {
    return [];
  }

  if (!fs.existsSync(dirFull) || !fs.statSync(dirFull).isDirectory()) {
    return [];
  }

  let entries;
  try {
    entries = fs.readdirSync(dirFull, { withFileTypes: true });
  } catch {
    return [];
  }

  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const ent of entries) {
    if (results.length >= limit) break;
    const name = ent.name;
    if (name === '.' || name === '..') continue;
    if (name.startsWith('.') && name !== '.gitignore' && name !== '.env.example' && name !== '.npmrc') {
      continue;
    }
    if (namePrefix && !name.startsWith(namePrefix)) continue;

    const rel = dirRel ? `${normalizeRel(dirRel)}/${name}` : name;
    const relPosix = rel.replace(/\\/g, '/');

    if (ignoreRules && isIgnored(relPosix, ignoreRules)) continue;
    if (ent.isDirectory() && SKIP_DIRS.has(name)) continue;

    // Never complete through symlinks outside
    if (ent.isSymbolicLink()) continue;

    if (ent.isDirectory()) {
      results.push({ path: relPosix, type: 'dir' });
    } else if (ent.isFile()) {
      results.push({ path: relPosix, type: 'file' });
    }
  }

  return results;
}

function byteLen(s) {
  return Buffer.byteLength(String(s || ''), 'utf8');
}

function splitLines(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function expandFileRef(projectRoot, ref, caps, remainingBytes) {
  const warnings = [];
  const relPath = ref.path.replace(/\/+$/, '');
  let full;
  try {
    full = resolveSafe(projectRoot, relPath);
  } catch (e) {
    return { section: null, warning: `跳过 ${ref.raw}: 路径越界 (${relPath})`, bytes: 0 };
  }

  if (!fs.existsSync(full)) {
    return { section: null, warning: `跳过 ${ref.raw}: 不存在 ${relPath}`, bytes: 0 };
  }

  const st = fs.statSync(full);
  if (st.isDirectory()) {
    return expandDirRef(projectRoot, { ...ref, path: relPath }, caps, remainingBytes);
  }
  if (!st.isFile()) {
    return { section: null, warning: `跳过 ${ref.raw}: 不是文件 ${relPath}`, bytes: 0 };
  }

  // binary check via sample
  let sample;
  try {
    const fd = fs.openSync(full, 'r');
    try {
      const buf = Buffer.alloc(Math.min(8192, st.size));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      sample = buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return { section: null, warning: `跳过 ${ref.raw}: 无法读取 ${e.message}`, bytes: 0 };
  }

  if (!isProbablyText(sample)) {
    return { section: null, warning: `跳过 ${ref.raw}: 二进制文件 ${relPath}`, bytes: 0 };
  }

  // If too large for full read and no range, truncate by reading limited
  const hasRange = ref.startLine != null;
  let content;
  try {
    if (!hasRange && st.size > caps.maxFileBytes * 4) {
      // still try to read but we'll cap lines/bytes
    }
    content = fs.readFileSync(full, 'utf8');
  } catch (e) {
    return { section: null, warning: `跳过 ${ref.raw}: 读取失败 ${e.message}`, bytes: 0 };
  }

  if (!isProbablyText(content)) {
    return { section: null, warning: `跳过 ${ref.raw}: 二进制文件 ${relPath}`, bytes: 0 };
  }

  let lines = splitLines(content);
  let startLine = 1;
  let endLine = lines.length;
  let headerPath = relPath;

  if (hasRange) {
    let s = Math.max(1, Number(ref.startLine) || 1);
    let e = ref.endLine != null ? Number(ref.endLine) : s;
    if (!Number.isFinite(e) || e < s) e = s;
    if (s > lines.length) {
      warnings.push(`${ref.raw}: 行号越界，已 clamp`);
      s = Math.max(1, lines.length);
      e = s;
    }
    if (e > lines.length) {
      warnings.push(`${ref.raw}: 结束行越界，已 clamp 到 ${lines.length}`);
      e = lines.length;
    }
    const span = e - s + 1;
    if (span > caps.maxRangeLines) {
      warnings.push(`${ref.raw}: 行范围超过 maxRangeLines=${caps.maxRangeLines}，已截断`);
      e = s + caps.maxRangeLines - 1;
    }
    startLine = s;
    endLine = e;
    headerPath = `${relPath}:${s}-${e}`;
    lines = lines.slice(s - 1, e);
  } else {
    // full file caps
    let truncated = false;
    if (lines.length > caps.maxFileLines) {
      lines = lines.slice(0, caps.maxFileLines);
      truncated = true;
      warnings.push(`${ref.raw}: 超过 maxFileLines=${caps.maxFileLines}，已截断`);
    }
    // byte cap after line slice
    let body = lines.join('\n');
    if (byteLen(body) > caps.maxFileBytes) {
      // shrink lines until under cap
      while (lines.length > 0 && byteLen(lines.join('\n')) > caps.maxFileBytes) {
        lines.pop();
      }
      truncated = true;
      if (!warnings.some((w) => w.includes('maxFileLines'))) {
        warnings.push(`${ref.raw}: 超过 maxFileBytes=${caps.maxFileBytes}，已截断`);
      } else {
        warnings.push(`${ref.raw}: 同时受 maxFileBytes 限制，已截断`);
      }
    }
    void truncated;
  }

  // remaining budget
  let body = lines.join('\n');
  const header = `### file: ${headerPath}`;
  let section = `${header}\n${body}`;
  if (byteLen(section) > remainingBytes) {
    // shrink body
    while (lines.length > 0 && byteLen(`${header}\n${lines.join('\n')}`) > remainingBytes) {
      lines.pop();
    }
    body = lines.join('\n');
    section = `${header}\n${body}`;
    warnings.push(`${ref.raw}: 超过总预算 maxTotalBytes，已截断`);
  }

  if (remainingBytes <= byteLen(header) + 1 && body.length === 0 && lines.length === 0) {
    return {
      section: null,
      warning: warnings.concat([`${ref.raw}: 总预算不足，跳过`]).join('; '),
      bytes: 0,
    };
  }

  return {
    section,
    warning: warnings.length ? warnings.join('; ') : null,
    bytes: byteLen(section),
  };
}

function expandDirRef(projectRoot, ref, caps, remainingBytes) {
  const warnings = [];
  const relPath = normalizeRel(ref.path) || '.';
  let full;
  try {
    full = resolveSafe(projectRoot, relPath === '.' ? '.' : relPath);
  } catch {
    return { section: null, warning: `跳过 ${ref.raw}: 路径越界 (${ref.path})`, bytes: 0 };
  }

  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
    return { section: null, warning: `跳过 ${ref.raw}: 目录不存在 ${relPath}`, bytes: 0 };
  }

  const ignoreRules = loadGitignoreRules(projectRoot);
  // listTree walks `full` (subdir); pass project-relative prefix so root .gitignore
  // patterns like `src/secret` still match when expanding `@src/`.
  const ignorePrefix = relPath === '.' ? '' : relPath;
  let tree;
  try {
    tree = listTree(full, {
      maxDepth: 6,
      maxEntries: caps.maxTreeEntries,
      ignoreRules,
      includeSkippedMarkers: true,
      ignorePrefix,
    });
  } catch (e) {
    return { section: null, warning: `跳过 ${ref.raw}: 无法列目录 ${e.message}`, bytes: 0 };
  }

  const displayPath = relPath === '.' ? '.' : relPath;
  const header = `### dir: ${displayPath}`;
  let parts = [header, tree.treeText];

  // optional file head previews
  const previewFiles = [];
  try {
    const entries = fs.readdirSync(full, { withFileTypes: true });
    for (const ent of entries) {
      if (previewFiles.length >= caps.dirPreviewFiles) break;
      if (!ent.isFile()) continue;
      if (ent.name.startsWith('.')) continue;
      const fileRel = relPath === '.' ? ent.name : `${relPath}/${ent.name}`;
      if (ignoreRules && isIgnored(fileRel, ignoreRules)) continue;
      const ffull = path.join(full, ent.name);
      let st;
      try {
        st = fs.statSync(ffull);
      } catch {
        continue;
      }
      if (st.size > caps.dirPreviewBytes * 4) continue;
      let buf;
      try {
        buf = fs.readFileSync(ffull);
      } catch {
        continue;
      }
      if (!isProbablyText(buf)) continue;
      let text = buf.toString('utf8');
      if (byteLen(text) > caps.dirPreviewBytes) {
        // truncate by bytes roughly
        text = Buffer.from(text, 'utf8').subarray(0, caps.dirPreviewBytes).toString('utf8');
        text += '\n…(preview truncated)';
      }
      previewFiles.push({ path: fileRel, text });
    }
  } catch {
    // ignore preview failures
  }

  for (const pf of previewFiles) {
    parts.push(`### file: ${pf.path} (preview)`, pf.text);
  }

  let section = parts.join('\n');
  if (byteLen(section) > remainingBytes) {
    // drop previews first
    section = `${header}\n${tree.treeText}`;
    if (byteLen(section) > remainingBytes) {
      // truncate tree text
      const budget = Math.max(0, remainingBytes - byteLen(header) - 1);
      let treeText = tree.treeText;
      while (treeText.length > 0 && byteLen(treeText) > budget) {
        treeText = treeText.slice(0, Math.floor(treeText.length * 0.8));
      }
      section = `${header}\n${treeText}\n…(tree truncated)`;
      warnings.push(`${ref.raw}: 目录摘要超过总预算，已截断`);
    } else {
      warnings.push(`${ref.raw}: 目录预览因预算被省略`);
    }
  }

  return {
    section,
    warning: warnings.length ? warnings.join('; ') : null,
    bytes: byteLen(section),
  };
}

/**
 * @param {string} projectRoot
 * @param {string} text
 * @param {typeof DEFAULT_CAPS} [caps]
 * @returns {{ contextBlock: string|null, refs: object[], warnings: string[] }}
 */
function expandAtRefs(projectRoot, text, caps = DEFAULT_CAPS) {
  const c = { ...DEFAULT_CAPS, ...(caps || {}) };
  const parsed = parseAtRefs(text);
  const warnings = [];
  const usedRefs = [];
  const sections = [];
  let totalBytes = 0;

  if (!projectRoot) {
    if (parsed.length) {
      warnings.push('无项目绑定，跳过 @ 引用展开');
    }
    return { contextBlock: null, refs: [], warnings };
  }

  let considered = 0;
  for (const ref of parsed) {
    if (considered >= c.maxRefs) {
      warnings.push(`超过 maxRefs=${c.maxRefs}，后续 ref 已忽略`);
      break;
    }
    considered += 1;

    const remaining = c.maxTotalBytes - totalBytes;
    if (remaining <= 32) {
      warnings.push('超过总预算 maxTotalBytes，后续 ref 已忽略');
      break;
    }

    // Decide file vs dir by trailing slash or existence
    let result;
    const pathForCheck = ref.path.replace(/\/+$/, '') || '.';
    let isDirHint = ref.path.endsWith('/');
    try {
      const full = resolveSafe(projectRoot, pathForCheck);
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
        isDirHint = true;
      }
    } catch (e) {
      result = {
        section: null,
        warning: `跳过 ${ref.raw}: 路径越界 (${ref.path})`,
        bytes: 0,
      };
    }

    if (!result) {
      if (isDirHint) {
        result = expandDirRef(projectRoot, ref, c, remaining);
      } else {
        result = expandFileRef(projectRoot, ref, c, remaining);
      }
    }

    if (result.warning) {
      // may be multi joined
      for (const w of String(result.warning).split('; ')) {
        if (w) warnings.push(w);
      }
    }
    if (result.section) {
      // final budget check
      if (totalBytes + result.bytes > c.maxTotalBytes) {
        warnings.push(`${ref.raw}: 超过总预算 maxTotalBytes，已跳过`);
        continue;
      }
      sections.push(result.section);
      totalBytes += result.bytes;
      usedRefs.push(ref);
    }
  }

  if (!sections.length) {
    return { contextBlock: null, refs: usedRefs, warnings };
  }

  const body = sections.join('\n');
  const contextBlock = '```context:refs\n' + body + '\n```';
  return { contextBlock, refs: usedRefs, warnings };
}

module.exports = {
  DEFAULT_CAPS,
  parseAtRefs,
  completeAtPath,
  expandAtRefs,
};
