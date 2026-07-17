function buildChatPayload(model, messages, extra = {}) {
  const body = {
    model,
    messages,
    temperature: extra.temperature ?? 0.7,
  };
  if (extra.tools) body.tools = extra.tools;
  if (extra.tool_choice) body.tool_choice = extra.tool_choice;
  return body;
}

function normalizeBaseUrl(baseUrl) {
  let root = String(baseUrl || '').trim();
  if (!root) {
    throw new Error('Base URL 为空，请在设置中填写，例如 https://api.openai.com/v1');
  }
  root = root.replace(/\/+$/, '');
  root = root.replace(/\/chat\/completions$/i, '');
  root = root.replace(/\/+$/, '');
  return root;
}

function looksLikeHtml(text) {
  const s = String(text || '').trim().slice(0, 200).toLowerCase();
  return s.startsWith('<!doctype') || s.startsWith('<html') || s.includes('<head') || s.includes('<body');
}

async function readResponseBody(res) {
  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  return { text, json };
}

function formatHttpError(status, url, text, json) {
  if (json?.error?.message) return `API ${status}: ${json.error.message}`;
  if (json?.message) return `API ${status}: ${json.message}`;
  if (looksLikeHtml(text)) {
    return [
      `API ${status}: 返回了 HTML 页面而不是 JSON。`,
      `请求地址: ${url}`,
      '常见原因：Base URL 填错 / 代理拦截 / Key 无效',
      text ? `响应片段: ${String(text).replace(/\s+/g, ' ').slice(0, 160)}` : '',
    ].filter(Boolean).join('\n');
  }
  const snippet = String(text || '').replace(/\s+/g, ' ').slice(0, 200);
  return `API ${status}${snippet ? `: ${snippet}` : ''}`;
}

async function chatRequest({ baseUrl, apiKey, model, messages, tools, tool_choice, fetchFn, temperature, signal }) {
  const fetchImpl = fetchFn || globalThis.fetch;
  if (!fetchImpl) throw new Error('当前环境没有 fetch，无法调用 API');
  if (!model) throw new Error('Model 为空，请在设置中填写模型名');

  const root = normalizeBaseUrl(baseUrl);
  const url = `${root}/chat/completions`;
  const body = buildChatPayload(model, messages, { tools, tool_choice, temperature });

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey || ''}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      const e = new Error('已停止');
      e.code = 'ABORTED';
      throw e;
    }
    throw new Error(`网络请求失败（${url}）: ${err?.message || err}`);
  }

  const { text, json } = await readResponseBody(res);
  if (!res.ok) throw new Error(formatHttpError(res.status, url, text, json));
  if (!json) throw new Error(formatHttpError(res.status || 200, url, text, null));
  return json;
}

/** Returns assistant message object: { role, content, tool_calls? } */
async function chatCompletionMessage(opts) {
  const json = await chatRequest(opts);
  const msg = json?.choices?.[0]?.message;
  if (!msg) {
    throw new Error('API 返回缺少 message: ' + JSON.stringify(json).slice(0, 240));
  }
  return {
    role: 'assistant',
    content: typeof msg.content === 'string' ? msg.content : (msg.content ?? ''),
    tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : undefined,
  };
}

/** Back-compat: string content only */
async function chatCompletion(opts) {
  const msg = await chatCompletionMessage(opts);
  if (msg.tool_calls?.length) {
    // if tools returned unexpectedly, still try content
  }
  if (typeof msg.content !== 'string' || (!msg.content && !msg.tool_calls?.length)) {
    throw new Error('API 返回空内容');
  }
  return msg.content || '';
}

module.exports = {
  buildChatPayload,
  chatCompletion,
  chatCompletionMessage,
  chatRequest,
  normalizeBaseUrl,
  looksLikeHtml,
};
