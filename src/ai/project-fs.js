const fs = require('fs');
const path = require('path');
const { isIgnored } = require('./gitignore');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage',
  '.cache', '.turbo', 'out', 'vendor', '__pycache__', '.venv', 'venv',
  '.idea', '.vscode', '.npm-cache',
]);

function resolveSafe(projectRoot, relPath = '.') {
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, relPath || '.');
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径越界，禁止访问项目外文件: ${relPath}`);
  }
  return target;
}

/**
 * Full directory walk on host (not model hallucination).
 * @param {string} projectRoot
 * @param {{maxDepth?:number,maxEntries?:number,includeSkippedMarkers?:boolean,showDot?:boolean,ignoreRules?:object[],ignorePrefix?:string}} opts
 *   ignorePrefix: when walking a subdirectory, project-relative path of that dir
 *   (e.g. "src") so gitignore rules from the project root match correctly.
 */
function listTree(projectRoot, opts = {}) {
  const maxDepth = opts.maxDepth ?? 10;
  const maxEntries = opts.maxEntries ?? 8000;
  const includeSkippedMarkers = opts.includeSkippedMarkers !== false;
  const showDot = opts.showDot === true;
  const ignoreRules = opts.ignoreRules || null;
  const ignorePrefix = String(opts.ignorePrefix || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');

  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`项目目录不存在: ${projectRoot}`);
  }

  const lines = [path.basename(root) + '/'];
  let count = 0;
  let truncated = false;
  let skippedHeavy = 0;

  function relFromRoot(full) {
    return path.relative(root, full).replace(/\\/g, '/');
  }

  function ignorePathFor(rel) {
    if (!ignorePrefix) return rel;
    if (!rel || rel === '.') return ignorePrefix;
    return `${ignorePrefix}/${rel}`;
  }

  function walk(dir, depth) {
    if (truncated) return;
    if (depth > maxDepth) {
      lines.push(`${'  '.repeat(depth)}…(深度截断 maxDepth=${maxDepth})`);
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      lines.push(`${'  '.repeat(depth)}⚠ 无法读取: ${e.message}`);
      return;
    }

    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const ent of entries) {
      if (count >= maxEntries) {
        truncated = true;
        lines.push(`${'  '.repeat(depth)}…(条目截断 maxEntries=${maxEntries})`);
        return;
      }

      const name = ent.name;
      if (!showDot && name.startsWith('.') && name !== '.env.example' && name !== '.gitignore' && name !== '.npmrc') {
        continue;
      }

      const indent = '  '.repeat(depth);
      const full = path.join(dir, name);
      const rel = relFromRoot(full);

      if (ignoreRules && isIgnored(ignorePathFor(rel), ignoreRules)) {
        continue;
      }

      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name)) {
          skippedHeavy += 1;
          if (includeSkippedMarkers) {
            lines.push(`${indent}${name}/  [已跳过大目录]`);
            count += 1;
          }
          continue;
        }
        lines.push(`${indent}${name}/`);
        count += 1;
        walk(full, depth + 1);
      } else {
        lines.push(`${indent}${name}`);
        count += 1;
      }
    }
  }

  walk(root, 1);

  return {
    root,
    treeText: lines.join('\n'),
    count,
    truncated,
    skippedHeavy,
    maxDepth,
    maxEntries,
  };
}

function isListIntent(text) {
  const t = String(text || '');
  return /(列出|罗列|list\b|\bls\b|目录树|文件树|树状|tree\b|有哪些(文件|目录|文件夹)|扫(描|一遍)目录|看(下|看)?目录)/i.test(t);
}

function isStructureIntent(text) {
  const t = String(text || '');
  return /(整理|梳理|生成).*(目录|结构|项目结构)|项目结构|目录结构|structure\.md|PROJECT_STRUCTURE|架构图|目录说明/i.test(t);
}

/** Host-side: always real scan, never model invent */
function buildTreeReply(project, userText) {
  const tree = listTree(project.path, { maxDepth: 12, maxEntries: 12000 });
  const title = project.name || path.basename(project.path);
  const header = [
    `# ${title} 目录结构`,
    '',
    `- 真实路径: \`${tree.root}\``,
    `- 扫描条目: ${tree.count}`,
    `- 深度上限: ${tree.maxDepth}`,
    `- 截断: ${tree.truncated ? '是' : '否'}`,
    `- 跳过大目录数: ${tree.skippedHeavy}（node_modules/.git 等）`,
    '',
    '```text',
    tree.treeText,
    '```',
    '',
    '> 以上由本机真实扫盘生成，不是模型猜测。',
  ];

  if (isStructureIntent(userText)) {
    // also prepare a markdown doc content for write
    const md = header.join('\n') + '\n';
    return {
      content: [
        '已在本机完整扫描目录（非模型臆造）。',
        '',
        ...header,
        '',
        '如需写入文件，可说：保存为 PROJECT_STRUCTURE.md',
      ].join('\n'),
      tree,
      structureMarkdown: md,
    };
  }

  return {
    content: header.join('\n'),
    tree,
    structureMarkdown: null,
  };
}

