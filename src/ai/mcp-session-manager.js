'use strict';

const crypto = require('crypto');
const { createMcpClient } = require('./mcp-client');

const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 8;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (/token|secret|authorization|password|api[_-]?key|cookie/i.test(key)) continue;
    const v = value[key];
    if (typeof v === 'function' || v === undefined) continue;
    out[key] = stableValue(v);
  }
  return out;
}

function configFingerprint(config = {}) {
  const transport = String(config.transport || (config.command ? 'stdio' : 'http')).toLowerCase();
  const identity = {
    transport,
    name: String(config.name || ''),
    command: config.command || '',
    args: Array.isArray(config.args) ? config.args : [],
    cwd: config.cwd || '',
    url: config.url || '',
    sseUrl: config.sseUrl || '',
    headers: config.headers || {},
    allowPrivate: config.allowPrivate === true,
    auth: config.auth || 'none',
    oauth: config.oauth || {},
    sessionRecovery: config.sessionRecovery === true,
    sampling: { enabled: config.sampling?.enabled === true },
    tasks: {
      enabled: config.tasks?.enabled === true,
      defaultTtlMs: Number(config.tasks?.defaultTtlMs) || 60 * 60 * 1000,
    },
    elicitation: {
      enabled: config.elicitation?.enabled !== false,
      allowPrivateUrl: config.elicitation?.allowPrivateUrl === true,
    },
    roots: Array.isArray(config.roots)
      ? config.roots.map((root) => ({ rootId: root.rootId, label: root.label, path: root.path })).sort((a, b) => String(a.rootId).localeCompare(String(b.rootId)))
      : [],
  };
  const serialized = JSON.stringify(stableValue(identity));
  return crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 32);
}

function sessionSummary(entry) {
  return {
    server: entry.serverName,
    state: entry.state,
    reusable: entry.reusable,
    lastErrorCode: entry.lastErrorCode || null,
    leases: entry.leases,
  };
}

