const fs = require('fs');
const path = require('path');
const {
  listTree,
  readFile,
  writeFile,
  deletePath,
  searchReplace,
  previewSearchReplace,
  parseWriteFences,
  resolveSafe,
} = require('./project-fs');
const { runTerminal } = require('./terminal');
const { chatCompletionMessage } = require('./openai-compatible');
const { grepFiles, globFiles } = require('./search');
const { loadProjectInstructions } = require('./project-instructions');
const { loadGitignoreRules } = require('./gitignore');
const { riskForTool } = require('./permission');
const { AGENT_EVENTS } = require('./agent-events');
const { computeUnifiedDiff, truncateDiff } = require('./diff');
const { gitStatus, gitDiff, gitCommit } = require('./git');
const {
  normalizeAgentMode,
  filterToolsForMode,
  makePlanId,
  truncatePlanMarkdown,
} = require('./agent-mode');
const { resolveVerifyCommand } = require('./verify');
const { createDefaultRegistry: buildDefaultRegistry } = require('./providers');
const { loadHooks } = require('./hooks-loader');
const { createHooksRunner } = require('./hooks-runner');

const MUTATING_TOOLS = new Set(['search_replace', 'write_file', 'delete_path']);

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
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show git working tree status (branch + changed files).',
      parameters: { type: 'object', properties: { short: { type: 'boolean' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show git diff for worktree or staged changes. Optional path filter.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          staged: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description: 'Stage optional paths and create a git commit. Does not push. Does not git add -A unless paths listed.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          stage: { type: 'boolean' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_plan',
      description:
        'Submit a structured implementation plan for user approval. Plan mode only. Does not write files. Call when research is done.',
      parameters: {
        type: 'object',
        properties: {
          markdown: {
            type: 'string',
            description: 'Full plan body in markdown (required, min ~10 chars)',
          },
          title: { type: 'string', description: 'Short plan title' },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional ordered step list for UI',
          },
        },
        required: ['markdown'],
      },
    },
  },
];

const TOOL_NAMES = TOOL_DEFS.map((t) => t.function.name).join(', ');

/**
 * @param {object} project
 * @param {object} settings
 * @param {{ agentMode?: string, verifyCmd?: string|null, subagentDepth?: number, exploreReadonly?: boolean }} [opts]
 */
function agentSystemPrompt(project, settings, opts = {}) {
  const depth = Number(opts.subagentDepth) || 0;
  const exploreReadonly = !!opts.exploreReadonly || depth >= 1;
  const mode = normalizeAgentMode(opts.agentMode);

  // Nested explore sub-agent: short readonly research prompt only.
  if (depth >= 1 || exploreReadonly) {
    const parts = [
      '你是只读调研子 Agent（explore）。只能使用 list_dir / read_file / grep / glob / git_status / git_diff。',
      '禁止写文件、删除、终端、git_commit、submit_plan、spawn_explore、skills。',
      '围绕用户给出的 goal 做代码库调研，完成后用中文给出简洁结论（关键路径、发现、不确定点）。',
      '不要编造文件内容；先搜/读再总结。路径一律相对项目根。',
    ];
    if (project?.path) {
      parts.push(`当前工作项目：${project.name || path.basename(project.path)}`);
      parts.push(`项目根目录（真实路径）: ${project.path}`);
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
      } catch (e) {
        parts.push(`目录树读取失败: ${e.message}`);
      }
    }
    return parts.join('\n');
  }

  const parts = [
    '你是 Codex 风格编程 Agent。你可以通过工具在本机真实项目上操作。',
    '工作流：需要信息时先 list_dir / glob / grep / read_file，再修改；优先 search_replace 做局部修改；新建或整文件重写用 write_file；提交用 git_status / git_diff / git_commit（不 push）；必要时 run_terminal 验证。',
    '规则：',
    '1. 路径一律相对项目根，禁止访问项目外',
    '2. 不要编造文件内容；先读/搜再改',
    '3. 局部编辑优先 search_replace（要求 old_string 默认唯一匹配）；不要用 write_file 整文件覆盖只改几行的情况',
    '4. git_commit 仅暂存给定 paths（或不带 paths 时只提交已暂存），不会 git add -A，不会 push',
    '5. 完成后用中文总结改动',
    '6. 若无需再调用工具，直接给出最终答复（不要空回复）',
    '7. 用户消息中的 `context:refs` 代码块是用户显式附加的文件内容（@ 引用展开），请优先依据其中内容作答',
    `终端工具: ${settings.terminalEnabled ? '已启用' : '未启用（不要调用 run_terminal）'}`,
  ];

  if (mode === 'plan') {
    parts.push('');
    parts.push('【当前为计划模式 plan】');
    parts.push('- 只能只读调研（list_dir / read_file / grep / glob / git_status / git_diff）');
    parts.push('- 禁止写文件、删除、终端、git_commit；不要声称已改文件');
    parts.push('- 调研完成后必须调用 submit_plan 提交结构化计划（含目标、步骤、涉及路径、风险、建议验证方式）');
    parts.push('- 用户批准前不要假设会执行；批准后会切入 agent 模式');
  } else if (opts.verifyCmd) {
    parts.push('');
    parts.push(`【验证】完成代码修改后应使用 run_terminal 执行约定验证命令：\`${opts.verifyCmd}\``);
    parts.push('若命令失败，根据输出修复或说明阻塞原因。');
  }

  if (settings?.subagentEnabled !== false && mode === 'agent') {
    parts.push('');
    parts.push('【子 Agent】复杂调研可用 spawn_explore(goal, maxTurns?) 派发只读 explore 子 Agent，会返回 summary；勿嵌套 spawn。');
  }

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

