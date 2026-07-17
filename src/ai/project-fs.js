const fs = require('fs');
const path = require('path');

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
 * @param {{maxDepth?:number,maxEntries?:number,includeSkippedMarkers?:boolean,showDot?:boolean}} opts
 */
function listTree(projectRoot, opts = {}) {
  const maxDepth = opts.maxDepth ?? 10;
  const maxEntries = opts.maxEntries ?? 8000;
  const includeSkippedMarkers = opts.includeSkippedMarkers !== false;
  const showDot = opts.showDot === true;

  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`项目目录不存在: ${projectRoot}`);
  }

  const lines = [path.basename(root) + '/'];
  let count = 0;
  let truncated = false;
  let skippedHeavy = 0;

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

function readFile(projectRoot, relPath, { maxBytes = 200_000 } = {}) {
  const full = resolveSafe(projectRoot, relPath);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw new Error(`文件不存在: ${relPath}`);
  }
  const stat = fs.statSync(full);
  if (stat.size > maxBytes) {
    throw new Error(`文件过大 (${stat.size} bytes)，拒绝读取: ${relPath}`);
  }
  const content = fs.readFileSync(full, 'utf8');
  return { path: relPath.replace(/\\/g, '/'), content, size: stat.size };
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
