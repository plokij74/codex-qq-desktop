const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildChatPayload, chatCompletion, normalizeBaseUrl } = require('../src/ai/openai-compatible');

describe('openai-compatible', () => {
  it('buildChatPayload shapes request body', () => {
    const body = buildChatPayload('gpt-4o-mini', [{ role: 'user', content: 'hi' }]);
    assert.equal(body.model, 'gpt-4o-mini');
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
});
