const path = require('path');
const {
  listTree,
  readFile,
  writeFile,
  deletePath,
  searchReplace,
  parseWriteFences,
} = require('./project-fs');
const { runTerminal } = require('./terminal');
const { chatCompletionMessage } = require('./openai-compatible');
const { grepFiles, globFiles } = require('./search');
const { loadProjectInstructions } = require('./project-instructions');
const { loadGitignoreRules } = require('./gitignore');
const { riskForTool } = require('./permission');
const { AGENT_EVENTS } = require('./agent-events');

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List project directory tree (real filesystem). Prefer relative path from project root. Respects .gitignore.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory, default .' },
          maxDepth: { type: 'integer', description: 'Max depth, default 6' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file inside the project. Use offset (1-based line) and limit for large files; output is line-numbered.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          offset: { type: 'integer', description: '1-based start line (optional)' },
          limit: { type: 'integer', description: 'Max number of lines (optional)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents in the project (regex by default). Optional path/glob filters. Respects .gitignore.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern (regex unless literal=true)' },
          path: { type: 'string', description: 'Relative start directory, default .' },
          glob: { type: 'string', description: 'Optional file glob filter, e.g. **/*.js' },
          maxResults: { type: 'integer', description: 'Max matches, default 50, max 200' },
          literal: { type: 'boolean', description: 'Treat pattern as literal string' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files by glob pattern under project root. Respects .gitignore.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.js' },
          maxResults: { type: 'integer', description: 'Max files, default 50, max 200' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_replace',
      description: 'Replace a unique old_string with new_string in an existing file (prefer this over write_file for edits). Set replace_all=true to replace all occurrences.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean', description: 'Replace all occurrences (default false; requires unique match)' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a text file. Prefer search_replace for local edits; use write_file for new files or intentional full rewrites.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_path',
      description: 'Delete a file or directory inside the project',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_terminal',
      description: 'Run a shell command in the project directory (only if terminal enabled)',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
    },
  },
];

const TOOL_NAMES = TOOL_DEFS.map((t) => t.function.name).join(', ');

function agentSystemPrompt(project, settings) {
  const parts = [
    '你是 Codex 风格编程 Agent。你可以通过工具在本机真实项目上操作。',
    '工作流：需要信息时先 list_dir / glob / grep / read_file，再修改；优先 search_replace 做局部修改；新建或整文件重写用 write_file；必要时 run_terminal 验证。',
    '规则：',
    '1. 路径一律相对项目根，禁止访问项目外',
    '2. 不要编造文件内容；先读/搜再改',
    '3. 局部编辑优先 search_replace（要求 old_string 默认唯一匹配）；不要用 write_file 整文件覆盖只改几行的情况',
    '4. 完成后用中文总结改动',
    '5. 若无需再调用工具，直接给出最终答复（不要空回复）',
    `终端工具: ${settings.terminalEnabled ? '已启用' : '未启用（不要调用 run_terminal）'}`,
  ];

  if (project?.path) {
    parts.push(`当前工作项目：${project.name || path.basename(project.path)}`);
    parts.push(`项目根目录（真实路径）: ${project.path}`);

    try {
      const instr = loadProjectInstructions(project.path);
      if (instr.parts) {
        parts.push('');
        parts.push(instr.parts);
      }
    } catch {
      // ignore instruction load errors
    }

    try {
      const ignoreRules = loadGitignoreRules(project.path);
      const t = listTree(project.path, {
        maxDepth: 3,
        maxEntries: 80,
        ignoreRules,
      });
      parts.push('');
      parts.push(`简要目录树（maxDepth=3, maxEntries=80, 扫描 ${t.count} 项, 截断=${t.truncated}）:`);
      parts.push(t.treeText);
      parts.push('完整结构请用 list_dir / glob / grep，不要编造路径。');
    } catch (e) {
      parts.push(`目录树读取失败: ${e.message}`);
    }
  }

  return parts.join('\n');
}

function toolsForSettings(settings) {
  if (settings.terminalEnabled) return TOOL_DEFS;
  return TOOL_DEFS.filter((t) => t.function.name !== 'run_terminal');
}

