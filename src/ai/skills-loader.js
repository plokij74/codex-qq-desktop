const fs = require('fs');
const path = require('path');

const SKILL_BODY_MAX = 24 * 1024;
const SKILL_MAX_COUNT = 50;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DESC_FALLBACK_MAX = 120;

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
 * Scan one skills root: immediate subdirs that contain SKILL.md.
 * @param {string} rootDir
 * @param {'project'|'user'|'bundled'} source
 * @returns {Array<{ name: string, description: string, source: string, dir: string, skillPath: string }>}
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

    out.push({
      name,
      description,
      source,
      dir,
      skillPath,
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
  discoverSkills,
  loadSkillBody,
};