function createMcpSessionManager(options = {}) {
  const createClient = typeof options.createClient === 'function' ? options.createClient : (cfg) => createMcpClient(cfg);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const idleMs = Number.isFinite(Number(options.idleMs)) && Number(options.idleMs) > 0 ? Number(options.idleMs) : DEFAULT_IDLE_MS;
  const maxSessions = Number.isFinite(Number(options.maxSessions)) && Number(options.maxSessions) > 0 ? Math.min(64, Math.floor(Number(options.maxSessions))) : DEFAULT_MAX_SESSIONS;
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
  const sessions = new Map();
  const acquireFlights = new Map();
  let sweepTimer = null;

  function emit(entry, extra = {}) {
    onStatus?.({ ...sessionSummary(entry), ...extra });
  }

  function scheduleSweep() {
    if (sweepTimer || typeof setTimeout !== 'function') return;
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      sweep().catch(() => {});
      if (sessions.size) scheduleSweep();
    }, Math.max(1000, Math.min(idleMs, 60_000)));
    sweepTimer.unref?.();
  }

  async function closeEntry(entry, reason = 'closed') {
    if (!entry || entry.closing) return;
    entry.closing = true;
    entry.state = 'disabled';
    entry.context = null;
    entry.rejectReady?.(Object.assign(new Error(`MCP session ${reason}`), { code: 'MCP_SESSION_CLOSED' }));
    try { await entry.client?.close?.(); } catch { /* best effort */ }
    sessions.delete(entry.key);
    emit(entry, { reason });
  }

  async function sweep(at = now()) {
    const current = Number(at) || now();
    const closing = [];
    for (const entry of sessions.values()) {
      if (entry.leases > 0 || !entry.reusable) continue;
      if (current - entry.lastUsedAt >= idleMs) closing.push(closeEntry(entry, 'idle-expired'));
    }
    await Promise.all(closing);
    return closing.length;
  }

  async function evictForCapacity() {
    if (sessions.size < maxSessions) return true;
    await sweep(now());
    if (sessions.size < maxSessions) return true;
    const candidates = [...sessions.values()]
      .filter((entry) => entry.leases === 0)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    if (!candidates.length) return false;
    await closeEntry(candidates[0], 'capacity');
    return sessions.size < maxSessions;
  }

  async function acquire(config = {}, context = {}) {
    const cfg = { ...config };
    const serverName = String(cfg.name || '').trim();
    const reusable = cfg.sessionRecovery === true;
    const projectIdentity = String(context.projectPath || context.cwd || '');
    const baseKey = `${configFingerprint(cfg)}:${crypto.createHash('sha256').update(projectIdentity).digest('hex').slice(0, 16)}`;
    // Recovery sessions are intentionally shareable by config + project. A
    // non-recovery acquire must retain D8's per-run isolation, even when two
    // runs happen to overlap and use the same server.
    let key = reusable
      ? baseKey
      : `${baseKey}:run_${crypto.randomBytes(8).toString('hex')}`;
    let startFlight = null;
    if (reusable && key === baseKey) {
      const existingFlight = acquireFlights.get(baseKey);
      if (existingFlight) {
        // A second run must not attach to a client whose inbound requests are
        // already routed to another run's roots/sampling callbacks. Keep a
        // separate retained session instead of waiting and sharing context.
        key = `${baseKey}:run_${crypto.randomBytes(8).toString('hex')}`;
      }
    }
    let entry = sessions.get(key);
    if (entry && !entry.closing) {
      if (entry.leases > 0) {
        key = `${baseKey}:run_${crypto.randomBytes(8).toString('hex')}`;
        entry = null;
      }
    }
    if (entry && !entry.closing) {
      await entry.ready;
      if (entry.closing || !entry.client) {
        const error = new Error('MCP session closed during acquire');
        error.code = 'MCP_SESSION_CLOSED';
        throw error;
      }
      // A retained client must use the current run's roots, notification and
      // sampling callbacks. Never keep the previous run's gate or project in
      // a recovery session.
      entry.context = context;
      entry.leases += 1;
      entry.lastUsedAt = now();
      if (entry.state === 'error' && typeof entry.client?.reconnect === 'function' && !entry.recoveredThisRun) {
        entry.recoveredThisRun = true;
        entry.state = 'reconnecting';
        emit(entry);
        try {
          await entry.client.reconnect(entry.lastErrorCode || 'run-acquire');
          entry.state = 'connected';
          entry.lastErrorCode = null;
        } catch (error) {
          entry.state = 'error';
          entry.lastErrorCode = String(error?.code || 'MCP_RECONNECT_FAILED').slice(0, 64);
          emit(entry);
          entry.leases -= 1;
          throw error;
        }
      } else if (entry.state === 'idle') {
        entry.state = 'connected';
      }
      emit(entry);
      return makeLease(entry);
    }

    if (reusable && key === baseKey) {
      let resolveFlight;
      let rejectFlight;
      startFlight = new Promise((resolve, reject) => {
        resolveFlight = resolve;
        rejectFlight = reject;
      });
      startFlight.catch(() => {});
      acquireFlights.set(baseKey, startFlight);
      startFlight.resolve = resolveFlight;
      startFlight.reject = rejectFlight;
    }

    if (!(await evictForCapacity())) {
      const error = new Error('MCP session limit reached');
      error.code = 'MCP_SESSION_LIMIT';
      if (startFlight && acquireFlights.get(baseKey) === startFlight) {
        startFlight.reject(error);
        acquireFlights.delete(baseKey);
      }
      throw error;
    }

    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // A start failure can happen before another acquire awaits `ready`.
    // Attach a handler so the original acquire can report the real error
    // without creating an unhandled rejection.
    ready.catch(() => {});

    entry = {
      key,
      serverName,
      client: null,
      cfg,
      reusable,
      projectIdentity,
      context,
      leases: 1,
      createdAt: now(),
      lastUsedAt: now(),
      state: 'connecting',
      lastErrorCode: null,
      recoveredThisRun: false,
      closing: false,
      ready,
      resolveReady,
      rejectReady,
    };

    const activeContext = () => entry && entry.leases > 0 && !entry.closing
      ? entry.context
      : null;
    const unavailableRequest = () => {
      const error = new Error('MCP request unavailable outside an active run');
      error.code = 'MCP_METHOD_NOT_FOUND';
      return error;
    };
    const opts = {
      ...cfg,
      rootsProvider: (...args) => {
        const current = activeContext();
        if (typeof current?.rootsProvider !== 'function' && typeof current?.getRoots !== 'function') throw unavailableRequest();
        return (current.rootsProvider || current.getRoots)(...args);
      },
      getRoots: (...args) => {
        const current = activeContext();
        if (typeof current?.getRoots !== 'function' && typeof current?.rootsProvider !== 'function') throw unavailableRequest();
        return (current.getRoots || current.rootsProvider)(...args);
      },
      samplingHandler: (...args) => {
        const current = activeContext();
        if (typeof current?.samplingHandler !== 'function') throw unavailableRequest();
        return current.samplingHandler(...args);
      },
      elicitationHandler: (...args) => {
        const current = activeContext();
        if (typeof current?.elicitationHandler !== 'function') throw unavailableRequest();
        return current.elicitationHandler(...args);
      },
      taskHandler: (method, params, signal) => {
        const current = activeContext();
        if (typeof current?.taskHandler !== 'function') throw unavailableRequest();
        return current.taskHandler(method, params, signal);
      },
      notificationHandler: (method, params, message) => {
        const current = activeContext();
        if (method === 'notifications/roots/list_changed') current?.onRootsChanged?.(serverName);
        current?.notificationHandler?.(method, params, message);
      },
      elicitationComplete: (params, message) => {
        activeContext()?.elicitationComplete?.(params, message);
      },
      onTransportError: (error) => {
        const current = sessions.get(key);
        if (!current) return;
        current.state = 'error';
        current.lastErrorCode = String(error?.code || 'MCP_TRANSPORT').slice(0, 64);
        emit(current);
        activeContext()?.onTransportError?.(error);
      },
    };
    try {
      entry.client = createClient(opts);
      sessions.set(key, entry);
      emit(entry);
      await entry.client.start();
      if (entry.closing) {
        const error = new Error('MCP session closed during start');
        error.code = 'MCP_SESSION_CLOSED';
        throw error;
      }
      entry.state = 'connected';
      entry.resolveReady(entry.client);
      if (startFlight && acquireFlights.get(baseKey) === startFlight) {
        startFlight.resolve(entry.client);
        acquireFlights.delete(baseKey);
      }
      emit(entry);
      if (reusable) scheduleSweep();
      return makeLease(entry);
    } catch (error) {
      entry.rejectReady(error);
      if (startFlight && acquireFlights.get(baseKey) === startFlight) {
        startFlight.reject(error);
        acquireFlights.delete(baseKey);
      }
      entry.state = 'error';
      entry.lastErrorCode = String(error?.code || 'MCP_START_FAILED').slice(0, 64);
      emit(entry);
      await closeEntry(entry, 'start-failed');
      throw error;
    }
  }

  function makeLease(entry) {
    let released = false;
    return {
      key: entry.key,
      server: entry.serverName,
      client: entry.client,
      status: () => sessionSummary(entry),
      release: async () => {
        if (released) return;
        released = true;
        entry.leases = Math.max(0, entry.leases - 1);
        entry.lastUsedAt = now();
        if (entry.leases === 0) {
          entry.recoveredThisRun = false;
          entry.context = null;
        }
        if (!entry.reusable && entry.leases === 0) await closeEntry(entry, 'run-release');
        else {
          if (entry.leases === 0 && entry.state === 'connected') entry.state = 'idle';
          emit(entry);
          scheduleSweep();
        }
      },
      invalidate: async (reason) => closeEntry(entry, reason || 'invalidated'),
    };
  }

  async function invalidate(selector, reason = 'invalidated') {
    const matches = [...sessions.values()].filter((entry) => {
      if (!selector) return true;
      if (typeof selector === 'function') return selector(entry);
      if (typeof selector === 'string') return entry.serverName === selector || entry.key === selector;
      return selector.name ? entry.serverName === selector.name : true;
    });
    await Promise.all(matches.map((entry) => closeEntry(entry, reason)));
    return matches.length;
  }

  async function invalidateOtherProjects(projectPath, reason = 'project-changed') {
    const current = String(projectPath || '');
    const matches = [...sessions.values()].filter((entry) => entry.projectIdentity !== current
      && entry.context?.taskRecovery !== true);
    await Promise.all(matches.map((entry) => closeEntry(entry, reason)));
    return matches.length;
  }

  function status(name) {
    const entries = [...sessions.values()].filter((entry) => !name || entry.serverName === name);
    return entries.map(sessionSummary);
  }

  async function closeAll() {
    if (sweepTimer) clearTimeout(sweepTimer);
    sweepTimer = null;
    await Promise.all([...sessions.values()].map((entry) => closeEntry(entry, 'app-quit')));
  }

  async function notifyRootsChanged(serverName) {
    const targets = [...sessions.values()].filter((entry) => !serverName || entry.serverName === serverName);
    await Promise.all(targets.map(async (entry) => {
      try { await entry.client?.notifyRootsChanged?.(); } catch (error) {
        entry.state = 'error';
        entry.lastErrorCode = String(error?.code || 'MCP_ROOTS_NOTIFY_FAILED').slice(0, 64);
        emit(entry);
      }
    }));
  }

  return {
    acquire,
    release: async (lease) => lease?.release?.(),
    invalidate,
    reset: invalidate,
    invalidateOtherProjects,
    status,
    sweep,
    closeAll,
    notifyRootsChanged,
    size: () => sessions.size,
    getSessionKey: configFingerprint,
  };
}

module.exports = {
  DEFAULT_IDLE_MS,
  DEFAULT_MAX_SESSIONS,
  configFingerprint,
  createMcpSessionManager,
};