/**
 * Default ToolProvider registry (builtin + skills + explore + mcp).
 * Lazy deps avoid cycles: providers never require agent at load time.
 * runAgentLoop is a function declaration (hoisted) so it is safe here.
 */
function createDefaultRegistry() {
  return buildDefaultRegistry({
    getToolDefs: () => TOOL_DEFS,
    executeTool: executeToolFixed,
    runLoop: runAgentLoop,
  });
}

/**
 * Collect tools from registry then filter by agent mode.
 * @param {object} settings
 * @param {{
 *   agentMode?: string,
 *   subagentDepth?: number,
 *   exploreReadonly?: boolean,
 *   project?: object|null,
 *   extensions?: object,
 *   registry?: object,
 * }} [opts]
 * @returns {Promise<Array>}
 */
async function toolsForSettings(settings, opts = {}) {
  const agentMode = normalizeAgentMode(opts.agentMode);
  const registry = opts.registry || createDefaultRegistry();
  const ctx = {
    settings,
    agentMode,
    subagentDepth: Number(opts.subagentDepth) || 0,
    exploreReadonly: !!opts.exploreReadonly,
    project: opts.project || null,
    extensions: opts.extensions || {},
  };
  const tools = await registry.collectTools(ctx);
  return filterToolsForMode(tools, agentMode);
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
  if (name === 'git_status') return undefined;
  if (name === 'git_commit') {
    if (Array.isArray(args.paths) && args.paths.length) return args.paths[0];
    return undefined;
  }
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
    case 'git_status':
      return 'git status';
    case 'git_diff':
      return `git diff${args.staged ? ' --staged' : ''}${args.path ? ` ${args.path}` : ''}`;
    case 'git_commit':
      return `git commit: ${String(args.message || '').slice(0, 80)}`;
    case 'submit_plan':
      return `提交计划${args.title ? `: ${String(args.title).slice(0, 60)}` : ''}`;
    case 'spawn_explore':
      return `子 Agent 调研: ${String(args.goal || '').slice(0, 80)}`;
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
  if (name === 'git_commit') {
    return [
      `message: ${args.message}`,
      args.paths?.length ? `paths: ${args.paths.join(', ')}` : 'paths: (已暂存 only)',
    ].join('\n');
  }
  if (name === 'submit_plan') {
    return [
      args.title ? `title: ${args.title}` : '',
      String(args.markdown || '').slice(0, 1500),
    ].filter(Boolean).join('\n').slice(0, 2000);
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
  if (name === 'git_status') return parsed.summary || 'status';
  if (name === 'git_diff') return parsed.truncated ? 'diff (truncated)' : 'diff';
  if (name === 'git_commit') return parsed.summary || parsed.commit || 'committed';
  if (name === 'submit_plan') return parsed.planId ? `plan ${parsed.planId}` : 'plan submitted';
  if (name === 'spawn_explore') {
    if (parsed.ok === false) return parsed.error || 'explore failed';
    return parsed.summary ? String(parsed.summary).slice(0, 120) : `turns=${parsed.turns ?? '?'}`;
  }
  return 'ok';
}

/**
 * Authorize via PermissionGate when present.
 * Legacy fallback: allow non-terminal; terminal uses confirmTerminal if required.
 * Forwards optional `diff` (unified diff payload) to gate.authorize.
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
  diff,
  agentMode,
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
      diff,
      agentMode,
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

/**
 * Build truncated unified-diff payload for permission UI (no disk write).
 * @returns {{ computed: object, diffPayload: object|null, detailForGate: string }}
 */
function buildDiffForAuthorize(rel, before, after, { isDirDelete = false } = {}) {
  if (isDirDelete) {
    return {
      computed: { path: rel, text: '', stats: { additions: 0, deletions: 0 }, isBinary: false },
      diffPayload: null,
      detailForGate: `递归删除目录: ${rel}`,
    };
  }
  const computed = computeUnifiedDiff(rel, before, after);
  if (computed.isBinary) {
    return {
      computed,
      diffPayload: {
        path: rel,
        stats: computed.stats,
        text: '',
        truncated: false,
        isBinary: true,
      },
      detailForGate: `二进制或无法生成 diff：${rel}`,
    };
  }
  const trunc = truncateDiff(computed.text);
  return {
    computed,
    diffPayload: {
      path: rel,
      stats: computed.stats,
      text: trunc.text,
      truncated: trunc.truncated,
      isBinary: false,
    },
    detailForGate: trunc.text || `删除: ${rel}`,
  };
}

/**
 * Preview mutating tool effects in memory (no write).
 * @returns {{ before: string, after: string, op: string, isDirDelete: boolean, previewMeta: object }}
 */
function previewMutatingTool(name, args, projectRoot, rel) {
  if (name === 'search_replace') {
    const prev = previewSearchReplace(projectRoot, rel, args.old_string, args.new_string, {
      replaceAll: args.replace_all === true || args.replaceAll === true,
    });
    return {
      before: prev.before,
      after: prev.after,
      op: 'write',
      isDirDelete: false,
      previewMeta: { replacements: prev.replacements },
    };
  }
  if (name === 'write_file') {
    let before = '';
    try {
      const full = resolveSafe(projectRoot, rel);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        before = fs.readFileSync(full, 'utf8');
      }
    } catch {
      before = '';
    }
    const after = String(args.content ?? '');
    return {
      before,
      after,
      op: before ? 'write' : 'create',
      isDirDelete: false,
      previewMeta: {},
    };
  }
  if (name === 'delete_path') {
    const full = resolveSafe(projectRoot, rel);
    if (!fs.existsSync(full)) {
      throw new Error(`不存在: ${rel}`);
    }
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      return {
        before: '',
        after: '',
        op: 'delete',
        isDirDelete: true,
        previewMeta: {},
      };
    }
    let before = '';
    try {
      before = fs.readFileSync(full, 'utf8');
    } catch {
      before = '';
    }
    return {
      before,
      after: '',
      op: 'delete',
      isDirDelete: false,
      previewMeta: {},
    };
  }
  throw new Error(`非变更工具: ${name}`);
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
      const termId = `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      ctx.onEvent?.({
        type: AGENT_EVENTS.TERMINAL_START,
        termId,
        command,
        cwd: root,
        source: 'agent',
      });
      // Always emit TERMINAL_END after START (blocked command / spawn throw / abort).
      let endPayload = {
        code: -1,
        ok: false,
        timedOut: false,
        aborted: false,
        summary: 'error',
      };
      try {
        const result = await runTerminal(root, command, {
          timeoutMs: settings.terminalTimeoutMs || 60000,
          signal: ctx.signal,
          onStdout: (chunk) => ctx.onEvent?.({
            type: AGENT_EVENTS.TERMINAL_OUTPUT,
            termId,
            stream: 'stdout',
            chunk: String(chunk),
          }),
          onStderr: (chunk) => ctx.onEvent?.({
            type: AGENT_EVENTS.TERMINAL_OUTPUT,
            termId,
            stream: 'stderr',
            chunk: String(chunk),
          }),
        });
        endPayload = {
          code: result.code,
          ok: result.ok,
          timedOut: result.timedOut,
          aborted: result.aborted,
          summary: `exit=${result.code}`,
        };
        return JSON.stringify(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const aborted = !!(err && (err.code === 'ABORTED' || err.name === 'AbortError'));
        endPayload = {
          code: -1,
          ok: false,
          timedOut: false,
          aborted,
          summary: msg,
        };
        return JSON.stringify({ ok: false, error: msg, aborted });
      } finally {
        ctx.onEvent?.({
          type: AGENT_EVENTS.TERMINAL_END,
          termId,
          ...endPayload,
        });
      }
    }
    if (name === 'git_status') {
      const result = await gitStatus(root, { signal: ctx.signal });
      return JSON.stringify(result);
    }
    if (name === 'git_diff') {
      const result = await gitDiff(root, {
        path: args.path,
        staged: args.staged === true,
        signal: ctx.signal,
      });
      return JSON.stringify(result);
    }
    if (name === 'git_commit') {
      const result = await gitCommit(root, {
        message: args.message,
        paths: args.paths,
        stage: args.stage,
        signal: ctx.signal,
      });
      return JSON.stringify(result);
    }
    if (name === 'submit_plan') {
      const rawMd = String(args.markdown ?? '');
      if (rawMd.trim().length < 10) {
        return JSON.stringify({
          ok: false,
          error: '计划 markdown 过短（至少约 10 个字符）',
        });
      }
      const { text: markdown, truncated } = truncatePlanMarkdown(rawMd);
      const title = args.title != null ? String(args.title).trim() : '';
      let steps = [];
      if (Array.isArray(args.steps)) {
        steps = args.steps.map((s) => String(s)).filter(Boolean).slice(0, 50);
      }
      const planId = makePlanId();
      ctx.onEvent?.({
        type: AGENT_EVENTS.PLAN_READY,
        planId,
        title: title || undefined,
        markdown,
        steps: steps.length ? steps : undefined,
        truncated: truncated || undefined,
      });
      return JSON.stringify({
        ok: true,
        planId,
        message: '计划已提交，等待用户批准执行',
        truncated: truncated || undefined,
      });
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
      const ignorePrefix = rel === '.' ? '' : rel.replace(/\\/g, '/').replace(/\/+$/, '');
      const t = listTree(absResolved, {
        maxDepth: Number(args.maxDepth) || 6,
        maxEntries: 3000,
        ignoreRules,
        ignorePrefix,
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
  fileChanges,
  agentMode,
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
    onEvent?.({ type: AGENT_EVENTS.TOOL_START, tool: 'write_fence', args: { path: op.path } });
    let auth;
    let endEmitted = false;
    try {
      let before = '';
      try {
        const full = resolveSafe(projectRoot, op.path);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          before = fs.readFileSync(full, 'utf8');
        }
      } catch {
        before = '';
      }
      const after = String(op.content ?? '');
      const fileOp = before ? 'write' : 'create';
      const { computed, diffPayload, detailForGate } = buildDiffForAuthorize(op.path, before, after);

      try {
        auth = await authorizeTool({
          gate,
          confirmTerminal,
          settings,
          name: 'write_file',
          risk,
          summary,
          detail: detailForGate,
          path: op.path,
          sessionKey,
          signal,
          diff: diffPayload,
          agentMode,
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
        if (fileChanges) {
          fileChanges.push({ path: r.path, op: fileOp, stats: computed.stats });
        }
        onEvent?.({
          type: AGENT_EVENTS.FILE_CHANGE,
          path: r.path,
          op: fileOp,
          stats: computed.stats,
        });
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
  agentMode,
  subagentDepth = 0,
  registry: registryOpt,
  extensions: extensionsOpt,
}) {
  if (!project?.path) {
    throw new Error('Agent 需要绑定真实项目目录');
  }

  const mode = normalizeAgentMode(agentMode);
  const depth = Number(subagentDepth) || 0;
  const effectiveGate = resolveGate({ gate });
  const chat = typeof chatFn === 'function' ? chatFn : chatCompletionMessage;
  const registry = registryOpt || createDefaultRegistry();
  const extensions = extensionsOpt || {};

  const rawTurns = Number(settings.maxAgentTurns);
  // 0 = unlimited; otherwise clamp 1..50 for safety when user sets a number
  const unlimited = rawTurns === 0;
  const maxTurns = unlimited ? Number.POSITIVE_INFINITY : Math.max(1, Math.min(50, rawTurns || 8));

  const verifyCmd = settings.verifyBeforeDone === false
    ? null
    : resolveVerifyCommand(project.path, settings);
  let verifyPrompted = false;
  let verifyRepairPrompted = false;
  let verifySucceeded = false;
  let verifyLastFailed = false;

  const runCtx = {
    project,
    settings,
    agentMode: mode,
    subagentDepth: depth,
    exploreReadonly: depth >= 1,
    gate: effectiveGate,
    onEvent,
    signal,
    sessionKey,
    extensions,
    registry,
  };

  const userDataPath = extensions.userDataPath || null;
  let hooksRunner = null;
  let stopReason = 'done';

  try {
    await registry.onRunStart(runCtx);

    if (depth === 0 && settings.hooksEnabled !== false && userDataPath) {
      const resolved = loadHooks({ userDataPath, projectPath: project.path });
      hooksRunner = createHooksRunner({
        hooks: resolved,
        projectPath: project.path,
        userDataPath,
        settings,
        sessionKey,
        agentMode: mode,
        subagentDepth: depth,
        onEvent,
        signal,
      });
      await hooksRunner.runLifecycle('SessionStart');
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      await hooksRunner.runLifecycle('UserPromptSubmit', {
        promptPreview: lastUser ? String(lastUser.content || '') : '',
      });
    }
    // stash on runCtx for tool path (Task 5)
    runCtx.hooksRunner = hooksRunner;

    try {
      const tools = await toolsForSettings(settings, {
        agentMode: mode,
        subagentDepth: depth,
        exploreReadonly: depth >= 1,
        project,
        extensions,
        registry,
      });
      const agentLog = [];
      const applied = [];
      /** @type {{ path: string, op: string, stats: { additions: number, deletions: number } }[]} */
      const fileChanges = [];

      let systemContent = agentSystemPrompt(project, settings, {
        agentMode: mode,
        verifyCmd,
        subagentDepth: depth,
        exploreReadonly: depth >= 1,
      });
      const fragments = await registry.systemFragments(runCtx);
      if (fragments && String(fragments).trim()) {
        systemContent = `${systemContent}\n\n${String(fragments).trim()}`;
      }

      /** @type {any[]} */
      let working = [
        {
          role: 'system',
          content: systemContent,
        },
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
          const relPath = toolPath(name, args);

          onEvent?.({ type: AGENT_EVENTS.TOOL_START, tool: name, args });

          let resultStr;
          let authAllowed = true;
          let authReason;
          let toolEndEmitted = false;
          let diffStats = null;
          let fileOp = null;
          let effectiveArgs = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
          let effectiveRelPath = relPath;
          const hookFlags = {
            deniedByGate: false,
            deniedByHook: false,
            skipped: false,
          };
          try {
            let detail = toolDetail(name, args);
            let diffPayload;

            // git_commit: enrich authorize detail with message + intended paths (stage runs after allow)
            if (name === 'git_commit') {
              detail = [
                `message: ${args.message}`,
                args.paths?.length ? `paths: ${args.paths.join(', ')}` : 'paths: (已暂存 only)',
              ].join('\n');
            }

            // Keep preview for integrity apply (search_replace must write preview.after, not re-run).
            // Note: between preview and write there is still a TOCTOU window if the file changes externally.
            let mutatePreview = null;

            if (MUTATING_TOOLS.has(name)) {
              // Preview before authorize so gate can show unified diff; write only if allowed.
              try {
                mutatePreview = previewMutatingTool(name, args, project.path, relPath || '');
                fileOp = mutatePreview.op;
                const built = buildDiffForAuthorize(relPath || '', mutatePreview.before, mutatePreview.after, {
                  isDirDelete: mutatePreview.isDirDelete,
                });
                diffStats = built.computed.stats;
                diffPayload = built.diffPayload;
                detail = built.detailForGate;
              } catch (err) {
                if (err?.code === 'ABORTED' || err?.name === 'AbortError' || signal?.aborted) {
                  const e = new Error('已停止');
                  e.code = 'ABORTED';
                  throw e;
                }
                // Preview failure (no match / non-unique / missing) → tool error, skip authorize
                resultStr = JSON.stringify({ ok: false, error: err.message || String(err) });
                authAllowed = false;
                authReason = err.message || String(err);
              }
            }

            /**
             * Apply search_replace via approved mutatePreview, else registry.execute.
             * Uses effectiveArgs / effectiveRelPath (may differ after Pre rewrite).
             */
            async function executeAllowedTool() {
              if (name === 'search_replace' && mutatePreview) {
                // Apply approved preview.after (do not re-run searchReplace / re-preview).
                try {
                  const w = writeFile(project.path, effectiveRelPath || '', mutatePreview.after);
                  const replacements = mutatePreview.previewMeta?.replacements ?? 1;
                  return JSON.stringify({
                    ok: true,
                    path: w.path,
                    replacements,
                    bytes: w.bytes,
                    mode: 'search_replace',
                  });
                } catch (err) {
                  return JSON.stringify({ ok: false, error: err.message || String(err) });
                }
              }
              return registry.execute(name, effectiveArgs, {
                ...runCtx,
                project,
                settings,
                signal,
                gate: effectiveGate,
                onEvent,
              });
            }

            async function authorizeOnce({
              authSummary,
              authDetail,
              authPath,
              authDiff,
            }) {
              try {
                const auth = await authorizeTool({
                  gate: effectiveGate,
                  confirmTerminal,
                  settings,
                  name,
                  risk,
                  summary: authSummary,
                  detail: authDetail,
                  path: authPath,
                  sessionKey,
                  signal,
                  diff: authDiff,
                  agentMode: mode,
                });
                return {
                  allowed: !!auth.allowed,
                  reason: auth.reason,
                };
              } catch (err) {
                if (err?.code === 'ABORTED' || err?.name === 'AbortError' || signal?.aborted) {
                  const e = new Error('已停止');
                  e.code = 'ABORTED';
                  throw e;
                }
                return {
                  allowed: false,
                  reason: err.message || String(err),
                };
              }
            }

            if (resultStr == null) {
              // Gate₁ — sole authorization before Pre; skip cannot bypass this.
              const gate1 = await authorizeOnce({
                authSummary: summary,
                authDetail: detail,
                authPath: relPath,
                authDiff: diffPayload,
              });
              authAllowed = gate1.allowed;
              authReason = gate1.reason;

              if (!authAllowed) {
                resultStr = JSON.stringify({ ok: false, error: authReason || '未授权' });
                hookFlags.deniedByGate = true;
              } else if (hooksRunner) {
                const pre = await hooksRunner.runPreToolUse({
                  name,
                  args: effectiveArgs,
                  risk,
                });
                if (pre.decision === 'deny') {
                  resultStr = JSON.stringify({
                    ok: false,
                    error: pre.reason || '钩子拒绝',
                  });
                  hookFlags.deniedByHook = true;
                  if (pre.args && typeof pre.args === 'object') {
                    effectiveArgs = pre.args;
                  }
                } else if (pre.decision === 'skip') {
                  resultStr =
                    pre.resultStr
                    || JSON.stringify({ ok: true, skipped: true, by: 'hook' });
                  hookFlags.skipped = true;
                  if (pre.args && typeof pre.args === 'object') {
                    effectiveArgs = pre.args;
                  }
                } else {
                  // allow (+ optional args rewrite → Gate₂)
                  if (pre.args && typeof pre.args === 'object') {
                    effectiveArgs = pre.args;
                  }
                  if (pre.argsChanged) {
                    effectiveRelPath = toolPath(name, effectiveArgs);
                    const g2Summary = toolSummary(name, effectiveArgs);
                    let g2Detail = toolDetail(name, effectiveArgs);
                    let g2DiffPayload;

                    if (name === 'git_commit') {
                      g2Detail = [
                        `message: ${effectiveArgs.message}`,
                        effectiveArgs.paths?.length
                          ? `paths: ${effectiveArgs.paths.join(', ')}`
                          : 'paths: (已暂存 only)',
                      ].join('\n');
                    }

                    // Discard stale mutate preview; recompute for mutating tools.
                    mutatePreview = null;
                    diffStats = null;
                    fileOp = null;

                    if (MUTATING_TOOLS.has(name)) {
                      try {
                        mutatePreview = previewMutatingTool(
                          name,
                          effectiveArgs,
                          project.path,
                          effectiveRelPath || ''
                        );
                        fileOp = mutatePreview.op;
                        const built = buildDiffForAuthorize(
                          effectiveRelPath || '',
                          mutatePreview.before,
                          mutatePreview.after,
                          { isDirDelete: mutatePreview.isDirDelete }
                        );
                        diffStats = built.computed.stats;
                        g2DiffPayload = built.diffPayload;
                        g2Detail = built.detailForGate;
                      } catch (err) {
                        if (err?.code === 'ABORTED' || err?.name === 'AbortError' || signal?.aborted) {
                          const e = new Error('已停止');
                          e.code = 'ABORTED';
                          throw e;
                        }
                        resultStr = JSON.stringify({
                          ok: false,
                          error: err.message || String(err),
                        });
                      }
                    }

                    if (resultStr == null) {
                      const gate2 = await authorizeOnce({
                        authSummary: g2Summary,
                        authDetail: g2Detail,
                        authPath: effectiveRelPath,
                        authDiff: g2DiffPayload,
                      });
                      if (!gate2.allowed) {
                        resultStr = JSON.stringify({
                          ok: false,
                          error: gate2.reason || '未授权',
                        });
                        hookFlags.deniedByGate = true;
                      }
                    }
                  }

                  if (resultStr == null) {
                    resultStr = await executeAllowedTool();
                  }
                }
              } else if (name === 'search_replace' && mutatePreview) {
                // No hooks: existing apply path.
                try {
                  const w = writeFile(project.path, relPath || '', mutatePreview.after);
                  const replacements = mutatePreview.previewMeta?.replacements ?? 1;
                  resultStr = JSON.stringify({
                    ok: true,
                    path: w.path,
                    replacements,
                    bytes: w.bytes,
                    mode: 'search_replace',
                  });
                } catch (err) {
                  resultStr = JSON.stringify({ ok: false, error: err.message || String(err) });
                }
              } else {
                resultStr = await registry.execute(name, args, {
                  ...runCtx,
                  project,
                  settings,
                  signal,
                  gate: effectiveGate,
                  onEvent,
                });
              }
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

            // skip must not update applied / fileChanges (hook short-circuit is not a real write).
            if (!hookFlags.skipped) {
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
            }

            // Track verify success when agent runs the exact verify command.
            // skip cannot count as verify success.
            if (!hookFlags.skipped && name === 'run_terminal' && verifyCmd) {
              const cmd = String((effectiveArgs.command != null ? effectiveArgs.command : args.command) || '').trim();
              if (cmd === verifyCmd) {
                const codeOk = parsed.code == null || Number(parsed.code) === 0;
                const termOk = parsed.ok !== false && codeOk && !parsed.aborted && !parsed.error;
                if (termOk) {
                  verifySucceeded = true;
                  verifyLastFailed = false;
                  onEvent?.({
                    type: AGENT_EVENTS.VERIFY_RESULT,
                    command: verifyCmd,
                    ok: true,
                    code: parsed.code != null ? Number(parsed.code) : 0,
                    summary: stepSummary,
                  });
                } else {
                  verifyLastFailed = true;
                  onEvent?.({
                    type: AGENT_EVENTS.VERIFY_RESULT,
                    command: verifyCmd,
                    ok: false,
                    code: parsed.code != null ? Number(parsed.code) : -1,
                    summary: stepSummary || parsed.error || '验证失败',
                  });
                }
              }
            }

            // FILE_CHANGE before TOOL_END so UI can show change strip with tool completion.
            if (!hookFlags.skipped && MUTATING_TOOLS.has(name) && parsed.ok && diffStats) {
              const changePath = parsed.path || effectiveRelPath || relPath;
              const changeOp = fileOp || (name === 'delete_path' ? 'delete' : 'write');
              fileChanges.push({ path: changePath, op: changeOp, stats: diffStats });
              onEvent?.({
                type: AGENT_EVENTS.FILE_CHANGE,
                path: changePath,
                op: changeOp,
                stats: diffStats,
              });
            }

            // Post always when runner present (including Gate deny / Pre deny / skip / execute).
            if (hooksRunner) {
              try {
                await hooksRunner.runPostToolUse({
                  name,
                  args: effectiveArgs,
                  risk,
                  result: parsed,
                  flags: hookFlags,
                });
              } catch (err) {
                // Post must not break tool path; ABORT still propagates if signal aborted mid-post.
                if (err?.code === 'ABORTED' || err?.name === 'AbortError' || signal?.aborted) {
                  const e = new Error('已停止');
                  e.code = 'ABORTED';
                  throw e;
                }
              }
            }

            onEvent?.({
              type: AGENT_EVENTS.TOOL_END,
              tool: name,
              ok,
              summary: stepSummary,
            });
            toolEndEmitted = true;

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

      // Final natural language answer (maybe soft-verify first)
      let content = msg.content || '';
      // write fences: preview diff → authorize → write only if allowed
      // Pass agentMode so plan mode cannot land fence writes.
      const fence = await applyWriteFencesWithGate(project.path, content, {
        gate: effectiveGate,
        confirmTerminal,
        settings,
        sessionKey,
        signal,
        onEvent,
        fileChanges,
        agentMode: mode,
      });
      if (fence.applied.length) {
        applied.push(...fence.applied);
        content = fence.displayContent;
      }

      const hadSuccessfulWrite = applied.some((a) => a && a.ok && !a.error)
        || fileChanges.length > 0;

      // Soft verify gate (agent only; never blocks done permanently)
      if (
        mode === 'agent'
        && verifyCmd
        && settings.verifyBeforeDone !== false
        && hadSuccessfulWrite
        && settings.terminalEnabled
        && !verifySucceeded
        && (unlimited || turn < maxTurns)
      ) {
        if (!verifyPrompted) {
          verifyPrompted = true;
          working.push({ role: 'assistant', content: content || '(完成修改)' });
          working.push({
            role: 'user',
            content:
              `请立即使用 run_terminal 执行项目验证命令（不要改命令）：\n${verifyCmd}\n根据输出修复问题或总结结果。`,
          });
          continue;
        }
        if (!verifyRepairPrompted && verifyLastFailed) {
          verifyRepairPrompted = true;
          working.push({ role: 'assistant', content: content || '(验证未通过)' });
          working.push({
            role: 'user',
            content:
              `验证命令未通过。请根据失败输出尽量修复，并再次 run_terminal：\n${verifyCmd}\n若无法修复请说明原因。`,
          });
          continue;
        }
        // Allow done with incomplete verify
        onEvent?.({
          type: AGENT_EVENTS.VERIFY_RESULT,
          command: verifyCmd,
          ok: false,
          skipped: true,
          summary: '未完成验证',
        });
      } else if (
        mode === 'agent'
        && hadSuccessfulWrite
        && settings.verifyBeforeDone !== false
        && !settings.terminalEnabled
        && verifyCmd
        && !verifySucceeded
      ) {
        onEvent?.({
          type: AGENT_EVENTS.VERIFY_RESULT,
          command: verifyCmd,
          ok: false,
          skipped: true,
          summary: '终端未启用，跳过验证',
        });
      } else if (
        mode === 'agent'
        && hadSuccessfulWrite
        && verifySucceeded
      ) {
        // already emitted VERIFY_RESULT ok on tool end
      }

      content = appendAgentFooter(content, agentLog, applied, unlimited ? '∞' : turn);
      return {
        content,
        applied,
        agentLog,
        turns: turn,
        toolsSupported,
        fileChanges,
        agentMode: mode,
      };
    }

    // Only reached when a finite maxTurns was set
    const content = appendAgentFooter(
      `已达到最大 Agent 轮数（${maxTurns}）。请根据工具日志继续说明需求，发送新消息可继续。`,
      agentLog,
      applied,
      maxTurns
    );
    return { content, applied, agentLog, turns: maxTurns, toolsSupported, fileChanges };
    } catch (err) {
      stopReason = (err && err.code === 'ABORTED') || signal?.aborted ? 'aborted' : 'error';
      throw err;
    }
  } finally {
    try {
      if (hooksRunner) {
        const reason = signal?.aborted ? 'aborted' : stopReason;
        await hooksRunner.runLifecycle('Stop', { reason });
      }
    } catch {
      /* never throw from Stop */
    }
    await registry.onRunEnd(runCtx);
  }
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
  createDefaultRegistry,
  assertNotAborted,
  riskForTool,
  authorizeTool,
  applyWriteFencesWithGate,
};
