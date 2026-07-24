const fs = require('fs');
const path = require('path');

const SKILL_BODY_MAX = 24 * 1024;
const SKILL_MAX_COUNT = 50;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DESC_FALLBACK_MAX = 120;
const TRIGGER_MATCH_MAX = 5;
const TRIGGER_COUNT_MAX = 20;
const TRIGGER_LEN_MAX = 64;
const TIMEOUT_DEFAULT = 30000;
const TIMEOUT_MIN = 1000;
const TIMEOUT_MAX = 120000;

/**
 * @param {unknown} name
 * @returns {string|null}
 */
function sanitizeSkillName(name) {
  const s = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!s || !NAME_RE.test(s)) return null;
  return s;
}

/**
 * Parse simple leading frontmatter (no YAML library).
 * Only between first pair of leading `---` lines; `key: value` with optional quotes.
 * @param {string} text
 * @returns {{ attrs: Record<string, string>, body: string }}
 */
function parseFrontmatter(text) {
  const src = String(text || '');
  const lines = src.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { attrs: {}, body: src };
  }

  const attrs = {};
  let i = 1;
  let closed = false;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '---') {
      closed = true;
      i += 1;
      break;
    }
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    attrs[m[1]] = val;
  }

  if (!closed) {
    return { attrs: {}, body: src };
  }

  // Drop a single leading blank line after closing ---
  if (i < lines.length && lines[i] === '') i += 1;
  const body = lines.slice(i).join('\n');
  return { attrs, body };
}

/**
 * First non-empty line of body, truncated.
 * @param {string} body
 * @returns {string}
 */
function descriptionFromBody(body) {
  const lines = String(body || '').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (t) return t.slice(0, DESC_FALLBACK_MAX);
  }
  return '';
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseTriggers(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,，]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, TRIGGER_COUNT_MAX)
    .map((s) => s.slice(0, TRIGGER_LEN_MAX));
}

/**
 * JSON array string only.
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseArgsField(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  if (s.startsWith('[')) {
    try {
      const a = JSON.parse(s);
      return Array.isArray(a) ? a.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
function parseTimeoutMs(raw) {
  if (raw == null || raw === '') return TIMEOUT_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return TIMEOUT_DEFAULT;
  return Math.max(TIMEOUT_MIN, Math.min(TIMEOUT_MAX, Math.floor(n)));
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function parseCwdKind(raw) {
  if (raw == null || raw === '') return 'project';
  const s = String(raw).trim();
  if (!s) return 'project';
  if (s === 'project' || s === 'skill') return s;
  return s; // relative path under project
}

/**
 * Case-insensitive substring match; catalog order; max 5.
 * @param {Array<{ name?: string, triggers?: string[] }>} catalog
 * @param {string} userText
 * @returns {Array}
 */
function matchSkillsByTriggers(catalog, userText) {
  const text = String(userText || '').slice(0, 8 * 1024).toLowerCase();
  if (!text || !Array.isArray(catalog)) return [];
  const out = [];
  for (const skill of catalog) {
    const triggers = Array.isArray(skill?.triggers) ? skill.triggers : [];
    if (!triggers.length) continue;
    const hit = triggers.some((t) => {
      const key = String(t || '').toLowerCase();
      return key && text.includes(key);
    });
    if (hit) {
      out.push(skill);
      if (out.length >= TRIGGER_MATCH_MAX) break;
    }
  }
  return out;
}

/**
 * Resolve skill process cwd.
 * cwdKind: project | skill | relative-under-project
 * @param {{ cwdKind?: string, dir?: string }} meta
 * @param {string} projectPath
 * @returns {string}
 */
function resolveSkillCwd(meta, projectPath) {
  const kind = (meta && meta.cwdKind) || 'project';
  if (kind === 'skill') {
    if (!meta.dir) throw new Error('skill 目录缺失');
    return meta.dir;
  }
  if (kind === 'project' || !kind) {
    return path.resolve(projectPath);
  }
  // relative under project
  const root = path.resolve(projectPath);
  const resolved = path.resolve(root, kind);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('cwd 越界');
  }
  return resolved;
}

/**
 * Scan one skills root: immediate subdirs that contain SKILL.md.
 * @param {string} rootDir
 * @param {'project'|'user'|'bundled'} source
 * @returns {Array}
 */