function parseArgs(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Text-protocol fallback when API has no tool_calls support */
function parseTextToolCalls(content) {
  const text = String(content || '');
  const calls = [];
  // ```tool list_dir
  // {"path":"."}
  // ```
  const re = /```tool[ \t]+([a-z_]+)\s*\n([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    calls.push({
      id: 'text_' + calls.length + '_' + Date.now(),
      type: 'function',
      function: {
        name: m[1].trim(),
        arguments: m[2].trim() || '{}',
      },
    });
  }
  // TOOL_CALL list_dir {"path":"."}
  const re2 = /TOOL_CALL\s+([a-z_]+)\s+(\{[\s\S]*?\})/gi;
  while ((m = re2.exec(text)) !== null) {
    calls.push({
      id: 'text2_' + calls.length + '_' + Date.now(),
      type: 'function',
      function: { name: m[1].trim(), arguments: m[2].trim() },
    });
  }
  return calls;
}

function toolPath(name, args) {
  if (name === 'run_terminal') return undefined;
  if (name === 'grep') return args.path || undefined;
  if (name === 'glob') return undefined;
  return args.path || args.file || undefined;
}

function toolSummary(name, args) {
  const p = toolPath(name, args);
  switch (name) {
    case 'list_dir':
      return `列出 ${p || '.'}`;
    case 'read_file':
      return `读取 ${p || '?'}`;
    case 'grep':
      return `搜索 ${args.pattern || ''}${p ? ` in ${p}` : ''}`;
    case 'glob':
      return `匹配文件 ${args.pattern || ''}`;
    case 'search_replace':
      return `修改 ${p || '?'}`;
    case 'write_file':
      return `写入 ${p || '?'}`;
    case 'delete_path':
      return `删除 ${p || '?'}`;
    case 'run_terminal':
      return `执行: ${String(args.command || '').slice(0, 120)}`;
    default:
      return name;
  }
}

function toolDetail(name, args) {
  if (name === 'run_terminal') return String(args.command || '');
  if (name === 'search_replace') {
    const oldS = String(args.old_string || '');
    const newS = String(args.new_string || '');
    return `path=${args.path}\nold_string:\n${oldS.slice(0, 800)}\n---\nnew_string:\n${newS.slice(0, 800)}`.slice(0, 2000);
  }
  if (name === 'write_file') {
    return `path=${args.path}\ncontent:\n${String(args.content || '').slice(0, 1500)}`.slice(0, 2000);
  }
  try {
    return JSON.stringify(args).slice(0, 2000);
  } catch {
    return String(args);
  }
}

function summarizeToolResult(name, parsed) {
  if (parsed.error) return parsed.error;
  if (name === 'list_dir') return `count=${parsed.count}`;
  if (name === 'write_file') return `wrote ${parsed.path} (${parsed.bytes}b)`;
  if (name === 'search_replace') return `replaced ${parsed.replacements || 1} in ${parsed.path}`;
  if (name === 'grep') return `matches=${(parsed.matches && parsed.matches.length) || 0}`;
  if (name === 'glob') return `files=${(parsed.files && parsed.files.length) || 0}`;
  if (name === 'run_terminal') return `exit=${parsed.code}`;
  if (name === 'delete_path') return `deleted ${parsed.path}`;
  if (name === 'read_file') return `read ${parsed.path}`;
  return 'ok';
}

/**
 * Authorize via PermissionGate when present.
 * Legacy fallback: allow non-terminal; terminal uses confirmTerminal if required.
 */
async function authorizeTool({
  gate,
  confirmTerminal,
  settings,
  name,
  risk,
  summary,
  detail,
  path: toolRelPath,
  sessionKey,
  signal,
}) {
  if (gate && typeof gate.authorize === 'function') {
    return gate.authorize({
      tool: name,
      risk,
      summary,
      detail,
      path: toolRelPath,
      sessionKey,
      signal,
    });
  }

  const effectiveRisk = risk || riskForTool(name);
  if (effectiveRisk === 'terminal') {
    if (!settings?.terminalEnabled) {
      return { allowed: false, reason: '终端未启用，不允许执行终端命令' };
    }
    if (settings.terminalRequireConfirm && typeof confirmTerminal === 'function') {
      const allowed = await confirmTerminal(detail || summary || '');
      return allowed
        ? { allowed: true }
        : { allowed: false, reason: '用户拒绝执行该命令' };
    }
    return { allowed: true };
  }
  return { allowed: true };
}

async function executeTool(name, args, ctx) {
  const { project, settings } = ctx;
  const root = project.path;
  const rel = (args.path || args.file || '.').replace(/^\/+/, '');

  try {
    if (name === 'list_dir') {
      // handled in executeToolFixed
      return null;
    }
    if (name === 'read_file') {
      const opts = {};
      if (args.offset != null) opts.offset = Number(args.offset);
      if (args.limit != null) opts.limit = Number(args.limit);
      const f = readFile(root, rel, opts);
      return JSON.stringify({
        ok: true,
        path: f.path,
        size: f.size,
        content: f.content,
        totalLines: f.totalLines,
        startLine: f.startLine,
        endLine: f.endLine,
      });
    }
    if (name === 'grep') {
      const r = grepFiles(root, {
        pattern: args.pattern,
        path: args.path,
        glob: args.glob,
        maxResults: args.maxResults,
        literal: args.literal === true,
      });
      return JSON.stringify(r);
    }
    if (name === 'glob') {
      const r = globFiles(root, {
        pattern: args.pattern,
        maxResults: args.maxResults,
      });
      return JSON.stringify(r);
    }
    if (name === 'search_replace') {
      const r = searchReplace(root, rel, args.old_string, args.new_string, {
        replaceAll: args.replace_all === true || args.replaceAll === true,
      });
      return JSON.stringify({
        ok: true,
        path: r.path,
        replacements: r.replacements,
        bytes: r.bytes,
        mode: 'search_replace',
      });
    }
    if (name === 'write_file') {
      const w = writeFile(root, rel, args.content ?? '');
      return JSON.stringify({ ok: true, path: w.path, bytes: w.bytes });
    }
    if (name === 'delete_path') {
      const d = deletePath(root, rel);
      return JSON.stringify({ ok: true, path: d.path });
    }
    if (name === 'run_terminal') {
      if (!settings.terminalEnabled) {
        return JSON.stringify({ ok: false, error: '终端未启用。请在设置中打开「允许终端」。' });
      }
      const command = String(args.command || '').trim();
      if (!command) return JSON.stringify({ ok: false, error: 'command 为空' });
      // Authorization is done by PermissionGate in runAgentLoop (no confirmTerminal here).
      const result = await runTerminal(root, command, {
        timeoutMs: settings.terminalTimeoutMs || 60000,
        signal: ctx.signal,
      });
      return JSON.stringify(result);
    }
    return JSON.stringify({ ok: false, error: '未知工具: ' + name });
  } catch (err) {
    return JSON.stringify({ ok: false, error: err.message || String(err) });
  }
}

// fix list_dir to use project root + relative properly + gitignore
async function executeToolFixed(name, args, ctx) {
  if (name === 'list_dir') {
    const { project } = ctx;
    const rel = (args.path || '.').replace(/^\/+/, '') || '.';
    try {
      const abs = rel === '.' ? project.path : path.join(project.path, rel);
      const rootResolved = path.resolve(project.path);
      const absResolved = path.resolve(abs);
      if (absResolved !== rootResolved && !absResolved.startsWith(rootResolved + path.sep)) {
        return JSON.stringify({ ok: false, error: '路径越界' });
      }
      let ignoreRules = null;
      try {
        ignoreRules = loadGitignoreRules(project.path);
      } catch {
        ignoreRules = null;
      }
      const t = listTree(absResolved, {
        maxDepth: Number(args.maxDepth) || 6,
        maxEntries: 3000,
        ignoreRules,
      });
      return JSON.stringify({
        ok: true,
        path: rel,
        root: t.root,
        count: t.count,
        truncated: t.truncated,
        tree: t.treeText,
      });
    } catch (err) {
      return JSON.stringify({ ok: false, error: err.message || String(err) });
    }
  }
  return executeTool(name, args, ctx);
}

/**
 * Multi-turn agent loop.
 * onEvent is used for text-delta / tool-start / tool-end (main emits run-start/done).
 * Optional chatFn defaults to chatCompletionMessage for testability.
 * Gate should be created in main; if omitted, a settings-based gate or legacy confirmTerminal is used.
 */
function assertNotAborted(signal) {
  if (signal?.aborted) {
    const e = new Error('已停止');
    e.code = 'ABORTED';
    throw e;
  }
}

function resolveGate({ gate }) {
  // Prefer gate from main (binds onApprovalNeeded → UI).
  // If omitted, authorizeTool falls back to legacy confirmTerminal / allow path.
  if (gate && typeof gate.authorize === 'function') return gate;
  return null;
}

/**
 * Replace write fences in display text based on per-op results.
 * Success → ✅ 已写入; deny/fail → clear Chinese failure note (never claim 已写入).
 */
function displayContentForWriteFences(text, applied) {
  let i = 0;
  return String(text || '')
    .replace(/```(?:write|create|file):([^\n]+)\n([\s\S]*?)```/gi, (_a, p) => {
      const result = applied[i++];
      const pathLabel = String(p || '').trim();
      if (result?.ok) {
        return `✅ 已写入文件：\`${pathLabel}\``;
      }
      const reason = result?.error || '未授权';
      return `❌ 未写入（${reason}）：\`${pathLabel}\``;
    })
    .trim();
}