/**
 * Read a file; full reads enforce maxBytes.
 * When offset/limit is provided, allow a line slice even if total size > maxBytes
 * by streaming lines (sync) instead of loading the whole file into memory for the result.
 * Extremely large files still have a hard safety cap (maxBytes * 50) for the stream path.
 */
function readFile(projectRoot, relPath, { maxBytes = 200_000, offset, limit } = {}) {
  const full = resolveSafe(projectRoot, relPath);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw new Error(`文件不存在: ${relPath}`);
  }
  const stat = fs.statSync(full);
  const useSlice = offset != null || limit != null;
  const pathNorm = relPath.replace(/\\/g, '/');

  if (!useSlice) {
    if (stat.size > maxBytes) {
      throw new Error(`文件过大 (${stat.size} bytes)，拒绝读取: ${relPath}`);
    }
    const raw = fs.readFileSync(full, 'utf8');
    return { path: pathNorm, content: raw, size: stat.size };
  }

  const startLine = Math.max(1, Number(offset) || 1);
  const maxLines = limit != null ? Math.max(0, Number(limit)) : null;

  // Small enough: keep prior full-read + split behavior
  if (stat.size <= maxBytes) {
    const raw = fs.readFileSync(full, 'utf8');
    const lines = raw.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return formatSlicedLines(pathNorm, lines, startLine, maxLines, stat.size);
  }

  // Large file with slice: stream lines; hard cap to avoid unbounded work
  const sliceHardCap = maxBytes * 50;
  if (stat.size > sliceHardCap) {
    throw new Error(`文件过大 (${stat.size} bytes)，拒绝读取: ${relPath}`);
  }

  const { lines, totalLines } = streamCollectLines(full, startLine, maxLines);
  const endLine =
    lines.length === 0
      ? startLine - 1
      : lines[lines.length - 1].n;
  const width = String(Math.max(totalLines, 1)).length;
  const numbered = lines.map(({ n, text }) => `${String(n).padStart(width, ' ')}|${text}`);
  return {
    path: pathNorm,
    content: numbered.join('\n'),
    size: stat.size,
    totalLines,
    startLine,
    endLine,
  };
}

function formatSlicedLines(pathNorm, lines, startLine, maxLines, size) {
  const totalLines = lines.length;
  const take = maxLines != null ? maxLines : totalLines;
  const endLine = Math.min(totalLines, startLine + take - 1);
  const width = String(Math.max(totalLines, 1)).length;
  const numbered = [];
  for (let i = startLine; i <= endLine; i += 1) {
    const num = String(i).padStart(width, ' ');
    numbered.push(`${num}|${lines[i - 1]}`);
  }
  return {
    path: pathNorm,
    content: numbered.join('\n'),
    size,
    totalLines,
    startLine,
    endLine: endLine < startLine ? startLine - 1 : endLine,
  };
}

/**
 * Sync stream: collect requested line window and total line count.
 * Mirrors split(/\r?\n/) + pop trailing empty from final newline.
 */
function streamCollectLines(fullPath, startLine, maxLines) {
  const fd = fs.openSync(fullPath, 'r');
  const bufSize = 64 * 1024;
  const buffer = Buffer.alloc(bufSize);
  let leftover = '';
  let totalLines = 0;
  /** @type {{ n: number, text: string }[]} */
  const selected = [];
  let pos = 0;
  let endedWithNewline = false;

  const pushLine = (text) => {
    totalLines += 1;
    if (
      totalLines >= startLine &&
      (maxLines == null || selected.length < maxLines)
    ) {
      selected.push({ n: totalLines, text });
    }
  };

  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, bufSize, pos)) > 0) {
      pos += bytesRead;
      leftover += buffer.subarray(0, bytesRead).toString('utf8');
      let idx;
      while ((idx = leftover.indexOf('\n')) !== -1) {
        let line = leftover.slice(0, idx);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        leftover = leftover.slice(idx + 1);
        endedWithNewline = true;
        pushLine(line);
      }
      if (leftover.length > 0) endedWithNewline = false;
    }
    // Trailing content without newline is a real last line
    if (leftover.length > 0) {
      pushLine(leftover.replace(/\r$/, ''));
    } else if (pos === 0) {
      // empty file
      totalLines = 0;
    }
    // If file ended with newline, do not count a phantom empty last line (matches split+pop)
    void endedWithNewline;
  } finally {
    fs.closeSync(fd);
  }

  return { lines: selected, totalLines };
}

