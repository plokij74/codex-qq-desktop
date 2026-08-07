'use strict';

/**
 * Phase D.1 — structured session compaction.
 *
 * Pure helpers (no Electron / no fs) so they run under `node --test` and inside
 * the main process. The renderer reaches them through the `session:compact` IPC
 * because the preload runs sandboxed and cannot require local modules.
 */

/** Hard cap on the transcript handed to the summarizer. */
const TRANSCRIPT_MAX_DEFAULT = 100000;
/** Per-tool-line cap inside the transcript. */
const TOOL_SUMMARY_MAX = 200;
/** Prefix used on the generated summary bubble. */
const SUMMARY_PREFIX = '【会话摘要 · 更早 %d 条已压缩】';

/** Heuristic token count: 1 token ≈ 4 chars. No tiktoken dependency. */
function approxTokensFromText(s) {
  return Math.ceil(String(s || '').length / 4);
}

function messageText(m) {
  if (!m || typeof m !== 'object') return '';
  let t = typeof m.content === 'string' ? m.content : String(m.content || '');
  if (m.tool) t += '\n' + String(m.tool);
  if (m.toolSummary) t += '\n' + String(m.toolSummary);
  return t;
}

function approxTokensFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let n = 0;
  for (const m of list) n += approxTokensFromText(messageText(m));
  return n;
}

/**
 * Decide whether to compact and split the history.
 *
 * @param {Array} messages renderer session history
 * @param {{keepMessages?:number, maxMessages?:number, maxApproxTokens?:number, force?:boolean}} opts
 * @returns {{needed:boolean, older:Array, keep:Array, approxTokens:number, olderApproxTokens:number}}
 */
function planCompact(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const keepMessages = Math.max(1, Number(opts.keepMessages) || 24);
  const maxMessages = Number(opts.maxMessages) || 40;
  const maxApproxTokens = Number(opts.maxApproxTokens) || 24000;
  const force = opts.force === true;
  const approxTokens = approxTokensFromMessages(list);
  const notNeeded = { needed: false, older: [], keep: list, approxTokens, olderApproxTokens: 0 };

  if (list.length <= keepMessages) return notNeeded;
  if (!force && list.length < maxMessages && approxTokens < maxApproxTokens) return notNeeded;

  const older = list.slice(0, -keepMessages);
  const keep = list.slice(-keepMessages);
  if (!older.length) return notNeeded;
  // Nothing new to squeeze: the older window is already just prior summaries.
  if (older.every((m) => m && m.compact === true)) return notNeeded;

  return {
    needed: true,
    older,
    keep,
    approxTokens,
    olderApproxTokens: approxTokensFromMessages(older),
  };
}

/**
 * Flatten the older window into plain text for the summarizer.
 * Keeps the tail when over `maxChars` — recent context matters more.
 */
function serializeOlderTranscript(older, opts = {}) {
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : TRANSCRIPT_MAX_DEFAULT;
  const list = Array.isArray(older) ? older : [];
  const parts = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role || 'unknown';
    if (m.tool || role === 'tool') {
      const name = m.tool || m.name || 'tool';
      const body = String(m.toolSummary || m.content || '').slice(0, TOOL_SUMMARY_MAX);
      parts.push(`[tool:${name}]\n${body}`);
    } else {
      parts.push(`[${role}]\n${String(m.content || '')}`);
    }
  }
  let text = parts.join('\n\n');
  if (text.length > maxChars) {
    text = '…[transcript truncated]…\n' + text.slice(text.length - maxChars);
  }
  return text;
}

/** Replace `plan.older` with a single summary bubble; returns a new array. */
function applyCompact(messages, plan, summary) {
  const keep = plan && Array.isArray(plan.keep) ? plan.keep : [];
  const olderLen = plan && Array.isArray(plan.older) ? plan.older.length : 0;
  const summaryMsg = {
    role: 'assistant',
    content: `${SUMMARY_PREFIX.replace('%d', String(olderLen))}\n${String(summary || '').trim()}`,
    compact: true,
    compactAt: Date.now(),
    compactedCount: olderLen,
  };
  return [summaryMsg, ...keep];
}

function buildCompactSystemPrompt() {
  return [
    '你是会话压缩助手。根据用户提供的对话摘录，用中文写简洁结构化摘要。',
    '必须尽量保留：关键文件路径、已做决策、未决问题、用户明确约束、错误与修复结论。',
    '不要编造摘录中未出现的事实。使用短段落或 bullet。不要输出前言客套。',
  ].join('\n');
}

/**
 * Turn a transcript into a Chinese summary.
 *
 * Local mode never touches the network — it returns a deterministic placeholder
 * so the feature is still exercisable offline. `chatFn` is injectable for tests.
 *
 * @param {{transcript:string, settings:object, chatFn?:Function, signal?:AbortSignal,
 *   onUsage?:Function}} args
 * @returns {Promise<string>}
 */
async function generateCompactSummary({ transcript, settings, chatFn, signal, onUsage } = {}) {
  const text = String(transcript || '');
  if (!text.trim()) throw new Error('待压缩内容为空');
  const s = settings || {};
  const mode = s.mode === 'api' ? 'api' : 'local';
  if (mode === 'local') {
    return `（本地模式占位摘要）摘录约 ${text.length} 字符、约 ${approxTokensFromText(text)} token。切换到 API 模式可生成真实摘要。`;
  }
  const sentMessages = [
    { role: 'system', content: buildCompactSystemPrompt() },
    { role: 'user', content: text.slice(0, TRANSCRIPT_MAX_DEFAULT) },
  ];
  let content;
  let rawUsage = null;
  if (typeof chatFn === 'function') {
    const response = await chatFn({
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      model: s.model,
      temperature: 0.2,
      signal,
      messages: sentMessages,
    });
    if (response && typeof response === 'object') {
      content = response.content || '';
      rawUsage = response.usage ?? null;
    } else {
      content = response;
    }
  } else {
    const msg = await require('./openai-compatible').chatCompletionMessage({
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      model: s.model,
      temperature: 0.2,
      signal,
      messages: sentMessages,
    });
    content = msg?.content || '';
    rawUsage = msg?.usage ?? null;
  }
  const out = String(content || '').trim();
  if (typeof onUsage === 'function') {
    try {
      await Promise.resolve(onUsage({ rawUsage, messages: sentMessages, content: out }));
    } catch {
      // Usage metering is best-effort and must not turn a valid summary into a failure.
    }
  }
  if (!out) throw new Error('摘要为空');
  return out;
}

module.exports = {
  approxTokensFromText,
  approxTokensFromMessages,
  planCompact,
  serializeOlderTranscript,
  applyCompact,
  buildCompactSystemPrompt,
  generateCompactSummary,
  TRANSCRIPT_MAX_DEFAULT,
  TOOL_SUMMARY_MAX,
};
