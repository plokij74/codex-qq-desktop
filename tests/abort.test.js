const test = require('node:test');
const assert = require('node:assert/strict');
const { chatRequest } = require('../src/ai/openai-compatible');

test('chatRequest aborts with 已停止 / ABORTED', async () => {
  const ac = new AbortController();
  const fetchFn = (_url, opts) => new Promise((_resolve, reject) => {
    const onAbort = () => {
      const err = new Error('The user aborted a request.');
      err.name = 'AbortError';
      reject(err);
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  });

  const p = chatRequest({
    baseUrl: 'https://example.com/v1',
    apiKey: 'k',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    fetchFn,
    signal: ac.signal,
  });
  ac.abort();
  await assert.rejects(p, (err) => {
    assert.equal(err.code, 'ABORTED');
    assert.match(err.message, /已停止/);
    return true;
  });
});
