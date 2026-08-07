'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  approxTokensFromText,
  approxTokensFromMessages,
  planCompact,
  serializeOlderTranscript,
  applyCompact,
  buildCompactSystemPrompt,
  TOOL_SUMMARY_MAX,
} = require('../src/ai/session-compact');

describe('session-compact', () => {
  it('approxTokensFromText uses ceil length/4', () => {
    assert.equal(approxTokensFromText(''), 0);
    assert.equal(approxTokensFromText('abcd'), 1);
    assert.equal(approxTokensFromText('abcde'), 2);
    assert.equal(approxTokensFromText(null), 0);
  });

  it('approxTokensFromMessages sums content and tool summaries', () => {
    const msgs = [
      { role: 'user', content: 'abcd' },
      { role: 'assistant', content: 'abcd', tool: 'read', toolSummary: 'abcd' },
    ];
    // 'abcd' = 1 token; second message adds '\nread' + '\nabcd' before ceil
    assert.ok(approxTokensFromMessages(msgs) > 2);
    assert.equal(approxTokensFromMessages(null), 0);
  });

  it('planCompact not needed when under thresholds', () => {
    const msgs = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    const p = planCompact(msgs, { keepMessages: 24, maxMessages: 40, maxApproxTokens: 24000 });
    assert.equal(p.needed, false);
    assert.equal(p.older.length, 0);
    assert.equal(p.keep.length, 2);
  });

  it('planCompact not needed when count under keepMessages even if tokens large', () => {
    const msgs = [{ role: 'user', content: 'x'.repeat(400000) }];
    const p = planCompact(msgs, { keepMessages: 24, maxMessages: 40, maxApproxTokens: 1000 });
    assert.equal(p.needed, false);
  });

  it('planCompact triggers on token threshold alone', () => {
    const msgs = [];
    for (let i = 0; i < 12; i += 1) msgs.push({ role: 'user', content: 'x'.repeat(4000) });
    const p = planCompact(msgs, { keepMessages: 4, maxMessages: 1000, maxApproxTokens: 5000 });
    assert.equal(p.needed, true);
    assert.equal(p.keep.length, 4);
    assert.equal(p.older.length, 8);
  });

  it('planCompact splits older and keep', () => {
    const msgs = [];
    for (let i = 0; i < 30; i += 1) {
      msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
    }
    const p = planCompact(msgs, { keepMessages: 10, maxMessages: 20, maxApproxTokens: 24000 });
    assert.equal(p.needed, true);
    assert.equal(p.keep.length, 10);
    assert.equal(p.older.length, 20);
    assert.equal(p.keep[0].content, 'm20');
    assert.equal(p.olderApproxTokens > 0, true);
  });

  it('force compact when under max thresholds but has older prefix', () => {
    const msgs = [];
    for (let i = 0; i < 30; i += 1) msgs.push({ role: 'user', content: 'x' + i });
    const p = planCompact(msgs, {
      keepMessages: 10,
      maxMessages: 100,
      maxApproxTokens: 999999,
      force: true,
    });
    assert.equal(p.needed, true);
    assert.equal(p.older.length, 20);
  });

  it('force compact still not needed when older is only a prior summary', () => {
    const msgs = [
      { role: 'assistant', content: '【会话摘要 · 更早 9 条已压缩】…', compact: true },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    const p = planCompact(msgs, {
      keepMessages: 2,
      maxMessages: 2,
      maxApproxTokens: 1,
      force: true,
    });
    assert.equal(p.needed, false);
  });

  it('serializeOlderTranscript labels roles and truncates tool lines', () => {
    const older = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world', tool: 'write_file', toolSummary: 'x'.repeat(500) },
    ];
    const t = serializeOlderTranscript(older, { maxChars: 10000 });
    assert.match(t, /\[user\]/);
    assert.match(t, /hello/);
    assert.match(t, /\[tool:write_file\]/);
    assert.ok(!t.includes('x'.repeat(TOOL_SUMMARY_MAX + 1)));
  });

  it('serializeOlderTranscript truncates total length keeping the tail', () => {
    const older = [
      { role: 'user', content: 'START' + 'a'.repeat(2000) },
      { role: 'assistant', content: 'b'.repeat(2000) + 'END' },
    ];
    const t = serializeOlderTranscript(older, { maxChars: 500 });
    assert.ok(t.length <= 500 + 32);
    assert.match(t, /transcript truncated/);
    assert.match(t, /END$/);
    assert.ok(!t.includes('START'));
  });

  it('applyCompact prepends summary message with compact flag', () => {
    const msgs = [
      { role: 'user', content: 'old1' },
      { role: 'assistant', content: 'old2' },
      { role: 'user', content: 'new1' },
    ];
    const plan = planCompact(msgs, {
      keepMessages: 1,
      maxMessages: 1,
      maxApproxTokens: 1,
      force: true,
    });
    const out = applyCompact(msgs, plan, '要点：测试');
    assert.equal(out.length, 2);
    assert.equal(out[0].role, 'assistant');
    assert.equal(out[0].compact, true);
    assert.match(out[0].content, /会话摘要/);
    assert.match(out[0].content, /要点：测试/);
    assert.equal(out[0].compactedCount, plan.older.length);
    assert.equal(typeof out[0].compactAt, 'number');
    assert.equal(out[1].content, 'new1');
  });

  it('applyCompact does not mutate the input array', () => {
    const msgs = [
      { role: 'user', content: 'old1' },
      { role: 'user', content: 'new1' },
    ];
    const plan = planCompact(msgs, { keepMessages: 1, maxMessages: 1, maxApproxTokens: 1, force: true });
    applyCompact(msgs, plan, 's');
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].content, 'old1');
  });

  it('buildCompactSystemPrompt asks for Chinese structured summary', () => {
    const p = buildCompactSystemPrompt();
    assert.match(p, /中文/);
    assert.match(p, /路径|决策/);
  });
});

