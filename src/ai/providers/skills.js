'use strict';

const path = require('path');
const { discoverSkills, loadSkillBody } = require('../skills-loader');

/**
 * Skills ToolProvider: list_skills / use_skill + system catalog fragment.
 * @param {{ bundledDir?: string, userDataPath?: string }} [opts]
 */
function createSkillsProvider(opts = {}) {
  const bundledDir = opts.bundledDir || path.join(__dirname, '..', '..', 'skills');

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
            description: 'List available Skills (name, description, source)',
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
      return JSON.stringify({ ok: false, error: '未知工具: ' + name });
    },
    getSystemFragment(ctx) {
      const catalog = ensureCatalog(ctx);
      if (!catalog.length) return null;
      const lines = catalog.map((s) => {
        const desc = String(s.description || '').slice(0, 80);
        return `- ${s.name}: ${desc} (${s.source})`;
      });
      return ['【可用 Skills】需要时用 list_skills / use_skill 加载全文，勿编造技能内容。', ...lines].join('\n');
    },
  };
}

module.exports = { createSkillsProvider };
