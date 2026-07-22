'use strict';

const { spawn: defaultSpawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { matchTool } = require('./hooks-loader');
const { AGENT_EVENTS } = require('./agent-events');

const STRING_MAX = 8192;
const PAYLOAD_MAX = 256 * 1024;
const STREAM_MAX = 1024 * 1024;
const STDERR_MAX = 8192;
const STOP_ABORT_TIMEOUT_CAP = 5000;
const SECRET_KEY_RE = /api[_-]?key|secret|token|password|authorization|bearer/i;

const SAFE_ENV_KEYS = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TEMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'USERNAME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'ComSpec',
  'COMSPEC',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'windir',
  'WINDIR',
  'NODE_OPTIONS',
  'TERM',
  'COLORTERM',
]);

function makeAbortedError(message) {
  const err = new Error(message || '已停止');
  err.code = 'ABORTED';
  return err;
}

function truncateString(s, max = STRING_MAX) {
  const str = String(s);
  if (str.length <= max) return str;
  return str.slice(0, max) + '\n…[truncated]';
}

function truncateDeep(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return truncateString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > 8) return '[…]';
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => truncateDeep(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    const keys = Object.keys(value).slice(0, 100);
    for (const k of keys) {
      out[k] = truncateDeep(value[k], depth + 1);
    }
    return out;
  }
  return String(value);
}

function ensurePayloadSize(payload) {
  let json = JSON.stringify(payload);
  if (json.length <= PAYLOAD_MAX) return payload;
  // Aggressively shrink tool.args string fields
  if (payload.tool && payload.tool.args && typeof payload.tool.args === 'object') {
    const args = { ...payload.tool.args };
    for (const k of Object.keys(args)) {
      if (typeof args[k] === 'string' && args[k].length > 256) {
        args[k] = truncateString(args[k], 256);
      } else if (typeof args[k] === 'object' && args[k] != null) {
        args[k] = '[truncated-object]';
      }
    }
    payload = {
      ...payload,
      tool: { ...payload.tool, args },
      result: payload.result != null ? '[truncated]' : null,
    };
    json = JSON.stringify(payload);
  }
  if (json.length > PAYLOAD_MAX) {
    return {
      event: payload.event,
      timestamp: payload.timestamp,
      sessionKey: payload.sessionKey,
      agentMode: payload.agentMode,
      subagentDepth: payload.subagentDepth,
      projectPath: payload.projectPath,
      permissionMode: payload.permissionMode,
      tool: payload.tool
        ? { name: payload.tool.name, risk: payload.tool.risk, args: {} }
        : null,
      result: null,
      run: payload.run,
      promptPreview: null,
      flags: payload.flags || null,
      _truncated: true,
    };
  }
  return payload;
}

function isSecretKey(key) {
  return SECRET_KEY_RE.test(String(key || ''));
}

function buildEnv(rule, { event, projectPath, settings }) {
  const env = {};
  // Copy process.env with secret-like keys stripped on all platforms.
  // Windows: keep PATH/SystemRoot/TEMP essentials (+ a few Program* helpers).
  // Non-Windows: broader env, still drop secret-looking names.
  for (const key of Object.keys(process.env)) {
    if (isSecretKey(key)) continue;
    if (process.platform === 'win32' && !SAFE_ENV_KEYS.has(key)) {
      if (!/^(ProgramFiles|ProgramW6432|ProgramData|PUBLIC|ALLUSERSPROFILE|PSModulePath)$/i.test(key)) {
        continue;
      }
    }
    const v = process.env[key];
    if (v != null) env[key] = v;
  }
  // Always ensure PATH is present when available
  if (process.env.PATH && !env.PATH) env.PATH = process.env.PATH;
  if (process.env.Path && !env.Path) env.Path = process.env.Path;

  if (rule.env && typeof rule.env === 'object') {
    for (const [k, v] of Object.entries(rule.env)) {
      if (isSecretKey(k)) continue;
      if (v == null) continue;
      env[k] = String(v);
    }
  }

  // Never inject settings.apiKey; drop any secret-like keys that slipped through
  for (const k of Object.keys(env)) {
    if (isSecretKey(k)) delete env[k];
  }
  if (settings && settings.apiKey != null && settings.apiKey !== '') {
    const secretVal = String(settings.apiKey);
    for (const k of Object.keys(env)) {
      if (env[k] === secretVal) delete env[k];
    }
  }

  env.CODEX_QQ_EVENT = String(event || '');
  if (projectPath) env.CODEX_QQ_PROJECT = String(projectPath);

  return env;
}

