const path = require('path');
const {
  listTree,
  readFile,
  writeFile,
  deletePath,
  applyWriteFences,
  buildProjectSystemPrompt,
} = require('./project-fs');
const { runTerminal } = require('./terminal');
const { chatCompletionMessage } = require('./openai-compatible');

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List project directory tree (real filesystem). Prefer relative path from project root.',
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
      description: 'Read a text file inside the project',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a text file inside the project',
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

function agentSystemPrompt(project, settings) {
  const parts = [
    '你是 Codex 风格编程 Agent。你可以通过工具在本机真实项目上操作。',
    '工作流：需要信息时先 list_dir / read_file，再 write_file 修改，必要时 run_terminal 验证。',
    '规则：',
    '1. 路径一律相对项目根，禁止访问项目外',
    '2. 不要编造文件内容；先读再改',
    '3. 完成后用中文总结改动',
    '4. 若无需再调用工具，直接给出最终答复（不要空回复）',
    `终端工具: ${settings.terminalEnabled ? '已启用' : '未启用（不要调用 run_terminal）'}`,
  ];
  if (project?.path) {
    parts.push(buildProjectSystemPrompt(project));
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

async function executeTool(name, args, ctx) {
  const { project, settings, confirmTerminal } = ctx;
  const root = project.path;
  const rel = (args.path || args.file || '.').replace(/^\/+/, '');

  try {
    if (name === 'list_dir') {
      const t = listTree(path.join(root, rel === '.' ? '' : rel), {
        maxDepth: Number(args.maxDepth) || 6,
        maxEntries: 3000,
      });
      // if path is subdir, listTree expects absolute projectRoot - fix:
      // listTree takes project root; for subdir we need walk from sub
      // Actually listTree(projectRoot) walks that root as base. So pass absolute subdir.
      return JSON.stringify({
        ok: true,
        root: t.root,
        count: t.count,
        truncated: t.truncated,
        tree: t.treeText,
      });
    }
    if (name === 'read_file') {
      const f = readFile(root, rel);
      return JSON.stringify({ ok: true, path: f.path, size: f.size, content: f.content });
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
      if (settings.terminalRequireConfirm && typeof confirmTerminal === 'function') {
        const allowed = await confirmTerminal(command);
        if (!allowed) return JSON.stringify({ ok: false, error: '用户拒绝执行该命令' });
      }
      const result = await runTerminal(root, command, { timeoutMs: settings.terminalTimeoutMs || 60000, signal: ctx.signal });
      return JSON.stringify(result);
    }
    return JSON.stringify({ ok: false, error: '未知工具: ' + name });
  } catch (err) {
    return JSON.stringify({ ok: false, error: err.message || String(err) });
  }
}

// fix list_dir to use project root + relative properly
async function executeToolFixed(name, args, ctx) {
  if (name === 'list_dir') {
    const { project } = ctx;
    const rel = (args.path || '.').replace(/^\/+/, '') || '.';
    try {
      const abs = rel === '.' ? project.path : path.join(project.path, rel);
      // ensure inside project
      const rootResolved = path.resolve(project.path);
      const absResolved = path.resolve(abs);
      if (!absResolved.startsWith(rootResolved)) {
        return JSON.stringify({ ok: false, error: '路径越界' });
      }
      const t = listTree(absResolved, {
        maxDepth: Number(args.maxDepth) || 6,
        maxEntries: 3000,
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
 */
function assertNotAborted(signal) {
  if (signal?.aborted) {
    const e = new Error('已停止');
    e.code = 'ABORTED';
    throw e;
  }
}

async function runAgentLoop({
  project,
  settings,
  messages,
  confirmTerminal,
  fetchFn,
  signal,
}) {
  if (!project?.path) {
    throw new Error('Agent 需要绑定真实项目目录');
  }

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

  for (let turn = 1; unlimited || turn <= maxTurns; turn++) {
    assertNotAborted(signal);
    let msg;
    try {
      msg = await chatCompletionMessage({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        messages: working,
        tools: toolsSupported ? tools : undefined,
        tool_choice: toolsSupported ? 'auto' : undefined,
        fetchFn,
        signal,
      });
    } catch (err) {
      if (err?.code === 'ABORTED' || err?.name === 'AbortError' || signal?.aborted) {
        const e = new Error('已停止');
        e.code = 'ABORTED';
        throw e;
      }
      // Some gateways reject tools — retry once without tools
      if (toolsSupported && /tools|tool_choice|unsupported|400/i.test(String(err.message))) {
        toolsSupported = false;
        msg = await chatCompletionMessage({
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model: settings.model,
          messages: [
            ...working,
            {
              role: 'system',
              content: '当前 API 不支持 tools。请用文本协议调用工具：\n```tool list_dir\n{"path":"."}\n```\n可用: list_dir, read_file, write_file, delete_path, run_terminal',
            },
          ],
          fetchFn,
          signal,
        });
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
        const resultStr = await executeToolFixed(name, args, {
          project,
          settings,
          confirmTerminal,
          signal,
        });

        let parsed;
        try { parsed = JSON.parse(resultStr); } catch { parsed = { raw: resultStr }; }

        agentLog.push({
          turn,
          tool: name,
          args,
          ok: parsed.ok !== false,
          summary: parsed.error
            ? parsed.error
            : (name === 'list_dir'
              ? `count=${parsed.count}`
              : name === 'write_file'
                ? `wrote ${parsed.path} (${parsed.bytes}b)`
                : name === 'run_terminal'
                  ? `exit=${parsed.code}`
                  : 'ok'),
        });

        if (name === 'write_file' && parsed.ok) {
          applied.push({ path: parsed.path, ok: true, bytes: parsed.bytes });
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
      }
      continue;
    }

    // Final natural language answer
    let content = msg.content || '';
    // also honor write fences in final answer
    const fence = applyWriteFences(project.path, content);
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
};
