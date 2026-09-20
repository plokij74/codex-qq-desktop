'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createCiWatchManager } = require('../src/ai/ci-watch-manager');
const { normalizeRuns, outcome, fingerprint, publicWatch } = require('../src/ai/ci-watch-state');

const HEAD = 'a'.repeat(40);
const REPO = 'b'.repeat(64);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeClock() {
  let time = 1_800_000_000_000;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    timers,
    jump: (ms) => { time += ms; },
    async advance(ms = 0) {
      const end = time + ms;
      for (;;) {
        await flush();
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = Math.max(time, next[1].at); timers.delete(next[0]); next[1].fn();
      }
      time = end; await flush();
    },
  };
}

function run(id = '1', status = 'completed', conclusion = 'success', attempt = 1) {
  return { id, name: 'CI', headSha: HEAD, runAttempt: attempt, status, conclusion };
}

function fixture(overrides = {}) {
  const clock = fakeClock();
  const events = [];
  const calls = [];
  const data = { runs: [run()], head: HEAD, repoKey: REPO, state: 'OPEN', errors: [] };
  const github = {
    getCiWatchRepository: async ({ projectPath }) => ({ ok: true, repository: { repoRoot: projectPath, host: 'github.com', owner: 'acme', repo: 'widget', nameWithOwner: 'acme/widget', repoKey: REPO } }),
    getCiWatchOrigin: async () => ({ ok: true, repoKey: data.repoKey }),
    getCiPrStatus: async ({ number }) => ({ ok: true, pr: { number, state: data.state, isCrossRepository: false, headRepository: 'acme/widget', headSha: data.head, headRefName: 'feature' } }),
    getCiRunsForHead: async () => { calls.push(clock.now()); return data.errors.shift() || { ok: true, runs: data.runs }; },
    ...overrides,
  };
  const manager = createCiWatchManager({ githubCli: github, ...clock, canonicalPath: (p) => typeof p === 'string' && p ? p : '', projectKey: (p) => `key:${p}`, onEvent: (e) => events.push(e) });
  const start = (root = '/project', number = 7, minutes = 30) => manager.start(root, number, minutes);
  const read = (ref, root = '/project') => manager.get(root, ref).watch;
  const rerun = (phase = 'requested', extra = {}) => manager.noteRerun({ projectPath: '/project', repoKey: REPO, prNumber: 7, headSha: HEAD, runId: '1', runAttempt: 1, remoteCiRef: 'rci_' + 'c'.repeat(24), phase, ...extra });
  return { clock, events, calls, data, github, manager, start, read, rerun };
}

describe('D15 CI watch state', () => {
  it('requires complete, same-head metadata and keeps IDs literal', () => {
    assert.equal(normalizeRuns([run('90071992547409931')], HEAD)[0].id, '90071992547409931');
    assert.equal(normalizeRuns([{ ...run(), headSha: 'b'.repeat(40) }], HEAD), null);
    assert.equal(normalizeRuns([run(), run()], HEAD), null);
    assert.equal(normalizeRuns([run('1', 'new_server_state')], HEAD), null);
    assert.equal(normalizeRuns([{ ...run(), runAttempt: 0 }], HEAD), null);
    const rows = normalizeRuns([run('2'), run('1')], HEAD);
    assert.equal(fingerprint(rows), fingerprint(normalizeRuns([run('1'), run('2')], HEAD)));
  });
  it('never interprets empty, all-skipped or unknown conclusions as passed', () => {
    assert.equal(outcome([]), null);
    assert.equal(outcome([run('1', 'queued', '')]), null);
    assert.equal(outcome([run('1', 'completed', 'skipped')]), 'attention');
    assert.equal(outcome([run(), run('2', 'completed', 'neutral')]), 'passed');
    assert.equal(outcome([run(), run('2', 'completed', 'cancelled')]), 'attention');
    assert.equal(outcome([run('1', 'completed', 'startup_failure')]), 'failed');
    assert.equal(outcome(normalizeRuns([run('1', 'completed', 'surprise')], HEAD)), 'attention');
  });
});

