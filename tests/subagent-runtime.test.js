'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSubagentRuntime, mergeSubagentFileChanges } = require('../src/ai/subagent-runtime');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('D.3 usage forwarding', () => {
  it('overrides kind on forwarded usage events', async () => {
    const events = [];
    const runtime = createSubagentRuntime({
      runLoop: async ({ onEvent }) => {
        onEvent({ type: 'usage', kind: 'main', inputTokens: 5, outputTokens: 1 });
        return { content: 'done', turns: 1, agentLog: [] };
      },
    });
    await runtime.runExplore({
      project: { path: '/tmp' },
      settings: {},
      gate: null,
      onEvent: (event) => events.push(event),
      extensions: {},
      sessionKey: 's',
      subagentDepth: 0,
    }, { goal: 'inspect usage forwarding' });
    const usage = events.find((event) => event.type === 'usage');
    assert.equal(usage.kind, 'explore');
    assert.equal(usage.subagent, true);
    assert.equal(typeof usage.subagentId, 'string');
  });
});

function makeCtx(overrides = {}) {
  const events = [];
  return {
    events,
    ctx: {
      subagentDepth: 0,
      settings: { subagentEnabled: true, exploreMaxParallel: 2, maxAgentTurns: 8 },
      agentMode: 'agent',
      project: { path: process.cwd(), name: 't' },
      gate: {},
      sessionKey: 's1',
      signal: overrides.signal,
      onEvent: (e) => events.push(e),
      extensions: { mcpHub: { x: 1 }, keep: true },
      registry: {},
      ...overrides.ctx,
    },
  };
}