describe('generateCompactSummary', () => {
  const { generateCompactSummary } = require('../src/ai/session-compact');

  it('local mode returns a placeholder without calling out', async () => {
    let called = false;
    const s = await generateCompactSummary({
      transcript: 'hello',
      settings: { mode: 'local' },
      chatFn: async () => { called = true; return 'nope'; },
    });
    assert.equal(called, false);
    assert.match(s, /本地模式占位摘要/);
    assert.match(s, /token/);
  });

  it('api mode uses the injected chatFn', async () => {
    let seen = null;
    const s = await generateCompactSummary({
      transcript: 'abc',
      settings: { mode: 'api', apiKey: 'k', baseUrl: 'http://x', model: 'm' },
      chatFn: async (opts) => { seen = opts; return '  摘要正文  '; },
    });
    assert.equal(s, '摘要正文');
    assert.equal(seen.model, 'm');
    assert.equal(seen.apiKey, 'k');
    assert.equal(seen.messages.length, 2);
    assert.equal(seen.messages[0].role, 'system');
    assert.equal(seen.messages[1].content, 'abc');
  });

  it('api mode truncates the transcript to the hard cap', async () => {
    const { TRANSCRIPT_MAX_DEFAULT } = require('../src/ai/session-compact');
    let seen = null;
    await generateCompactSummary({
      transcript: 'y'.repeat(TRANSCRIPT_MAX_DEFAULT + 500),
      settings: { mode: 'api', model: 'm' },
      chatFn: async (opts) => { seen = opts; return 'ok'; },
    });
    assert.equal(seen.messages[1].content.length, TRANSCRIPT_MAX_DEFAULT);
  });

  it('rejects an empty transcript', async () => {
    await assert.rejects(
      () => generateCompactSummary({ transcript: '   ', settings: { mode: 'local' } }),
      /为空/
    );
  });

  it('drives the whole session:compact pipeline in local mode', async () => {
    // Mirrors the main-process handler: plan -> serialize -> summarize -> apply.
    const messages = [];
    for (let i = 0; i < 30; i += 1) {
      messages.push({ role: i % 2 ? 'assistant' : 'user', content: 'msg ' + i });
    }
    const settings = {
      mode: 'local',
      compactKeepMessages: 6,
      compactMaxMessages: 20,
      compactMaxApproxTokens: 24000,
    };
    const plan = planCompact(messages, {
      keepMessages: settings.compactKeepMessages,
      maxMessages: settings.compactMaxMessages,
      maxApproxTokens: settings.compactMaxApproxTokens,
      force: false,
    });
    assert.equal(plan.needed, true);
    const transcript = serializeOlderTranscript(plan.older);
    const summary = await generateCompactSummary({ transcript, settings });
    const next = applyCompact(messages, plan, summary);
    assert.equal(next.length, 7);
    assert.equal(next[0].compact, true);
    assert.equal(next[0].compactedCount, 24);
    assert.equal(next[1].content, 'msg 24');
    assert.equal(next[6].content, 'msg 29');
    // A second pass over the compacted history is a no-op until it grows again.
    const again = planCompact(next, {
      keepMessages: settings.compactKeepMessages,
      maxMessages: settings.compactMaxMessages,
      maxApproxTokens: settings.compactMaxApproxTokens,
      force: true,
    });
    assert.equal(again.needed, false);
  });

  it('rejects an empty model reply', async () => {
    let usageCalled = false;
    await assert.rejects(
      () => generateCompactSummary({
        transcript: 'abc',
        settings: { mode: 'api', model: 'm' },
        chatFn: async () => '   ',
        onUsage: () => { usageCalled = true; },
      }),
      /摘要为空/
    );
    assert.equal(usageCalled, true);
  });

  it('reports usage inputs after an injected API call', async () => {
    let seen;
    await generateCompactSummary({
      transcript: 'some earlier messages',
      settings: { mode: 'api', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' },
      chatFn: async () => ({
        content: 'summary',
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
      onUsage: (usage) => { seen = usage; },
    });
    assert.deepEqual(seen.rawUsage, { prompt_tokens: 12, completion_tokens: 3 });
    assert.equal(seen.content, 'summary');
    assert.ok(Array.isArray(seen.messages));
  });

  it('does not report usage in local mode', async () => {
    let called = false;
    await generateCompactSummary({
      transcript: 'x',
      settings: { mode: 'local' },
      onUsage: () => { called = true; },
    });
    assert.equal(called, false);
  });

  it('does not fail a valid summary when usage reporting throws or rejects', async () => {
    const base = {
      transcript: 'x',
      settings: { mode: 'api', model: 'm' },
      chatFn: async () => 'summary',
    };
    assert.equal(await generateCompactSummary({
      ...base,
      onUsage: () => { throw new Error('sync usage failure'); },
    }), 'summary');
    assert.equal(await generateCompactSummary({
      ...base,
      onUsage: async () => { throw new Error('async usage failure'); },
    }), 'summary');
  });
});
