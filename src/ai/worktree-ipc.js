'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isResultId } = require('./worktree-state');

function ipcError(code, error) {
  return { ok: false, code, error };
}

function senderId(event) {
  const value = Number(event?.sender?.id);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function createWorktreeIpcHandlers({ manager, isBusy, withMutation, openPath, openExternal } = {}) {
  if (!manager) throw new Error('worktree IPC requires manager');
  const bindingsBySender = new Map();

  function bind(event, payload = {}) {
    const owner = senderId(event);
    const projectId = String(payload.projectId || '').trim().slice(0, 200);
    const projectPath = String(payload.projectPath || '').trim();
    if (owner == null || !projectId || !path.isAbsolute(projectPath)) return ipcError('PATH_UNSAFE', '项目绑定参数无效');
    let canonical;
    try {
      const stat = fs.lstatSync(projectPath);
      canonical = fs.realpathSync.native(projectPath);
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(projectPath).toLowerCase() !== path.resolve(canonical).toLowerCase()) {
        return ipcError('PATH_UNSAFE', '项目绑定路径不能经过符号链接');
      }
    } catch {
      return ipcError('PATH_UNSAFE', '项目绑定路径不存在');
    }
    const projectBindingId = `pb_${crypto.randomBytes(16).toString('hex')}`;
    let bindings = bindingsBySender.get(owner);
    if (!bindings) {
      bindings = new Map();
      bindingsBySender.set(owner, bindings);
    }
    for (const [token, binding] of bindings) {
      if (binding.projectId === projectId) bindings.delete(token);
    }
    bindings.set(projectBindingId, { projectId, projectPath: canonical });
    return { ok: true, projectBindingId };
  }

  function resolveBinding(event, payload = {}) {
    const owner = senderId(event);
    const token = String(payload.projectBindingId || '');
    const binding = owner == null ? null : bindingsBySender.get(owner)?.get(token);
    return binding || null;
  }

  function unbind(event, payload = {}) {
    const owner = senderId(event);
    const token = String(payload.projectBindingId || '');
    const bindings = owner == null ? null : bindingsBySender.get(owner);
    if (!bindings?.has(token)) return ipcError('RESULT_NOT_FOUND', '项目绑定已失效');
    bindings.delete(token);
    if (bindings.size === 0) bindingsBySender.delete(owner);
    return { ok: true };
  }

  function resultArgs(event, payload) {
    const binding = resolveBinding(event, payload);
    const resultId = String(payload?.resultId || '');
    if (!binding || !isResultId(resultId)) return null;
    return { projectPath: binding.projectPath, resultId };
  }

  function prReferenceArgs(event, payload = {}) {
    const binding = resolveBinding(event, payload);
    if (!binding) return null;
    const resultId = String(payload.resultId || '');
    const number = Number(payload.number);
    const hasResult = Boolean(resultId);
    const hasNumber = Number.isInteger(number) && number > 0 && number <= 0x7fffffff;
    if (hasResult === hasNumber) return null;
    if (hasResult && !isResultId(resultId)) return null;
    return hasResult
      ? { projectPath: binding.projectPath, resultId }
      : { projectPath: binding.projectPath, number };
  }

  async function list(event, payload = {}) {
    const binding = resolveBinding(event, payload);
    if (!binding) return ipcError('RESULT_NOT_FOUND', '项目绑定已失效，请重新打开项目');
    const warnings = [];
    if (typeof isBusy === 'function' && isBusy()) {
      warnings.push('RECOVERY_DEFERRED_BUSY');
    } else if (typeof manager.recover === 'function') {
      const runRecovery = () => manager.recover({ projectPath: binding.projectPath });
      const recovered = typeof withMutation === 'function' ? await withMutation(runRecovery) : await runRecovery();
      if (recovered && recovered.ok === false && recovered.code === 'BUSY') warnings.push('RECOVERY_DEFERRED_BUSY');
    }
    const listed = await manager.list({ projectPath: binding.projectPath });
    if (!listed || listed.ok !== true || warnings.length === 0) return listed;
    return { ...listed, warnings: [...(Array.isArray(listed.warnings) ? listed.warnings : []), ...warnings] };
  }

  async function get(event, payload = {}) {
    const args = resultArgs(event, payload);
    if (!args) return ipcError('RESULT_NOT_FOUND', '隔离结果不存在');
    return manager.get({ ...args, preview: payload.preview === true });
  }

  async function mutate(event, payload, method) {
    const args = resultArgs(event, payload);
    if (!args) return ipcError('RESULT_NOT_FOUND', '隔离结果不存在');
    if (typeof isBusy === 'function' && isBusy()) return ipcError('BUSY', '有对话、终端或其它 worktree 操作正在进行');
    const run = () => manager[method](args);
    return typeof withMutation === 'function' ? withMutation(run) : run();
  }

  async function open(event, payload = {}) {
    const args = resultArgs(event, payload);
    if (!args) return ipcError('RESULT_NOT_FOUND', '隔离结果不存在');
    const resolved = await manager.open(args);
    if (!resolved?.ok) return resolved;
    if (typeof openPath === 'function') {
      const error = await openPath(resolved.path);
      if (error) return ipcError('PATH_UNSAFE', String(error));
    }
    return { ok: true };
  }

  async function prMutate(event, payload, method) {
    payload = payload && typeof payload === 'object' ? payload : {};
    const args = resultArgs(event, payload);
    if (!args) return ipcError('RESULT_NOT_FOUND', '隔离结果不存在');
    if (typeof isBusy === 'function' && isBusy()) return ipcError('BUSY', '有对话、终端或其它 worktree 操作正在进行');
    const run = () => manager[method]({
      ...args,
      title: String(payload.title || '').slice(0, 300),
      body: String(payload.body || '').slice(0, 10000),
      draft: payload.draft !== false,
    });
    return typeof withMutation === 'function' ? withMutation(run) : run();
  }

  async function prLifecycleMutate(event, payload, method, extra = {}) {
    payload = payload && typeof payload === 'object' ? payload : {};
    const args = prReferenceArgs(event, payload);
    if (!args || typeof manager[method] !== 'function') return ipcError('PR_INVALID', 'PR 引用无效');
    if (typeof isBusy === 'function' && isBusy()) return ipcError('BUSY', '有对话、终端或其它 worktree 操作正在进行');
    const run = () => manager[method]({ ...args, ...extra });
    return typeof withMutation === 'function' ? withMutation(run) : run();
  }

  return {
    bind,
    unbind,
    list,
    get,
    apply: (event, payload) => mutate(event, payload, 'apply'),
    discard: (event, payload) => mutate(event, payload, 'discard'),
    retryCollect: (event, payload) => mutate(event, payload, 'retryCollect'),
    cleanup: (event, payload) => mutate(event, payload, 'cleanup'),
    open,
    preflight: async (event, payload = {}) => {
      const args = resultArgs(event, payload);
      if (!args || typeof manager.preflightPr !== 'function') return ipcError('RESULT_NOT_FOUND', '隔离结果不存在');
      return manager.preflightPr(args);
    },
    createPr: (event, payload) => prMutate(event, payload, 'createPr'),
    retryPr: (event, payload) => prMutate(event, payload, 'retryPr'),
    cleanupPr: (event, payload) => {
      const args = resultArgs(event, payload);
      if (!args) return ipcError('RESULT_NOT_FOUND', '隔离结果不存在');
      if (typeof isBusy === 'function' && isBusy()) return ipcError('BUSY', '有对话、终端或其它 worktree 操作正在进行');
      const run = () => manager.cleanupPr(args);
      return typeof withMutation === 'function' ? withMutation(run) : run();
    },
    listPrs: async (event, payload = {}) => {
      const binding = resolveBinding(event, payload);
      if (!binding || typeof manager.listPrs !== 'function') return ipcError('RESULT_NOT_FOUND', '项目绑定已失效，请重新打开项目');
      const state = ['open', 'closed', 'merged', 'all'].includes(String(payload.state || '')) ? String(payload.state) : 'open';
      return manager.listPrs({ projectPath: binding.projectPath, state });
    },
    getPr: async (event, payload = {}) => {
      const args = prReferenceArgs(event, payload);
      if (!args || typeof manager.getPr !== 'function') return ipcError('PR_INVALID', 'PR 引用无效');
      if (!args.resultId) return manager.getPr(args);
      if (typeof isBusy === 'function' && isBusy()) return ipcError('BUSY', '有对话、终端或其它 worktree 操作正在进行');
      const run = () => manager.getPr(args);
      return typeof withMutation === 'function' ? withMutation(run) : run();
    },
    editPr: (event, payload = {}) => prLifecycleMutate(event, payload, 'editPr', {
      title: String(payload.title || '').slice(0, 300),
      body: String(payload.body || '').slice(0, 10000),
    }),
    commentPr: (event, payload = {}) => prLifecycleMutate(event, payload, 'commentPr', {
      body: String(payload.body || '').slice(0, 10000),
    }),
    closeLifecyclePr: (event, payload = {}) => prLifecycleMutate(event, payload, 'closePr'),
    reopenPr: (event, payload = {}) => prLifecycleMutate(event, payload, 'reopenPr'),
    readyPr: (event, payload = {}) => prLifecycleMutate(event, payload, 'readyPr'),
    mergePr: (event, payload = {}) => prLifecycleMutate(event, payload, 'mergePr', {
      method: ['merge', 'squash', 'rebase'].includes(String(payload.method || '')) ? String(payload.method) : 'squash',
    }),
    openPr: async (event, payload = {}) => {
      const args = prReferenceArgs(event, payload);
      if (!args || typeof manager.getPr !== 'function') return ipcError('PR_INVALID', 'PR 引用无效');
      const resolved = await manager.getPr({ ...args, syncMarker: false });
      const url = resolved?.pr?.url;
      let parsed;
      try { parsed = new URL(String(url || '')); } catch { parsed = null; }
      const repo = resolved?.repo || {};
      const number = Number(resolved?.pr?.number);
      const repoPrefix = `/${repo.owner}/${repo.repo}/pull/${number}`;
      if (!resolved?.ok || !number || parsed?.protocol !== 'https:'
        || parsed.username || parsed.password
        || parsed.host.toLowerCase() !== String(repo.host || '').toLowerCase()
        || (parsed.pathname !== repoPrefix && !parsed.pathname.startsWith(`${repoPrefix}/`))) {
        return ipcError('PR_INVALID', 'PR 地址不可用');
      }
      if (typeof openExternal === 'function') await openExternal(url);
      return { ok: true };
    },
    dropSender(eventOrId) {
      const id = typeof eventOrId === 'number' ? eventOrId : senderId(eventOrId);
      if (id != null) bindingsBySender.delete(id);
    },
  };
}

module.exports = { createWorktreeIpcHandlers };
