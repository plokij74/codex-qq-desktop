'use strict';

const fs = require('fs');
const path = require('path');

const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionStart',
  'UserPromptSubmit',
];

const DEFAULT_TIMEOUT = 15000;
const MIN_TIMEOUT = 1000;
const MAX_TIMEOUT = 120000;

function matchOne(pattern, toolName) {
  const p = String(pattern || '').trim();
  const name = String(toolName || '');
  if (!p || p === '*') return true;
  if (p.endsWith('*') && p.indexOf('*') === p.length - 1) {
    const prefix = p.slice(0, -1);
    return name.startsWith(prefix);
  }
  if (p.includes('*')) return false; // only trailing * supported
  return p === name;
}

function matchTool(matcher, toolName) {
  const raw = String(matcher == null ? '*' : matcher).trim() || '*';
  const parts = raw.split('|').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return true;
  return parts.some((part) => matchOne(part, toolName));
}

function emptyRulesByEvent() {
  const o = {};
  for (const e of HOOK_EVENTS) o[e] = [];
  return o;
}

function emptyCounts() {
  const o = {};
  for (const e of HOOK_EVENTS) o[e] = 0;
  return o;
}

function clampTimeout(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return DEFAULT_TIMEOUT;
  return Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, Math.floor(x)));
}

function normalizeRule(raw, source, errors, event) {
  const label = event ? `${source}:${event}` : source;
  if (!raw || typeof raw !== 'object') {
    errors.push(`${label}: invalid rule`);
    return null;
  }
  const command = String(raw.command || '').trim();
  if (!command) {
    errors.push(`${label}: rule missing command`);
    return null;
  }
  const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  const matcher = raw.matcher == null ? '*' : String(raw.matcher);
  let cwd = raw.cwd == null ? 'project' : String(raw.cwd);
  if (cwd !== 'project' && cwd !== 'userData') {
    // allow relative path under project only (resolved later)
    if (path.isAbsolute(cwd)) {
      errors.push(`${label}: absolute cwd not allowed: ${cwd}`);
      return null;
    }
  }
  const rule = {
    matcher,
    command,
    args,
    timeoutMs: clampTimeout(raw.timeoutMs),
    cwd,
    source,
  };
  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    rule.env = { ...raw.env };
  }
  return rule;
}

function loadLayer(filePath, source, errors) {
  const byEvent = emptyRulesByEvent();
  if (!filePath || !fs.existsSync(filePath)) return byEvent;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    errors.push(`${source}: bad JSON (${err.message || err})`);
    return byEvent;
  }
  if (!parsed || typeof parsed !== 'object') {
    errors.push(`${source}: root must be object`);
    return byEvent;
  }
  if (parsed.version !== 1) {
    errors.push(`${source}: unsupported version ${parsed.version}`);
    return byEvent;
  }
  const hooks = parsed.hooks && typeof parsed.hooks === 'object' ? parsed.hooks : {};
  for (const event of HOOK_EVENTS) {
    const list = hooks[event];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const rule = normalizeRule(item, source, errors, event);
      if (rule) byEvent[event].push(rule);
    }
  }
  return byEvent;
}

function loadHooks({ userDataPath, projectPath } = {}) {
  const errors = [];
  const userPath = userDataPath ? path.join(userDataPath, 'hooks.json') : null;
  const projectHooksPath = projectPath
    ? path.join(projectPath, '.codex', 'hooks.json')
    : null;

  const userRules = userPath
    ? loadLayer(userPath, 'user', errors)
    : emptyRulesByEvent();
  const projectRules = projectHooksPath
    ? loadLayer(projectHooksPath, 'project', errors)
    : emptyRulesByEvent();

  const rulesByEvent = emptyRulesByEvent();
  const countsByEvent = emptyCounts();
  for (const event of HOOK_EVENTS) {
    rulesByEvent[event] = [
      ...userRules[event],
      ...projectRules[event],
    ];
    countsByEvent[event] = rulesByEvent[event].length;
  }

  return {
    userPath: userPath || '',
    projectPath: projectHooksPath,
    errors,
    countsByEvent,
    rulesByEvent,
  };
}

module.exports = {
  HOOK_EVENTS,
  matchTool,
  loadHooks,
  clampTimeout,
  DEFAULT_TIMEOUT,
};