function resolveCwd(rule, projectPath, userDataPath) {
  const cwdMode = rule.cwd == null ? 'project' : String(rule.cwd);
  if (cwdMode === 'project') {
    if (!projectPath) {
      const err = new Error('hook cwd project requires projectPath');
      err.code = 'HOOK_CWD';
      throw err;
    }
    return path.resolve(projectPath);
  }
  if (cwdMode === 'userData') {
    if (!userDataPath) {
      const err = new Error('hook cwd userData requires userDataPath');
      err.code = 'HOOK_CWD';
      throw err;
    }
    return path.resolve(userDataPath);
  }
  // relative under project only
  if (!projectPath) {
    const err = new Error('hook relative cwd requires projectPath');
    err.code = 'HOOK_CWD';
    throw err;
  }
  if (path.isAbsolute(cwdMode)) {
    const err = new Error('absolute cwd not allowed');
    err.code = 'HOOK_CWD';
    throw err;
  }
  const root = path.resolve(projectPath);
  const resolved = path.resolve(root, cwdMode);
  let rootReal = root;
  let resolvedReal = resolved;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    /* use resolve */
  }
  try {
    if (fs.existsSync(resolved)) {
      resolvedReal = fs.realpathSync(resolved);
    }
  } catch {
    /* use resolve */
  }
  const rel = path.relative(rootReal, resolvedReal);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('hook cwd outside project root');
    err.code = 'HOOK_CWD';
    throw err;
  }
  return resolved;
}

function matchLifecycle(rule) {
  const m = rule.matcher == null ? '*' : String(rule.matcher).trim();
  return !m || m === '*';
}

function collectStream(stream, max = STREAM_MAX) {
  return new Promise((resolve) => {
    let buf = '';
    let truncated = false;
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      if (truncated) return;
      buf += chunk;
      if (buf.length > max) {
        buf = buf.slice(0, max);
        truncated = true;
      }
    });
    stream.on('end', () => resolve(buf));
    stream.on('error', () => resolve(buf));
  });
}

function parsePreStdout(stdout, exitCode) {
  if (exitCode !== 0) {
    return {
      decision: 'deny',
      reason: `hook exit ${exitCode}`,
      args: null,
      resultStr: null,
    };
  }
  const text = String(stdout || '').trim();
  if (!text) {
    return { decision: 'allow', reason: null, args: null, resultStr: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      decision: 'deny',
      reason: 'hook stdout is not JSON',
      args: null,
      resultStr: null,
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      decision: 'deny',
      reason: 'hook stdout must be object',
      args: null,
      resultStr: null,
    };
  }
  // Missing/empty decision defaults to allow; unknown values → deny (safer)
  const rawDecision = parsed.decision;
  const decision =
    rawDecision == null || rawDecision === ''
      ? 'allow'
      : String(rawDecision).toLowerCase();
  if (decision === 'deny') {
    return {
      decision: 'deny',
      reason: parsed.reason != null ? String(parsed.reason) : 'denied by hook',
      args: null,
      resultStr: null,
    };
  }
  if (decision === 'skip') {
    let result = parsed.result;
    if (result == null) {
      result = { ok: true, skipped: true, by: 'hook' };
    }
    const resultStr =
      typeof result === 'string' ? result : JSON.stringify(result);
    return {
      decision: 'skip',
      reason: parsed.reason != null ? String(parsed.reason) : null,
      args: null,
      resultStr,
    };
  }
  if (decision === 'allow') {
    let args = null;
    if (parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)) {
      args = parsed.args;
    }
    return {
      decision: 'allow',
      reason: parsed.reason != null ? String(parsed.reason) : null,
      args,
      resultStr: null,
    };
  }
  return {
    decision: 'deny',
    reason: `unknown hook decision: ${rawDecision}`,
    args: null,
    resultStr: null,
  };
}