describe('subagent-runtime', () => {
  it('runExplore sets depth 1, kind explore, strips mcpHub and subagentRuntime, emits start/end', async () => {
    let seen;
    const rt = createSubagentRuntime({
      runLoop: async (opts) => {
        seen = opts;
        return { content: 'sum', turns: 1, agentLog: [{ tool: 'grep', ok: true, summary: 'ok' }], fileChanges: [] };
      },
    });
    const { ctx, events } = makeCtx({
      ctx: {
        extensions: { mcpHub: { x: 1 }, subagentRuntime: { y: 1 }, keep: true },
      },
    });
    const out = await rt.runExplore(ctx, { goal: 'find auth module', maxTurns: 3 });
    assert.equal(out.ok, true);
    assert.equal(out.kind, 'explore');
    assert.ok(String(out.subagentId).startsWith('sa_'));
    assert.equal(seen.subagentDepth, 1);
    assert.equal(seen.subagentKind, 'explore');
    assert.equal(seen.settings.maxAgentTurns, 3);
    assert.equal(seen.extensions.mcpHub, undefined);
    assert.equal(seen.extensions.subagentRuntime, undefined);
    assert.equal(seen.extensions.keep, true);
    assert.ok(events.some((e) => e.type === 'subagent-start' && e.kind === 'explore'));
    assert.ok(events.some((e) => e.type === 'subagent-end' && e.ok === true));
  });

  it('rejects re-spawn when subagentDepth >= 1', async () => {
    let ran = 0;
    const rt = createSubagentRuntime({
      runLoop: async () => {
        ran += 1;
        return { content: 'x', turns: 1, agentLog: [] };
      },
    });
    const { ctx } = makeCtx({ ctx: { subagentDepth: 1 } });
    const explore = await rt.runExplore(ctx, { goal: 'should not spawn' });
    assert.equal(explore.ok, false);
    assert.match(String(explore.error || ''), /禁止|spawn|depth/i);
    const implement = await rt.runImplement(ctx, { goal: 'should not spawn' });
    assert.equal(implement.ok, false);
    assert.match(String(implement.error || ''), /禁止|spawn|depth/i);
    assert.equal(ran, 0);
  });

  it('limits explore concurrency to exploreMaxParallel', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const rt = createSubagentRuntime({
      runLoop: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(40);
        concurrent -= 1;
        return { content: 'x', turns: 1, agentLog: [] };
      },
    });
    const { ctx } = makeCtx();
    ctx.settings.exploreMaxParallel = 2;
    await Promise.all([
      rt.runExplore(ctx, { goal: 'goal one xx' }),
      rt.runExplore(ctx, { goal: 'goal two xx' }),
      rt.runExplore(ctx, { goal: 'goal three x' }),
    ]);
    assert.equal(maxConcurrent, 2);
  });

  it('serializes implement runs', async () => {
    const order = [];
    const rt = createSubagentRuntime({
      runLoop: async (opts) => {
        const tag = String(opts.messages[0].content);
        order.push('start:' + tag);
        await sleep(30);
        order.push('end:' + tag);
        return { content: 'done', turns: 1, agentLog: [], fileChanges: [{ path: 'a.js', op: 'write' }] };
      },
    });
    const { ctx } = makeCtx();
    await Promise.all([
      rt.runImplement(ctx, { goal: 'task AAA implement' }),
      rt.runImplement(ctx, { goal: 'task BBB implement' }),
    ]);
    // No interleaving of two implements (order of which runs first is not guaranteed)
    assert.equal(order.length, 4);
    const firstStart = order[0];
    const firstEnd = order[1];
    const secondStart = order[2];
    const secondEnd = order[3];
    assert.ok(firstStart.startsWith('start:'));
    assert.ok(firstEnd.startsWith('end:'));
    assert.ok(secondStart.startsWith('start:'));
    assert.ok(secondEnd.startsWith('end:'));
    assert.equal(firstStart.slice(6), firstEnd.slice(4));
    assert.equal(secondStart.slice(6), secondEnd.slice(4));
    assert.notEqual(firstStart.slice(6), secondStart.slice(6));
  });

  it('runExplores preserves goal order and sets parallel', async () => {
    const rt = createSubagentRuntime({
      runLoop: async (opts) => ({
        content: 's:' + opts.messages[0].content,
        turns: 1,
        agentLog: [],
      }),
    });
    const { ctx } = makeCtx();
    const out = await rt.runExplores(ctx, {
      goals: ['goal alpha here', 'goal beta here'],
      maxTurns: 2,
    });
    assert.equal(out.parallel, true);
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].ok, true);
    assert.match(out.results[0].summary, /alpha/);
    assert.match(out.results[1].summary, /beta/);
    assert.equal(out.ok, true);
  });

  it('rejects short goal', async () => {
    const rt = createSubagentRuntime({
      runLoop: async () => ({ content: 'x', turns: 0, agentLog: [] }),
    });
    const { ctx } = makeCtx();
    const out = await rt.runExplore(ctx, { goal: 'ab' });
    assert.equal(out.ok, false);
  });

  it('aborts queued explore when signal aborted', async () => {
    const ac = new AbortController();
    let started = 0;
    const rt = createSubagentRuntime({
      runLoop: async () => {
        started += 1;
        await sleep(80);
        return { content: 'x', turns: 1, agentLog: [] };
      },
    });
    const { ctx } = makeCtx({ signal: ac.signal });
    ctx.settings.exploreMaxParallel = 1;
    const p1 = rt.runExplore(ctx, { goal: 'first goal xx' });
    const p2 = rt.runExplore(ctx, { goal: 'second goal x' });
    await sleep(10);
    ac.abort();
    const results = await Promise.allSettled([p1, p2]);
    // At least one should reject with ABORTED or return ok:false with abort semantics.
    // Runtime should throw ABORTED for consistency with agent loop when aborted mid-flight.
    const aborted = results.some(
      (r) => r.status === 'rejected' && (r.reason?.code === 'ABORTED' || /停止|abort/i.test(String(r.reason?.message || r.reason)))
    );
    assert.ok(aborted || results.some((r) => r.status === 'fulfilled' && r.value?.ok === false));
    assert.ok(started <= 2);
  });

  it('aborts queued implement promptly without waiting for previous to finish', async () => {
    const ac = new AbortController();
    let bStarted = false;
    const rt = createSubagentRuntime({
      runLoop: async (opts) => {
        const tag = String(opts.messages[0].content);
        if (tag.includes('AAA')) {
          await sleep(300);
          return { content: 'a', turns: 1, agentLog: [], fileChanges: [] };
        }
        bStarted = true;
        return { content: 'b', turns: 1, agentLog: [], fileChanges: [] };
      },
    });
    const { ctx } = makeCtx({ signal: ac.signal });
    const p1 = rt.runImplement(ctx, { goal: 'task AAA implement' });
    await sleep(20); // A holds the implement lock
    const p2 = rt.runImplement(ctx, { goal: 'task BBB implement' });
    await sleep(20); // B is queued waiting on A
    const tAbort = Date.now();
    ac.abort();
    let bErr;
    try {
      await p2;
    } catch (e) {
      bErr = e;
    }
    const waitedMs = Date.now() - tAbort;
    assert.ok(bErr, 'queued implement should reject on abort');
    assert.equal(bErr.code, 'ABORTED');
    assert.ok(waitedMs < 150, `queued implement waited ${waitedMs}ms after abort (expected prompt abort)`);
    assert.equal(bStarted, false, 'B must not enter runLoop after abort while waiting');
    // A may still be in flight (mock ignores signal); drain so the chain settles
    await Promise.allSettled([p1]);
  });

  it('explore pool hand-off never exceeds exploreMaxParallel under stress', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const limit = 2;
    const rt = createSubagentRuntime({
      runLoop: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(5 + Math.floor(Math.random() * 15));
        concurrent -= 1;
        return { content: 'x', turns: 1, agentLog: [] };
      },
    });
    const { ctx } = makeCtx();
    ctx.settings.exploreMaxParallel = limit;
    const n = 20;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        rt.runExplore(ctx, { goal: `stress goal ${i} xx` })
      )
    );
    assert.ok(maxConcurrent <= limit, `maxConcurrent ${maxConcurrent} > limit ${limit}`);
    assert.equal(maxConcurrent, limit);
  });

  it('mergeSubagentFileChanges merges implement paths', () => {
    const arr = [];
    mergeSubagentFileChanges(arr, 'spawn_implement', JSON.stringify({
      ok: true,
      kind: 'implement',
      fileChanges: [{ path: 'a.js', op: 'write', stats: { additions: 1, deletions: 0 } }],
    }));
    assert.equal(arr.length, 1);
    assert.equal(arr[0].path, 'a.js');
    assert.equal(arr[0].op, 'write');
    assert.deepEqual(arr[0].stats, { additions: 1, deletions: 0 });

    // path+op dedupe
    mergeSubagentFileChanges(arr, 'spawn_implement', JSON.stringify({
      ok: true,
      fileChanges: [{ path: 'a.js', op: 'write' }],
    }));
    assert.equal(arr.length, 1);

    // different op is not deduped
    mergeSubagentFileChanges(arr, 'spawn_implement', JSON.stringify({
      ok: true,
      kind: 'implement',
      fileChanges: [{ path: 'a.js', op: 'search_replace' }, { path: 'b.js', op: 'write' }],
    }));
    assert.equal(arr.length, 3);
  });

  it('mergeSubagentFileChanges ignores non-implement and bad payloads', () => {
    const arr = [];
    mergeSubagentFileChanges(arr, 'spawn_explore', JSON.stringify({
      ok: true,
      kind: 'explore',
      fileChanges: [{ path: 'x.js', op: 'write' }],
    }));
    assert.equal(arr.length, 0);

    mergeSubagentFileChanges(arr, 'spawn_implement', JSON.stringify({
      ok: false,
      kind: 'implement',
      fileChanges: [{ path: 'x.js', op: 'write' }],
    }));
    assert.equal(arr.length, 0);

    mergeSubagentFileChanges(arr, 'spawn_implement', 'not-json');
    assert.equal(arr.length, 0);

    mergeSubagentFileChanges(arr, 'spawn_implement', JSON.stringify({
      ok: true,
      kind: 'implement',
      fileChanges: [{ op: 'write' }, null, { path: 'ok.js', op: 'write' }],
    }));
    assert.equal(arr.length, 1);
    assert.equal(arr[0].path, 'ok.js');
  });
});
