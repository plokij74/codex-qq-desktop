'use strict';

const { AGENT_EVENTS } = require('./agent-events');

const SUMMARY_MAX = 8 * 1024;
const GOALS_MAX = 6;
const LOG_MAX_ITEMS = 20;
const LOG_SUMMARY_MAX = 200;

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function makeAbortedError() {
  const err = new Error('已停止');
  err.code = 'ABORTED';
  return err;
}

/**
 * Merge spawn_implement tool-result fileChanges into the parent run array.
 * Strategy A: tool-result driven, path+op dedupe. No FILE_CHANGE emission here.
 *
 * @param {Array<{ path?: string, op?: string, stats?: object }>} parentArr
 * @param {string} toolName
 * @param {string} resultStr
 * @returns {Array} parentArr (mutated)
 */
function mergeSubagentFileChanges(parentArr, toolName, resultStr) {
  if (!Array.isArray(parentArr)) return parentArr;
  const name = String(toolName || '');
  if (name !== 'spawn_implement') return parentArr;

  let parsed;
  try {
    parsed = JSON.parse(String(resultStr ?? ''));
  } catch {
    return parentArr;
  }
  if (!parsed || parsed.ok === false) return parentArr;
  // Prefer spawn_implement; also accept explicit kind === 'implement'
  if (parsed.kind != null && parsed.kind !== 'implement') return parentArr;
  if (!Array.isArray(parsed.fileChanges)) return parentArr;

  for (const fc of parsed.fileChanges) {
    if (!fc || typeof fc !== 'object' || !fc.path) continue;
    const path = String(fc.path);
    const op = fc.op != null ? String(fc.op) : 'write';
    if (parentArr.some((x) => x && x.path === path && x.op === op)) continue;
    const entry = { path, op };
    if (fc.stats != null) entry.stats = fc.stats;
    parentArr.push(entry);
  }
  return parentArr;
}

