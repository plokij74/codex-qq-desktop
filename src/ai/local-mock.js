const path = require('path');
const { listTree } = require('./project-fs');

function generateLocalReply(userText, opts = {}) {
  const text = (userText || '').trim();
  const project = opts.project;

  if (project?.path && /^(列出|list|ls|目录|树|tree)/i.test(text)) {
    try {
      const t = listTree(project.path);
      return [
        `项目 \`${project.name || path.basename(project.path)}\` 目录树：`,
        '',
        '```text',
        t.treeText,
        '```',
        '',
        '可以说「读取 xxx」或「新建 README 并写一段介绍」让我改文件。',
      ].join('\n');
    } catch (e) {
      return `无法列出目录：${e.message}`;
    }
  }

  if (project?.path && /读取|打开文件|read\s+/i.test(text)) {
    const m = text.match(/(?:读取|打开文件|read)\s*[：:]?\s*[`「]?([^\s`」]+)[`」]?/i);
    if (m) {
      try {
        const { readFile } = require('./project-fs');
        const f = readFile(project.path, m[1]);
        return [
          `文件 \`${f.path}\`：`,
          '',
          '```text',
          f.content.slice(0, 4000),
          '```',
        ].join('\n');
      } catch (e) {
        return `读取失败：${e.message}`;
      }
    }
  }

  if (project?.path && /(新建|创建|写(一个|入)?|修改|改一下|更新).*(readme|README|\.md|\.js|\.ts|\.json|文件)/i.test(text)
    || (project?.path && /写(入)?\s+/.test(text) && /\.(md|js|ts|json|txt)/i.test(text))) {
    const fileMatch = text.match(/([\w./-]+\.(?:md|js|ts|tsx|jsx|json|txt|css|html))/i);
    const rel = fileMatch ? fileMatch[1] : 'CODEX_NOTE.md';
    const body = [
      `# ${project.name || 'Project'}`,
      '',
      `由 Codex QQ 本地模拟于 ${new Date().toLocaleString()} 生成。`,
      '',
      '## 用户请求',
      text,
      '',
      '## 下一步',
      '- 在设置中切换 API 模式可获得更智能的改码能力',
      '- 继续对话说明你想改的文件与逻辑',
      '',
    ].join('\n');
    return [
      `将在项目中写入 \`${rel}\`（模拟助手会真实落盘）：`,
      '',
      '```write:' + rel,
      body,
      '```',
      '',
      '如需改别的路径，直接说例如：把说明写到 docs/note.md',
    ].join('\n');
  }

  if (project?.path && /改|修|实现|添加|删除|重构|bug/i.test(text)) {
    return [
      `当前项目：\`${project.name}\``,
      `路径：\`${project.path}\``,
      '',
      '本地模拟模式下我可以：',
      '1. 列出目录（说「列出文件」）',
      '2. 读取文件（说「读取 package.json」）',
      '3. 写入/创建文件（说「新建 README.md 并写介绍」）',
      '',
      '切换到 **API 模式** 后，我会像 Codex 一样根据对话直接改多文件。',
      '',
      '你这次说的是：',
      `> ${text.slice(0, 300)}`,
      '',
      '若要我先摸底，回复「列出文件」。',
    ].join('\n');
  }

  if (/migration|wrangler|d1|\bKV\b|kv|读写/i.test(text)) {
    return [
      '结构确认没问题：',
      '',
      '- `redeem_codes`、`push_tokens` 与 migration 一致。',
      '- `android_subscriptions` 多了 `free_trial` 字段，这是后续的增量字段，不影响 baseline。',
      '- `d1_migrations` 已存在，但缺少历史记录。',
      '',
      '现在补记录：',
      '',
      '```bash',
      './node_modules/.bin/wrangler d1 execute haiker --remote --command \\',
      '"INSERT OR IGNORE INTO d1_migrations (name) VALUES (\'0001_initial.sql\'), (\'0002_push_notifications.sql\');"',
      '```',
      '',
      '然后：',
      '',
      '```bash',
      './node_modules/.bin/wrangler d1 migrations list haiker --remote',
      '```',
      '',
      '确认只显示 `0003_push_delivery_dedup.sql` 后，再运行：',
      '',
      '```bash',
      './node_modules/.bin/wrangler d1 migrations apply haiker --remote',
      '```',
      '',
      '这不会影响现有业务数据。',
    ].join('\n');
  }

  if (/bug|错误|修复|报错/i.test(text)) {
    return [
      '可以，把完整报错栈和复现步骤发我。',
      '',
      '先快速排查清单：',
      '1. 确认依赖版本与 lockfile 一致',
      '2. 清缓存后重装：`rm -rf node_modules && npm i`',
      '3. 用最小复现脚本隔离问题',
      '',
      '我可以陪你写补丁、改代码、查文档。',
    ].join('\n');
  }

  if (!text) {
    return '在呢。把需求、报错或代码片段丢过来就行。';
  }

  return [
    `收到：${text.slice(0, 200)}`,
    '',
    '我是 Codex 小助手。可以直接问架构、改 Bug、写脚本或看日志。',
    project?.path
      ? `当前已绑定项目目录，可直接让我改文件（例如：新建 README.md）。`
      : '绑定真实项目后，我可以像 Codex 一样读写目录内文件。',
    '需要我按步骤给出命令的话，说下你的运行环境即可。',
  ].join('\n');
}

module.exports = { generateLocalReply };