async function applyWriteFencesWithGate(projectRoot, content, {
  gate,
  confirmTerminal,
  settings,
  sessionKey,
  signal,
  onEvent,
}) {
  const ops = parseWriteFences(content);
  if (!ops.length) {
    return { applied: [], displayContent: content };
  }

  const applied = [];
  for (const op of ops) {
    assertNotAborted(signal);
    const risk = 'write';
    const summary = `写入 ${op.path}`;
    const detail = String(op.content || '').slice(0, 2000);
    onEvent?.({ type: AGENT_EVENTS.TOOL_START, tool: 'write_fence', args: { path: op.path } });
    let auth;
    let endEmitted = false;
    try {
      try {
        auth = await authorizeTool({
          gate,
          confirmTerminal,
          settings,
          name: 'write_file',
          risk,
          summary,
          detail,
          path: op.path,
          sessionKey,
          signal,
        });
      } catch (err) {
        if (err?.code === 'ABORTED' || err?.name === 'AbortError') throw err;
        auth = { allowed: false, reason: err.message || String(err) };
      }

      if (!auth.allowed) {
        const reason = auth.reason || '未授权';
        applied.push({ path: op.path, ok: false, error: reason });
        onEvent?.({
          type: AGENT_EVENTS.TOOL_END,
          tool: 'write_fence',
          ok: false,
          summary: reason,
        });
        endEmitted = true;
        continue;
      }

      try {
        const r = writeFile(projectRoot, op.path, op.content);
        applied.push({ path: r.path, ok: true, bytes: r.bytes, mode: 'write_fence' });
        onEvent?.({
          type: AGENT_EVENTS.TOOL_END,
          tool: 'write_fence',
          ok: true,
          summary: `wrote ${r.path} (${r.bytes}b)`,
        });
        endEmitted = true;
      } catch (err) {
        applied.push({ path: op.path, ok: false, error: err.message || String(err) });
        onEvent?.({
          type: AGENT_EVENTS.TOOL_END,
          tool: 'write_fence',
          ok: false,
          summary: err.message || String(err),
        });
        endEmitted = true;
      }
    } catch (err) {
      // Abort (or unexpected throw) after TOOL_START: always emit TOOL_END first
      if (!endEmitted) {
        onEvent?.({
          type: AGENT_EVENTS.TOOL_END,
          tool: 'write_fence',
          ok: false,
          summary: err?.code === 'ABORTED' || err?.name === 'AbortError' ? '已停止' : (err.message || String(err)),
        });
      }
      throw err;
    }
  }

  return {
    applied,
    displayContent: displayContentForWriteFences(content, applied),
  };
}