describe('D15 CI watch manager', () => {
  it('waits for discovery to stabilize and confirms the head before notifying once', async (t) => {
    const f = fixture(); t.after(() => f.manager.close());
    const { watchRef } = f.start();
    await f.clock.advance();
    assert.equal(f.read(watchRef).status, 'watching');
    await f.clock.advance(15_000);
    f.data.runs.push(run('2', 'in_progress', ''));
    await f.clock.advance(15_000);
    assert.equal(f.read(watchRef).counts.pending, 1);
    f.data.runs[1] = run('2');
    await f.clock.advance(15_000);
    await f.clock.advance(29_999);
    assert.equal(f.read(watchRef).status, 'watching');
    await f.clock.advance(1);
    assert.equal(f.read(watchRef).status, 'completed');
    assert.equal(f.read(watchRef).outcome, 'passed');
    assert.equal(f.events.filter((e) => e.notify).length, 1);
    const calls = f.calls.length;
    await f.clock.advance(60_000);
    assert.equal(f.calls.length, calls);
    f.manager.ack('/project', watchRef);
    assert.equal(f.read(watchRef).unread, false);
    assert.equal(f.events.filter((e) => e.notify).length, 1);
  });
  it('keeps empty lists waiting until the deadline and never cancels remote CI', async (t) => {
    const f = fixture(); t.after(() => f.manager.close()); f.data.runs = [];
    const { watchRef } = f.start('/project', 7, 15);
    await f.clock.advance(15 * 60_000);
    assert.equal(f.read(watchRef).status, 'expired');
    assert.equal(f.read(watchRef).outcome, null);
    assert.equal(f.read(watchRef).reasonCode, 'CI_WATCH_NO_RUNS');
    assert.equal(f.clock.timers.size, 0);
  });
  it('blocks old failures until a requested or uncertain rerun exposes a new attempt', async (t) => {
    const f = fixture(); t.after(() => f.manager.close());
    f.data.runs = [run('1', 'completed', 'failure')];
    f.rerun('sending'); f.rerun('uncertain');
    const { watchRef } = f.start();
    await f.clock.advance(90_000);
    assert.equal(f.read(watchRef).status, 'watching');
    assert.equal(f.read(watchRef).waitingForAttempt, true);
    f.data.runs = [run('1', 'queued', '', 2)];
    await f.clock.advance(15_000);
    assert.equal(f.read(watchRef).waitingForAttempt, false);
    f.data.runs = [run('1', 'completed', 'success', 2)];
    await f.clock.advance(45_000);
    assert.equal(f.read(watchRef).outcome, 'passed');
  });
  it('releases a definite rerun failure and resets the stable window for an in-flight request', async (t) => {
    const f = fixture(); t.after(() => f.manager.close());
    const { watchRef } = f.start(); await f.clock.advance(15_000);
    f.rerun('sending');
    await f.clock.advance(60_000);
    assert.equal(f.read(watchRef).status, 'watching');
    f.rerun('failed');
    await f.clock.advance(45_000);
    assert.equal(f.read(watchRef).outcome, 'passed');
  });
  it('does not finish if a rerun starts during the final head confirmation', async (t) => {
    const f = fixture(); t.after(() => f.manager.close());
    const original = f.github.getCiPrStatus;
    let reads = 0;
    f.github.getCiPrStatus = async (args) => { if (++reads === 4) f.rerun('sending'); return original(args); };
    const { watchRef } = f.start(); await f.clock.advance(30_000);
    assert.equal(f.read(watchRef).status, 'watching');
    assert.equal(f.events.some((e) => e.notify), false);
  });
  it('ends on new commits, origin changes and a closed PR without following new targets', async (t) => {
    for (const change of ['head', 'repoKey', 'state']) {
      const f = fixture(); t.after(() => f.manager.close());
      const { watchRef } = f.start(); await f.clock.advance();
      f.data[change] = change === 'state' ? 'MERGED' : 'd'.repeat(change === 'head' ? 40 : 64);
      await f.clock.advance(15_000);
      assert.equal(f.read(watchRef).status, ({ head: 'head_changed', repoKey: 'error', state: 'pr_closed' })[change]);
      assert.equal(f.read(watchRef).headSha, HEAD);
      assert.equal(f.calls.length, 1);
    }
  });
  it('rejects fork PRs and incomplete lists, including disappearing or regressed runs', async (t) => {
    const cases = [
      { getCiPrStatus: async () => ({ ok: true, pr: { number: 7, state: 'OPEN', isCrossRepository: true } }) },
      { getCiRunsForHead: async () => ({ ok: true, runs: [run()], truncated: true }) },
      { getCiRunsForHead: async () => ({ ok: true, runs: [{ ...run(), headSha: 'e'.repeat(40) }] }) },
    ];
    for (const opts of cases) {
      const f = fixture(opts); t.after(() => f.manager.close());
      const { watchRef } = f.start(); await f.clock.advance();
      assert.equal(f.read(watchRef).status, 'error');
      assert.equal(f.read(watchRef).outcome, null);
    }
    for (const next of [[], [run()]]) {
      const f = fixture(); t.after(() => f.manager.close()); f.data.runs = [run('1', 'queued', '', 2)];
      const { watchRef } = f.start(); await f.clock.advance(); f.data.runs = next;
      await f.clock.advance(15_000);
      assert.equal(f.read(watchRef).reasonCode, 'CI_WATCH_INCOMPLETE');
    }
  });
  it('backs off transient errors and ends on the third failure', async (t) => {
    const f = fixture(); t.after(() => f.manager.close());
    f.data.errors = Array.from({ length: 3 }, () => ({ ok: false, code: 'CI_WATCH_NETWORK', transient: true }));
    const { watchRef } = f.start(); await f.clock.advance();
    await f.clock.advance(29_999); assert.equal(f.calls.length, 1);
    await f.clock.advance(1); assert.equal(f.calls.length, 2);
    await f.clock.advance(60_000);
    assert.equal(f.read(watchRef).status, 'error'); assert.equal(f.calls.length, 3);
  });
  it('shares rate-limit cooldowns by host and does not extend the deadline', async (t) => {
    const f = fixture(); t.after(() => f.manager.close());
    f.data.errors = [{ ok: false, code: 'CI_WATCH_RATE_LIMITED', rateLimited: true, retryAfterMs: 120_000 }];
    const first = f.start(); await f.clock.advance();
    f.start('/second'); await f.clock.advance(119_999);
    assert.equal(f.calls.length, 1);
    await f.clock.advance(1); assert.equal(f.calls.length, 3);
    assert.equal(f.read(first.watchRef).deadlineAt - f.read(first.watchRef).createdAt, 30 * 60_000);
  });
  it('enforces project ownership, deduplication, limits and metadata-only output', (t) => {
    const f = fixture(); t.after(() => f.manager.close());
    assert.equal(f.start('/project', 7, 0).ok, false);
    const { watchRef } = f.start();
    assert.equal(f.start().watchRef, watchRef);
    assert.equal(f.start('/project', 8).code, 'CI_WATCH_ALREADY_RUNNING');
    f.start('/two'); f.start('/three');
    assert.equal(f.start('/four').code, 'CI_WATCH_LIMIT');
    for (const action of ['get', 'stop', 'ack']) assert.equal(f.manager[action]('/two', watchRef).code, 'CI_WATCH_NOT_FOUND');
    const r = f.manager.records.get(watchRef);
    r.token = 'secret'; r.log = 'secret'; r.command = 'secret';
    assert.doesNotMatch(JSON.stringify(publicWatch(r, { detail: true })), /secret|projectPath|repoRoot|command|token/);
  });
  it('shares a cooldown even when repository discovery has not finished', async (t) => {
    const f = fixture(); t.after(() => f.manager.close());
    const resolveRepo = f.github.getCiWatchRepository;
    let remoteQueries = 0;
    f.github.getCiWatchRepository = async (args) => {
      const wait = args.getHostCooldownMs('github.com');
      if (wait > 0) return { ok: false, code: 'CI_WATCH_RATE_LIMITED', rateLimited: true, retryAfterMs: wait, host: 'github.com' };
      if (++remoteQueries === 1) return { ok: false, code: 'CI_WATCH_RATE_LIMITED', rateLimited: true, retryAfterMs: 120_000, host: 'github.com' };
      return resolveRepo(args);
    };
    f.start(); await f.clock.advance();
    f.start('/second'); await f.clock.advance(119_999);
    assert.equal(remoteQueries, 1);
    await f.clock.advance(1);
    assert.equal(remoteQueries, 3);
    assert.equal(f.calls.length, 2);
  });
  it('resumes immediately after aborting a hanging poll without treating cancellation as failure', async (t) => {
    const f = fixture(); t.after(() => f.manager.close());
    const readRuns = f.github.getCiRunsForHead;
    let lateResolve; let signal;
    f.github.getCiRunsForHead = (args) => { signal = args.signal; return new Promise((resolve) => { lateResolve = resolve; }); };
    const { watchRef } = f.start(); await f.clock.advance();
    f.github.getCiRunsForHead = readRuns;
    f.manager.suspend(); f.manager.resume();
    assert.equal(signal.aborted, true);
    await f.clock.advance();
    assert.equal(f.read(watchRef).status, 'watching');
    assert.equal(f.read(watchRef).reasonCode, '');
    lateResolve({ ok: true, runs: [run('99', 'completed', 'failure')] });
    await f.clock.advance(30_000);
    assert.equal(f.read(watchRef).outcome, 'passed');
    assert.equal(f.events.filter((event) => event.notify).length, 1);
  });
  it('aborts a request on stop and ignores its late response', async (t) => {
    let resolve; let signal;
    const f = fixture({ getCiRunsForHead: (args) => { signal = args.signal; return new Promise((r) => { resolve = r; }); } });
    t.after(() => f.manager.close());
    const { watchRef } = f.start(); await f.clock.advance();
    f.manager.stop('/project', watchRef);
    assert.equal(signal.aborted, true);
    resolve({ ok: true, runs: [run()] }); await flush();
    assert.equal(f.read(watchRef).status, 'stopped');
    assert.equal(f.read(watchRef).unread, false);
    assert.equal(f.clock.timers.size, 0);
  });
  it('bounds a hanging query and stops after three timeouts', async (t) => {
    let signals = [];
    const f = fixture({ getCiRunsForHead: ({ signal }) => { signals.push(signal); return new Promise(() => {}); } });
    t.after(() => f.manager.close());
    const { watchRef } = f.start(); await f.clock.advance(135_000);
    assert.equal(f.read(watchRef).status, 'error');
    assert.equal(f.read(watchRef).reasonCode, 'CI_WATCH_QUERY_TIMEOUT');
    assert.equal(signals.length, 3); assert.ok(signals.every((s) => s.aborted));
  });
  it('expires after sleep without catch-up queries and clears timers on shutdown', async () => {
    const f = fixture(); const { watchRef } = f.start(); await f.clock.advance();
    f.manager.suspend(); f.clock.jump(60 * 60_000); f.manager.resume();
    assert.equal(f.read(watchRef).status, 'expired'); assert.equal(f.calls.length, 1);
    f.start('/two'); f.manager.close();
    assert.equal(f.clock.timers.size, 0); assert.equal(f.manager.records.size, 0);
  });
  it('retains at most 50 terminal records and never evicts an active watch', () => {
    const f = fixture(); const active = f.start('/active');
    for (let i = 0; i < 60; i++) { const started = f.start(); f.manager.stop('/project', started.watchRef); f.clock.jump(1); }
    assert.equal(f.manager.records.size, 51); assert.equal(f.manager.get('/active', active.watchRef).ok, true);
    f.manager.dropProject('/active'); assert.equal(f.manager.get('/active', active.watchRef).watch.status, 'stopped');
    f.manager.close();
  });
});
