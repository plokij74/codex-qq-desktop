'use strict';

const path = require('path');
const { spawn: defaultSpawn } = require('child_process');
const {
  discoverSkills,
  loadSkillBody,
  matchSkillsByTriggers,
  resolveSkillCwd,
} = require('../skills-loader');

const OUT_MAX = 16 * 1024;
const STDIN_MAX = 8 * 1024;

/**
 * @param {Array} messages
 * @returns {string}
 */
function extractLastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'user') {
      return String(m.content || '').slice(0, 8 * 1024);
    }
  }
  return '';
}

/**
 * @param {object} meta
 * @param {string} projectPath
 * @param {{ args?: string[], signal?: AbortSignal, spawnFn?: Function }} opts
 * @returns {Promise<object>}
 */
function runSkillProcess(meta, projectPath, opts = {}) {
  const command = meta && meta.command ? String(meta.command).trim() : '';
  if (!command) {
    return Promise.resolve({ ok: false, error: '该 skill 无 command，不可执行' });
  }

  let cwd;
  try {
    cwd = resolveSkillCwd(meta, projectPath);
  } catch (err) {
    return Promise.resolve({
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }

  const skillArgs = Array.isArray(opts.args)
    ? opts.args.map(String)
    : (Array.isArray(meta.skillArgs) ? meta.skillArgs.map(String) : []);
  const timeoutMs = Number(meta.timeoutMs) > 0 ? Number(meta.timeoutMs) : 30000;
  const spawnFn = typeof opts.spawnFn === 'function' ? opts.spawnFn : defaultSpawn;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command, skillArgs, {
        cwd,
        env: {
          ...process.env,
          CODEX_QQ_SKILL: String(meta.name || ''),
        },
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        ok: false,
        error: err && err.message ? err.message : String(err),
        command,
        cwd,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let killed = false;
    let aborted = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (opts.signal) {
        try {
          opts.signal.removeEventListener('abort', onAbort);
        } catch { /* ignore */ }
      }
      resolve(result);
    };

    const onAbort = () => {
      aborted = true;
      killed = true;
      try {
        child.kill();
      } catch { /* ignore */ }
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill();
      } catch { /* ignore */ }
    }, timeoutMs);

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (d) => {
        stdout += d.toString('utf8');
        if (stdout.length > OUT_MAX * 2) stdout = stdout.slice(0, OUT_MAX * 2);
      });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (d) => {
        stderr += d.toString('utf8');
        if (stderr.length > OUT_MAX * 2) stderr = stderr.slice(0, OUT_MAX * 2);
      });
    }

    // optional stdin payload
    if (child.stdin && typeof child.stdin.write === 'function') {
      try {
        const payload = JSON.stringify({
          skill: meta.name,
          projectPath,
          args: skillArgs,
        }).slice(0, STDIN_MAX);
        child.stdin.write(payload);
        if (typeof child.stdin.end === 'function') child.stdin.end();
      } catch { /* ignore */ }
    }

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        code: -1,
        stdout: stdout.slice(0, OUT_MAX),
        stderr: (stderr + '\n' + (err && err.message ? err.message : String(err))).slice(0, OUT_MAX),
        cwd,
        command,
        timedOut: false,
        aborted,
        error: err && err.message ? err.message : String(err),
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (aborted) {
        const err = new Error('已停止');
        err.code = 'ABORTED';
        finish({
          ok: false,
          code: -1,
          stdout: stdout.slice(0, OUT_MAX),
          stderr: stderr.slice(0, OUT_MAX),
          cwd,
          command,
          timedOut: false,
          aborted: true,
          error: '已停止',
          abortCode: 'ABORTED',
        });
        return;
      }
      const timedOut = killed && !aborted;
      const ok = !killed && !aborted && code === 0;
      finish({
        ok,
        code: (killed || aborted) ? -1 : code,
        stdout: stdout.slice(0, OUT_MAX),
        stderr: stderr.slice(0, OUT_MAX),
        cwd,
        command,
        timedOut,
        aborted,
        error: ok ? undefined : (timedOut ? '执行超时' : (code !== 0 ? `exit ${code}` : 'spawn failed')),
      });
    });
  });
}

/**
 * Skills ToolProvider: list_skills / use_skill / run_skill + system catalog fragment.
 * @param {{ bundledDir?: string, userDataPath?: string, spawnFn?: Function }} [opts]
 */
