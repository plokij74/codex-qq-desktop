'use strict';

const { randomUUID } = require('node:crypto');
const profiles = require('./model-profiles');
const { DIAGNOSTIC_CHECKS } = require('./model-diagnostics');

const SAFE_ERRORS = Object.freeze({
  MODEL_SENDER_INVALID: '窗口已失效，请重新打开后重试。',
  MODEL_CONFIG_INVALID: '模型或助手配置无效，请检查目标与填写的字段。',
  CONFIG_CONFLICT: '配置已被修改，请核对最新配置后重新保存。',
  CONFIG_IN_USE: '此配置正在使用，请先停止相关运行并等待清理完成。',
  PROFILE_IN_USE: '此配置仍被默认模型、助手或会话引用，请先显式换绑。',
  MODEL_CREDENTIAL_UNAVAILABLE: '凭据未配置、无法读取或不属于此服务地址，请重新绑定。',
  MODEL_CONFIG_SAVE_FAILED: '配置保存失败，未提交的更改没有生效。',
  MODEL_DIAGNOSTIC_UNAVAILABLE: '模型诊断服务暂不可用。',
});
const clone = (value) => structuredClone(value);
const fail = (code) => Object.assign(new Error(SAFE_ERRORS[code] || SAFE_ERRORS.MODEL_CONFIG_INVALID), { code });
const physicalRef = (ref) => ref === 'sec_main_api_key' ? 'main_api_key' : String(ref || '');
const originOf = (provider) => new URL(provider.baseUrl).origin;
const sameTransport = (left, right) => left.protocol === right.protocol && left.baseUrl === right.baseUrl && left.auth.kind === right.auth.kind;

