function buildChatPayload(model, messages, extra = {}) {
  const body = {
    model,
    messages,
    temperature: extra.temperature ?? 0.7,
  };
  if (extra.tools) body.tools = extra.tools;
  if (extra.tool_choice) body.tool_choice = extra.tool_choice;
  if (extra.stream) body.stream = true;
  if (extra.stream && extra.includeUsage !== false) {
    body.stream_options = { include_usage: true };
  }
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

function abortedError() {
  const e = new Error('已停止');
  e.code = 'ABORTED';
  return e;
}

function isAbortError(err, signal) {
  return err?.code === 'ABORTED' || err?.name === 'AbortError' || !!signal?.aborted;
}

async function* iterateSse(fetchRes) {
  const reader = fetchRes?.body?.getReader?.();
  if (!reader) {
    throw new Error('SSE stream: response body has no getReader');
  }
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    let result;
    try {
      result = await reader.read();
    } catch (err) {
      if (isAbortError(err)) throw abortedError();
      throw err;
    }
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    // Normalize CRLF; process complete lines
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') return;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        throw new Error(`SSE parse error: ${payload.slice(0, 120)}`);
      }
      yield json;
    }
  }
}

function accumulateToolCall(map, tc) {
  const idx = typeof tc.index === 'number' ? tc.index : 0;
  let acc = map.get(idx);
  if (!acc) {
    acc = {
      id: '',
      type: 'function',
      function: { name: '', arguments: '' },
    };
    map.set(idx, acc);
  }
  if (tc.id) acc.id = tc.id;
  if (tc.type) acc.type = tc.type;
  if (tc.function?.name) acc.function.name += tc.function.name;
  if (typeof tc.function?.arguments === 'string') {
    acc.function.arguments += tc.function.arguments;
  }
}

async function postChatCompletions({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  tool_choice,
  fetchFn,
  temperature,
  signal,
  stream,
  includeUsage,
}) {
  const fetchImpl = fetchFn || globalThis.fetch;
  if (!fetchImpl) throw new Error('当前环境没有 fetch，无法调用 API');
  if (!model) throw new Error('Model 为空，请在设置中填写模型名');

  const root = normalizeBaseUrl(baseUrl);
  const url = `${root}/chat/completions`;
  const body = buildChatPayload(model, messages, {
    tools,
    tool_choice,
    temperature,
    stream: !!stream,
    includeUsage,
  });

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
    if (isAbortError(err, signal)) throw abortedError();
    throw new Error(`网络请求失败（${url}）: ${err?.message || err}`);
  }
  return { res, url };
}

async function chatRequest({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  tool_choice,
  fetchFn,
  temperature,
  signal,
  includeUsage,
}) {
  const { res, url } = await postChatCompletions({
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    tool_choice,
    fetchFn,
    temperature,
    signal,
    stream: false,
    includeUsage,
  });

  const { text, json } = await readResponseBody(res);
  if (!res.ok) throw new Error(formatHttpError(res.status, url, text, json));
  if (!json) throw new Error(formatHttpError(res.status || 200, url, text, null));
  return json;
}

async function streamChatCompletionMessage(opts) {
  const {
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    tool_choice,
    fetchFn,
    temperature,
    signal,
    onDelta,
    includeUsage,
  } = opts;

  const { res, url } = await postChatCompletions({
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    tool_choice,
    fetchFn,
    temperature,
    signal,
    stream: true,
    includeUsage,
  });

  if (!res.ok) {
    let text = '';
    let json = null;
    if (typeof res.text === 'function') {
      ({ text, json } = await readResponseBody(res));
    }
    throw new Error(formatHttpError(res.status, url, text, json));
  }

  let content = '';
  let usage;
  const toolMap = new Map();

  try {
    for await (const event of iterateSse(res)) {
      if (signal?.aborted) throw abortedError();
      if (event?.usage && typeof event.usage === 'object') usage = event.usage;
      const delta = event?.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        if (typeof onDelta === 'function') onDelta({ text: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) accumulateToolCall(toolMap, tc);
      }
    }
  } catch (err) {
    if (isAbortError(err, signal)) throw abortedError();
    throw err;
  }

  if (signal?.aborted) throw abortedError();

  const tool_calls = toolMap.size
    ? [...toolMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
    : undefined;

  return {
    role: 'assistant',
    content,
    tool_calls: tool_calls?.length ? tool_calls : undefined,
    usage,
  };
}

/** Returns assistant message object: { role, content, tool_calls? } */
async function chatCompletionMessage(opts) {
  if (opts?.stream) {
    return streamChatCompletionMessage(opts);
  }

  const json = await chatRequest(opts);
  const msg = json?.choices?.[0]?.message;
  if (!msg) {
    throw new Error('API 返回缺少 message: ' + JSON.stringify(json).slice(0, 240));
  }
  return {
    role: 'assistant',
    content: typeof msg.content === 'string' ? msg.content : (msg.content ?? ''),
    tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : undefined,
    usage: json?.usage && typeof json.usage === 'object' ? json.usage : undefined,
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
