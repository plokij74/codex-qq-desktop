'use strict';

/**
 * Phase D.1 — session export to Markdown / JSON.
 *
 * Pure helpers: no fs, no dialog. The caller (main) writes the returned string
 * to whatever path the user picked in the save dialog.
 */

/** Keys never written to an export, at any nesting depth. */
const SECRET_KEYS = new Set(['apikey', 'authorization', 'token', 'password', 'secret', 'accesstoken', 'refreshtoken']);

const ROLE_LABELS = { user: '我', assistant: '助手', system: '系统', tool: '工具' };

function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(String(k).toLowerCase())) continue;
    out[k] = v && typeof v === 'object' ? stripSecrets(v) : v;
  }
  return out;
}

function roleLabel(role) {
  return ROLE_LABELS[String(role || '').toLowerCase()] || String(role || 'unknown');
}

function sessionMessages(session) {
  return Array.isArray(session?.messages) ? session.messages : [];
}

function exportSessionMarkdown(session) {
  const s = session || {};
  const messages = sessionMessages(s);
  const title = String(s.title || s.id || '未命名会话');
  const lines = [];
  lines.push(`# 会话导出：${title}`);
  lines.push('');
  lines.push(`- 会话 ID：${s.id ?? '-'}`);
  lines.push(`- 类型：${s.kind ?? '-'}`);
  lines.push(`- 对话对象：${s.peer ?? '-'}`);
  lines.push(`- 项目：${s.projectId ?? '-'}`);
  lines.push(`- 会话模式：${s.agentMode ?? '-'}`);
  lines.push(`- 消息数：${messages.length}`);
  lines.push(`- 导出时间：${new Date().toISOString()}`);
  lines.push('');
  lines.push('---');

  messages.forEach((m, i) => {
    const who = roleLabel(m?.role);
    const marks = [];
    if (m?.compact) marks.push(`摘要（已压缩 ${m.compactedCount ?? 0} 条）`);
    if (m?.error) marks.push('错误');
    lines.push('');
    lines.push(`### ${i + 1} · ${who}${marks.length ? ' · ' + marks.join(' · ') : ''}`);
    lines.push('');
    lines.push(String(m?.content ?? ''));
    if (m?.tool) {
      lines.push('');
      lines.push(`- 工具 \`${String(m.tool)}\`：${String(m.toolSummary ?? '').slice(0, 500)}`);
    }
    if (Array.isArray(m?.fileChanges) && m.fileChanges.length) {
      lines.push('');
      for (const fc of m.fileChanges) {
        lines.push(`- 文件改动：${String(fc?.path ?? fc ?? '')}`);
      }
    }
  });

  lines.push('');
  return lines.join('\n');
}

function exportSessionJson(session) {
  const s = session || {};
  const safe = stripSecrets({
    id: s.id ?? null,
    title: s.title ?? null,
    kind: s.kind ?? null,
    peer: s.peer ?? null,
    projectId: s.projectId ?? null,
    agentMode: s.agentMode ?? null,
    pinned: s.pinned === true,
    createdAt: s.createdAt ?? null,
    updatedAt: s.updatedAt ?? null,
    messages: sessionMessages(s),
  });
  return JSON.stringify(
    { version: 1, exportedAt: new Date().toISOString(), session: safe },
    null,
    2
  );
}

const UNSAFE_FILENAME_CHARS = /[\s<>:"/\\|?*\u0000-\u001f]+/g;

function defaultExportFilename(session, format) {
  const ext = format === 'json' ? 'json' : 'md';
  const base =
    String(session?.title || session?.id || 'session')
      .replace(UNSAFE_FILENAME_CHARS, '_')
      .replace(/^[_.]+|[_.]+$/g, '')
      .slice(0, 40) || 'session';
  const day = new Date().toISOString().slice(0, 10);
  return `${base}-${day}.${ext}`;
}

module.exports = {
  exportSessionMarkdown,
  exportSessionJson,
  defaultExportFilename,
  stripSecrets,
  SECRET_KEYS,
};
