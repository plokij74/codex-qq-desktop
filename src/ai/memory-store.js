'use strict';

/**
 * Phase D.2 — two-layer long-term memory store.
 *
 * Project memory lives in `<project>/.codex/memory.jsonl`, user memory in
 * `<userData>/memory.jsonl`. JSONL (not JSON) so appends from two windows do
 * not clobber each other and one corrupt line never costs the whole store.
 */

const fs = require('fs');
const path = require('path');
const { resolveSafe } = require('./project-fs');

const TEXT_MAX = 1000;
const TAG_MAX = 24;
const TAGS_MAX = 8;

/** Fold whitespace + case so dedupe survives reformatting. */
function normalizeText(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function nextId() {
  return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function normalizeTags(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    const s = String(t || '').trim().toLowerCase().slice(0, TAG_MAX);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= TAGS_MAX) break;
  }
  return out;
}

/**
 * Project memory lives beside hooks.json / skills under .codex; user memory
 * sits next to settings.json. resolveSafe keeps the project path in-sandbox.
 * @param {{ scope?: string, projectPath?: string, userDataPath?: string }} opts
 * @returns {string} absolute path of the JSONL file
 */
function memoryFilePath({ scope, projectPath, userDataPath } = {}) {
  if (scope === 'user') {
    if (!userDataPath) throw new Error('缺少 userDataPath');
    return path.join(userDataPath, 'memory.jsonl');
  }
  if (!projectPath) throw new Error('缺少 projectPath');
  return path.join(resolveSafe(projectPath, '.codex'), 'memory.jsonl');
}

/**
 * One bad line never costs the whole store — that is why this is JSONL.
 * @param {string} file
 * @param {'project'|'user'} scope stamped onto every entry
 * @returns {{ entries: any[], skipped: number }}
 */
function readEntries(file, scope) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { entries: [], skipped: 0 };
  }
  const entries = [];
  let skipped = 0;
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const o = JSON.parse(trimmed);
      if (!o || typeof o.text !== 'string' || !o.text.trim()) {
        skipped++;
        continue;
      }
      entries.push({
        id: String(o.id || ''),
        text: o.text,
        tags: Array.isArray(o.tags) ? o.tags.map((t) => String(t)) : [],
        createdAt: Number(o.createdAt) || 0,
        source: o.source === 'slash' ? 'slash' : 'tool',
        scope,
      });
    } catch {
      skipped++;
    }
  }
  return { entries, skipped };
}

/**
 * Merge both layers. A missing project binding is normal (no project open).
 * @param {{ projectPath?: string, userDataPath?: string }} opts
 * @returns {{ entries: any[], skipped: number, counts: { project: number, user: number } }}
 */
function readAll({ projectPath, userDataPath } = {}) {
  const entries = [];
  let skipped = 0;
  const counts = { project: 0, user: 0 };
  if (projectPath) {
    const r = readEntries(memoryFilePath({ scope: 'project', projectPath }), 'project');
    entries.push(...r.entries);
    skipped += r.skipped;
    counts.project = r.entries.length;
  }
  if (userDataPath) {
    const r = readEntries(memoryFilePath({ scope: 'user', userDataPath }), 'user');
    entries.push(...r.entries);
    skipped += r.skipped;
    counts.user = r.entries.length;
  }
  return { entries, skipped, counts };
}

/**
 * tmp + rename so a crash mid-write cannot leave a half file. The tmp name is
 * per-process so two windows pruning at the same moment cannot share it — with
 * a fixed name one window could rename a file the other is still writing.
 * @param {string} file
 * @param {any[]} entries
 */
function writeAllAtomic(file, entries) {
  const body = entries
    .map((e) => JSON.stringify({
      id: e.id, text: e.text, tags: e.tags, createdAt: e.createdAt, source: e.source,
    }))
    .join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36);
  try {
    fs.writeFileSync(tmp, body ? body + '\n' : '', 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    // A failed write must not litter .codex/ with an orphan tmp file.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp 未创建成功，忽略 */
    }
    throw err;
  }
}

/**
 * Append-only is what makes two windows writing at once safe.
 * @param {{ scope?: string, projectPath?: string, userDataPath?: string,
 *   text: string, tags?: string[], source?: string, maxEntries?: number, now?: number }} opts
 * @returns {{ ok: true, id: string, scope: string, deduped?: boolean, pruned?: number }
 *   | { ok: false, error: string }}
 */
function appendEntry({
  scope, projectPath, userDataPath, text, tags, source, maxEntries, now,
} = {}) {
  const clean = String(text || '').trim();
  if (!clean) return { ok: false, error: '记忆内容为空' };

  const effectiveScope = scope === 'user' ? 'user' : 'project';
  // memoryFilePath throws by contract; here the contract is an ok:false result.
  let file;
  try {
    file = memoryFilePath({ scope: effectiveScope, projectPath, userDataPath });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const { entries } = readEntries(file, effectiveScope);

  const key = normalizeText(clean);
  const dup = entries.find((e) => normalizeText(e.text) === key);
  if (dup) return { ok: true, id: dup.id, scope: effectiveScope, deduped: true };

  const entry = {
    id: nextId(),
    text: clean.length > TEXT_MAX ? clean.slice(0, TEXT_MAX - 1) + '…' : clean,
    tags: normalizeTags(tags),
    createdAt: Number.isFinite(Number(now)) ? Number(now) : Date.now(),
    source: source === 'slash' ? 'slash' : 'tool',
  };

  let pruned = 0;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');

    const limit = Number(maxEntries);
    if (Number.isFinite(limit) && limit > 0 && entries.length + 1 > limit) {
      const all = [...entries, { ...entry, scope: effectiveScope }]
        .sort((a, b) => a.createdAt - b.createdAt);
      const keep = all.slice(all.length - limit);
      pruned = all.length - keep.length;
      writeAllAtomic(file, keep);
    }
  } catch (err) {
    return { ok: false, error: '写入记忆失败：' + err.message };
  }

  return { ok: true, id: entry.id, scope: effectiveScope, pruned };
}

/**
 * No scope given → project first, then user; stop at the first hit.
 * @param {{ id: string, scope?: string, projectPath?: string, userDataPath?: string }} opts
 * @returns {{ ok: true, removed: boolean, scope?: string } | { ok: false, error: string }}
 */
function deleteEntry({ id, scope, projectPath, userDataPath } = {}) {
  const wanted = String(id || '');
  if (!wanted) return { ok: true, removed: false };
  const scopes = scope === 'project' || scope === 'user' ? [scope] : ['project', 'user'];
  for (const sc of scopes) {
    if (sc === 'project' && !projectPath) continue;
    if (sc === 'user' && !userDataPath) continue;
    let file;
    try {
      file = memoryFilePath({ scope: sc, projectPath, userDataPath });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const { entries } = readEntries(file, sc);
    const next = entries.filter((e) => e.id !== wanted);
    if (next.length !== entries.length) {
      // The rewrite is the only I/O that can fail here — report it, do not throw.
      try {
        writeAllAtomic(file, next);
      } catch (err) {
        return { ok: false, error: '删除记忆失败：' + err.message };
      }
      return { ok: true, removed: true, scope: sc };
    }
  }
  return { ok: true, removed: false };
}

module.exports = {
  memoryFilePath,
  readEntries,
  readAll,
  appendEntry,
  deleteEntry,
  writeAllAtomic,
  normalizeText,
  TEXT_MAX,
  TAG_MAX,
  TAGS_MAX,
};