/**
 * Compute search/replace result without writing disk.
 * Same uniqueness / replaceAll rules as searchReplace.
 * @returns {{ path: string, before: string, after: string, replacements: number }}
 */
function previewSearchReplace(projectRoot, relPath, oldString, newString, opts = {}) {
  const oldS = String(oldString ?? '');
  const newS = String(newString ?? '');
  if (!oldS) throw new Error('old_string 为空');
  const full = resolveSafe(projectRoot, relPath);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw new Error(`文件不存在，请用 write_file 创建: ${relPath}`);
  }
  const text = fs.readFileSync(full, 'utf8');
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(oldS, idx)) !== -1) {
    count += 1;
    idx += oldS.length;
  }
  if (count === 0) throw new Error(`未找到 old_string 匹配: ${relPath}`);
  if (!opts.replaceAll && count > 1) {
    throw new Error(`old_string 出现 ${count} 次，默认要求唯一匹配；可设 replace_all=true`);
  }
  let next;
  if (opts.replaceAll) {
    next = text.split(oldS).join(newS);
  } else {
    const i = text.indexOf(oldS);
    next = text.slice(0, i) + newS + text.slice(i + oldS.length);
  }
  return {
    path: relPath.replace(/\\/g, '/'),
    before: text,
    after: next,
    replacements: opts.replaceAll ? count : 1,
  };
}

function searchReplace(projectRoot, relPath, oldString, newString, opts = {}) {
  const preview = previewSearchReplace(projectRoot, relPath, oldString, newString, opts);
  const full = resolveSafe(projectRoot, relPath);
  fs.writeFileSync(full, preview.after, 'utf8');
  return {
    path: preview.path,
    replacements: preview.replacements,
    bytes: Buffer.byteLength(preview.after, 'utf8'),
  };
}

function writeFile(projectRoot, relPath, content) {
  const full = resolveSafe(projectRoot, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, String(content ?? ''), 'utf8');
  return { path: relPath.replace(/\\/g, '/'), bytes: Buffer.byteLength(String(content ?? ''), 'utf8') };
}

function deletePath(projectRoot, relPath) {
  const full = resolveSafe(projectRoot, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`不存在: ${relPath}`);
  }
  const st = fs.statSync(full);
  if (st.isDirectory()) {
    fs.rmSync(full, { recursive: true, force: true });
  } else {
    fs.unlinkSync(full);
  }
  return { path: relPath.replace(/\\/g, '/') };
}

function parseWriteFences(text) {
  const re = /```(?:write|create|file):([^\n]+)\n([\s\S]*?)```/gi;
  const ops = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    ops.push({
      path: m[1].trim().replace(/^\/+/, ''),
      content: m[2].replace(/\n$/, ''),
    });
  }
  return ops;
}

function stripWriteFences(text) {
  return String(text || '')
    .replace(/```(?:write|create|file):([^\n]+)\n([\s\S]*?)```/gi, (_a, p) => `✅ 已写入文件：\`${p.trim()}\``)
    .trim();
}

function applyWriteFences(projectRoot, text) {
  const ops = parseWriteFences(text);
  const applied = [];
  for (const op of ops) {
    try {
      const r = writeFile(projectRoot, op.path, op.content);
      applied.push({ path: r.path, ok: true, bytes: r.bytes });
    } catch (err) {
      applied.push({ path: op.path, ok: false, error: err.message });
    }
  }
  return {
    applied,
    displayContent: ops.length ? stripWriteFences(text) : text,
  };
}

function buildProjectSystemPrompt(project) {
  if (!project?.path) return '';
  let tree = '(无法读取目录树)';
  let meta = '';
  try {
    const t = listTree(project.path, { maxDepth: 8, maxEntries: 3000 });
    tree = t.treeText;
    meta = `（真实扫描 ${t.count} 项，截断=${t.truncated}）`;
  } catch (e) {
    tree = `读取失败: ${e.message}`;
  }
  return [
    `你是 Codex 风格编程助手，当前工作项目：${project.name || path.basename(project.path)}`,
    `项目根目录（真实路径）: ${project.path}`,
    '重要：下面的目录树是本机真实扫描结果，整理结构时必须基于它，禁止编造不存在的路径。',
    '你可以修改项目内文件。需要写文件时使用：',
    '```write:相对路径/文件名',
    '完整文件内容',
    '```',
    '规则：路径相对项目根；禁止 .. 越界；使用简体中文。',
    '',
    `当前目录树 ${meta}:`,
    tree,
  ].join('\n');
}

module.exports = {
  resolveSafe,
  listTree,
  readFile,
  previewSearchReplace,
  searchReplace,
  writeFile,
  deletePath,
  parseWriteFences,
  stripWriteFences,
  applyWriteFences,
  buildProjectSystemPrompt,
  isListIntent,
  isStructureIntent,
  buildTreeReply,
};