function createHooksRunner(opts = {}) {
  const {
    hooks,
    projectPath,
    userDataPath,
    settings = {},
    sessionKey,
    agentMode = 'agent',
    subagentDepth = 0,
    onEvent,
    signal,
    spawnFn = defaultSpawn,
  } = opts;

  const depth = Number(subagentDepth) || 0;
  const hasRules =
    hooks &&
    hooks.rulesByEvent &&
    typeof hooks.rulesByEvent === 'object';
  const enabled =
    settings.hooksEnabled !== false && depth === 0 && !!hasRules;

  function emit(type, fields) {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent({ type, ...fields });
    } catch {
      /* swallow UI errors */
    }
  }

  function basePayload(event, extra = {}) {
    const payload = {
      event,
      timestamp: new Date().toISOString(),
      sessionKey: sessionKey || null,
      agentMode,
      subagentDepth: depth,
      projectPath: projectPath || null,
      permissionMode: settings.permissionMode || 'confirm-writes',
      tool: extra.tool || null,
      result: extra.result != null ? truncateDeep(extra.result) : null,
      run: {
        aborting: !!(signal && signal.aborted),
        reason: extra.reason || null,
      },
      promptPreview:
        extra.promptPreview != null
          ? String(extra.promptPreview).slice(0, 2000)
          : null,
      flags: extra.flags || null,
    };
    if (payload.tool && payload.tool.args) {
      payload.tool = {
        ...payload.tool,
        args: truncateDeep(payload.tool.args),
      };
    }
    return ensurePayloadSize(payload);
  }

  function runProcess(rule, event, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      let cwd;
      try {
        cwd = resolveCwd(rule, projectPath, userDataPath);
      } catch (err) {
        resolve({
          ok: false,
          exitCode: -1,
          stdout: '',
          stderr: String(err.message || err),
          error: err,
          timedOut: false,
          aborted: false,
        });
        return;
      }

      const env = buildEnv(rule, { event, projectPath, settings });
      const args = Array.isArray(rule.args) ? rule.args.map(String) : [];
      let child;
      try {
        child = spawnFn(rule.command, args, {
          cwd,
          env,
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({
          ok: false,
          exitCode: -1,
          stdout: '',
          stderr: String(err.message || err),
          error: err,
          timedOut: false,
          aborted: false,
        });
        return;
      }

      let settled = false;
      let timedOut = false;
      let aborted = false;
      const stdoutP = collectStream(child.stdout, STREAM_MAX);
      const stderrP = collectStream(child.stderr, STDERR_MAX);

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }, timeoutMs);

      const onAbort = () => {
        aborted = true;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) {
          try {
            signal.removeEventListener('abort', onAbort);
          } catch {
            /* ignore */
          }
        }
        resolve(result);
      };

      child.on('error', async (err) => {
        const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
        finish({
          ok: false,
          exitCode: -1,
          stdout,
          stderr: stderr || String(err.message || err),
          error: err,
          timedOut,
          aborted,
        });
      });

      child.on('close', async (code) => {
        const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
        const exitCode = code == null ? -1 : code;
        finish({
          ok: exitCode === 0 && !timedOut && !aborted,
          exitCode,
          stdout,
          stderr,
          error: null,
          timedOut,
          aborted,
        });
      });

      // Ignore EPIPE/stream errors if hook exits before reading stdin
      if (child.stdin) {
        child.stdin.on('error', () => {});
      }
      try {
        const body = JSON.stringify(payload);
        if (child.stdin) {
          child.stdin.write(body, 'utf8');
          child.stdin.end();
        }
      } catch (err) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish({
          ok: false,
          exitCode: -1,
          stdout: '',
          stderr: String(err.message || err),
          error: err,
          timedOut: false,
          aborted: false,
        });
      }
    });
  }

  async function runOne(rule, event, payload, options = {}) {
    const start = Date.now();
    let timeoutMs = Number(rule.timeoutMs) || 15000;
    if (options.clampStopAbort) {
      timeoutMs = Math.min(timeoutMs, STOP_ABORT_TIMEOUT_CAP);
    }

    emit(AGENT_EVENTS.HOOK_START, {
      event,
      matcher: rule.matcher,
      command: rule.command,
      toolName: options.toolName || null,
      source: rule.source || null,
    });

    let proc;
    try {
      proc = await runProcess(rule, event, payload, timeoutMs);
    } catch (err) {
      const durationMs = Date.now() - start;
      emit(AGENT_EVENTS.HOOK_END, {
        event,
        ok: false,
        reason: String(err.message || err),
        durationMs,
        toolName: options.toolName || null,
      });
      return { ok: false, error: err, durationMs, decision: null, reason: String(err.message || err) };
    }

    const durationMs = Date.now() - start;

    if (proc.aborted && options.isPre) {
      emit(AGENT_EVENTS.HOOK_END, {
        event,
        ok: false,
        reason: '已停止',
        durationMs,
        toolName: options.toolName || null,
      });
      throw makeAbortedError('已停止');
    }

    if (options.isPre) {
      let decision = 'deny';
      let reason = null;
      let parsed = null;
      if (proc.timedOut) {
        decision = 'deny';
        reason = 'hook timeout';
      } else if (proc.error && proc.exitCode === -1 && !proc.stdout) {
        decision = 'deny';
        reason = proc.stderr || 'hook spawn failed';
      } else {
        parsed = parsePreStdout(proc.stdout, proc.exitCode);
        decision = parsed.decision;
        reason = parsed.reason;
      }
      emit(AGENT_EVENTS.HOOK_END, {
        event,
        ok: decision !== 'deny',
        decision,
        reason,
        durationMs,
        skipped: decision === 'skip' || undefined,
        toolName: options.toolName || null,
      });
      return {
        ok: decision !== 'deny',
        decision,
        reason,
        args: parsed && parsed.args,
        resultStr: parsed && parsed.resultStr,
        durationMs,
        stdout: proc.stdout,
        stderr: proc.stderr,
      };
    }

    // non-Pre: failures swallowed after hook-end
    const ok = !proc.timedOut && !proc.aborted && proc.exitCode === 0 && !proc.error;
    let message = null;
    if (proc.stdout && String(proc.stdout).trim()) {
      try {
        const j = JSON.parse(String(proc.stdout).trim());
        if (j && typeof j === 'object' && j.message != null) {
          message = truncateString(String(j.message), 2000);
        }
      } catch {
        /* ignore non-json */
      }
    }
    emit(AGENT_EVENTS.HOOK_END, {
      event,
      ok,
      reason: ok
        ? message
        : proc.timedOut
          ? 'hook timeout'
          : proc.aborted
            ? '已停止'
            : proc.stderr
              ? truncateString(proc.stderr, 500)
              : `hook exit ${proc.exitCode}`,
      durationMs,
      message: message || undefined,
      toolName: options.toolName || null,
    });
    return { ok, durationMs, stdout: proc.stdout, stderr: proc.stderr };
  }

  async function runPreToolUse({ name, args, risk }) {
    const initialArgs = args && typeof args === 'object' ? { ...args } : {};
    if (!enabled) {
      return { decision: 'allow', args: initialArgs, argsChanged: false };
    }
    const rules = (hooks.rulesByEvent && hooks.rulesByEvent.PreToolUse) || [];
    const matched = rules.filter((r) => matchTool(r.matcher, name));
    if (!matched.length) {
      return { decision: 'allow', args: initialArgs, argsChanged: false };
    }

    let currentArgs = { ...initialArgs };
    for (const rule of matched) {
      if (signal && signal.aborted) {
        throw makeAbortedError('已停止');
      }
      const payload = basePayload('PreToolUse', {
        tool: {
          name,
          risk: risk || null,
          args: currentArgs,
        },
      });
      const one = await runOne(rule, 'PreToolUse', payload, {
        isPre: true,
        toolName: name,
      });
      if (one.decision === 'deny') {
        return {
          decision: 'deny',
          args: currentArgs,
          reason: one.reason || 'denied by hook',
          argsChanged:
            JSON.stringify(currentArgs) !== JSON.stringify(initialArgs),
        };
      }
      if (one.decision === 'skip') {
        return {
          decision: 'skip',
          args: currentArgs,
          reason: one.reason || undefined,
          resultStr:
            one.resultStr ||
            JSON.stringify({ ok: true, skipped: true, by: 'hook' }),
          argsChanged:
            JSON.stringify(currentArgs) !== JSON.stringify(initialArgs),
        };
      }
      // allow — merge args by key overwrite
      if (one.args && typeof one.args === 'object') {
        currentArgs = { ...currentArgs, ...one.args };
      }
    }
    return {
      decision: 'allow',
      args: currentArgs,
      argsChanged: JSON.stringify(currentArgs) !== JSON.stringify(initialArgs),
    };
  }

  async function runPostToolUse(ctx = {}) {
    if (!enabled) return;
    const name = ctx.name || (ctx.tool && ctx.tool.name) || '';
    const rules = (hooks.rulesByEvent && hooks.rulesByEvent.PostToolUse) || [];
    const matched = rules.filter((r) => matchTool(r.matcher, name));
    if (!matched.length) return;

    const toolArgs = ctx.args || (ctx.tool && ctx.tool.args) || {};
    const risk = ctx.risk || (ctx.tool && ctx.tool.risk) || null;
    const payload = basePayload('PostToolUse', {
      tool: { name, risk, args: toolArgs },
      result: ctx.result,
      flags: ctx.flags || null,
    });

    for (const rule of matched) {
      try {
        await runOne(rule, 'PostToolUse', payload, {
          isPre: false,
          toolName: name,
        });
      } catch {
        /* swallow — lifecycle/post failures do not throw */
      }
    }
  }

  async function runLifecycle(event, extra = {}) {
    if (!enabled) return;
    const rules = (hooks.rulesByEvent && hooks.rulesByEvent[event]) || [];
    const matched = rules.filter((r) => matchLifecycle(r));
    if (!matched.length) return;

    const clampStopAbort =
      event === 'Stop' &&
      (!!(signal && signal.aborted) || extra.reason === 'aborted');

    const payload = basePayload(event, {
      reason: extra.reason,
      promptPreview: extra.promptPreview,
      flags: extra.flags,
      result: extra.result,
      tool: extra.tool || null,
    });

    for (const rule of matched) {
      try {
        await runOne(rule, event, payload, {
          isPre: false,
          clampStopAbort,
        });
      } catch {
        /* swallow */
      }
    }
  }

  return {
    enabled: !!enabled,
    runPreToolUse,
    runPostToolUse,
    runLifecycle,
  };
}

module.exports = {
  createHooksRunner,
  matchLifecycle,
  parsePreStdout,
  truncateDeep,
  buildEnv,
  isSecretKey,
};