function createSubagentRuntime({ runLoop } = {}) {
  if (typeof runLoop !== 'function') {
    throw new Error('createSubagentRuntime requires runLoop');
  }

  let idSeq = 0;
  function nextId() {
    idSeq += 1;
    return `sa_${idSeq.toString(36)}_${Date.now().toString(36).slice(-4)}`;
  }

  /** @type {Map<object, { active: number, wait: Array<() => void> }>} */
  const explorePools = new Map();
  /** @type {Map<object, Promise<void>>} */
  const implementTails = new Map();

  function poolKey(ctx) {
    return ctx; // per parent ctx object identity for this run
  }

  function getExplorePool(ctx) {
    const key = poolKey(ctx);
    let p = explorePools.get(key);
    if (!p) {
      p = { active: 0, wait: [] };
      explorePools.set(key, p);
    }
    return p;
  }

  function exploreLimit(ctx) {
    return clampInt(ctx?.settings?.exploreMaxParallel, 1, 3, 2);
  }

  async function acquireExplore(ctx) {
    const pool = getExplorePool(ctx);
    const limit = exploreLimit(ctx);
    for (;;) {
      if (ctx.signal?.aborted) throw makeAbortedError();
      if (pool.active < limit) {
        pool.active += 1;
        return;
      }
      await new Promise((resolve, reject) => {
        const entry = { resolve, reject };
        pool.wait.push(entry);
        if (ctx.signal) {
          const onAbort = () => {
            const i = pool.wait.indexOf(entry);
            if (i >= 0) pool.wait.splice(i, 1);
            reject(makeAbortedError());
          };
          entry.onAbort = onAbort;
          entry.signal = ctx.signal;
          ctx.signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      // Hand-off: releaser transferred the slot — already counted in active, do not ++ again
      return;
    }
  }

  function releaseExplore(ctx) {
    const pool = getExplorePool(ctx);
    const next = pool.wait.shift();
    if (next) {
      if (next.signal && next.onAbort) {
        try { next.signal.removeEventListener('abort', next.onAbort); } catch { /* ignore */ }
      }
      next.resolve(); // hand-off: keep active the same
    } else {
      pool.active = Math.max(0, pool.active - 1);
    }
  }

  async function withImplementLock(ctx, fn) {
    const key = poolKey(ctx);
    const prev = implementTails.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((r) => { release = r; });
    const tail = prev.then(() => gate, () => gate);
    implementTails.set(key, tail);

    // Wait for previous implement, but abort promptly if signal fires (same pattern as explore pool).
    await new Promise((resolve, reject) => {
      let settled = false;
      /** @type {(() => void)|null} */
      let onAbort = null;
      const finish = (fnFinish) => {
        if (settled) return;
        settled = true;
        if (ctx.signal && onAbort) {
          try { ctx.signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
        }
        fnFinish();
      };
      onAbort = () => {
        finish(() => {
          release();
          reject(makeAbortedError());
        });
      };
      if (ctx.signal) {
        if (ctx.signal.aborted) {
          finish(() => {
            release();
            reject(makeAbortedError());
          });
          return;
        }
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }
      prev.then(
        () => finish(() => resolve()),
        () => finish(() => resolve())
      );
    });

    if (ctx.signal?.aborted) {
      release();
      throw makeAbortedError();
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  function normalizeGoal(goal) {
    return String(goal || '').trim();
  }

  function clampMaxTurns(kind, raw) {
    if (kind === 'implement') {
      const n = Number(raw);
      if (!Number.isFinite(n)) return 6;
      return clampInt(n, 1, 12, 6);
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return 4;
    return clampInt(n, 1, 8, 4);
  }

  function slimLog(agentLog) {
    if (!Array.isArray(agentLog)) return [];
    return agentLog.slice(0, LOG_MAX_ITEMS).map((x) => ({
      tool: x.tool,
      ok: x.ok,
      summary: String(x.summary || '').slice(0, LOG_SUMMARY_MAX),
    }));
  }

  function childSettings(parentSettings, maxTurns) {
    return {
      ...parentSettings,
      maxAgentTurns: maxTurns,
      skillsEnabled: false,
      mcpEnabled: false,
      subagentEnabled: false,
      verifyBeforeDone: false,
      hooksEnabled: false,
    };
  }

  function childExtensions(parentExt) {
    const childExt = { ...(parentExt || {}) };
    delete childExt.mcpHub;
    delete childExt.subagentRuntime;
    return childExt;
  }

  async function runChild(ctx, { kind, goal, maxTurns, batchId }) {
    if (Number(ctx.subagentDepth) >= 1) {
      return { ok: false, kind, error: '子 Agent 内禁止再次 spawn' };
    }
    const g = normalizeGoal(goal);
    if (g.length < 4) {
      return { ok: false, kind, error: 'goal 过短（至少 4 个字符）' };
    }
    const turns = clampMaxTurns(kind, maxTurns);
    const subagentId = nextId();
    const t0 = Date.now();

    if (ctx.signal?.aborted) throw makeAbortedError();

    ctx.onEvent?.({
      type: AGENT_EVENTS.SUBAGENT_START,
      subagentId,
      kind,
      goal: g,
      maxTurns: turns,
      ...(batchId ? { batchId } : {}),
    });

    try {
      const result = await runLoop({
        project: ctx.project,
        settings: childSettings(ctx.settings, turns),
        messages: [{ role: 'user', content: g }],
        gate: ctx.gate,
        onEvent: (ev) => {
          if (ev && typeof ev === 'object') {
            ctx.onEvent?.({ ...ev, subagent: true, subagentId, kind });
          }
        },
        signal: ctx.signal,
        sessionKey: ctx.sessionKey,
        agentMode: 'agent',
        subagentDepth: 1,
        subagentKind: kind,
        registry: ctx.registry,
        extensions: childExtensions(ctx.extensions),
      });

      const summary = String(result.content || '').slice(0, SUMMARY_MAX);
      const fileChanges = Array.isArray(result.fileChanges)
        ? result.fileChanges.map((fc) => ({
          path: fc.path,
          op: fc.op,
          stats: fc.stats,
        }))
        : [];
      const out = {
        ok: true,
        kind,
        subagentId,
        summary,
        turns: result.turns,
        agentLog: slimLog(result.agentLog),
      };
      if (kind === 'implement') out.fileChanges = fileChanges;

      ctx.onEvent?.({
        type: AGENT_EVENTS.SUBAGENT_END,
        subagentId,
        kind,
        ok: true,
        summary,
        durationMs: Date.now() - t0,
        fileChangeCount: fileChanges.length,
        ...(batchId ? { batchId } : {}),
        ...(kind === 'implement' && fileChanges.length ? { fileChanges } : {}),
      });
      return out;
    } catch (err) {
      const msg = err?.message || String(err);
      ctx.onEvent?.({
        type: AGENT_EVENTS.SUBAGENT_END,
        subagentId,
        kind,
        ok: false,
        error: msg,
        durationMs: Date.now() - t0,
        ...(batchId ? { batchId } : {}),
      });
      if (err?.code === 'ABORTED') throw err;
      return { ok: false, kind, subagentId, error: msg };
    }
  }

  function precheckChild(ctx, { kind, goal }) {
    if (Number(ctx.subagentDepth) >= 1) {
      return { ok: false, kind, error: '子 Agent 内禁止再次 spawn' };
    }
    const g = normalizeGoal(goal);
    if (g.length < 4) {
      return { ok: false, kind, error: 'goal 过短（至少 4 个字符）' };
    }
    return null;
  }

  async function runExplore(ctx, { goal, maxTurns, batchId } = {}) {
    const early = precheckChild(ctx, { kind: 'explore', goal });
    if (early) return early;
    await acquireExplore(ctx);
    try {
      return await runChild(ctx, { kind: 'explore', goal, maxTurns, batchId });
    } finally {
      releaseExplore(ctx);
    }
  }

  async function runImplement(ctx, { goal, maxTurns } = {}) {
    const early = precheckChild(ctx, { kind: 'implement', goal });
    if (early) return early;
    return withImplementLock(ctx, () => runChild(ctx, { kind: 'implement', goal, maxTurns }));
  }

  async function runExplores(ctx, { goals, maxTurns } = {}) {
    if (!Array.isArray(goals)) {
      return { ok: false, error: 'goals 必须为数组', results: [] };
    }
    const normalized = goals.map((g) => normalizeGoal(g)).filter((g) => g.length > 0);
    if (normalized.length === 0) {
      return { ok: false, error: 'goals 为空或全非法', results: [] };
    }
    let truncated = false;
    let list = normalized;
    if (list.length > GOALS_MAX) {
      list = list.slice(0, GOALS_MAX);
      truncated = true;
    }
    const batchId = `batch_${nextId()}`;
    const results = await Promise.all(
      list.map((goal) => runExplore(ctx, { goal, maxTurns, batchId }))
    );
    return {
      ok: results.every((r) => r && r.ok),
      parallel: true,
      results,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  return { runExplore, runExplores, runImplement };
}

module.exports = { createSubagentRuntime, mergeSubagentFileChanges };