/** Main-process-only configuration authority. Dependencies keep tests away from real userData/vault. */
function createModelIpcHandlers(options = {}) {
  if (typeof options.getSettings !== 'function' || typeof options.saveSettings !== 'function') {
    throw new TypeError('Model IPC requires settings callbacks');
  }
  const sessionReferences = new Map();
  const volatileCleanup = new Set();
  const settings = () => options.getSettings();
  const registry = () => {
    const current = settings();
    return profiles.createModelRegistry(current);
  };
  const manager = () => options.getSecretManager?.();
  const senderId = (event) => {
    const id = event?.sender?.id;
    if (!Number.isSafeInteger(id) || id <= 0 || event.sender.isDestroyed?.() || options.authorizeSender?.(event) === false) {
      throw fail('MODEL_SENDER_INVALID');
    }
    return id;
  };
  const journal = () => [...new Set([
    ...(Array.isArray(settings().modelCredentialCleanup) ? settings().modelCredentialCleanup : []), ...volatileCleanup,
  ].filter((ref) => typeof ref === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(ref)))];
  const credentialState = (provider) => {
    const auth = provider.auth || {};
    if (!auth.secretRef) return 'unset';
    if (auth.credentialOrigin !== originOf(provider)) return 'unavailable';
    try { const value = manager()?.getSecret(physicalRef(auth.secretRef)); return typeof value === 'string' && value ? 'configured' : 'unavailable'; }
    catch { return 'unavailable'; }
  };
  const publicState = () => {
    const current = settings(); const currentRegistry = registry(); const pending = journal();
    return { ok: true, mode: current.mode || 'local', revision: currentRegistry.revision,
      registry: profiles.publicModelRegistry(currentRegistry, { getCredentialState: credentialState }),
      cleanupState: pending.length ? 'pending' : 'clean', pendingCleanupCount: pending.length };
  };
  const allReferences = () => [...sessionReferences.values()].flat();
  const inUse = (query) => options.isInUse?.(query) === true;
  const expected = (payload, current) => {
    if (!Number.isSafeInteger(payload?.expectedRevision) || payload.expectedRevision !== current.revision) throw fail('CONFIG_CONFLICT');
  };
  const commit = (before, after, cleanup = journal()) => {
    options.saveSettings({ modelRegistry: after, modelCredentialCleanup: cleanup }, { trustedModelRegistry: true, resolveLegacyApiKey: false });
    volatileCleanup.clear();
    try { options.onRegistryChange?.(before, after); } catch { /* a notification cannot roll back a committed configuration */ }
  };
  const persistJournal = (pending) => {
    volatileCleanup.clear(); pending.forEach((ref) => volatileCleanup.add(ref));
    try {
      options.saveSettings({ modelCredentialCleanup: pending }, { trustedModelRegistry: true, resolveLegacyApiKey: false });
      volatileCleanup.clear();
    } catch { /* retain pending state in this process; never claim the orphan was retired */ }
  };
  const isReferenced = (ref, current = registry()) => current.providers.some((p) => physicalRef(p.auth.secretRef) === physicalRef(ref));
  const retirePending = () => {
    const pending = journal(); const remaining = [];
    for (const ref of pending) {
      if (isReferenced(ref)) continue; // an active/shared reference is never retired
      try { manager()?.deleteSecret(ref); if (!manager() || manager().hasSecret(ref)) remaining.push(ref); }
      catch { remaining.push(ref); }
    }
    if (JSON.stringify(pending) !== JSON.stringify(remaining) || volatileCleanup.size) persistJournal(remaining);
    return remaining;
  };
  const responseError = (err) => {
    const code = Object.hasOwn(SAFE_ERRORS, err?.code) ? err.code : 'MODEL_CONFIG_INVALID';
    let state = {};
    if (code !== 'MODEL_SENDER_INVALID') {
      try { state = publicState(); } catch { /* invalid stored state must not be replaced with an empty registry */ }
    }
    return { ...state, ok: false, code, error: SAFE_ERRORS[code] };
  };
  const guard = (fn) => async (event, payload = {}) => {
    try { senderId(event); return await fn(event, payload); } catch (err) { return responseError(err); }
  };
  const save = (kind) => guard((_event, payload) => {
    const before = registry(); expected(payload, before);
    const draft = payload[kind] || payload.profile;
    if (!draft || typeof draft !== 'object') throw fail('MODEL_CONFIG_INVALID');
    const after = profiles.saveProfile(before, kind, draft, { expectedRevision: payload.expectedRevision });
    const retired = [];
    if (kind === 'provider') {
      const previous = before.providers.find((p) => p.id === draft.id); const next = after.providers.find((p) => p.id === draft.id);
      if (previous && next && !sameTransport(previous, next) && inUse({ providerId: previous.id })) throw fail('CONFIG_IN_USE');
      const oldRef = physicalRef(previous?.auth?.secretRef);
      if (oldRef && !isReferenced(oldRef, after)) retired.push(oldRef);
    }
    // An origin/auth edit can invalidate a key just like an explicit clear.
    // Commit the unbound provider and retired reference together before deletion.
    try { commit(before, after, [...new Set([...journal(), ...retired])]); } catch { throw fail('MODEL_CONFIG_SAVE_FAILED'); }
    if (retired.length) retirePending();
    return publicState();
  });

  const handlers = {
    list: guard(() => publicState()),
    listAssistants: guard(() => ({ ...publicState(), assistants: publicState().registry.assistants })),
    saveProvider: save('provider'), saveModel: save('model'), saveAssistant: save('assistant'),
    setDefault: guard((_event, payload) => {
      const before = registry(); expected(payload, before);
      if (!before.models.some((m) => m.id === payload.modelProfileId)) throw fail('MODEL_CONFIG_INVALID');
      const after = profiles.updateModelRegistry(before, (next) => { next.defaultModelProfileId = payload.modelProfileId; }, payload.expectedRevision);
      try { commit(before, after); } catch { throw fail('MODEL_CONFIG_SAVE_FAILED'); }
      return publicState();
    }),
    remove: guard((_event, payload) => {
      const before = registry(); expected(payload, before);
      if (!['provider', 'model'].includes(payload.kind)) throw fail('MODEL_CONFIG_INVALID');
      if (inUse(payload.kind === 'provider' ? { providerId: payload.id } : { modelProfileId: payload.id })) throw fail('CONFIG_IN_USE');
      const after = profiles.removeProfile(before, payload.kind, payload.id, { expectedRevision: payload.expectedRevision, liveReferences: allReferences() });
      const removed = payload.kind === 'provider' ? before.providers.find((p) => p.id === payload.id) : null;
      const retired = removed?.auth?.secretRef && !isReferenced(removed.auth.secretRef, after) ? [physicalRef(removed.auth.secretRef)] : [];
      try { commit(before, after, [...new Set([...journal(), ...retired])]); } catch { throw fail('MODEL_CONFIG_SAVE_FAILED'); }
      retirePending(); return publicState();
    }),
    deleteAssistant: guard((_event, payload) => {
      const before = registry(); expected(payload, before);
      if (inUse({ assistantId: payload.assistantId })) throw fail('CONFIG_IN_USE');
      if (profiles.BUILTIN_ASSISTANT_IDS.includes(payload.assistantId)) throw fail('PROFILE_IN_USE');
      let after;
      try { after = profiles.removeProfile(before, 'assistant', payload.assistantId, { expectedRevision: payload.expectedRevision, liveReferences: allReferences() }); }
      catch (err) {
        if (err?.code !== 'PROFILE_IN_USE') throw err;
        after = profiles.saveProfile(before, 'assistant', { id: payload.assistantId, archived: true }, { expectedRevision: payload.expectedRevision });
      }
      try { commit(before, after); } catch { throw fail('MODEL_CONFIG_SAVE_FAILED'); }
      return publicState();
    }),
    syncSessionReferences: guard((event, payload) => {
      if (!Array.isArray(payload.sessions) || payload.sessions.length > 2048) throw fail('MODEL_CONFIG_INVALID');
      const refs = payload.sessions.map((value) => {
        if (!value || typeof value.sessionId !== 'string' || value.sessionId.length < 1 || value.sessionId.length > 160
          || !['ai', 'demo-contact'].includes(value.identityType)
          || (value.assistantId != null && (typeof value.assistantId !== 'string' || value.assistantId.length > 160))
          || (value.modelProfileId != null && (typeof value.modelProfileId !== 'string' || value.modelProfileId.length > 160))) throw fail('MODEL_CONFIG_INVALID');
        return { sessionId: value.sessionId, assistantId: value.assistantId || null, modelProfileId: value.modelProfileId || null, identityType: value.identityType };
      });
      sessionReferences.set(senderId(event), refs);
      return { ok: true, count: refs.length };
    }),
    setCredential: guard((_event, payload) => {
      const before = registry(); expected(payload, before);
      const provider = before.providers.find((p) => p.id === payload.providerId);
      if (!provider || provider.auth.kind === 'none' || typeof payload.credential !== 'string' || payload.credential.length > 16384) throw fail('MODEL_CONFIG_INVALID');
      const value = payload.credential.trim();
      if (!value) return publicState(); // blank is keep, not clear
      if (inUse({ providerId: provider.id })) throw fail('CONFIG_IN_USE');
      const secretManager = manager(); if (!secretManager) throw fail('MODEL_CREDENTIAL_UNAVAILABLE');
      const newRef = `model_credential_${randomUUID().replace(/-/g, '')}`;
      secretManager.registerSecret?.(value, 'MODEL_CREDENTIAL');
      let committed = false;
      try {
        secretManager.setSecret(newRef, value, { label: 'Model provider credential' });
        if (secretManager.getSecret(newRef) !== value) throw fail('MODEL_CREDENTIAL_UNAVAILABLE');
        const after = profiles.updateModelRegistry(before, (next) => {
          const target = next.providers.find((p) => p.id === provider.id);
          target.revision += 1;
          target.auth = { kind: target.auth.kind, secretRef: newRef, credentialOrigin: originOf(target), credentialRevision: (target.auth.credentialRevision || 0) + 1 };
        }, payload.expectedRevision);
        const oldRef = physicalRef(provider.auth.secretRef);
        const retired = oldRef && !isReferenced(oldRef, after) ? [oldRef] : [];
        commit(before, after, [...new Set([...journal(), ...retired])]); committed = true;
      } catch {
        if (!committed) {
          try { secretManager.deleteSecret(newRef); }
          catch { persistJournal([...new Set([...journal(), newRef])]); }
          throw fail('MODEL_CREDENTIAL_UNAVAILABLE');
        }
      }
      retirePending(); return publicState();
    }),
    clearCredential: guard((_event, payload) => {
      const before = registry(); expected(payload, before);
      const provider = before.providers.find((p) => p.id === payload.providerId);
      if (!provider) throw fail('MODEL_CONFIG_INVALID');
      if (inUse({ providerId: provider.id })) throw fail('CONFIG_IN_USE');
      if (!provider.auth.secretRef) return publicState();
      const after = profiles.updateModelRegistry(before, (next) => {
        const target = next.providers.find((p) => p.id === provider.id); target.revision += 1;
        target.auth = { kind: target.auth.kind, secretRef: '', credentialOrigin: null, credentialRevision: (target.auth.credentialRevision || 0) + 1 };
      }, payload.expectedRevision);
      const oldRef = physicalRef(provider.auth.secretRef);
      const retired = oldRef && !isReferenced(oldRef, after) ? [oldRef] : [];
      try { commit(before, after, [...new Set([...journal(), ...retired])]); } catch { throw fail('MODEL_CONFIG_SAVE_FAILED'); }
      retirePending(); return publicState();
    }),
    retryCredentialCleanup: guard((_event, payload) => { expected(payload, registry()); retirePending(); return publicState(); }),
    diagnose: guard((event, payload) => {
      const current = registry(); expected(payload, current);
      // A diagnostic may incur physical requests. Never infer its target or
      // selected checks from chat defaults when the renderer omitted them.
      if (!current.models.some((model) => model.id === payload.modelProfileId)
        || !Array.isArray(payload.checks) || !payload.checks.length || payload.checks.length > DIAGNOSTIC_CHECKS.length
        || payload.checks.some((check) => !DIAGNOSTIC_CHECKS.includes(check))
        || new Set(payload.checks).size !== payload.checks.length) throw fail('MODEL_CONFIG_INVALID');
      if (typeof options.startDiagnosis !== 'function') throw fail('MODEL_DIAGNOSTIC_UNAVAILABLE');
      const runId = `diagnostic_${randomUUID()}`;
      const binding = profiles.resolveModelBinding({ registry: current, senderId: senderId(event), sessionId: runId,
        runId, clientRequestId: runId, kind: 'model-diagnostic',
        assistantId: 'assistant_general', modelProfileId: payload.modelProfileId, expectedRegistryRevision: payload.expectedRevision });
      return options.startDiagnosis(event, payload, binding);
    }),
    cancelDiagnosis: guard((event, payload) => {
      if (typeof options.cancelDiagnosis !== 'function') throw fail('MODEL_DIAGNOSTIC_UNAVAILABLE');
      return options.cancelDiagnosis(event, payload);
    }),
    resolveBinding(event, payload = {}) {
      return profiles.resolveModelBinding({ ...payload, registry: registry(), senderId: senderId(event) });
    },
    resolveCredential(binding) {
      if (profiles.isResolvedModelBinding && !profiles.isResolvedModelBinding(binding)) throw fail('MODEL_CONFIG_INVALID');
      if (binding.auth?.kind === 'none') return '';
      const auth = binding.auth || {}; const current = registry().providers.find((p) => p.id === binding.providerId);
      if (!current || !auth.secretRef || auth.credentialOrigin !== new URL(binding.baseUrl).origin
        || current.auth.secretRef !== auth.secretRef || current.auth.credentialRevision !== auth.credentialRevision
        || current.auth.kind !== auth.kind || originOf(current) !== new URL(binding.baseUrl).origin) throw fail('MODEL_CREDENTIAL_UNAVAILABLE');
      try { const value = manager()?.getSecret(physicalRef(auth.secretRef)); if (typeof value !== 'string' || !value) throw fail('MODEL_CREDENTIAL_UNAVAILABLE'); return value; }
      catch { throw fail('MODEL_CREDENTIAL_UNAVAILABLE'); }
    },
    applyDiagnosticResult(result) {
      const before = registry(); const after = profiles.applyObservedCapabilities(before, result);
      if (after.revision !== before.revision) commit(before, after);
      return publicState();
    },
    dropSender(id) { sessionReferences.delete(Number(id)); },
    getPublicState: publicState,
    getLiveReferences: () => clone(allReferences()),
  };
  return handlers;
}

function registerModelIpc(ipcMain, handlers) {
  const names = { 'models:list': 'list', 'models:saveProvider': 'saveProvider', 'models:saveModel': 'saveModel',
    'models:setDefault': 'setDefault', 'models:remove': 'remove', 'models:setCredential': 'setCredential',
    'models:clearCredential': 'clearCredential', 'models:retryCredentialCleanup': 'retryCredentialCleanup',
    'models:syncSessionReferences': 'syncSessionReferences', 'models:diagnose': 'diagnose', 'models:cancelDiagnosis': 'cancelDiagnosis',
    'assistants:list': 'listAssistants', 'assistants:save': 'saveAssistant', 'assistants:delete': 'deleteAssistant' };
  for (const [channel, method] of Object.entries(names)) ipcMain.handle(channel, handlers[method]);
}
module.exports = { createModelIpcHandlers, registerModelIpc };