function scanSkillRoot(rootDir, source) {
  const out = [];
  if (!rootDir) return out;
  let entries;
  try {
    if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) return out;
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(rootDir, ent.name);
    const skillPath = path.join(dir, 'SKILL.md');
    let raw;
    try {
      if (!fs.existsSync(skillPath) || !fs.statSync(skillPath).isFile()) continue;
      raw = fs.readFileSync(skillPath, 'utf8');
    } catch {
      continue;
    }

    const { attrs, body } = parseFrontmatter(raw);
    const name = sanitizeSkillName(attrs.name || ent.name);
    if (!name) continue;

    let description = attrs.description != null ? String(attrs.description).trim() : '';
    if (!description) description = descriptionFromBody(body);

    const triggers = parseTriggers(attrs.triggers);
    const command = attrs.command != null ? String(attrs.command).trim() : '';
    const skillArgs = parseArgsField(attrs.args);
    const timeoutMs = parseTimeoutMs(attrs.timeoutMs);
    const cwdKind = parseCwdKind(attrs.cwd);

    out.push({
      name,
      description,
      source,
      dir,
      skillPath,
      triggers,
      command: command || undefined,
      skillArgs,
      timeoutMs,
      cwdKind,
    });
  }
  return out;
}

/**
 * Discover skills from three roots. Priority: project > user > bundled
 * (merge inserts bundled → user → project so later overwrites).
 * Cap at SKILL_MAX_COUNT by final map insertion order.
 * @param {{ projectPath?: string, userDataPath?: string, bundledDir?: string }} opts
 * @returns {Array<{ name: string, description: string, source: string, dir: string, skillPath: string }>}
 */
function discoverSkills(opts = {}) {
  const projectPath = opts.projectPath || '';
  const userDataPath = opts.userDataPath || '';
  const bundledDir = opts.bundledDir || '';

  const projectSkillsDir = projectPath
    ? path.join(projectPath, '.codex', 'skills')
    : '';
  const userSkillsDir = userDataPath ? path.join(userDataPath, 'skills') : '';

  /** @type {Map<string, { name: string, description: string, source: string, dir: string, skillPath: string }>} */
  const map = new Map();

  // Later overwrites earlier: bundled → user → project
  for (const skill of scanSkillRoot(bundledDir, 'bundled')) {
    map.set(skill.name, skill);
  }
  for (const skill of scanSkillRoot(userSkillsDir, 'user')) {
    map.set(skill.name, skill);
  }
  for (const skill of scanSkillRoot(projectSkillsDir, 'project')) {
    map.set(skill.name, skill);
  }

  return Array.from(map.values()).slice(0, SKILL_MAX_COUNT);
}

/**
 * Load and optionally truncate skill body from meta.
 * @param {{ name: string, description?: string, source?: string, dir?: string, skillPath: string }} meta
 * @returns {{ ok: boolean, name?: string, description?: string, body?: string, source?: string, truncated?: boolean, error?: string }}
 */
function loadSkillBody(meta) {
  if (!meta || !meta.skillPath) {
    return { ok: false, error: 'missing skillPath' };
  }
  let raw;
  try {
    raw = fs.readFileSync(meta.skillPath, 'utf8');
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }

  const { attrs, body: parsedBody } = parseFrontmatter(raw);
  const name = sanitizeSkillName(attrs.name || meta.name) || meta.name || null;
  if (!name) {
    return { ok: false, error: 'invalid skill name' };
  }

  let description =
    attrs.description != null && String(attrs.description).trim()
      ? String(attrs.description).trim()
      : (meta.description || descriptionFromBody(parsedBody));

  let body = parsedBody;
  let truncated = false;
  if (body.length > SKILL_BODY_MAX) {
    body = body.slice(0, SKILL_BODY_MAX);
    truncated = true;
  }

  return {
    ok: true,
    name,
    description,
    body,
    source: meta.source || 'project',
    truncated,
  };
}

module.exports = {
  SKILL_BODY_MAX,
  SKILL_MAX_COUNT,
  parseFrontmatter,
  sanitizeSkillName,
  parseTriggers,
  parseArgsField,
  parseTimeoutMs,
  parseCwdKind,
  matchSkillsByTriggers,
  resolveSkillCwd,
  discoverSkills,
  loadSkillBody,
};
