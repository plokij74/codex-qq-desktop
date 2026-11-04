'use strict';

const { generateMemoryCandidates } = require('./memory-candidates');
const { createMessageV2, projectToStorageJson, normalizeMessage, normalizeAttachmentRef, attachmentMetadataText, attachmentProjectionError, PART_TYPES } = require('./message-schema');
const { LIMITS: ATTACHMENT_LIMITS } = require('./attachment-contract');

/** Public locators only; no host fetch, paths, bytes, grants or renderer manifests. */
function gatherAttachmentManifest(messages) {
  const refs = [], seen = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const normalized = normalizeMessage(message);
    const candidates = [...normalized.parts.filter(p => p.type === PART_TYPES.ATTACHMENT_REF), ...(normalized.attachmentManifest || [])];
    for (const raw of candidates) {
      const ref = { type: PART_TYPES.ATTACHMENT_REF, ...normalizeAttachmentRef(raw) };
      const key = ref.attachmentId || JSON.stringify([ref.name, ref.mimeType, ref.size, ref.source]);
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
      if (refs.length > ATTACHMENT_LIMITS.MAX_COMPACT_ATTACHMENT_REFS) throw attachmentProjectionError('ATTACHMENT_COMPACT_MANIFEST_LIMIT');
    }
  }
  return refs;
}

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
  const norm = projectToStorageJson(m);
  let t = norm.content || '';
  if (Array.isArray(norm.trajectory) && norm.trajectory.length) {
    for (const item of norm.trajectory) {
      if (item.tool) t += `\n${item.tool} ${item.argsSummary || ''}`;
      if (item.goal) t += `\n${item.goal}`;
    }
  } else {
    if (m.tool) t += '\n' + String(m.tool);
    if (m.toolSummary) t += '\n' + String(m.toolSummary);
  }
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
    attachmentManifest: gatherAttachmentManifest(older),
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
    const norm = projectToStorageJson(m);
    const role = norm.role || 'unknown';

    if (Array.isArray(norm.trajectory) && norm.trajectory.length) {
      const trajDesc = norm.trajectory.map((t) => {
        if (t.tool) return `[tool:${t.tool}] ${t.argsSummary || ''} (${t.status || 'done'})`;
        if (t.subagentId) return `[subagent:${t.kindName || 'explore'}] ${t.goal || ''} (${t.status || 'done'})`;
        if (t.kind === 'verify') return `[verify] passed=${t.passed}`;
        return `[action:${t.kind}]`;
      }).join('\n');
      parts.push(`[${role}]\n${norm.content || ''}\n【执行轨迹】\n${trajDesc}`);
    } else if (norm.tool || role === 'tool') {
      const name = norm.tool || 'tool';
      const body = String(norm.toolSummary || norm.content || '').slice(0, TOOL_SUMMARY_MAX);
      parts.push(`[tool:${name}]\n${body}`);
    } else {
      parts.push(`[${role}]\n${String(norm.content || '')}`);
    }
    for (const ref of norm.parts || []) if (ref.type === PART_TYPES.ATTACHMENT_REF) parts.push(attachmentMetadataText(ref));
  }
  let text = parts.join('\n\n');
  if (text.length > maxChars) {
    text = '…[transcript truncated]…\n' + text.slice(text.length - maxChars);
  }
  return require('./secret-manager').redactSecrets(text);
}

