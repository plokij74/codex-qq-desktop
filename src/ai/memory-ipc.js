'use strict';

/**
 * Phase D.2 — pure handlers behind the memory:* IPC channels.
 *
 * main.js cannot be loaded under node:test (it requires Electron), so every
 * gating and scope decision lives here and main only forwards.
 */

const store = require('./memory-store');
const { containsSensitiveValue } = require('./memory-candidates');
// clampInt 已由 settings.js 导出，不要再抄一份。
const { clampInt } = require('./settings');

const DISABLED = { ok: false, error: '长期记忆未启用' };

function isEnabled(settings) {
  return settings?.memoryEnabled !== false;
}

function pathsFrom(payload, userDataPath) {
  return {
    projectPath: payload?.projectPath ? String(payload.projectPath) : null,
    userDataPath: userDataPath || null,
  };
}

function requestedScope(payload) {
  return payload?.scope === 'project' || payload?.scope === 'user'
    ? payload.scope
    : null;
}

function validateExplicitScope(scope, paths) {
  if (!scope) return { ok: false, error: '记忆作用域无效' };
  if (scope === 'project' && !paths.projectPath) {
    return { ok: false, error: 'project 记忆缺少 projectPath' };
  }
  return null;
}

/**
 * These are UI-driven: the permission tiers gate the model, not the user,
 * so nothing here goes through PermissionGate (same as project:writeFile).
 * @param {{ settings?: any, userDataPath?: string, payload?: any }} opts
 * @returns {{ ok: true, entries: any[], skipped: number, counts: { project: number, user: number } }
 *   | { ok: false, error: string }}
 */
function memoryList({ settings, userDataPath, payload = {} } = {}) {
  if (!isEnabled(settings)) return { ...DISABLED };
  try {
    return { ok: true, ...store.readAll(pathsFrom(payload, userDataPath)) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Scope: explicit user wins, no bound project falls back to user, else project.
 * @param {{ settings?: any, userDataPath?: string, payload?: any }} opts
 * @returns {{ ok: true, id: string, scope: string, deduped?: boolean, pruned?: number }
 *   | { ok: false, error: string }}
 */
function memoryAdd({ settings, userDataPath, payload = {} } = {}) {
  if (!isEnabled(settings)) return { ...DISABLED };
  const paths = pathsFrom(payload, userDataPath);
  const scope = payload?.scope === 'user' || !paths.projectPath ? 'user' : 'project';
  try {
    // appendEntry 已按契约返回 ok:false，这里的 try 只兜住意料之外的 I/O 异常。
    return store.appendEntry({
      ...paths,
      scope,
      text: payload?.text,
      tags: Array.isArray(payload?.tags) ? payload.tags : [],
      source: 'slash',
      maxEntries: clampInt(settings?.memoryMaxEntries, 20, 2000, 200),
    });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * @param {{ settings?: any, userDataPath?: string, payload?: any }} opts
 * @returns {{ ok: true, removed: boolean, scope?: string } | { ok: false, error: string }}
 */
function memoryDelete({ settings, userDataPath, payload = {} } = {}) {
  if (!isEnabled(settings)) return { ...DISABLED };
  try {
    return store.deleteEntry({
      ...pathsFrom(payload, userDataPath),
      id: String(payload?.id || ''),
      scope: payload?.scope,
    });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function memoryAccept({ settings, userDataPath, payload = {} } = {}) {
  if (!isEnabled(settings)) return { ...DISABLED };
  const paths = pathsFrom(payload, userDataPath);
  const scope = requestedScope(payload);
  const invalid = validateExplicitScope(scope, paths);
  if (invalid) return invalid;
  const rawTags = Array.isArray(payload?.tags) ? payload.tags : [];
  const rawMemoryText = [
    String(payload?.text ?? ''),
    ...rawTags.map((tag) => String(tag ?? '')),
  ].join('\n');
  if (containsSensitiveValue(rawMemoryText)) {
    return { ok: false, error: '候选疑似包含敏感信息，未写入记忆' };
  }
  try {
    return store.appendEntry({
      ...paths,
      scope,
      text: payload?.text,
      tags: rawTags,
      source: 'compact',
      maxEntries: clampInt(settings?.memoryMaxEntries, 20, 2000, 200),
    });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function memoryUpdate({ settings, userDataPath, payload = {} } = {}) {
  if (!isEnabled(settings)) return { ...DISABLED };
  const paths = pathsFrom(payload, userDataPath);
  const scope = requestedScope(payload);
  const invalid = validateExplicitScope(scope, paths);
  if (invalid) return invalid;
  try {
    return store.updateEntry({
      ...paths,
      id: String(payload?.id || ''),
      scope,
      expected: payload?.expected && typeof payload.expected === 'object'
        ? payload.expected
        : {},
      text: payload?.text,
      tags: Array.isArray(payload?.tags) ? payload.tags : [],
    });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

module.exports = {
  memoryList,
  memoryAdd,
  memoryDelete,
  memoryAccept,
  memoryUpdate,
};
