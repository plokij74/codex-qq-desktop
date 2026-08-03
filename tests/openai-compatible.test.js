const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildChatPayload,
  chatCompletion,
  chatCompletionMessage,
  normalizeBaseUrl,
} = require('../src/ai/openai-compatible');

function mockSseFetch(chunks, { captureBody } = {}) {
  let i = 0;
  const encoder = new TextEncoder();
  return async (_url, opts) => {
    if (captureBody) captureBody(opts?.body);
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              if (i >= chunks.length) return { done: true, value: undefined };
              const value = encoder.encode(chunks[i++]);
              return { done: false, value };
            },
          };
        },
      },
    };
  };
}

describe('openai-compatible', () => {
  it('buildChatPayload shapes request body', () => {
    const body = buildChatPayload('gpt-4o-mini', [{ role: 'user', content: 'hi' }]);
    assert.equal(body.model, 'gpt-4o-mini');
  });

  it('buildChatPayload sets stream when requested', () => {
    const body = buildChatPayload('m', [{ role: 'user', content: 'hi' }], { stream: true });
    assert.equal(body.stream, true);
  });

  it('D.3 buildChatPayload adds stream_options only for stream', () => {
    const streamed = buildChatPayload('m', [], { stream: true });
    assert.deepEqual(streamed.stream_options, { include_usage: true });
    const disabled = buildChatPayload('m', [], { stream: true, includeUsage: false });
    assert.equal(disabled.stream_options, undefined);
    const nonStreamed = buildChatPayload('m', [], {});
    assert.equal(nonStreamed.stream_options, undefined);
  });

  it('normalizeBaseUrl strips chat/completions suffix', () => {
    assert.equal(normalizeBaseUrl('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1');
  });

  it('chatCompletion returns assistant content on 200', async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: 'hello from api' } }],
      }),
    });
    const text = await chatCompletion({
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchFn,
    });
    assert.equal(text, 'hello from api');
  });

  it('D.3 non-stream response carries usage through', async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 100, completion_tokens: 7 },
      }),
    });
    const msg = await chatCompletionMessage({
      baseUrl: 'https://example.com/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      fetchFn,
    });
    assert.deepEqual(msg.usage, { prompt_tokens: 100, completion_tokens: 7 });
  });

  it('chatCompletion throws on error status', async () => {
    const fetchFn = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: 'bad key' } }),
    });
    await assert.rejects(
      () => chatCompletion({
        baseUrl: 'https://example.com/v1',
        apiKey: 'x',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        fetchFn,
      }),
      /401|bad key/
    );
  });

  it('chatCompletion explains HTML responses', async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      text: async () => '<!doctype html><html><body>Not Found</body></html>',
    });
    await assert.rejects(
      () => chatCompletion({
        baseUrl: 'https://example.com',
        apiKey: 'x',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        fetchFn,
      }),
      /HTML|Base URL|JSON/
    );
  });

  it('chatCompletionMessage stream concatenates deltas', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    let posted;
    const fetchFn = mockSseFetch(chunks, {
      captureBody: (b) => { posted = JSON.parse(b); },
    });
    const deltas = [];
    const msg = await chatCompletionMessage({
      baseUrl: 'https://example.com/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      onDelta: (d) => { if (d.text) deltas.push(d.text); },
      fetchFn,
    });
    assert.equal(msg.content, 'Hello');
    assert.equal(msg.role, 'assistant');
    assert.deepEqual(deltas, ['Hel', 'lo']);
    assert.equal(posted.stream, true);
  });

  it('D.3 stream captures usage from the final empty-choices chunk', async () => {
    const fetchFn = mockSseFetch([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":42,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const msg = await chatCompletionMessage({
      baseUrl: 'https://example.com/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      fetchFn,
      stream: true,
    });
    assert.equal(msg.content, '你好');
    assert.deepEqual(msg.usage, { prompt_tokens: 42, completion_tokens: 2 });
  });

  it('D.3 stream without usage chunk leaves msg.usage undefined', async () => {
    let posted;
    const fetchFn = mockSseFetch([
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: [DONE]\n\n',
    ], { captureBody: (body) => { posted = JSON.parse(body); } });
    const msg = await chatCompletionMessage({
      baseUrl: 'https://example.com/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      fetchFn,
      stream: true,
    });
    assert.equal(msg.usage, undefined);
    assert.deepEqual(posted.stream_options, { include_usage: true });
  });

  it('D.3 includeUsage false is forwarded to the streamed request body', async () => {
    let posted;
    const fetchFn = mockSseFetch([
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: [DONE]\n\n',
    ], { captureBody: (body) => { posted = JSON.parse(body); } });
    await chatCompletionMessage({
      baseUrl: 'https://example.com/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      fetchFn,
      stream: true,
      includeUsage: false,
    });
    assert.equal(posted.stream_options, undefined);
  });

  it('chatCompletionMessage stream accumulates tool_calls deltas', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"list_dir","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\".\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchFn = mockSseFetch(chunks);
    const deltas = [];
    const msg = await chatCompletionMessage({
      baseUrl: 'https://example.com/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'list' }],
      stream: true,
      onDelta: (d) => { if (d.text) deltas.push(d.text); },
      fetchFn,
    });
    assert.equal(msg.content, '');
    assert.deepEqual(deltas, []);
    assert.ok(Array.isArray(msg.tool_calls));
    assert.equal(msg.tool_calls.length, 1);
    assert.equal(msg.tool_calls[0].id, 'call_1');
    assert.equal(msg.tool_calls[0].type, 'function');
    assert.equal(msg.tool_calls[0].function.name, 'list_dir');
    assert.equal(msg.tool_calls[0].function.arguments, '{"path":"."}');
  });

  it('chatCompletionMessage stream abort throws ABORTED', async () => {
    const ac = new AbortController();
    const encoder = new TextEncoder();
    let released = false;
    const fetchFn = async (_url, opts) => ({
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              if (opts.signal?.aborted) {
                const err = new Error('The user aborted a request.');
                err.name = 'AbortError';
                throw err;
              }
              if (!released) {
                released = true;
                ac.abort();
                return {
                  done: false,
                  value: encoder.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'),
                };
              }
              // second read after abort
              const err = new Error('The user aborted a request.');
              err.name = 'AbortError';
              throw err;
            },
          };
        },
      },
    });
    await assert.rejects(
      () => chatCompletionMessage({
        baseUrl: 'https://example.com/v1',
        apiKey: 'k',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        signal: ac.signal,
        fetchFn,
      }),
      (err) => {
        assert.equal(err.code, 'ABORTED');
        assert.match(err.message, /已停止/);
        return true;
      }
    );
  });
});