function createSkillsProvider(opts = {}) {
  const bundledDir = opts.bundledDir || path.join(__dirname, '..', '..', 'skills');
  const spawnFn = opts.spawnFn;

  function ensureCatalog(ctx) {
    if (ctx.extensions?.skillCatalog) return ctx.extensions.skillCatalog;
    if (!ctx.extensions) ctx.extensions = {};
    const catalog = discoverSkills({
      projectPath: ctx.project?.path,
      userDataPath: ctx.extensions.userDataPath || opts.userDataPath,
      bundledDir,
    });
    ctx.extensions.skillCatalog = catalog;
    return catalog;
  }

  function resolveUserText(ctx) {
    if (ctx.extensions?.userPromptText) {
      return String(ctx.extensions.userPromptText);
    }
    return extractLastUserText(ctx.messages);
  }

  return {
    id: 'skills',
    isEnabled(ctx) {
      if (ctx.settings?.skillsEnabled === false) return false;
      if (Number(ctx.subagentDepth) >= 1) return false;
      return true;
    },
    getTools() {
      return [
        {
          type: 'function',
          function: {
            name: 'list_skills',
            description: 'List available Skills (name, description, source, runnable, triggers)',
            parameters: { type: 'object', properties: {} },
          },
        },
        {
          type: 'function',
          function: {
            name: 'use_skill',
            description: 'Load full Skill body by name',
            parameters: {
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'run_skill',
            description: 'Run an executable Skill (frontmatter command) via spawn shell:false',
            parameters: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                args: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional args override',
                },
              },
              required: ['name'],
            },
          },
        },
      ];
    },
    async execute(name, args, ctx) {
      const catalog = ensureCatalog(ctx);
      if (name === 'list_skills') {
        return JSON.stringify({
          ok: true,
          skills: catalog.map((s) => ({
            name: s.name,
            description: s.description,
            source: s.source,
            runnable: !!(s.command && String(s.command).trim()),
            triggers: Array.isArray(s.triggers) ? s.triggers.slice(0, 10) : [],
          })),
        });
      }
      if (name === 'use_skill') {
        const key = String(args?.name || '').trim().toLowerCase();
        const meta = catalog.find((s) => s.name === key);
        if (!meta) {
          return JSON.stringify({ ok: false, error: '未找到 skill: ' + key });
        }
        const body = loadSkillBody(meta);
        return JSON.stringify(body);
      }
      if (name === 'run_skill') {
        const key = String(args?.name || '').trim().toLowerCase();
        const meta = catalog.find((s) => s.name === key);
        if (!meta) {
          return JSON.stringify({ ok: false, error: '未找到 skill: ' + key });
        }
        if (!meta.command || !String(meta.command).trim()) {
          return JSON.stringify({ ok: false, error: '该 skill 无 command，不可执行' });
        }
        const projectPath = ctx.project?.path;
        if (!projectPath) {
          return JSON.stringify({ ok: false, error: '需要绑定项目目录' });
        }
        const overrideArgs = Array.isArray(args?.args) ? args.args.map(String) : undefined;
        const result = await runSkillProcess(meta, projectPath, {
          args: overrideArgs,
          signal: ctx.signal,
          spawnFn,
        });
        if (result.abortCode === 'ABORTED' || result.aborted) {
          const err = new Error('已停止');
          err.code = 'ABORTED';
          throw err;
        }
        return JSON.stringify(result);
      }
      return JSON.stringify({ ok: false, error: '未知工具: ' + name });
    },
    getSystemFragment(ctx) {
      const catalog = ensureCatalog(ctx);
      if (!catalog.length) return null;
      const lines = catalog.map((s) => {
        const desc = String(s.description || '').slice(0, 80);
        const runTag = s.command ? ' [runnable]' : '';
        return `- ${s.name}: ${desc} (${s.source})${runTag}`;
      });
      const parts = [
        '【可用 Skills】需要时用 list_skills / use_skill 加载全文；可执行技能用 run_skill，勿编造技能内容。',
        ...lines,
      ];

      const userText = resolveUserText(ctx);
      const matched = matchSkillsByTriggers(catalog, userText);
      if (matched.length) {
        parts.push(
          '【Skills 自动匹配】下列技能与当前用户消息相关，请优先 use_skill 加载全文后再执行；可执行技能用 run_skill，勿臆造步骤。',
        );
        for (const s of matched) {
          const triggers = Array.isArray(s.triggers) ? s.triggers.slice(0, 5).join(', ') : '';
          parts.push(
            `- ${s.name}: ${String(s.description || '').slice(0, 80)} (triggers: ${triggers})`,
          );
        }
      }
      return parts.join('\n');
    },
  };
}

module.exports = {
  createSkillsProvider,
  extractLastUserText,
  runSkillProcess,
};
