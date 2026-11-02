'use strict';

(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.E4Models = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildE4Models() {
  const CAPABILITIES = ['text', 'nativeTools', 'vision', 'streaming', 'usage', 'temperature', 'stop'];
  const DIAGNOSTIC_CHECKS = ['text', 'streaming', 'nativeTools', 'usage'];
  const PROTOCOLS = ['openai-chat-completions', 'openai-responses', 'anthropic-messages'];
  const HOST_AUTHORIZED_TOOLS = '@host-authorized';
  const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function emptyState() {
    return { loaded: false, mode: 'local', revision: 0, registry: null, cleanupState: 'clean', pendingCleanupCount: 0, error: '', diagnostics: {} };
  }

  function providerDraftForSave(input) {
    const provider = input && typeof input === 'object' ? input : {};
    const draft = {
      id: String(provider.id || '').trim(),
      name: String(provider.name || '').trim(),
      protocol: PROTOCOLS.includes(provider.protocol) ? provider.protocol : 'openai-chat-completions',
      baseUrl: String(provider.baseUrl || '').trim(),
      auth: { kind: String(provider.auth?.kind || (provider.protocol === 'anthropic-messages' ? 'api-key' : 'bearer')) },
    };
    if (provider.revision != null) draft.revision = provider.revision;
    const protocol = draft.protocol;
    const authValid = protocol === 'anthropic-messages' ? 'api-key' : ['bearer', 'none'].includes(draft.auth.kind);
    if (!authValid) draft.auth.kind = protocol === 'anthropic-messages' ? 'api-key' : 'bearer';
    if (provider.transportConfirmation && typeof provider.transportConfirmation === 'object') {
      const origin = String(provider.transportConfirmation.origin || '');
      const acceptedAt = provider.transportConfirmation.plainHttpAcceptedAt || null;
      if (origin && acceptedAt) draft.transportConfirmation = { origin, plainHttpAcceptedAt: String(acceptedAt) };
    }
    return draft;
  }

  function declaredCapability(raw) {
    const state = ['supported', 'unsupported', 'unknown'].includes(raw?.state) ? raw.state : 'unknown';
    if (raw?.source !== 'declared' || state === 'unknown') return { state: 'unknown', source: 'unknown', checkedAt: null, bindingRevision: null };
    return { state, source: 'declared', checkedAt: null, bindingRevision: null };
  }

  function modelDraftForSave(input) {
    const model = input && typeof input === 'object' ? input : {};
    const request = model.request || {};
    const compatibility = model.compatibility || {};
    const capabilities = model.capabilities || {};
    const normalizedCapabilities = {};
    for (const name of CAPABILITIES) {
      if (own(capabilities, name) && capabilities[name]?.source !== 'observed') normalizedCapabilities[name] = declaredCapability(capabilities[name]);
    }
    if (own(capabilities, 'contextWindow') && capabilities.contextWindow?.source !== 'observed') {
      const context = capabilities.contextWindow || {};
      normalizedCapabilities.contextWindow = {
        tokens: context.source === 'declared' && Number.isSafeInteger(context.tokens) && context.tokens > 0 ? context.tokens : null,
        source: context.source === 'declared' && Number.isSafeInteger(context.tokens) && context.tokens > 0 ? 'declared' : 'unknown',
        checkedAt: null,
        bindingRevision: null,
      };
    }
    const draft = {
      id: String(model.id || '').trim(),
      name: String(model.name || '').trim(),
      providerId: String(model.providerId || '').trim(),
      model: String(model.model || '').trim(),
      request: {
        maxOutputTokens: Number(request.maxOutputTokens) || 4096,
        ...(own(request, 'temperature') && request.temperature !== undefined
          ? request.temperature === null || request.temperature === ''
            ? { temperature: null }
            : Number.isFinite(Number(request.temperature)) ? { temperature: Number(request.temperature) } : {}
          : {}),
        ...(own(request, 'chatTokenLimitField') && request.chatTokenLimitField !== undefined
          ? { chatTokenLimitField: request.chatTokenLimitField === null || request.chatTokenLimitField === '' ? null : String(request.chatTokenLimitField) }
          : {}),
      },
      compatibility: {
        toolMode: ['native', 'text-compat', 'none'].includes(compatibility.toolMode) ? compatibility.toolMode : 'native',
        streamMode: ['auto', 'on', 'off'].includes(compatibility.streamMode) ? compatibility.streamMode : 'auto',
        includeUsage: compatibility.includeUsage === true,
      },
      capabilities: normalizedCapabilities,
    };
    if (Number.isSafeInteger(model.revision) && model.revision > 0) draft.revision = model.revision;
    return draft;
  }

  function normalizeToolPolicy(assistant, policy) {
    const id = String(assistant?.id || '');
    const builtIn = assistant?.builtIn === true;
    const codex = id === 'assistant_codex' && builtIn;
    const values = Array.isArray(policy?.allowedTools) ? policy.allowedTools : [];
    const allowedTools = [...new Set(values.map((entry) => String(entry || '').trim()).filter((entry) => {
      if (codex && entry === HOST_AUTHORIZED_TOOLS) return true;
      return entry !== HOST_AUTHORIZED_TOOLS && entry !== '*' && TOOL_NAME_RE.test(entry);
    }))].slice(0, 256);
    if (policy?.mode !== 'allowlist' || allowedTools.length === 0) return { mode: 'none', allowedTools: [] };
    return { mode: 'allowlist', allowedTools };
  }

  function createAssistantDraft(input = {}) {
    const id = String(input.id || `assistant_${Date.now().toString(36)}`);
    const builtIn = input.builtIn === true && ['assistant_codex', 'assistant_general'].includes(id);
    const codex = id === 'assistant_codex' && builtIn;
    return {
      id,
      name: String(input.name || (codex ? 'Codex' : '新助手')),
      builtIn,
      identityType: 'ai',
      modelProfileId: input.modelProfileId || null,
      ...(Number.isSafeInteger(input.revision) && input.revision > 0 ? { revision: input.revision } : {}),
      systemPrompt: String(input.systemPrompt || ''),
      knowledge: input.knowledge && typeof input.knowledge === 'object'
        ? { projectContext: input.knowledge.projectContext === true, projectMemory: input.knowledge.projectMemory === true }
        : { projectContext: codex, projectMemory: codex },
      projectId: input.projectId || null,
      toolPolicy: normalizeToolPolicy({ id, builtIn }, input.toolPolicy || (codex ? { mode: 'allowlist', allowedTools: [HOST_AUTHORIZED_TOOLS] } : { mode: 'none', allowedTools: [] })),
      ...(input.archived === true ? { archived: true } : {}),
    };
  }

  function assistantDraftForSave(input) {
    const assistant = createAssistantDraft(input);
    return {
      id: assistant.id,
      name: assistant.name,
      builtIn: assistant.builtIn,
      identityType: 'ai',
      ...(assistant.revision ? { revision: assistant.revision } : {}),
      modelProfileId: assistant.modelProfileId,
      systemPrompt: assistant.systemPrompt,
      knowledge: assistant.knowledge,
      projectId: assistant.projectId,
      toolPolicy: normalizeToolPolicy(assistant, assistant.toolPolicy),
      ...(assistant.archived ? { archived: true } : {}),
    };
  }

  function modelWireFingerprint(registry, modelProfileId) {
    const model = (registry?.models || []).find((item) => item.id === modelProfileId);
    if (!model) return null;
    if (typeof model.bindingRevision === 'string' && model.bindingRevision) return model.bindingRevision;
    const provider = (registry?.providers || []).find((item) => item.id === model.providerId);
    if (!provider) return null;
    let endpoint = String(provider.baseUrl || '').replace(/\/+$/, '');
    try { endpoint = new URL(endpoint).toString().replace(/\/+$/, ''); } catch {}
    return JSON.stringify({ protocol: provider.protocol, endpoint, authKind: provider.auth?.kind,
      model: model.model, request: model.request || {}, compatibility: model.compatibility || {} });
  }

  function getSwitchWarning({ current, next, hasContext, autoCompact }) {
    let sameOrigin = false;
    try { sameOrigin = Boolean(current?.origin && next?.origin && new URL(current.origin).origin === new URL(next.origin).origin); } catch { /* unknown origins require confirmation */ }
    const changedTarget = Boolean(next && (!current || current.id !== next.id || current.providerId !== next.providerId || !sameOrigin));
    return {
      required: Boolean(hasContext && changedTarget),
      contextDisclosed: Boolean(hasContext && changedTarget),
      autoCompactTarget: autoCompact && changedTarget ? (next?.id || 'default model') : null,
      sameOrigin,
    };
  }

  function createModelManager(api, { beforeMutation } = {}) {
    const state = emptyState();
    const listeners = new Set();
    const pendingDiagnosticEvents = new Map();
    const notify = () => listeners.forEach((listener) => listener(getState()));
    const getState = () => clone(state);

    function applyResult(result = {}) {
      if (result.registry && typeof result.registry === 'object') {
        const nextRevision = Number.isSafeInteger(result.revision) ? result.revision : result.registry.revision;
        if (Number.isSafeInteger(nextRevision) && nextRevision < state.revision) return result;
        state.registry = clone(result.registry);
        state.revision = Number.isSafeInteger(nextRevision) ? nextRevision : state.revision;
        for (const item of Object.values(state.diagnostics)) item.stale = item.bindingFingerprint !== modelWireFingerprint(state.registry, item.modelProfileId) || item.status === 'stale';
      } else if (Number.isSafeInteger(result.revision)) {
        state.revision = Math.max(state.revision, result.revision);
      }
      if (result.mode === 'local' || result.mode === 'api') state.mode = result.mode;
      if (result.cleanupState === 'pending' || result.cleanupState === 'clean') state.cleanupState = result.cleanupState;
      if (Number.isSafeInteger(result.pendingCleanupCount) && result.pendingCleanupCount >= 0) state.pendingCleanupCount = result.pendingCleanupCount;
      if (result.ok === false) state.error = String(result.error || result.code || '操作失败');
      else state.error = '';
      notify();
      return result;
    }

    async function invoke(method, payload = {}) {
      if (typeof api?.[method] !== 'function') return applyResult({ ok: false, code: 'API_UNAVAILABLE', error: '模型管理接口暂不可用' });
      try {
        if (typeof beforeMutation === 'function' && method !== 'diagnoseModel') {
          const sync = await beforeMutation();
          if (sync?.ok === false) return applyResult({ ok: false, code: sync.code || 'SESSION_REFERENCES_UNAVAILABLE', error: sync.error || '会话引用未同步，未提交配置' });
        }
        const result = await api[method]({ ...payload, expectedRevision: state.revision });
        if (result?.ok === false && ['CONFLICT', 'CONFIG_CONFLICT'].includes(result.code)) {
          applyResult(result);
          await load();
          return applyResult({ ...result, error: result.error || '配置已变化，已刷新列表；请核对保留的编辑后重新提交。' });
        }
        return applyResult(result || { ok: false, code: 'EMPTY_RESPONSE', error: '没有收到模型管理响应' });
      } catch (error) { return applyResult({ ok: false, code: 'IPC_FAILED', error: error?.message || '模型管理传输失败' }); }
    }

    async function load() {
      if (typeof api?.listModels !== 'function') return applyResult({ ok: false, code: 'API_UNAVAILABLE', error: '模型管理接口暂不可用' });
      try {
        const result = await api.listModels();
        state.loaded = Boolean(result?.registry && result?.ok !== false);
        return applyResult(result || {});
      } catch (error) {
        state.error = error?.message || '模型列表加载失败'; notify();
        return { ok: false, error: state.error };
      }
    }

    function previewDiagnosis(modelProfileId, checks) {
      const selected = [...new Set((Array.isArray(checks) ? checks : []).filter((check) => DIAGNOSTIC_CHECKS.includes(check)))];
      const model = (state.registry?.models || []).find((item) => item.id === modelProfileId);
      const provider = (state.registry?.providers || []).find((item) => item.id === model?.providerId);
      let origin = ''; try { origin = new URL(provider?.baseUrl || '').origin; } catch {}
      return { origin, protocol: provider?.protocol || '', model: model?.model || '',
        bindingRevision: modelWireFingerprint(state.registry, modelProfileId), maxOutputTokens: 128, timeoutMs: 15000, maxResponseBytes: 256 * 1024,
        modelProfileId: String(modelProfileId || ''), checks: selected, synthetic: true, externalRequests: 0, potentialRequests: selected.reduce((total, check) => total + (check === 'nativeTools' ? 2 : 1), 0), estimatedCost: null, registryRevision: state.revision };
    }

    async function startDiagnosis(modelProfileId, checks) {
      const preview = previewDiagnosis(modelProfileId, checks);
      if (!preview.modelProfileId || !preview.checks.length) return { ok: false, code: 'DIAGNOSIS_INVALID', error: '选择模型和至少一项检查' };
      const expectedRevision = state.revision;
      const retained = Object.values(state.diagnostics);
      if (retained.length >= 32) {
        const removable = retained.find((item) => item.terminal);
        if (!removable) return applyResult({ ok: false, code: 'DIAGNOSTIC_UI_LIMIT', error: '诊断队列已满，请等待已有任务完成' });
        delete state.diagnostics[removable.diagnosticId];
      }
      const result = await invoke('diagnoseModel', { modelProfileId: preview.modelProfileId, checks: preview.checks });
      if (result?.ok && result.diagnosticId) {
        const task = result.task || {};
        state.diagnostics[result.diagnosticId] = {
          diagnosticId: String(result.diagnosticId), modelProfileId: preview.modelProfileId,
          expectedRevision, bindingFingerprint: preview.bindingRevision, status: 'queued', task, terminal: false, cancelling: false,
          startedAt: result.startedAt || null, completedAt: null, requestCount: 0,
          sessionId: result.sessionId || task.sessionId || null,
          runId: result.runId || task.runId || null,
          clientRequestId: result.clientRequestId || task.clientRequestId || null,
          modelSource: result.modelSource || null, results: {}, stale: preview.bindingRevision !== modelWireFingerprint(state.registry, preview.modelProfileId),
        };
        for (const event of pendingDiagnosticEvents.get(String(result.diagnosticId)) || []) onDiagnosticEvent(event);
        pendingDiagnosticEvents.delete(String(result.diagnosticId));
        notify();
      }
      return result;
    }

    function onDiagnosticEvent(event = {}) {
      const current = state.diagnostics[event.diagnosticId];
      if (!current) {
        if (typeof event.diagnosticId === 'string' && event.diagnosticId.length <= 160
          && typeof event.sessionId === 'string' && typeof event.runId === 'string' && typeof event.clientRequestId === 'string') {
          const key = event.diagnosticId;
          if (!pendingDiagnosticEvents.has(key) && pendingDiagnosticEvents.size >= 16) return false;
          const pending = pendingDiagnosticEvents.get(key) || [];
          if (pending.length < 20) pending.push(clone(event));
          pendingDiagnosticEvents.set(key, pending);
        }
        return false;
      }
      if (current.terminal || event.modelProfileId !== current.modelProfileId
        || event.sessionId !== current.sessionId || event.runId !== current.runId || event.clientRequestId !== current.clientRequestId) return false;
      current.stale = current.bindingFingerprint !== modelWireFingerprint(state.registry, current.modelProfileId) || event.state === 'stale';
      current.status = String(event.state || event.type || 'unknown');
      if (event.check && DIAGNOSTIC_CHECKS.includes(event.check) && event.result) current.results[event.check] = clone(event.result);
      if (event.checks && typeof event.checks === 'object') {
        for (const check of DIAGNOSTIC_CHECKS) if (event.checks[check]) current.results[check] = clone(event.checks[check]);
      }
      if (Array.isArray(event.results)) for (const item of event.results.slice(0, 4)) {
        if (DIAGNOSTIC_CHECKS.includes(item?.check)) current.results[item.check] = clone(item.result || item);
      }
      if (event.task) current.task = clone(event.task);
      if (event.modelSource) current.modelSource = clone(event.modelSource);
      if (typeof event.bindingRevision === 'string') current.bindingRevision = event.bindingRevision;
      if (typeof event.startedAt === 'string') current.startedAt = event.startedAt;
      if (typeof event.completedAt === 'string') current.completedAt = event.completedAt;
      if (Number.isSafeInteger(event.requestCount)) current.requestCount = Math.min(5, Math.max(0, event.requestCount));
      if (event.code) current.code = String(event.code).slice(0, 160);
      if (['done', 'error', 'cancelled', 'aborted'].includes(event.type)) {
        current.terminal = true; current.cancelling = false;
        if (event.type === 'done' && !event.state) current.status = 'passed';
        if (event.type === 'error' && !event.state) current.status = 'failed';
      }
      notify();
      return true;
    }

    if (typeof api?.onModelDiagnosticEvent === 'function') api.onModelDiagnosticEvent(onDiagnosticEvent);
    let registryRefreshing = false, requestedRegistryRevision = 0;
    if (typeof api?.onModelRegistryChanged === 'function') api.onModelRegistryChanged(async (event) => {
      if (!Number.isSafeInteger(event?.revision) || event.revision <= state.revision) return;
      requestedRegistryRevision = Math.max(requestedRegistryRevision, event.revision);
      if (registryRefreshing) return;
      registryRefreshing = true;
      try {
        do {
          const requested = requestedRegistryRevision, result = await load();
          if (result?.ok === false || state.revision < requested) break;
        } while (requestedRegistryRevision > state.revision);
      } finally { registryRefreshing = false; }
    });

    return {
      load,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      getState,
      applyResult,
      loadAssistants: async () => {
        if (typeof api?.listAssistants !== 'function') return { ok: false, error: '助手管理接口暂不可用' };
        try { return applyResult(await api.listAssistants()); } catch (error) { return { ok: false, error: error?.message || '助手列表加载失败' }; }
      },
      saveProvider: (provider) => invoke('saveModelProvider', { provider: providerDraftForSave(provider) }),
      saveModel: (model) => invoke('saveModelProfile', { model: modelDraftForSave(model) }),
      setDefault: (modelProfileId) => invoke('setDefaultModel', { modelProfileId: String(modelProfileId || '') }),
      remove: (kind, id) => invoke('removeModelProfile', { kind, id: String(id || '') }),
      setCredential: (providerId, credential) => invoke('setModelCredential', { providerId: String(providerId || ''), credential: String(credential || '') }),
      clearCredential: (providerId) => invoke('clearModelCredential', { providerId: String(providerId || '') }),
      retryCleanup: () => invoke('retryModelCredentialCleanup'),
      saveAssistant: (assistant) => invoke('saveAssistant', { assistant: assistantDraftForSave(assistant) }),
      deleteAssistant: (assistantId) => invoke('deleteAssistant', { assistantId: String(assistantId || '') }),
      previewDiagnosis,
      startDiagnosis,
      cancelDiagnosis: async (diagnosticId) => {
        const item = state.diagnostics[String(diagnosticId || '')];
        if (!item?.sessionId || !item?.runId || !item?.clientRequestId || item.terminal || typeof api?.cancelModelDiagnosis !== 'function') return { ok: false, code: 'DIAGNOSTIC_SCOPE_MISSING', error: '诊断任务尚未返回完整取消归属或已结束' };
        try {
          const result = await api.cancelModelDiagnosis({ diagnosticId: item.diagnosticId, sessionId: item.sessionId, runId: item.runId, clientRequestId: item.clientRequestId });
          if (result?.ok && !item.terminal) { item.cancelling = true; item.status = 'cancelling'; notify(); }
          return result;
        } catch (error) { return applyResult({ ok: false, code: 'IPC_FAILED', error: error?.message || '诊断取消失败' }); }
      },
      onDiagnosticEvent,
    };
  }

  function createModelSettingsUi({ root, api, onClose, getProjects = () => [], beforeMutation } = {}) {
    const manager = createModelManager(api, { beforeMutation });
    const ui = { tab: 'providers', providerId: '', modelId: '', assistantId: '', diagnosticPreview: null, diagnosticModelId: '', diagnosticChecks: [...DIAGNOSTIC_CHECKS], message: '' };
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
    const state = () => manager.getState();
    const registry = () => state().registry || { providers: [], models: [], assistants: [], defaultModelProfileId: null };
    const providers = () => registry().providers || [];
    const models = () => registry().models || [];
    const assistants = () => registry().assistants || [];
    const selectedProvider = () => providers().find((item) => item.id === ui.providerId) || null;
    const selectedModel = () => models().find((item) => item.id === ui.modelId) || null;
    const selectedAssistant = () => assistants().find((item) => item.id === ui.assistantId) || null;
    const editDrafts = new Map();
    let renderingEditKey = null;
    const editableFields = {
      provider: ['id', 'name', 'protocol', 'baseUrl', 'authKind', 'plainHttpAccepted'],
      model: ['id', 'name', 'providerId', 'model', 'maxOutputTokens', 'temperature', 'chatTokenLimitField', 'toolMode', 'streamMode', 'includeUsage', ...CAPABILITIES.map((name) => `cap-${name}`), 'contextWindowTokens'],
      assistant: ['id', 'name', 'modelProfileId', 'projectId', 'systemPrompt', 'projectContext', 'projectMemory', 'hostAuthorized', 'toolMode', 'allowedTools'],
    };
    const editKey = (kind) => own(editableFields, kind)
      ? `${kind}:${kind === 'provider' ? ui.providerId : kind === 'model' ? ui.modelId : ui.assistantId}` : null;
    const retainedValue = (name, value) => {
      const data = editDrafts.get(renderingEditKey)?.data;
      return data && own(data, name) ? data[name] : value;
    };
    const retainedChecked = (name, checked) => retainedValue(name, checked ? 'on' : '') === 'on';
    function retainFormDraft(form) {
      const kind = form?.dataset?.form;
      if (!own(editableFields, kind)) return null;
      const key = editKey(kind), values = formData(form), data = {};
      for (const name of editableFields[kind]) if (own(values, name)) data[name] = values[name];
      const checkboxes = kind === 'provider' ? ['plainHttpAccepted'] : kind === 'model' ? ['includeUsage'] : ['projectContext', 'projectMemory', 'hostAuthorized'];
      for (const name of checkboxes) data[name] = form.querySelector(`[name="${name}"]`)?.checked ? 'on' : '';
      const draft = { data, ...(kind === 'model' ? { capabilities: editDrafts.get(key)?.capabilities || clone(selectedModel()?.capabilities || {}) } : {}) };
      editDrafts.set(key, draft);
      return { key, draft };
    }
    const projectOptions = (selectedId = '') => {
      let list = [];
      try { list = getProjects(); } catch { /* retain an unavailable existing association below */ }
      const entries = (Array.isArray(list) ? list : [])
        .filter((item) => item && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 128)
        .map((item) => [item.id, String(item.name || item.id)]);
      if (selectedId && !entries.some(([id]) => id === selectedId)) entries.unshift([selectedId, `当前关联项目不可用：${selectedId}`]);
      return [['', '不关联项目'], ...entries];
    };
    const diagnosticPreviewCurrent = () => {
      const preview = ui.diagnosticPreview;
      return Boolean(preview?.bindingRevision && preview.bindingRevision === manager.previewDiagnosis(preview.modelProfileId, preview.checks).bindingRevision);
    };
    const input = (label, name, value = '', type = 'text', attrs = '') => `<label class="field"><span>${esc(label)}</span><input name="${esc(name)}" type="${type}" value="${esc(retainedValue(name, value))}" ${attrs}></label>`;
    const select = (label, name, value, options) => `<label class="field"><span>${esc(label)}</span><select name="${esc(name)}">${options.map(([key, text]) => `<option value="${esc(key)}" ${key === retainedValue(name, value) ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
    const capabilitySelect = (name, raw = {}) => {
      const current = ['supported', 'unsupported', 'unknown'].includes(raw?.state) ? raw.state : 'unknown';
      const source = ['declared', 'observed'].includes(raw?.source) ? raw.source : 'unknown';
      return `<label class="field"><span>${esc(name)}</span><small>当前：${esc(current)} · ${esc(source)}</small><select name="cap-${esc(name)}">${[['unknown', '声明未知'], ['supported', '声明支持'], ['unsupported', '声明不支持']].map(([value, label]) => `<option value="${value}" ${value === retainedValue(`cap-${name}`, source === 'declared' ? current : 'unknown') ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
    };
    const panelHead = (title, action = '') => `<div class="e4-panel-head"><h2>${esc(title)}</h2>${action}</div>`;
    const renderStatus = () => {
      const current = state();
      return `<div class="e4-status"><span>修订 ${current.revision}</span><span>${current.mode === 'api' ? 'API' : '本地'}</span>${current.cleanupState === 'pending' ? `<span class="e4-warning">凭据清理待重试 (${current.pendingCleanupCount}) <button type="button" class="btn-small" data-action="retry-cleanup">重试清理</button></span>` : ''}</div>${current.error ? `<div class="e4-error" role="alert">${esc(current.error)}</div>` : ''}${ui.message ? `<div class="e4-notice" role="status">${esc(ui.message)}</div>` : ''}`;
    };
    const renderProviderList = () => providers().map((item) => `<button type="button" class="e4-list-row ${item.id === ui.providerId ? 'selected' : ''}" data-edit-provider="${esc(item.id)}"><span>${esc(item.name)}</span><small>${esc(item.protocol)} · ${esc(item.auth?.kind || 'auth unknown')} · Key ${esc(item.credentialState || 'unset')}</small></button>`).join('') || '<div class="muted">尚无服务商</div>';
    const renderProviderForm = () => {
      const current = selectedProvider();
      const item = current || { id: '', name: '', protocol: 'openai-chat-completions', baseUrl: '', auth: { kind: 'bearer' } };
      const authKind = item.protocol === 'anthropic-messages' ? 'api-key' : (item.auth?.kind || 'bearer');
      const confirmedOrigin = (() => { try { return item.transportConfirmation?.origin === new URL(item.baseUrl).origin && item.transportConfirmation?.plainHttpAcceptedAt ? item.transportConfirmation.origin : ''; } catch { return ''; } })();
      const form = `<form data-form="provider">${input('ID', 'id', item.id, 'text', 'required maxlength="80"')}${input('显示名称', 'name', item.name, 'text', 'required maxlength="128"')}${select('协议', 'protocol', item.protocol, PROTOCOLS.map((value) => [value, value]))}${input('Base URL', 'baseUrl', item.baseUrl, 'url', 'required maxlength="2048" placeholder="https://…"')}<label class="switch-row"><input type="checkbox" name="plainHttpAccepted" ${retainedChecked('plainHttpAccepted', Boolean(confirmedOrigin)) ? 'checked' : ''}><span>允许将数据以明文 HTTP 发往此 origin</span></label>${select('认证类型', 'authKind', authKind, item.protocol === 'anthropic-messages' ? [['api-key', 'API Key']] : [['bearer', 'Bearer'], ['none', '无认证']])}<div class="e4-form-actions"><button class="btn-primary" type="submit">保存服务商</button>${current ? `<button class="btn-danger" type="button" data-remove-provider="${esc(item.id)}">删除</button>` : ''}</div></form>`;
      const credential = current ? `<div class="e4-credential">${panelHead('凭据', `<span>状态：${esc(item.credentialState || 'unset')}</span>`)}<form data-form="credential">${input('本次输入密钥', 'credential', '', 'password', 'autocomplete="new-password" maxlength="4096"')}<div class="e4-form-actions"><button class="btn-primary" type="submit">设置密钥</button><button class="btn-secondary" type="button" data-clear-credential="${esc(item.id)}">清除密钥</button></div></form></div>` : '';
      return `<div class="e4-columns"><div class="e4-list">${panelHead('服务商', '<button type="button" class="btn-small" data-action="new-provider">新增</button>')}${renderProviderList()}</div><div class="e4-editor">${panelHead(current ? '编辑服务商' : '新服务商')}${form}${credential}</div></div>`;
    };
    const renderModelList = () => models().map((item) => {
      const provider = providers().find((entry) => entry.id === item.providerId);
      const isDefault = registry().defaultModelProfileId === item.id;
      return `<div class="e4-list-row ${item.id === ui.modelId ? 'selected' : ''}"><button type="button" class="e4-row-main" data-edit-model="${esc(item.id)}"><span>${esc(item.name)}</span><small>${esc(provider?.name || item.providerId)} · ${esc(item.model)}${isDefault ? ' · 默认' : ''}</small></button><button type="button" class="btn-small" data-default-model="${esc(item.id)}" ${isDefault ? 'disabled' : ''} title="设为默认模型">默认</button></div>`;
    }).join('') || '<div class="muted">尚无模型</div>';
    const renderModelForm = () => {
      const current = selectedModel();
      const item = current || { id: '', name: '', providerId: providers()[0]?.id || '', model: '', request: { maxOutputTokens: 4096 }, compatibility: { toolMode: 'native', streamMode: 'auto', includeUsage: false }, capabilities: {} };
      const caps = item.capabilities || {};
      const form = `<form data-form="model">${input('Profile ID', 'id', item.id, 'text', 'required maxlength="80"')}${input('显示名称', 'name', item.name, 'text', 'required maxlength="128"')}${select('服务商', 'providerId', item.providerId, providers().map((entry) => [entry.id, entry.name]))}${input('远端模型名', 'model', item.model, 'text', 'required maxlength="256"')}${input('最大输出 tokens', 'maxOutputTokens', item.request?.maxOutputTokens || 4096, 'number', 'min="1" max="32768" required')}${input('Temperature', 'temperature', item.request?.temperature ?? '', 'number', 'min="0" max="2" step="0.01"')}${input('Chat token limit JSON field', 'chatTokenLimitField', item.request?.chatTokenLimitField || '', 'text', 'maxlength="100"')}${select('工具兼容', 'toolMode', item.compatibility?.toolMode || 'native', [['native', 'Native tools'], ['text-compat', 'Text compatibility'], ['none', '不使用工具']])}${select('Streaming', 'streamMode', item.compatibility?.streamMode || 'auto', [['auto', '自动'], ['on', '开启'], ['off', '关闭']])}<label class="switch-row"><input type="checkbox" name="includeUsage" ${retainedChecked('includeUsage', item.compatibility?.includeUsage === true) ? 'checked' : ''}><span>请求 usage</span></label><fieldset class="e4-capabilities"><legend>能力声明</legend>${CAPABILITIES.map((name) => capabilitySelect(name, caps[name])).join('')}<p class="muted">Context window 当前：${esc(caps.contextWindow?.tokens ?? '未知')} · ${esc(caps.contextWindow?.source || 'unknown')}</p>${input('Context window tokens', 'contextWindowTokens', caps.contextWindow?.source === 'declared' ? caps.contextWindow.tokens : '', 'number', 'min="1" max="10000000"')}</fieldset><div class="e4-form-actions"><button class="btn-primary" type="submit">保存模型</button>${current ? `<button class="btn-danger" type="button" data-remove-model="${esc(item.id)}">删除模型</button>` : ''}</div></form>`;
      return `<div class="e4-columns"><div class="e4-list">${panelHead('模型', '<button type="button" class="btn-small" data-action="new-model">新增</button>')}${renderModelList()}</div><div class="e4-editor">${panelHead(current ? '编辑模型' : '新模型')}${providers().length ? form : '<div class="muted">请先配置服务商。</div>'}</div></div>`;
    };
    const renderAssistantList = () => assistants().map((item) => `<button type="button" class="e4-list-row ${item.id === ui.assistantId ? 'selected' : ''}" data-edit-assistant="${esc(item.id)}"><span>${esc(item.name)}${item.builtIn ? ' · 内置' : ''}</span><small>${esc(item.identityType || 'ai')} · ${esc(item.modelProfileId || '跟随默认')}</small></button>`).join('') || '<div class="muted">尚无助手</div>';
    const renderAssistantForm = () => {
      const current = selectedAssistant();
      const item = current ? createAssistantDraft(current) : createAssistantDraft();
      const codex = item.id === 'assistant_codex' && item.builtIn;
      const allowed = item.toolPolicy?.allowedTools || [];
      const toolText = allowed.filter((name) => name !== HOST_AUTHORIZED_TOOLS).join(', ');
      const hostConfirmation = codex ? `<label class="switch-row"><input type="checkbox" name="hostAuthorized" ${retainedChecked('hostAuthorized', allowed.includes(HOST_AUTHORIZED_TOOLS)) ? 'checked' : ''}><span>宿主已授权工具（仍受项目权限与审批限制）</span></label>` : '';
      return `<div class="e4-columns"><div class="e4-list">${panelHead('AI 助手', '<button type="button" class="btn-small" data-action="new-assistant">新增</button>')}${renderAssistantList()}</div><div class="e4-editor">${panelHead(current ? '编辑助手' : '新助手')}<form data-form="assistant">${input('助手 ID', 'id', item.id, 'text', `required maxlength="80" ${item.builtIn ? 'readonly' : ''}`)}${input('名称', 'name', item.name, 'text', 'required maxlength="128"')}${select('默认模型', 'modelProfileId', item.modelProfileId || '', [['', '跟随全局默认'], ...models().map((model) => [model.id, model.name])])}${select('关联项目', 'projectId', item.projectId || '', projectOptions(retainedValue('projectId', item.projectId || '')))}<label class="field"><span>System prompt</span><textarea name="systemPrompt" rows="5" maxlength="16384">${esc(retainedValue('systemPrompt', item.systemPrompt))}</textarea></label><label class="switch-row"><input type="checkbox" name="projectContext" ${retainedChecked('projectContext', item.knowledge.projectContext) ? 'checked' : ''}><span>注入项目上下文</span></label><label class="switch-row"><input type="checkbox" name="projectMemory" ${retainedChecked('projectMemory', item.knowledge.projectMemory) ? 'checked' : ''}><span>注入项目记忆</span></label>${hostConfirmation}${select('工具策略', 'toolMode', item.toolPolicy.mode, [['none', '无工具'], ['allowlist', '精确 allowlist']])}${input(codex ? '精确工具名（逗号分隔，可收紧）' : '精确工具名（逗号分隔）', 'allowedTools', toolText, 'text', 'maxlength="2048"')}<div class="e4-form-actions"><button class="btn-primary" type="submit">保存助手</button>${current && !item.builtIn ? `<button class="btn-danger" type="button" data-delete-assistant="${esc(item.id)}">删除助手</button>` : ''}</div></form><div class="e4-note">AI 助手不是在线真人。新建助手默认不注入知识且不授予工具。</div></div></div>`;
    };
    const renderDiagnosticPreview = () => {
      const preview = ui.diagnosticPreview;
      if (!preview) return '';
      return `<div class="e4-diagnostic-preview"><dl><dt>Origin</dt><dd>${esc(preview.origin || '未知')}</dd><dt>协议</dt><dd>${esc(preview.protocol || '未知')}</dd><dt>远端模型</dt><dd>${esc(preview.model || '未知')}</dd><dt>Profile</dt><dd>${esc(preview.modelProfileId)}</dd><dt>检查项</dt><dd>${esc(preview.checks.join(', '))}</dd></dl><p>${preview.potentialRequests} 个可能请求 · 输入仅为合成数据 · 可能产生费用（金额无法预估）</p><p>每项最多 ${preview.timeoutMs / 1000} 秒 · ${preview.maxOutputTokens} 输出 tokens · ${preview.maxResponseBytes / 1024} KiB 响应</p></div>`;
    };
    const renderDiagnostics = () => {
      const selectedId = ui.diagnosticPreview?.modelProfileId || ui.diagnosticModelId || models()[0]?.id || '';
      const selectedChecks = ui.diagnosticPreview?.checks || ui.diagnosticChecks;
      const choices = models().map((item) => `<option value="${esc(item.id)}" ${item.id === selectedId ? 'selected' : ''}>${esc(item.name)} · ${esc(item.model)}</option>`).join('');
      const previews = Object.values(state().diagnostics || {}).map((item) => {
        const cancellable = ['queued', 'running', 'start', 'check-start', 'check-result'].includes(item.status) && Boolean(item.sessionId && item.runId && item.clientRequestId);
        const count = Number.isSafeInteger(item.requestCount) && item.requestCount >= 0 ? item.requestCount : '未知';
        return `<div class="e4-diagnostic"><strong>${esc(item.modelProfileId)}</strong> <span>${item.stale ? 'stale' : esc(item.status)}</span>${item.modelSource ? `<small>${esc(item.modelSource.kind)} · ${esc(item.modelSource.model || '')}</small>` : ''}<small>开始：${esc(item.startedAt || '未开始')} · 完成：${esc(item.completedAt || '未完成')} · 请求数：${esc(count)}</small><pre>${esc(JSON.stringify(item.results || {}, null, 2))}</pre><button type="button" class="btn-small" data-cancel-diagnostic="${esc(item.diagnosticId)}" ${cancellable ? '' : 'disabled'}>取消</button></div>`;
      }).join('');
      return `${panelHead('模型诊断')}<form data-form="diagnostic"><label class="field"><span>模型</span><select name="modelProfileId">${choices}</select></label><fieldset class="e4-checks"><legend>检查项</legend>${DIAGNOSTIC_CHECKS.map((check) => `<label><input type="checkbox" name="check" value="${check}" ${selectedChecks.includes(check) ? 'checked' : ''}><span>${check}</span></label>`).join('')}</fieldset><div class="e4-form-actions"><button type="button" class="btn-secondary" data-action="preview-diagnosis">预览合成请求</button><button type="submit" class="btn-primary" ${ui.diagnosticPreview ? '' : 'disabled'}>启动诊断</button></div></form>${renderDiagnosticPreview()}${previews || '<div class="muted">暂无诊断任务</div>'}`;
    };
    function render() {
      if (!root) return;
      const tab = ui.tab;
      renderingEditKey = editKey(tab === 'providers' ? 'provider' : tab === 'models' ? 'model' : tab === 'assistants' ? 'assistant' : 'diagnostic');
      const tabs = [['providers', '服务商'], ['models', '模型'], ['assistants', '助手'], ['diagnostics', '诊断']];
      const body = tab === 'providers' ? renderProviderForm() : tab === 'models' ? renderModelForm() : tab === 'assistants' ? renderAssistantForm() : renderDiagnostics();
      root.innerHTML = renderStatus() + `<nav class="e4-tabs" aria-label="模型管理">${tabs.map(([key, label]) => `<button type="button" class="e4-tab ${tab === key ? 'selected' : ''}" data-tab="${key}">${label}</button>`).join('')}</nav><div class="e4-body">${body}</div>`;
    }
    function formData(form) { return Object.fromEntries(new FormData(form).entries()); }
    function capabilityDraft(data, existing = {}) {
      const result = {};
      for (const name of CAPABILITIES) {
        const value = data[`cap-${name}`] || 'unknown';
        const previous = existing[name]?.source === 'declared' ? existing[name].state : 'unknown';
        if (value !== previous) result[name] = declaredCapability({ state: value, source: value === 'unknown' ? 'unknown' : 'declared' });
      }
      const rawTokens = Number(data.contextWindowTokens);
      const tokens = Number.isSafeInteger(rawTokens) && rawTokens > 0 ? rawTokens : null;
      const previousTokens = existing.contextWindow?.source === 'declared' ? existing.contextWindow.tokens : null;
      if (tokens !== previousTokens) result.contextWindow = { tokens, source: tokens === null ? 'unknown' : 'declared', checkedAt: null, bindingRevision: null };
      return result;
    }
    async function refresh() { await manager.load(); if (api?.listAssistants) await manager.loadAssistants(); render(); }
    async function act(promise, success, submitted = null) {
      const result = await promise;
      if (result?.ok && submitted && editDrafts.get(submitted.key) === submitted.draft) editDrafts.delete(submitted.key);
      ui.message = result?.ok ? success : (result?.error || '操作失败');
      if (result?.ok) { ui.providerId = providers().some((item) => item.id === ui.providerId) ? ui.providerId : providers()[0]?.id || ''; ui.modelId = models().some((item) => item.id === ui.modelId) ? ui.modelId : models()[0]?.id || ''; ui.assistantId = assistants().some((item) => item.id === ui.assistantId) ? ui.assistantId : assistants()[0]?.id || ''; }
      render();
      return result;
    }
    root?.addEventListener('input', (event) => retainFormDraft(event.target?.closest?.('form[data-form]')));
    root?.addEventListener('change', (event) => retainFormDraft(event.target?.closest?.('form[data-form]')));
    root?.addEventListener('click', async (event) => {
      const button = event.target.closest('button'); if (!button) return;
      if (button.dataset.tab) { ui.tab = button.dataset.tab; ui.message = ''; render(); }
      else if (button.dataset.editProvider) { ui.providerId = button.dataset.editProvider; render(); }
      else if (button.dataset.editModel) { ui.modelId = button.dataset.editModel; render(); }
      else if (button.dataset.editAssistant) { ui.assistantId = button.dataset.editAssistant; render(); }
      else if (button.dataset.action === 'new-provider') { ui.providerId = ''; render(); }
      else if (button.dataset.action === 'new-model') { ui.modelId = ''; render(); }
      else if (button.dataset.action === 'new-assistant') { ui.assistantId = ''; render(); }
      else if (button.dataset.action === 'preview-diagnosis') {
        const form = root.querySelector('[data-form="diagnostic"]'); const data = formData(form);
        ui.diagnosticModelId = data.modelProfileId;
        ui.diagnosticChecks = Array.from(form.querySelectorAll('[name="check"]:checked')).map((item) => item.value);
        const preview = manager.previewDiagnosis(ui.diagnosticModelId, ui.diagnosticChecks);
        ui.diagnosticPreview = preview.bindingRevision && preview.checks.length ? preview : null;
        ui.message = ui.diagnosticPreview ? '' : '请选择有效模型和至少一项检查';
        render();
      } else if (button.dataset.defaultModel) await act(manager.setDefault(button.dataset.defaultModel), '默认模型已更新');
      else if (button.dataset.removeProvider) { if (window.confirm('删除服务商及其未被引用配置？')) await act(manager.remove('provider', button.dataset.removeProvider), '服务商已删除'); }
      else if (button.dataset.removeModel) { if (window.confirm('删除此模型？')) await act(manager.remove('model', button.dataset.removeModel), '模型已删除'); }
      else if (button.dataset.deleteAssistant) await act(manager.deleteAssistant(button.dataset.deleteAssistant), '助手已删除或归档');
      else if (button.dataset.clearCredential) { if (window.confirm('清除该服务商凭据？')) await act(manager.clearCredential(button.dataset.clearCredential), '凭据清理已提交'); }
      else if (button.dataset.cancelDiagnostic) await act(manager.cancelDiagnosis(button.dataset.cancelDiagnostic), '已请求取消诊断');
      else if (button.dataset.action === 'retry-cleanup') await act(manager.retryCleanup(), '凭据清理已重试');
      else if (button.id === 'e4-model-manager-close') { onClose?.(); }
    });
    root?.addEventListener('submit', async (event) => {
      const form = event.target.closest('form[data-form]'); if (!form) return;
      event.preventDefault(); const data = formData(form); const kind = form.dataset.form;
      const submitted = retainFormDraft(form);
      if (kind === 'provider') {
        const previous = providers().find((item) => item.id === data.id);
        const protocol = data.protocol;
        const baseUrl = new URL(data.baseUrl);
        const previousConfirmation = previous?.transportConfirmation;
        const transportConfirmation = baseUrl.protocol === 'http:' && data.plainHttpAccepted === 'on'
          ? { origin: baseUrl.origin, plainHttpAcceptedAt: previousConfirmation?.origin === baseUrl.origin && previousConfirmation?.plainHttpAcceptedAt ? previousConfirmation.plainHttpAcceptedAt : new Date().toISOString() }
          : undefined;
        const provider = providerDraftForSave({ id: data.id, name: data.name, protocol, baseUrl: data.baseUrl, auth: { kind: protocol === 'anthropic-messages' ? 'api-key' : data.authKind }, ...(previous ? { revision: previous.revision } : {}), ...(transportConfirmation ? { transportConfirmation } : {}) });
        await act(manager.saveProvider(provider), '服务商已保存', submitted);
      } else if (kind === 'credential') {
        const credential = data.credential || '';
        if (!credential) { ui.message = '输入本次密钥后才能设置'; render(); return; }
        await act(manager.setCredential(ui.providerId, credential), '凭据已提交');
      } else if (kind === 'model') {
        const previous = models().find((item) => item.id === data.id);
        const model = { id: data.id, name: data.name, providerId: data.providerId, model: data.model, ...(previous ? { revision: previous.revision } : {}), request: { maxOutputTokens: Number(data.maxOutputTokens), temperature: data.temperature === '' || data.temperature == null ? null : Number(data.temperature), chatTokenLimitField: data.chatTokenLimitField || null }, compatibility: { toolMode: data.toolMode, streamMode: data.streamMode, includeUsage: form.querySelector('[name="includeUsage"]').checked }, capabilities: capabilityDraft(data, submitted?.draft?.capabilities || previous?.capabilities) };
        await act(manager.saveModel(model), '模型已保存', submitted);
      } else if (kind === 'assistant') {
        const previous = assistants().find((item) => item.id === data.id);
        const hostAuthorized = previous?.id === 'assistant_codex' && previous.builtIn === true && form.querySelector('[name="hostAuthorized"]')?.checked;
        const allowedTools = data.allowedTools.split(',').map((name) => name.trim()).filter(Boolean);
        if (hostAuthorized) allowedTools.push(HOST_AUTHORIZED_TOOLS);
        const assistant = { ...(previous || {}), id: data.id, name: data.name, builtIn: previous?.builtIn === true, identityType: 'ai', revision: previous?.revision, modelProfileId: data.modelProfileId || null, systemPrompt: data.systemPrompt || '', knowledge: { projectContext: form.querySelector('[name="projectContext"]').checked, projectMemory: form.querySelector('[name="projectMemory"]').checked }, projectId: data.projectId || null, toolPolicy: { mode: data.toolMode, allowedTools } };
        await act(manager.saveAssistant(assistant), '助手已保存', submitted);
      } else if (kind === 'diagnostic') {
        const checks = Array.from(form.querySelectorAll('[name="check"]:checked')).map((item) => item.value);
        if (!ui.diagnosticPreview || ui.diagnosticPreview.modelProfileId !== data.modelProfileId || JSON.stringify(ui.diagnosticPreview.checks) !== JSON.stringify(checks) || !diagnosticPreviewCurrent()) {
          ui.diagnosticPreview = null; ui.message = '模型、检查项或目标配置已变化，请重新预览合成请求'; render(); return;
        }
        const result = await act(manager.startDiagnosis(data.modelProfileId, checks), '诊断已启动');
        if (result?.ok) { ui.diagnosticPreview = null; render(); }
      }
    });
    manager.subscribe(() => {
      if (ui.diagnosticPreview && !diagnosticPreviewCurrent()) {
        ui.diagnosticPreview = null; ui.message = '诊断目标配置已变化，请重新预览合成请求';
      }
      render();
    });
    render();
    return { manager, render, refresh, getState: manager.getState, open: refresh };
  }

  return {
    CAPABILITIES, DIAGNOSTIC_CHECKS, PROTOCOLS, HOST_AUTHORIZED_TOOLS,
    providerDraftForSave, modelDraftForSave, createAssistantDraft, assistantDraftForSave,
    normalizeToolPolicy, getSwitchWarning, createModelManager, createModelSettingsUi,
  };
});