async function callModelTurn({
  chatFn,
  settings,
  working,
  tools,
  toolsSupported,
  fetchFn,
  signal,
  onEvent,
  streamFailedOnce,
}) {
  const baseOpts = {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    messages: working,
    tools: toolsSupported ? tools : undefined,
    tool_choice: toolsSupported ? 'auto' : undefined,
    fetchFn,
    signal,
  };

  const useStream = !streamFailedOnce;
  /** True if any text-delta was already pushed for this turn (avoid full re-emit on fallback). */
  let emittedStreamText = false;
  try {
    const msg = await chatFn({
      ...baseOpts,
      stream: useStream,
      onDelta: useStream
        ? (d) => {
          if (d?.text) {
            emittedStreamText = true;
            onEvent?.({ type: AGENT_EVENTS.TEXT_DELTA, text: d.text });
          }
        }
        : undefined,
    });
    return { msg, streamFailedOnce };
  } catch (err) {
    if (err?.code === 'ABORTED' || err?.name === 'AbortError' || signal?.aborted) {
      const e = new Error('已停止');
      e.code = 'ABORTED';
      throw e;
    }
    // Stream/SSE parse failure → one non-stream fallback
    if (useStream && /stream|SSE|parse/i.test(String(err.message || err))) {
      const msg = await chatFn({
        ...baseOpts,
        stream: false,
      });
      // If partial stream text was already emitted, do not re-emit full content
      // (content still returned on msg for loop state / final answer).
      if (msg?.content && !emittedStreamText) {
        onEvent?.({ type: AGENT_EVENTS.TEXT_DELTA, text: msg.content });
      }
      return { msg, streamFailedOnce: true };
    }
    throw err;
  }
}

