const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createWebProvider } = require('../src/ai/providers/web');

function ctxWith(overrides = {}) {
  return {
    settings: { webEnabled: true, webAllowDomains: [], webDenyDomains: [], webTimeoutMs: 15000, webMaxBytes: 524288, webMaxChars: 15000 },
    extensions: {},
    subagentDepth: 0,
    agentMode: 'agent',
    ...overrides,
  };
}

describe('web provider', () => {
  it('is disabled unless webEnabled is true', () => {
    const p = createWebProvider();
    assert.equal(p.isEnabled(ctxWith({ settings: { webEnabled: false } })), false);
    assert.equal(p.isEnabled(ctxWith({ settings: {} })), false);
    assert.equal(p.isEnabled(ctxWith()), true);
  });

  it('stays enabled in plan mode and for subagents', () => {
    const p = createWebProvider();
    assert.equal(p.isEnabled(ctxWith({ agentMode: 'plan' })), true);
    assert.equal(p.isEnabled(ctxWith({ subagentDepth: 1 })), true);
  });

  it('exposes exactly one tool named web_fetch requiring url', () => {
    const tools = createWebProvider().getTools(ctxWith());
    assert.equal(tools.length, 1);
    assert.equal(tools[0].function.name, 'web_fetch');
    assert.deepEqual(tools[0].function.parameters.required, ['url']);
  });

  it('executes via injected fetchImpl and returns JSON string', async () => {
    const seen = [];
    const p = createWebProvider({
      fetchImpl: async (url, opts) => { seen.push({ url, opts }); return { ok: true, url, status: 200, text: '内容', truncated: false, redirects: [] }; },
    });
    const ctx = ctxWith();
    await p.onRunStart(ctx);
    const out = JSON.parse(await p.execute('web_fetch', { url: 'https://example.com/a' }, ctx));
    assert.equal(out.ok, true);
    assert.equal(seen[0].opts.maxChars, 15000);
    assert.deepEqual(seen[0].opts.allowDomains, []);
  });

  it('caches per finalUrl within a run and shares the map with children', async () => {
    let calls = 0;
    const p = createWebProvider({
      fetchImpl: async (url) => { calls += 1; return { ok: true, url, status: 200, text: 'x', truncated: false, redirects: [] }; },
    });
    const ctx = ctxWith();
    await p.onRunStart(ctx);
    await p.execute('web_fetch', { url: 'https://example.com/a' }, ctx);
    await p.execute('web_fetch', { url: 'https://example.com/a' }, ctx);
    assert.equal(calls, 1);
    const childCtx = { ...ctx, subagentDepth: 1 };
    await p.onRunStart(childCtx);
    await p.execute('web_fetch', { url: 'https://example.com/a' }, childCtx);
    assert.equal(calls, 1);
    await p.onRunEnd(childCtx);
    assert.ok(ctx.extensions.webCache instanceof Map);
    await p.onRunEnd(ctx);
    assert.equal(ctx.extensions.webCache, undefined);
  });

  it('does not cache failures', async () => {
    let calls = 0;
    const p = createWebProvider({
      fetchImpl: async () => { calls += 1; return { ok: false, code: 'HTTP_500', error: 'HTTP 500' }; },
    });
    const ctx = ctxWith();
    await p.onRunStart(ctx);
    await p.execute('web_fetch', { url: 'https://example.com/e' }, ctx);
    await p.execute('web_fetch', { url: 'https://example.com/e' }, ctx);
    assert.equal(calls, 2);
  });

  it('rejects empty url without calling fetchImpl', async () => {
    let calls = 0;
    const p = createWebProvider({ fetchImpl: async () => { calls += 1; } });
    const ctx = ctxWith();
    const out = JSON.parse(await p.execute('web_fetch', {}, ctx));
    assert.equal(out.ok, false);
    assert.equal(calls, 0);
  });

  it('system fragment marks web content as data, not instructions', () => {
    const frag = createWebProvider().getSystemFragment(ctxWith());
    assert.match(frag, /web_fetch/);
    assert.match(frag, /数据|不是指令/);
  });
});