/** Replace `plan.older` with a single summary bubble; returns a new array. */
function applyCompact(messages, plan, summary) {
  const source = Array.isArray(messages) ? messages : [];
  const keepCount = plan && Array.isArray(plan.keep) ? Math.min(source.length, plan.keep.length) : 0;
  const keep = source.slice(source.length - keepCount).map(normalizeMessage);
  const older = source.slice(0, source.length - keepCount);
  const attachmentManifest = gatherAttachmentManifest(older);
  const content = `${SUMMARY_PREFIX.replace('%d', String(older.length))}\n${String(summary || '').trim()}`;
  const summaryMsg = createMessageV2({
    role: 'assistant', content,
    parts: [{ type: PART_TYPES.TEXT, text: content }, ...attachmentManifest],
    attachmentManifest,
    compact: true, compactAt: Date.now(), compactedCount: older.length, createdAt: Date.now(),
  });
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
async function generateCompactSummary({ transcript, settings, modelBinding, chatFn, signal, onUsage } = {}) {
  if (modelBinding != null && !require('./model-profiles').isResolvedModelBinding(modelBinding)) throw Object.assign(new Error('压缩需要主进程模型绑定。'), { code: 'MODEL_BINDING_INVALID' });
  if (signal?.aborted) throw Object.assign(new Error('已停止'), { code: 'ABORTED' });
  const text = String(transcript || '');
  if (!text.trim()) throw new Error('待压缩内容为空');
  const s = settings || {};
  const mode = s.mode === 'api' ? 'api' : 'local';
  if (mode === 'local') {
    return `（本地模式占位摘要）摘录约 ${text.length} 字符、约 ${approxTokensFromText(text)} token。切换到 API 模式可生成真实摘要。`;
  }
  if (modelBinding && typeof chatFn !== 'function') throw Object.assign(new Error('压缩缺少绑定的模型客户端。'), { code: 'MODEL_BOUND_CHAT_REQUIRED' });
  const sentMessages = [
    { role: 'system', content: buildCompactSystemPrompt() },
    { role: 'user', content: text.slice(0, TRANSCRIPT_MAX_DEFAULT) },
  ];
  let content;
  let rawUsage = null;
  if (typeof chatFn === 'function') {
    const response = await chatFn({
      ...(modelBinding ? { modelBinding } : { baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model }),
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
  if (signal?.aborted) throw Object.assign(new Error('已停止'), { code: 'ABORTED' });
  const out = String(content || '').trim();
  if (!modelBinding && typeof onUsage === 'function') {
    try {
      await Promise.resolve(onUsage({ rawUsage, messages: sentMessages, content: out }));
    } catch {
      // Usage metering is best-effort and must not turn a valid summary into a failure.
    }
  }
  if (!out) throw new Error('摘要为空');
  return out;
}

function bestEffortUsageReporter(onUsage) {
  if (typeof onUsage !== 'function') return undefined;
  return (event) => {
    try {
      const result = onUsage(event);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Usage 失败不能改变 compact 的消息结果。
    }
  };
}

async function generateCompactArtifacts({
  transcript, settings, modelBinding, candidateLimit, chatFn, candidateChatFn, signal, onUsage,
} = {}) {
  const reportUsage = bestEffortUsageReporter(onUsage);
  const summary = await generateCompactSummary({
    transcript, settings, modelBinding, chatFn, signal, onUsage: reportUsage,
  });
  try {
    const candidates = await generateMemoryCandidates({
      transcript, settings, modelBinding, limit: candidateLimit,
      chatFn: modelBinding ? candidateChatFn : (candidateChatFn || chatFn), signal, onUsage: reportUsage,
    });
    if (signal?.aborted) throw Object.assign(new Error('已停止'), { code: 'ABORTED' });
    return { summary, candidates, candidateWarning: null };
  } catch (error) {
    if (signal?.aborted || ['ABORTED', 'MODEL_TIMEOUT', 'MODEL_BINDING_INVALID', 'MODEL_BOUND_CHAT_REQUIRED'].includes(error?.code) || error?.name === 'AbortError') throw error;
    return {
      summary,
      candidates: [],
      candidateWarning: '候选提炼失败，已仅完成会话压缩',
    };
  }
}

module.exports = {
  gatherAttachmentManifest,
  approxTokensFromText,
  approxTokensFromMessages,
  planCompact,
  serializeOlderTranscript,
  applyCompact,
  buildCompactSystemPrompt,
  generateCompactSummary,
  generateCompactArtifacts,
  TRANSCRIPT_MAX_DEFAULT,
  TOOL_SUMMARY_MAX,
};