async function runAgentLoop({
  project,
  settings,
  messages,
  gate,
  onEvent,
  fetchFn,
  signal,
  sessionKey,
  chatFn,
  confirmTerminal, // legacy optional; prefer gate
}) {
  if (!project?.path) {
    throw new Error('Agent 需要绑定真实项目目录');
  }

  const effectiveGate = resolveGate({ gate });
  const chat = typeof chatFn === 'function' ? chatFn : chatCompletionMessage;

  const rawTurns = Number(settings.maxAgentTurns);
  // 0 = unlimited; otherwise clamp 1..50 for safety when user sets a number
  const unlimited = rawTurns === 0;
  const maxTurns = unlimited ? Number.POSITIVE_INFINITY : Math.max(1, Math.min(50, rawTurns || 8));
  const tools = toolsForSettings(settings);
  const agentLog = [];
  const applied = [];

  /** @type {any[]} */
  let working = [
    { role: 'system', content: agentSystemPrompt(project, settings) },
    ...messages.map((m) => ({ role: m.role, content: String(m.content || '') })),
  ];

  let toolsSupported = true;
  let streamFailedOnce = false;

  for (let turn = 1; unlimited || turn <= maxTurns; turn++) {
    assertNotAborted(signal);
    let msg;
    try {
      const called = await callModelTurn({
        chatFn: chat,
        settings,
        working,
        tools,
        toolsSupported,
        fetchFn,
        signal,
        onEvent,
        streamFailedOnce,
      });
      msg = called.msg;
      streamFailedOnce = called.streamFailedOnce;
    } catch (err) {
      if (err?.code === 'ABORTED' || err?.name === 'AbortError' || signal?.aborted) {
        const e = new Error('已停止');
        e.code = 'ABORTED';
        throw e;
      }
      // Some gateways reject tools — retry once without tools
      if (toolsSupported && /tools|tool_choice|unsupported|400/i.test(String(err.message))) {
        toolsSupported = false;
        const called = await callModelTurn({
          chatFn: chat,
          settings,
          working: [
            ...working,
            {
              role: 'system',
              content:
                '当前 API 不支持 tools。请用文本协议调用工具：\n```tool list_dir\n{"path":"."}\n```\n可用: '
                + TOOL_NAMES,
            },
          ],
          tools,
          toolsSupported: false,
          fetchFn,
          signal,
          onEvent,
          streamFailedOnce,
        });
        msg = called.msg;
        streamFailedOnce = called.streamFailedOnce;
      } else {
        throw err;
      }
    }

    let toolCalls = msg.tool_calls;
    if (!toolCalls?.length) {
      const textCalls = parseTextToolCalls(msg.content);
      if (textCalls.length) toolCalls = textCalls;
    }

    if (toolCalls?.length) {
      // store assistant message
      if (msg.tool_calls?.length) {
        working.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.tool_calls,
        });
      } else {
        working.push({ role: 'assistant', content: msg.content || '(调用工具)' });
      }

      for (const tc of toolCalls) {
        const name = tc.function?.name || tc.name;
        const args = parseArgs(tc.function?.arguments ?? tc.arguments);
        assertNotAborted(signal);

        const risk = riskForTool(name);
        const summary = toolSummary(name, args);
        const detail = toolDetail(name, args);
        const relPath = toolPath(name, args);

        onEvent?.({ type: AGENT_EVENTS.TOOL_START, tool: name, args });

        let resultStr;
        let authAllowed = true;
        let authReason;
        let toolEndEmitted = false;
        try {
          try {
            const auth = await authorizeTool({
              gate: effectiveGate,
              confirmTerminal,
              settings,
              name,
              risk,
              summary,
              detail,
              path: relPath,
              sessionKey,
              signal,
            });
            authAllowed = !!auth.allowed;
            authReason = auth.reason;
          } catch (err) {
            if (err?.code === 'ABORTED' || err?.name === 'AbortError' || signal?.aborted) {
              const e = new Error('已停止');
              e.code = 'ABORTED';
              throw e;
            }
            authAllowed = false;
            authReason = err.message || String(err);
          }

          if (!authAllowed) {
            resultStr = JSON.stringify({ ok: false, error: authReason || '未授权' });
          } else {
            resultStr = await executeToolFixed(name, args, {
              project,
              settings,
              signal,
              gate: effectiveGate,
            });
          }

          let parsed;
          try { parsed = JSON.parse(resultStr); } catch { parsed = { raw: resultStr }; }

          const ok = parsed.ok !== false;
          const stepSummary = summarizeToolResult(name, parsed);

          agentLog.push({
            turn,
            tool: name,
            args,
            ok,
            summary: stepSummary,
          });

          onEvent?.({
            type: AGENT_EVENTS.TOOL_END,
            tool: name,
            ok,
            summary: stepSummary,
          });
          toolEndEmitted = true;

          if (name === 'write_file' && parsed.ok) {
            applied.push({ path: parsed.path, ok: true, bytes: parsed.bytes });
          }
          if (name === 'search_replace' && parsed.ok) {
            applied.push({
              path: parsed.path,
              ok: true,
              bytes: parsed.bytes,
              mode: 'search_replace',
              replacements: parsed.replacements,
            });
          }
          if (name === 'delete_path' && parsed.ok) {
            applied.push({ path: parsed.path, ok: true, bytes: 0, deleted: true });
          }

          if (tc.id && String(tc.id).startsWith('text')) {
            // text protocol: append as user-visible tool result in chat history
            working.push({
              role: 'user',
              content: `【工具 ${name} 结果】\n` + resultStr.slice(0, 12000),
            });
          } else {
            working.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: resultStr.slice(0, 50000),
            });
          }
        } catch (err) {
          // Abort (or unexpected throw) after TOOL_START: always emit TOOL_END first
          if (!toolEndEmitted) {
            const aborted = err?.code === 'ABORTED' || err?.name === 'AbortError' || signal?.aborted;
            onEvent?.({
              type: AGENT_EVENTS.TOOL_END,
              tool: name,
              ok: false,
              summary: aborted ? '已停止' : (err.message || String(err)),
            });
          }
          if (err?.code === 'ABORTED' || err?.name === 'AbortError' || signal?.aborted) {
            const e = new Error('已停止');
            e.code = 'ABORTED';
            throw e;
          }
          throw err;
        }
      }
      continue;
    }

    // Final natural language answer
    let content = msg.content || '';
    // write fences: authorize each op via gate before apply
    const fence = await applyWriteFencesWithGate(project.path, content, {
      gate: effectiveGate,
      confirmTerminal,
      settings,
      sessionKey,
      signal,
      onEvent,
    });
    if (fence.applied.length) {
      applied.push(...fence.applied);
      content = fence.displayContent;
    }

    content = appendAgentFooter(content, agentLog, applied, unlimited ? '∞' : turn);
    return {
      content,
      applied,
      agentLog,
      turns: turn,
      toolsSupported,
    };
  }

  // Only reached when a finite maxTurns was set
  const content = appendAgentFooter(
    `已达到最大 Agent 轮数（${maxTurns}）。请根据工具日志继续说明需求，发送新消息可继续。`,
    agentLog,
    applied,
    maxTurns
  );
  return { content, applied, agentLog, turns: maxTurns, toolsSupported };
}

function appendAgentFooter(content, agentLog, applied, turns) {
  let out = String(content || '').trim();
  if (agentLog.length) {
    out += '\n\n---\n🤖 Agent 工具轨迹（' + agentLog.length + ' 步，轮次≤' + turns + '）\n';
    for (const step of agentLog) {
      out += `- [turn ${step.turn}] ${step.tool} → ${step.ok ? '✅' : '❌'} ${step.summary}\n`;
    }
  }
  if (applied.length) {
    out += '\n📁 文件变更\n';
    for (const a of applied) {
      out += a.ok
        ? `- ✅ ${a.path}${a.deleted ? ' (deleted)' : a.bytes != null ? ` (${a.bytes} bytes)` : ''}\n`
        : `- ❌ ${a.path}: ${a.error}\n`;
    }
  }
  return out;
}

module.exports = {
  runAgentLoop,
  parseTextToolCalls,
  toolsForSettings,
  TOOL_DEFS,
  executeToolFixed,
  assertNotAborted,
  riskForTool,
  authorizeTool,
  applyWriteFencesWithGate,
};
