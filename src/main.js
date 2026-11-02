const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage, Notification, powerMonitor } = require('electron');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const {
  loadSettings,
  saveSettings,
  clampInt,
  clampMemorySettings,
  normalizeDomainList,
  sanitizePricing,
  getSettingsSecretManager,
} = require('./ai/settings');
const { createModelIpcHandlers, registerModelIpc } = require('./ai/model-ipc');
const { createForegroundRuntime, publicModelSource } = require('./ai/model-runtime');
const { createModelChatFunction, preflightModelRequest } = require('./ai/model-router');
const { buildModelUsageEvent } = require('./ai/model-usage');
const { assistantContextPolicy, assertAssistantToolAllowed, filterAssistantTools } = require('./ai/assistant-policy');
const { generateLocalReply } = require('./ai/local-mock');
const {
  runAgentLoop,
  applyWriteFencesWithGate,
  buildUsageEvent,
} = require('./ai/agent');
const { createMemoryOnlyRegistry } = require('./ai/providers');
const { AGENT_EVENTS } = require('./ai/agent-events');
const { createPermissionGate } = require('./ai/permission');
const { TaskHandle, TASK_KINDS, createTaskEventEnvelope } = require('./ai/task-contract');
const { PlanStateManager } = require('./ai/plan-state');
const { authorizeHostExecution } = require('./ai/host-execution');
const { redactSecrets } = require('./ai/secret-manager');
const { createModelTextRedactor, redactModelPartialOutput } = require('./ai/model-text-redaction');
const { publicModelError } = require('./ai/model-errors');
const RUN_BUSINESS_ERRORS = Object.freeze({
  BUSY: '已有前台任务运行或清理中，请先等待其结束。',
  CONFIG_CONFLICT: '模型配置已改变，请核对最新配置后重新发送。',
  CONFIG_IN_USE: '模型配置仍在使用，请等待运行与清理完成。',
  ASSISTANT_IDENTITY_INVALID: '演示联系人不能调用模型；请新建 AI 助手会话。',
  ASSISTANT_TOOL_DENIED: '此助手未获准使用请求的工具。',
  ASSISTANT_PROJECT_MISMATCH: '此助手关联的项目与当前授权项目不一致。',
  PROJECT_BINDING_INVALID: '项目绑定已失效，请重新打开项目。',
  TOOL_PERMISSION_DENIED: '操作未获授权，请检查当前权限。',
  PLAN_BINDING_CHANGED: '模型、助手、权限或项目绑定已改变，请重新生成计划。',
  PLAN_NOT_FOUND: '计划不存在，请重新生成。',
  PLAN_NOT_PROPOSED: '计划已处理或过期，请重新生成。',
  PLAN_EXECUTION_ALREADY_STARTED: '计划执行已开始，请检查现场并生成新计划。',
  PLAN_EXECUTION_FAILED: '计划执行未完成，请检查现场并生成新计划。',
  PLAN_APPROVAL_FAILED: '无法接受计划执行，请检查绑定并重新生成计划。',
  INVALID_BINDING: '计划缺少可信的会话、项目或发送者绑定。',
  INVALID_CLAIM: '计划执行凭证无效，请重新生成计划。',
  DUPLICATE_PLAN: '计划标识已存在，请重新生成计划。',
});
function publicRunError(error, modelSource) {
  let code;
  try { code = Object.getOwnPropertyDescriptor(error || {}, 'code')?.value; } catch { /* no untrusted getter */ }
  const safeMessage = typeof code === 'string' && Object.hasOwn(RUN_BUSINESS_ERRORS, code) ? RUN_BUSINESS_ERRORS[code] : undefined;
  return publicModelError(error, { modelSource, redactMessage: redactModelPartialOutput, redactPartial: redactModelPartialOutput,
    ...(safeMessage ? { preserveCodes: [code], safeMessage } : {}) });
}
function busyRunResult() {
  const projected = publicRunError(Object.assign(new Error(RUN_BUSINESS_ERRORS.BUSY), { code: 'BUSY' }));
  return { ...projected, ok: false, error: projected.safeMessage };
}
const modelTextStreams = new WeakMap();
const { runTerminal } = require('./ai/terminal');
const {
  listTree,
  readFile,
  writeFile,
  deletePath,
  buildProjectSystemPrompt,
  isListIntent,
  isStructureIntent,
  buildTreeReply,
} = require('./ai/project-fs');
const { gitStatus, gitDiff } = require('./ai/git');
const { expandAtRefs, completeAtPath } = require('./ai/at-ref');
const { computeUnifiedDiff, truncateDiff } = require('./ai/diff');
const {
  normalizeAgentMode,
  buildApproveExecutionMessage,
  shouldUseAgent,
} = require('./ai/agent-mode');
const { discoverSkills, loadSkillBody } = require('./ai/skills-loader');
const { loadHooks } = require('./ai/hooks-loader');
const { sanitizeMcpServers } = require('./ai/mcp-config');
const { createMcpOAuthManager } = require('./ai/mcp-oauth');
const { createMcpSessionManager } = require('./ai/mcp-session-manager');
const { createMcpHub } = require('./ai/mcp-hub');
const { createMcpSamplingController } = require('./ai/mcp-sampling');
const { createMcpTaskManager } = require('./ai/mcp-task-manager');
const { createMcpElicitationController } = require('./ai/mcp-elicitation');
const { configFingerprint } = require('./ai/mcp-session-manager');
const {
  planCompact,
  serializeOlderTranscript,
  applyCompact,
  generateCompactArtifacts,
} = require('./ai/session-compact');
const {
  exportSessionMarkdown,
  exportSessionJson,
  defaultExportFilename,
} = require('./ai/session-export');
const {
  projectToModelMessages,
  createMessageV2,
  PLAN_STATUS,
} = require('./ai/message-schema');
const {
  memoryList,
  memoryAdd,
  memoryDelete,
  memoryAccept,
  memoryUpdate,
} = require('./ai/memory-ipc');
const { fetchUrl } = require('./ai/web-fetch');
const { aggregate } = require('./ai/usage');
const { createWorktreeManager } = require('./ai/worktree');
const { createWorktreeIpcHandlers } = require('./ai/worktree-ipc');
const { createEngineeringIpcHandlers } = require('./ai/engineering-ipc');
const { createCiWatchNotifier } = require('./ai/ci-watch-notifications');
const { createSubagentRuntime } = require('./ai/subagent-runtime');
const { projectKey, canonicalProjectPath } = require('./ai/project-index');
const {
  usageFilePath,
  appendRecord,
  readRecords,
  pruneRecords,
  clearRecords,
} = require('./ai/usage-store');

const PERMISSION_MODES = new Set(['read-only', 'confirm-writes', 'full-auto']);
const AGENT_MODES = new Set(['plan', 'agent']);

/**
 * Canonical model projection: project versioned messages for LLM completion;
 * expand @refs on the last user message only.
 * Renderer history keeps the original text/parts (not this expanded copy).
 */
function messagesForModel(messages, projectPath) {
  if (Array.isArray(messages) && messages.some((message) => message?.role === 'system')) {
    throw Object.assign(new Error('会话历史不能提供主机 system 指令；请在助手设置中配置提示词。'), { code: 'MODEL_MESSAGE_ROLE_INVALID' });
  }
  return projectToModelMessages(messages, {
    projectPath,
    expandAtRefs,
  });
}

/**
 * Active chat run state.
 * @type {{ abort: AbortController, gate: ReturnType<typeof createPermissionGate>, runId: string, sender: Electron.WebContents } | null}
 */
let activeRun = null;
const foregroundModels = createForegroundRuntime({ newRunId: makeRunId });
const backgroundModelBindings = new Set();
const backgroundModelBindingRefs = new Map();
const activeModelRequests = new Map();
let modelIpc = null;
let modelDiagnostics = null;

function retainBackgroundModelBinding(binding) {
  backgroundModelBindingRefs.set(binding, (backgroundModelBindingRefs.get(binding) || 0) + 1);
  backgroundModelBindings.add(binding);
}

function releaseBackgroundModelBinding(binding) {
  const remaining = (backgroundModelBindingRefs.get(binding) || 0) - 1;
  if (remaining > 0) backgroundModelBindingRefs.set(binding, remaining);
  else {
    backgroundModelBindingRefs.delete(binding);
    backgroundModelBindings.delete(binding);
  }
}

function getModelDiagnostics() {
  if (modelDiagnostics) return modelDiagnostics;
  const { createModelDiagnosticService } = require('./ai/model-diagnostics');
  modelDiagnostics = createModelDiagnosticService({
    resolveCredential: (binding) => getModelIpc().resolveCredential(binding),
    onEvent: (sender, event) => safeSend(sender, 'models:diagnostic-event', event),
    onUsage: ({ binding, attempt }) => {
      const settings = modelSettings();
      const usage = buildModelUsageEvent({ binding, settings, attempt, kind: 'model-diagnostic' });
      if (usage) persistUsageEvent(settings, binding.sessionId, usage);
    },
    applyResult: (result) => {
      const registry = modelSettings().modelRegistry;
      const model = registry.models.find((entry) => entry.id === result.modelProfileId);
      const provider = model && registry.providers.find((entry) => entry.id === model.providerId);
      if (!model || !provider || require('./ai/model-profiles').computeBindingRevision(provider, model) !== result.bindingRevision) return { stale: true };
      return getModelIpc().applyDiagnosticResult(result);
    },
    onRetain: retainBackgroundModelBinding,
    onRelease: releaseBackgroundModelBinding,
  });
  return modelDiagnostics;
}

function startModelDiagnosis(event, payload, binding) {
  return getModelDiagnostics().start({ binding, checks: payload.checks, sender: event.sender });
}

function modelSettings() { return loadSettings(userDataPath(), { resolveLegacyApiKey: false }); }
function getModelIpc() {
  if (modelIpc) return modelIpc;
  modelIpc = createModelIpcHandlers({
    getSettings: modelSettings,
    saveSettings: (partial, options) => saveSettings(userDataPath(), partial, options),
    getSecretManager: () => getSettingsSecretManager(userDataPath()),
    authorizeSender: (event) => BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.webContents === event.sender),
    isInUse: (query) => [foregroundModels.current?.binding, ...backgroundModelBindings, ...activeModelRequests.keys()].some((binding) => binding && Object.entries(query).every(([key, value]) => binding[key] === value)),
    startDiagnosis: startModelDiagnosis,
    cancelDiagnosis: (event, payload) => modelDiagnostics ? modelDiagnostics.cancel({
      diagnosticId: payload?.diagnosticId, sessionId: payload?.sessionId,
      runId: payload?.runId, clientRequestId: payload?.clientRequestId,
      senderId: event.sender.id,
    }) : { ok: false, code: 'DIAGNOSTIC_TARGET_MISMATCH' },
    onRegistryChange: (_before, after) => {
      const { computeBindingRevision } = require('./ai/model-profiles');
      for (const plan of planState.plans.values()) {
        if (!plan.bindingRevision || !['proposed', 'executing'].includes(plan.status)) continue;
        const model = after.models.find((entry) => entry.id === plan.modelProfileId);
        const provider = model && after.providers.find((entry) => entry.id === model.providerId);
        const assistant = after.assistants.find((entry) => entry.id === plan.assistantId);
        if (!model || !provider || !assistant || assistant.archived || assistant.revision !== Number(plan.assistantRevision)
          || model.revision !== Number(plan.modelRevision) || provider.revision !== Number(plan.providerRevision)
          || computeBindingRevision(provider, model) !== plan.bindingRevision) planState.expireBinding({ planId: plan.planId });
      }
      const lease = foregroundModels.current;
      const bindings = new Set([lease?.binding, ...activeModelRequests.keys()]);
      for (const binding of bindings) {
        if (!binding || !assistantPermissionsRevoked(binding.assistant, after.assistants.find((assistant) => assistant.id === binding.assistantId))) continue;
        if (lease?.binding === binding) {
          lease.abort.abort();
          try { lease.gate?.cancelPending('助手权限已撤销'); } catch { /* old permission cannot survive */ }
        }
        for (const controller of activeModelRequests.get(binding) || []) controller.abort();
      }
      // Metadata revisions can change after successful observed text evidence too.
      // Notify all live renderers without disclosing any registry/vault contents.
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) safeSend(win.webContents, 'models:registry-changed', { revision: after.revision });
      }
    },
  });
  return modelIpc;
}

/** Resolve file-system and model identities separately; renderer paths are never authority. */
function resolveModelContext(event, payload = {}, metadata = {}) {
  if (payload.identityType === 'demo-contact') throw Object.assign(new Error('演示联系人不能调用模型；请新建 AI 助手会话。'), { code: 'ASSISTANT_IDENTITY_INVALID' });
  const token = typeof payload.projectBindingId === 'string' ? payload.projectBindingId : '';
  const requestedPath = payload.project?.path || payload.projectPath || '';
  const trustedProject = token ? worktreeIpc.resolveBinding(event, { projectBindingId: token }) : null;
  if ((token || requestedPath) && (!trustedProject || (requestedPath && canonicalDirectory(requestedPath) !== trustedProject.projectPath))) throw Object.assign(new Error('项目绑定已失效，请重新打开项目。'), { code: 'PROJECT_BINDING_INVALID' });
  const project = trustedProject ? { id: trustedProject.projectId, path: trustedProject.projectPath, name: payload.project?.name || path.basename(trustedProject.projectPath) } : null;
  const binding = getModelIpc().resolveBinding(event, {
    sessionId: String(payload.sessionId || ''), assistantId: payload.assistantId || 'assistant_codex',
    modelProfileId: payload.modelProfileId, expectedRegistryRevision: payload.expectedRegistryRevision,
    projectBindingId: trustedProject ? token : null, ...metadata,
  });
  const policy = assistantContextPolicy(binding, project);
  return { binding, project, contextPolicy: { ...policy, toolsAllowed: policy.toolsAllowed && binding.compatibility.toolMode !== 'none' } };
}

function isProjectModelBindingCurrent(binding) {
  return !binding.projectBindingId || Boolean(worktreeIpc.resolveBinding(
    { sender: { id: binding.senderId } }, { projectBindingId: binding.projectBindingId },
  ));
}

/** Revocation is token- and owner-scoped; the foreground lease stays held through cleanup. */
function revokeInvalidProjectModelBindings(event) {
  const lease = foregroundModels.current;
  const bindings = new Set([lease?.binding, ...backgroundModelBindings, ...activeModelRequests.keys()]);
  for (const binding of bindings) {
    if (!binding || binding.senderId !== event.sender.id || isProjectModelBindingCurrent(binding)) continue;
    planState.expireBinding({ senderId: binding.senderId, projectBindingId: binding.projectBindingId });
    if (lease?.binding === binding) {
      lease.abort.abort();
      try { lease.gate?.cancelPending('项目绑定已撤销'); } catch { /* revoked approval cannot survive */ }
    }
    for (const controller of activeModelRequests.get(binding) || []) controller.abort();
  }
}

function boundModelChat(binding, settings, { kind = binding.kind || 'chat', signal, onUsage } = {}) {
  const chat = createModelChatFunction({ binding, signal, kind, resolveCredential: (accepted) => getModelIpc().resolveCredential(accepted),
    onUsage: (attempt) => {
      const usage = buildModelUsageEvent({ binding, settings, attempt, kind });
      if (!usage) return;
      if (onUsage) onUsage(usage); else persistUsageEvent(settings, binding.sessionId, usage);
    },
    onResult: (result) => {
      // A normal successful text request is narrow evidence, never a tool probe.
      if (result.content && !result.toolCalls.length && binding.capabilities.text.state === 'unknown') {
        getModelIpc().applyDiagnosticResult(structuredClone({ modelProfileId: binding.modelProfileId, bindingRevision: binding.bindingRevision,
          observations: { text: { state: 'supported', checkedAt: new Date().toISOString() } },
          expectedDeclarations: binding.modelProfile.capabilities }));
      }
    },
  });
  return async (options = {}) => {
    if (!isProjectModelBindingCurrent(binding)) {
      throw Object.assign(new Error('项目绑定已撤销，请重新开始运行。'), { code: 'ABORTED' });
    }
    const currentAssistant = modelSettings().modelRegistry.assistants.find((assistant) => assistant.id === binding.assistantId);
    if (assistantPermissionsRevoked(binding.assistant, currentAssistant)) {
      throw Object.assign(new Error('助手权限已撤销，请重新开始运行。'), { code: 'ABORTED' });
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (options.signal?.aborted) cancel(); else options.signal?.addEventListener('abort', cancel, { once: true });
    const active = activeModelRequests.get(binding) || new Set();
    active.add(controller); activeModelRequests.set(binding, active);
    try { return await chat({ ...options, signal: controller.signal }); }
    finally {
      options.signal?.removeEventListener('abort', cancel);
      active.delete(controller);
      if (!active.size) activeModelRequests.delete(binding);
    }
  };
}

function assistantPermissionsRevoked(previous, next) {
  return !next || next.archived || next.identityType !== 'ai'
    || previous.toolPolicy.allowedTools.some((name) => !next.toolPolicy.allowedTools.includes(name))
    || previous.knowledge.projectContext && !next.knowledge.projectContext
    || previous.knowledge.projectMemory && !next.knowledge.projectMemory;
}

function modelPolicyRevision(settings) {
  const keys = ['mode', 'executionPolicy', 'permissionMode', 'agentEnabled', 'terminalEnabled', 'terminalRequireConfirm',
    'webEnabled', 'webRequireConfirm', 'webAllowDomains', 'webDenyDomains', 'skillsEnabled', 'hooksEnabled',
    'subagentEnabled', 'mcpEnabled', 'mcpServers', 'memoryEnabled', 'memoryCandidateEnabled', 'codeIndexEnabled'];
  const values = Object.fromEntries(keys.map((key) => [key, settings[key]]));
  // Never hash vault references, keys, transport env or raw MCP authentication.
  values.mcpServers = (settings.mcpServers || []).map((server) => ({ name: server.name, enabled: server.enabled !== false,
    sampling: server.sampling?.enabled === true, tasks: server.tasks?.enabled === true, elicitation: server.elicitation?.enabled !== false }));
  return require('node:crypto').createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function hostPermissionsRevoked(previous, next) {
  const switches = ['agentEnabled', 'terminalEnabled', 'webEnabled', 'skillsEnabled', 'hooksEnabled',
    'subagentEnabled', 'mcpEnabled', 'memoryEnabled', 'memoryCandidateEnabled', 'codeIndexEnabled'];
  if (switches.some((key) => previous[key] === true && next[key] !== true)) return true;
  if (['terminalRequireConfirm', 'webRequireConfirm'].some((key) => previous[key] === false && next[key] !== false)) return true;
  const permissionRank = { 'read-only': 0, 'confirm-writes': 1, 'full-auto': 2 };
  if ((permissionRank[next.permissionMode] ?? 0) < (permissionRank[previous.permissionMode] ?? 0)) return true;
  const isolationRank = { 'strict-isolated': 0, 'workspace-write': 1, 'host-unconfined': 2 };
  if ((isolationRank[next.executionPolicy] ?? 0) < (isolationRank[previous.executionPolicy] ?? 0)) return true;
  const oldServers = previous.mcpServers || [];
  if (oldServers.some((server) => server.enabled !== false && !(next.mcpServers || []).some((entry) => entry.name === server.name && entry.enabled !== false))) return true;
  return (next.webDenyDomains || []).some((domain) => !(previous.webDenyDomains || []).includes(domain))
    || (next.webAllowDomains || []).length > 0 && ((previous.webAllowDomains || []).length === 0
      || (previous.webAllowDomains || []).some((domain) => !next.webAllowDomains.includes(domain)));
}

/**
 * Pending plan per session (from submit_plan / plan-ready).
 * @type {Map<string, { planId: string, title?: string, markdown: string, steps?: string[], sessionId: string }>}
 */
const planState = new PlanStateManager();

function resolvePlanBinding(event, payload = {}, acceptedModelBinding) {
  const sessionId = String(payload.sessionId || '');
  const token = String(payload.projectBindingId || '');
  const requestedPath = payload.project?.path || payload.projectPath || '';
  const project = token ? worktreeIpc.resolveBinding(event, { projectBindingId: token }) : null;
  if (!sessionId || !event.sender?.id || ((requestedPath || token) && (!project || (requestedPath && canonicalDirectory(requestedPath) !== project.projectPath)))) {
    throw Object.assign(new Error('项目绑定已失效，请重新打开项目并生成计划'), { code: 'PLAN_BINDING_CHANGED' });
  }
  const model = acceptedModelBinding || resolveModelContext(event, payload).binding;
  return { sessionId, senderId: event.sender.id, projectId: project?.projectId || '', projectPath: project?.projectPath || '', projectBindingId: token,
    assistantId: model.assistantId, assistantRevision: model.assistantRevision, providerId: model.providerId,
    providerRevision: model.providerRevision, modelProfileId: model.modelProfileId, modelRevision: model.modelRevision,
    bindingRevision: model.bindingRevision, policyRevision: modelPolicyRevision(modelSettings()) };
}

registerModelIpc(ipcMain, getModelIpc());

async function requestHostExecution(sender, request) {
  const native = require('./ai/windows-isolation');
  const policy = String(request.policyLevel || 'strict-isolated').toLowerCase().replace(/_/g, '-');
  if (policy !== 'host-unconfined' && native.getWindowsIsolationStatus().available) {
    return native.authorizeIsolatedExecution({
      ...request,
      confirm: async (scope) => {
        if (!sender || sender.isDestroyed() || request.signal?.aborted) return false;
        if (request.needsConfirmation === false) return true;
        const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(sender), {
          type: 'question', title: '确认单次隔离执行',
          message: '此命令使用 Windows AppContainer 与 Job 对象运行，网络全部拒绝。',
          detail: redactSecrets(`项目：${scope.projectRoot}\n目录：${scope.cwd}\n命令：${scope.command}\n工作区：${scope.workspacePolicy === 'workspace-write' ? '允许项目内读写' : '只读'}\n\n只允许项目与本次私有临时目录；后代进程受同一隔离和资源限制。执行失败不会自动改为宿主运行。`),
          buttons: ['取消', '允许这一次'], defaultId: 0, cancelId: 0, noLink: true,
        });
        return result.response === 1 && !sender.isDestroyed() && !request.signal?.aborted;
      },
    });
  }
  return authorizeHostExecution({
    ...request,
    confirm: async (scope) => {
      if (!sender || sender.isDestroyed() || request.signal?.aborted) return false;
      const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(sender), {
        type: 'warning', title: '确认单次宿主执行',
        message: '此命令将在宿主机执行，没有操作系统文件或网络隔离。',
        detail: redactSecrets(`项目：${scope.projectRoot}\n目录：${scope.cwd}\n命令：${scope.command}\n定向凭据：${scope.secretNames?.length ? scope.secretNames.join(', ') : '无'}\n\n仅授权这一次命令；子进程可访问当前账户的文件和网络。`),
        buttons: ['取消', '允许这一次'], defaultId: 0, cancelId: 0, noLink: true,
      });
      return result.response === 1 && !sender.isDestroyed() && !request.signal?.aborted;
    },
  });
}

/**
 * Manual terminal run (panel). Independent from activeRun / chat:stop.
 * @type {{ abort: AbortController, gate: ReturnType<typeof createPermissionGate>, sessionId: string, sender: Electron.WebContents, termId: string } | null}
 */
let manualTerm = null;
let worktreeMutation = false;
let mcpOAuthManager = null;
let mcpSessionManager = null;
let mcpTaskManager = null;
let mcpElicitationController = null;
let mcpTaskRecoveryHub = null;
let engineeringIpc = null;
let ciWatchNotifier = null;
let quitting = false;
const oauthFlowOwners = new Map();
const oauthPendingOwnersByName = new Map();
const rootTokensBySender = new Map();
const rootTokenRecords = new Map();
const mcpProjectBySender = new Map();

const worktreeManager = createWorktreeManager();
const subagentRuntime = createSubagentRuntime({ runLoop: runAgentLoop, worktreeManager });
const worktreeIpc = createWorktreeIpcHandlers({
  manager: worktreeManager,
  checkWorkflowGate: (event, payload) => getEngineeringIpc().workflowGateCheck(event, payload),
  isBusy: () => Boolean(activeRun || manualTerm || worktreeMutation),
  withMutation: async (fn) => {
    if (activeRun || manualTerm || worktreeMutation) return { ok: false, code: 'BUSY', error: '有对话或终端正在进行，请稍后重试' };
    worktreeMutation = true;
    try { return await fn(); } finally { worktreeMutation = false; }
  },
  openPath: async (target) => {
    if (!target || !fs.existsSync(target)) return '路径不存在';
    return shell.openPath(target);
  },
  openExternal: async (url) => shell.openExternal(url),
});

/** Accept engineering models synchronously, before private sources or worktrees. */
function acceptEngineeringModel({ kind, taskId, context, settings }) {
  const { ModelError } = require('./ai/model-adapters/common');
  const { isResolvedModelBinding } = require('./ai/model-profiles');
  if (!['pr-audit', 'pr-audit-recheck', 'repair'].includes(kind)) throw new ModelError('MODEL_INPUT_INVALID', '工程模型任务类型无效。');
  const inherited = context?.modelBinding;
  if (inherited !== undefined && !isResolvedModelBinding(inherited)) throw new ModelError('MODEL_BINDING_INVALID', '继承的工程模型绑定无效。');
  // Associated Agent repairs carry the parent brand, not a renderer-supplied sender.
  const sender = context?.sender || (kind === 'repair' && inherited
    ? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.webContents.id === inherited.senderId)?.webContents : null);
  if (!sender || !BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.webContents === sender)
    || sender.isDestroyed?.()) throw new ModelError('MODEL_SENDER_INVALID', '工程窗口已失效。');
  if ((kind !== 'repair' && !context.isCurrent?.()) || context.isCurrent?.() === false || context.signal?.aborted) {
    throw new ModelError('ABORTED', '工程项目绑定已撤销。');
  }
  const project = worktreeIpc.resolveBinding({ sender }, { projectBindingId: context.projectBindingId });
  const expectedPath = context.binding?.projectPath || context.projectPath || context.project?.path;
  const expectedId = context.binding?.projectId || context.project?.id;
  if (!project || (expectedId && project.projectId !== expectedId)
    || !expectedPath || canonicalProjectPath(project.projectPath) !== canonicalProjectPath(expectedPath)) {
    throw new ModelError('MODEL_BINDING_INVALID', '工程任务需要当前窗口的有效项目绑定。');
  }
  let binding = inherited;
  if (binding !== undefined) {
    if (binding.senderId !== sender.id || binding.projectBindingId !== context.projectBindingId) {
      throw new ModelError('MODEL_BINDING_INVALID', '继承的工程模型绑定无效。');
    }
  } else {
    const registry = modelSettings().modelRegistry;
    binding = getModelIpc().resolveBinding({ sender }, {
      assistantId: 'assistant_codex', modelProfileId: registry.defaultModelProfileId,
      projectBindingId: context.projectBindingId, runId: taskId, clientRequestId: taskId, kind,
    });
  }
  if (!isProjectModelBindingCurrent(binding)) throw new ModelError('ABORTED', '工程项目绑定已撤销。');
  assistantContextPolicy(binding, { id: project.projectId, path: project.projectPath });
  let hostTools;
  if (kind === 'repair') {
    if (settings.agentEnabled === false || settings.mode !== 'api') throw new ModelError('REPAIR_AGENT_UNAVAILABLE', '没有可用的修复 Agent。');
    const { IMPLEMENT_TOOLS } = require('./ai/providers/builtin');
    hostTools = require('./ai/agent').TOOL_DEFS.filter((tool) => IMPLEMENT_TOOLS.has(tool.function.name));
  } else {
    hostTools = (kind === 'pr-audit' ? require('./ai/pr-audit-runtime') : require('./ai/pr-audit-recheck-runtime')).TOOLS;
  }
  const tools = binding.compatibility.toolMode === 'none' ? [] : filterAssistantTools(hostTools, binding);
  if (kind === 'repair' && !tools.some((tool) => ['write_file', 'search_replace'].includes(tool.function?.name))) {
    throw new ModelError('ASSISTANT_TOOL_DENIED', '当前助手未获隔离修复工具权限。');
  }
  const canonicalTools = tools.map((tool) => tool.function
    ? { name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters } : tool);
  preflightModelRequest({ binding, messages: [
    { role: 'system', content: kind === 'repair' ? '仅在已授权的隔离 worktree 中提出必要修复。' : '只读固定快照审计。' },
    { role: 'user', content: '工程模型接受预检。' },
  ], tools: canonicalTools, request: { timeoutMs: 120000 } });
  getModelIpc().resolveCredential(binding);
  const controller = context.abortController;
  if (!controller || controller.signal !== context.signal || typeof controller.abort !== 'function') {
    throw new ModelError('MODEL_BINDING_INVALID', '工程任务缺少可信的取消控制器。');
  }
  retainBackgroundModelBinding(binding);
  let controllers = activeModelRequests.get(binding);
  if (!controllers) { controllers = new Set(); activeModelRequests.set(binding, controllers); }
  controllers.add(controller);
  let released = false;
  return {
    binding, chatFn: boundModelChat(binding, settings, { kind, signal: context.signal }),
    modelSource: publicModelSource(binding),
    release() {
      if (released) return;
      released = true;
      releaseBackgroundModelBinding(binding);
      controllers.delete(controller);
      if (!controllers.size && activeModelRequests.get(binding) === controllers) activeModelRequests.delete(binding);
    },
  };
}

function getEngineeringIpc() {
  if (engineeringIpc) return engineeringIpc;
  engineeringIpc = createEngineeringIpcHandlers({
    resolveBinding: (event, payload) => worktreeIpc.resolveBinding(event, payload),
    acceptBoundModel: acceptEngineeringModel,
    userDataPath: userDataPath(),
    safeStorage,
    worktreeManager,
    subagentRuntime,
    runTerminal,
    withMutation: async (fn) => {
      if (activeRun || manualTerm || worktreeMutation) return { ok: false, code: 'BUSY', error: '有对话或终端正在进行，请稍后重试' };
      worktreeMutation = true;
      try { return await fn(); } finally { worktreeMutation = false; }
    },
    indexStorePathFor: (projectPath) => path.join(userDataPath(), `engineering-index-${crypto.createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 16)}.json`),
    isIndexEnabled: () => modelSettings().codeIndexEnabled !== false,
    getProfiles: (projectPath) => {
      const key = projectKey(projectPath);
      return (modelSettings().verificationProfiles || [])
        .filter((profile) => profile.projectKey === key);
    },
    setProfiles: (projectPath, profiles) => {
      const settings = modelSettings();
      const key = projectKey(projectPath);
      const retained = (settings.verificationProfiles || [])
        .filter((profile) => profile.projectKey !== key);
      saveSettings(userDataPath(), {
        verificationProfiles: [
          ...retained,
          ...profiles.map((profile) => ({ ...profile, projectKey: key })),
        ],
      });
    },
    getSettings: () => modelSettings(),
    onCiWatchEvent: (event, ownerIds) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (ownerIds.includes(win.webContents.id)) safeSend(win.webContents, 'engineering:ci-watch:event', event);
      }
      if (event.notify) getCiWatchNotifier().publish(event);
    },
    onPrAuditEvent: (event, ownerIds) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (ownerIds.includes(win.webContents.id)) safeSend(win.webContents, 'engineering:pr-audit:event', event);
      }
    },
    onPrAuditRecheckEvent: (event, ownerIds) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (ownerIds.includes(win.webContents.id)) safeSend(win.webContents, 'engineering:pr-audit:recheck:event', event);
      }
    },
    isBusy: () => Boolean(activeRun || manualTerm || worktreeMutation),
    createPermissionGate: (event, settings) => createPermissionGate({
      projectId: `engineering:${event.sender.id}`,
      policyLevel: settings.executionPolicy,
      requestHostExecution: (request) => requestHostExecution(event.sender, request),
      permissionMode: PERMISSION_MODES.has(settings.permissionMode) ? settings.permissionMode : 'confirm-writes',
      terminalEnabled: settings.terminalEnabled === true,
      terminalRequireConfirm: true,
      onApprovalNeeded: async (approval) => {
        const source = approval?.source || (approval?.tool === 'verification_start' ? 'verification' : undefined);
        safeSend(event.sender, 'chat:event', {
          type: AGENT_EVENTS.APPROVAL_NEEDED,
          runId: null,
          ...approval,
          ...(source ? { source } : {}),
        });
      },
    }),
    onEvent: (event, ownerIds = []) => {
      const owners = new Set(ownerIds);
      for (const win of BrowserWindow.getAllWindows()) {
        if (!owners.has(win.webContents.id)) continue;
        // Keep the aggregate engineering channel for existing consumers and
        // also expose the D13-specific channel so repair events never need to
        // share the ordinary verification/workflow event contract.
        safeSend(win.webContents, 'engineering:event', event);
        if (event?.type === 'engineering:repair:event') {
          safeSend(win.webContents, 'engineering:repair:event', event);
        }
      }
    },
  });
  return engineeringIpc;
}

function getCiWatchNotifier() {
  if (!ciWatchNotifier) ciWatchNotifier = createCiWatchNotifier({
    Notification,
    getWindows: () => BrowserWindow.getAllWindows(),
    getOwnerIds: (key) => engineeringIpc?.ciWatchOwnerIds(key) || [],
    canNavigate: (owner, key, ref) => engineeringIpc?.ciWatchNavigation(owner, key, ref),
    navigate: (win, target) => safeSend(win.webContents, 'engineering:ci-watch:navigate', target),
    isEnabled: () => !quitting && modelSettings().ciWatchSystemNotifications === true,
  });
  return ciWatchNotifier;
}

function userDataPath() {
  return app.getPath('userData');
}

function getMcpOAuthManager() {
  if (mcpOAuthManager) return mcpOAuthManager;
  mcpOAuthManager = createMcpOAuthManager({
    userDataPath: userDataPath(),
    openExternal: (url) => shell.openExternal(url),
  });
  mcpOAuthManager.onEvent((event) => {
    const pendingSenderId = oauthPendingOwnersByName.get(event.name);
    if (event.flowId && pendingSenderId != null && event.state === 'starting') {
      oauthFlowOwners.set(event.flowId, pendingSenderId);
    }
    if (event.state === 'success' || event.state === 'error' || event.state === 'cancelled') {
      if (event.flowId) oauthFlowOwners.delete(event.flowId);
      oauthPendingOwnersByName.delete(event.name);
    }
    for (const win of BrowserWindow.getAllWindows()) {
      safeSend(win.webContents, 'mcp:oauth:event', event);
    }
  });
  return mcpOAuthManager;
}

function getMcpSessionManager() {
  if (mcpSessionManager) return mcpSessionManager;
  mcpSessionManager = createMcpSessionManager({
    onStatus: (status) => {
      // Session summaries are intentionally identifier-free; broadcast only
      // state/reconnect changes to windows that can render them.
      for (const win of BrowserWindow.getAllWindows()) safeSend(win.webContents, 'mcp:session:event', status);
    },
  });
  return mcpSessionManager;
}

function getMcpTaskManager() {
  if (mcpTaskManager) return mcpTaskManager;
  mcpTaskManager = createMcpTaskManager({
    userDataPath: userDataPath(),
    onEvent: (event) => {
      for (const win of BrowserWindow.getAllWindows()) safeSend(win.webContents, 'mcp:task:event', event);
    },
  });
  return mcpTaskManager;
}

function getMcpElicitationController() {
  if (mcpElicitationController) return mcpElicitationController;
  mcpElicitationController = createMcpElicitationController({
    onEvent: (event) => {
      for (const win of BrowserWindow.getAllWindows()) safeSend(win.webContents, 'mcp:elicitation:event', event);
    },
    openExternal: (url) => shell.openExternal(url),
    allowPrivateUrlForServer: (name) => modelSettings().mcpServers
      .some((server) => server.name === String(name || '') && server.elicitation?.allowPrivateUrl === true),
  });
  return mcpElicitationController;
}

async function restoreMcpTasksAtStartup() {
  const taskManager = getMcpTaskManager();
  const active = taskManager.list().filter((task) => task.needsRecovery === true);
  if (!active.length) return;
  const settings = modelSettings();
  const enabledByName = new Map(settings.mcpServers
    .filter((server) => server.enabled !== false)
    .map((server) => [server.name, server]));
  const currentFingerprint = (serverName) => {
    const server = enabledByName.get(serverName);
    return server ? configFingerprint(server) : '';
  };
  const serverNames = new Set(taskManager.recoveryServerNames(currentFingerprint));
  const servers = [...enabledByName.values()].filter((server) => serverNames.has(server.name));
  if (!servers.length) {
    await taskManager.restore({ getClient: () => null, getConfigFingerprint: currentFingerprint });
    return;
  }
  const hub = createMcpHub({
    sessionManager: getMcpSessionManager(),
    taskManager,
  });
  try {
    await hub.startAll(servers, {
      taskRecovery: true,
      // Startup recovery only monitors persisted tool tasks. It deliberately
      // has no Agent, roots, sampling, or elicitation callback context.
    });
    mcpTaskRecoveryHub = hub;
  } catch {
    await hub.close().catch(() => {});
  }
}

function cancelOAuthFlowsForSender(senderId) {
  const manager = mcpOAuthManager;
  if (!manager) return;
  for (const [flowId, ownerId] of oauthFlowOwners) {
    if (ownerId !== senderId) continue;
    manager.cancel(flowId);
    oauthFlowOwners.delete(flowId);
  }
  for (const [name, ownerId] of oauthPendingOwnersByName) {
    if (ownerId === senderId) oauthPendingOwnersByName.delete(name);
  }
}

function persistUsageEvent(settings, sessionId, event) {
  if (!event || settings?.usageEnabled === false) return false;
  try {
    const file = usageFilePath(userDataPath());
    const written = appendRecord(file, {
      ...event, ts: Date.now(), session: String(sessionId || event.sessionId || ''),
      model: String(event.model || ''), kind: String(event.kind || 'main'),
      in: event.inputTokens ?? null, out: event.outputTokens ?? null, cached: event.cachedInputTokens ?? null,
      cacheCreation: event.cacheCreationInputTokens ?? null, est: event.estimated === true,
      cost: Number.isFinite(event.cost) ? event.cost : null, cur: String(event.currency || '$'),
    });
    if (written) pruneRecords(file, settings.usageMaxRecords);
    return written;
  } catch {
    // Usage metering is best-effort and must never interrupt a chat or compact.
    return false;
  }
}

function bundledSkillsDir() {
  return path.join(__dirname, 'skills');
}

function makePublicRootToken(senderId, name, rootId) {
  if (senderId == null) return String(rootId || '');
  const ownerId = Number(senderId);
  let tokens = rootTokensBySender.get(ownerId);
  if (!tokens) {
    tokens = new Map();
    rootTokensBySender.set(ownerId, tokens);
  }
  const key = `${String(name || '')}:${String(rootId || '')}`;
  const existing = tokens.get(key);
  if (existing) return existing;
  const token = `rt_${crypto.randomBytes(18).toString('base64url')}`;
  tokens.set(key, token);
  rootTokenRecords.set(token, { senderId: ownerId, name: String(name || ''), rootId: String(rootId || '') });
  return token;
}

function resolvePublicRootId(senderId, name, token) {
  const record = rootTokenRecords.get(String(token || ''));
  if (!record || record.senderId !== Number(senderId) || record.name !== String(name || '')) return '';
  return record.rootId;
}

function dropMcpRootTokens(senderId) {
  const ownerId = Number(senderId);
  const tokens = rootTokensBySender.get(ownerId);
  if (!tokens) return;
  for (const token of tokens.values()) rootTokenRecords.delete(token);
  rootTokensBySender.delete(ownerId);
}

function publicMcpServer(server, status, senderId) {
  const out = {
    name: String(server?.name || ''),
    transport: String(server?.transport || 'stdio'),
    enabled: server?.enabled !== false,
    sessionRecovery: server?.sessionRecovery === true,
    sampling: { enabled: server?.sampling?.enabled === true },
    tasks: {
      enabled: server?.tasks?.enabled === true,
      defaultTtlMs: Number(server?.tasks?.defaultTtlMs) || 60 * 60 * 1000,
    },
    elicitation: {
      enabled: server?.elicitation?.enabled !== false,
      allowPrivateUrl: server?.elicitation?.allowPrivateUrl === true,
    },
    roots: Array.isArray(server?.roots) ? server.roots.map((root) => ({
      rootId: makePublicRootToken(senderId, server.name, root.rootId),
      label: root.label,
    })) : [],
    session: status
      ? publicSessionStatus(status)
      : {
        state: server?.sessionRecovery ? 'idle' : 'disabled',
        reusable: server?.sessionRecovery === true,
        lastErrorCode: null,
      },
  };
  // These fields are needed to edit the server row. Do not spread the
  // persisted object: stdio env and remote headers may contain credentials.
  if (server?.command) out.command = String(server.command);
  if (server?.url) out.url = String(server.url);
  if (server?.timeoutMs != null) out.timeoutMs = Number(server.timeoutMs);
  if (server?.allowPrivate === true) out.allowPrivate = true;
  if (server?.auth === 'oauth') {
    out.auth = 'oauth';
    const oauth = server.oauth && typeof server.oauth === 'object' ? server.oauth : {};
    out.oauth = {};
    for (const key of [
      'clientId',
      'resource',
      'authorizationServer',
      'authorizationEndpoint',
      'tokenEndpoint',
      'registrationEndpoint',
      'revocationEndpoint',
    ]) {
      if (oauth[key]) out.oauth[key] = String(oauth[key]);
    }
    if (Array.isArray(oauth.scopes)) out.oauth.scopes = oauth.scopes.map(String).slice(0, 32);
  } else {
    out.auth = 'none';
  }
  return out;
}

function toPublicSettings(s, senderId) {
  const servers = sanitizeMcpServers(s.mcpServers);
  const statuses = new Map(getMcpSessionManager().status().map((status) => [status.server, status]));
  return {
    mode: s.mode,
    baseUrl: s.baseUrl,
    model: s.model,
    apiKeySet: Boolean(s.apiKeyConfigured || s.apiKey),
    apiKey: '',
    executionPolicy: s.executionPolicy || 'strict-isolated',
    agentEnabled: s.agentEnabled !== false,
    maxAgentTurns: s.maxAgentTurns ?? 8,
    permissionMode: PERMISSION_MODES.has(s.permissionMode) ? s.permissionMode : 'confirm-writes',
    terminalEnabled: Boolean(s.terminalEnabled),
    terminalRequireConfirm: s.terminalRequireConfirm !== false,
    terminalTimeoutMs: s.terminalTimeoutMs ?? 60000,
    defaultAgentMode: AGENT_MODES.has(s.defaultAgentMode) ? s.defaultAgentMode : 'agent',
    verifyCommand: s.verifyCommand != null ? String(s.verifyCommand) : '',
    verifyBeforeDone: s.verifyBeforeDone !== false,
    skillsEnabled: s.skillsEnabled !== false,
    subagentEnabled: s.subagentEnabled !== false,
    mcpEnabled: Boolean(s.mcpEnabled),
    mcpServers: servers.map((server) => publicMcpServer(server, statuses.get(server.name), senderId)),
    mcpTasksPersistence: getMcpTaskManager().persistence(),
    hooksEnabled: s.hooksEnabled !== false,
    exploreMaxParallel: (() => {
      const n = Number(s.exploreMaxParallel);
      if (!Number.isFinite(n)) return 2;
      return Math.max(1, Math.min(3, Math.floor(n)));
    })(),
    autoCompact: s.autoCompact === true,
    compactKeepMessages: clampInt(s.compactKeepMessages, 6, 80, 24),
    compactMaxMessages: clampInt(s.compactMaxMessages, 20, 200, 40),
    compactMaxApproxTokens: clampInt(s.compactMaxApproxTokens, 4000, 200000, 24000),
    memoryEnabled: s.memoryEnabled !== false,
    memoryMaxEntries: clampInt(s.memoryMaxEntries, 20, 2000, 200),
    memoryInjectTopN: clampInt(s.memoryInjectTopN, 0, 30, 8),
    memoryInjectMaxTokens: clampInt(s.memoryInjectMaxTokens, 200, 8000, 1200),
    memoryCandidateEnabled: s.memoryCandidateEnabled !== false,
    webEnabled: s.webEnabled === true,
    webRequireConfirm: s.webRequireConfirm !== false,
    webAllowDomains: normalizeDomainList(s.webAllowDomains),
    webDenyDomains: normalizeDomainList(s.webDenyDomains),
    webTimeoutMs: clampInt(s.webTimeoutMs, 3000, 60000, 15000),
    webMaxBytes: clampInt(s.webMaxBytes, 32768, 4194304, 524288),
    webMaxChars: clampInt(s.webMaxChars, 1000, 50000, 15000),
    usageEnabled: s.usageEnabled !== false,
    usageMaxRecords: clampInt(s.usageMaxRecords, 500, 50000, 5000),
    usagePricing: sanitizePricing(s.usagePricing),
    usageCurrency: String(s.usageCurrency ?? '$').slice(0, 4) || '$',
    codeIndexEnabled: s.codeIndexEnabled !== false,
    ciWatchSystemNotifications: s.ciWatchSystemNotifications === true,
    // Generic settings expose only bounded summaries. Commands are available
    // solely through a sender-owned project binding in engineering IPC.
    verificationProfiles: (Array.isArray(s.verificationProfiles) ? s.verificationProfiles : []).slice(0, 100).map((p) => ({
      id: String(p.id || ''), name: String(p.name || ''), kind: String(p.kind || 'custom'),
      enabled: p.enabled !== false,
    })),
  };
}

function isAbortError(err, signal) {
  if (!err && !signal) return false;
  if (signal?.aborted) return true;
  if (err?.code === 'ABORTED' || err?.name === 'AbortError') return true;
  const msg = String(err?.message || err || '');
  return /已停止|The user aborted a request|AbortError/i.test(msg);
}

function throwAborted() {
  const e = new Error('已停止');
  e.code = 'ABORTED';
  throw e;
}

function makeRunId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function safeSend(sender, channel, data) {
  try {
    if (!sender || sender.isDestroyed()) return;
    let outgoing = data;
    const identity = data && typeof data === 'object' ? String(data.runId || data.taskId || data.clientRequestId || '') : '';
    const key = `${channel}\u0000${identity}`;
    let streams = modelTextStreams.get(sender);
    if (data?.type === AGENT_EVENTS.TEXT_DELTA) {
      if (!streams) { streams = new Map(); modelTextStreams.set(sender, streams); }
      if (!streams.has(key)) {
        if (streams.size >= 64) { const oldest = streams.keys().next().value; streams.get(oldest).finish(); streams.delete(oldest); }
        streams.set(key, createModelTextRedactor());
      }
      const text = streams.get(key).write(String(data.text ?? data.delta ?? ''));
      if (!text) return;
      outgoing = { ...data, text }; delete outgoing.delta;
    } else if ([AGENT_EVENTS.DONE, AGENT_EVENTS.ERROR, AGENT_EVENTS.ABORTED, 'cancelled'].includes(data?.type) && streams?.has(key)) {
      const text = streams.get(key).finish(); streams.delete(key);
      if (text) sender.send(channel, redactSecrets({ type: AGENT_EVENTS.TEXT_DELTA, text,
        runId: data.runId, sessionId: data.sessionId, clientRequestId: data.clientRequestId, modelSource: data.modelSource, task: data.task }));
    }
    if (typeof outgoing?.partialOutput === 'string') outgoing = { ...outgoing, partialOutput: redactModelPartialOutput(outgoing.partialOutput) };
    sender.send(channel, redactSecrets(outgoing));
  } catch {
    /* ignore destroyed sender */
  }
}

function abortActiveRun() {
  if (!activeRun) return;
  try {
    activeRun.abort.abort();
  } catch {
    /* ignore */
  }
}

function abortManualTerm() {
  if (!manualTerm) return;
  try {
    manualTerm.abort.abort();
  } catch {
    /* ignore */
  }
}

function makeTermId() {
  return `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function dropModelOwner(senderId) {
  modelIpc?.dropSender(senderId);
  modelDiagnostics?.cancelOwner(senderId);
  foregroundModels.cancelOwner(senderId);
  for (const [binding, controllers] of activeModelRequests) if (binding.senderId === senderId) {
    for (const controller of controllers) controller.abort();
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 580,
    backgroundColor: '#c3d9f1',
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const windowSender = win.webContents;
  const worktreeSenderId = windowSender.id;
  win.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame !== false) {
      worktreeIpc.dropSender(worktreeSenderId);
      dropModelOwner(worktreeSenderId);
      planState.expireSender(worktreeSenderId);
      if (activeRun?.sender === windowSender) abortActiveRun();
      if (manualTerm?.sender === windowSender) abortManualTerm();
      engineeringIpc?.dropSender?.(worktreeSenderId);
    }
  });
  win.webContents.once('destroyed', () => { worktreeIpc.dropSender(worktreeSenderId); planState.expireSender(worktreeSenderId); if (activeRun?.sender === windowSender) abortActiveRun(); if (manualTerm?.sender === windowSender) abortManualTerm(); });
  win.webContents.once('destroyed', () => dropModelOwner(worktreeSenderId));
  win.webContents.once('destroyed', () => engineeringIpc?.dropSender?.(worktreeSenderId));
  win.webContents.once('destroyed', () => cancelOAuthFlowsForSender(worktreeSenderId));
  win.webContents.once('destroyed', () => mcpElicitationController?.cancelOwner?.(worktreeSenderId));
  win.webContents.once('destroyed', () => {
    dropMcpRootTokens(worktreeSenderId);
    mcpProjectBySender.delete(worktreeSenderId);
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    Menu?.setApplicationMenu(null);
    getMcpOAuthManager();
    // Decrypt the verification stores now so an interrupted job is recorded as
    // such before any window asks for it. This never re-runs a command.
    try { getEngineeringIpc().restoreAtStartup(); } catch {}
    createWindow();
    if (process.platform === 'win32') app.setAppUserModelId?.('com.codex.qqdesktop');
    powerMonitor?.on?.('suspend', () => engineeringIpc?.suspendCiWatches());
    powerMonitor?.on?.('resume', () => engineeringIpc?.resumeCiWatches());
    restoreMcpTasksAtStartup().catch(() => {});
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  ciWatchNotifier?.close();
  const lease = foregroundModels.current;
  abortActiveRun();
  try { lease?.gate?.cancelPending('应用正在关闭'); } catch { /* shutdown cannot keep a permission request */ }
  for (const controllers of activeModelRequests.values()) for (const controller of controllers) controller.abort();
  Promise.allSettled([
    Promise.resolve().then(() => lease?.completion),
    Promise.resolve().then(() => modelDiagnostics?.close?.()),
    Promise.resolve().then(() => mcpOAuthManager?.closeAll?.()),
    Promise.resolve().then(() => mcpSessionManager?.closeAll?.()),
    Promise.resolve().then(() => mcpTaskManager?.close?.()),
    Promise.resolve().then(() => mcpElicitationController?.cancelAll?.()),
    Promise.resolve().then(() => engineeringIpc?.close?.()),
  ]).catch(() => {}).finally(() => app.quit());
});

function windowFromEvent(event) {
  return BrowserWindow.fromWebContents?.(event?.sender)
    || BrowserWindow.getFocusedWindow?.()
    || null;
}

ipcMain.handle('window:minimize', (event) => {
  const win = windowFromEvent(event);
  if (win && !win.isDestroyed?.()) win.minimize();
  return { ok: Boolean(win) };
});

ipcMain.handle('window:toggle-maximize', (event) => {
  const win = windowFromEvent(event);
  if (!win || win.isDestroyed?.()) return { ok: false, maximized: false };
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return { ok: true, maximized: win.isMaximized() };
});

ipcMain.handle('window:close', (event) => {
  const win = windowFromEvent(event);
  if (win && !win.isDestroyed?.()) win.close();
  return { ok: Boolean(win) };
});

ipcMain.handle('settings:get', async (event) => toPublicSettings(modelSettings(), event.sender.id));

ipcMain.handle('settings:save', async (event, partial = {}) => {
  const nextPartial = { ...partial };
  const currentSettings = modelSettings();
  for (const alias of ['apiKey', 'secretRef', 'apiKeyConfigured', 'apiKeyUnavailable', 'baseUrl', 'model']) delete nextPartial[alias];
  for (const k of [
    'agentEnabled',
    'terminalEnabled',
    'terminalRequireConfirm',
    'verifyBeforeDone',
    'skillsEnabled',
    'subagentEnabled',
    'mcpEnabled',
    'hooksEnabled',
    'autoCompact',
    'memoryEnabled',
    'memoryCandidateEnabled',
    'webEnabled',
    'usageEnabled',
    'codeIndexEnabled',
    'ciWatchSystemNotifications',
  ]) {
    if (k in nextPartial) nextPartial[k] = Boolean(nextPartial[k]);
  }
  for (const [k, min, max, fallback] of [
    ['compactKeepMessages', 6, 80, 24],
    ['compactMaxMessages', 20, 200, 40],
    ['compactMaxApproxTokens', 4000, 200000, 24000],
    ['memoryMaxEntries', 20, 2000, 200],
    ['memoryInjectTopN', 0, 30, 8],
    ['memoryInjectMaxTokens', 200, 8000, 1200],
    ['webTimeoutMs', 3000, 60000, 15000],
    ['webMaxBytes', 32768, 4194304, 524288],
    ['webMaxChars', 1000, 50000, 15000],
    ['usageMaxRecords', 500, 50000, 5000],
  ]) {
    if (k in nextPartial) nextPartial[k] = clampInt(nextPartial[k], min, max, fallback);
  }
  if ('maxAgentTurns' in nextPartial) {
    const n = Number(nextPartial.maxAgentTurns);
    if (n === 0) nextPartial.maxAgentTurns = 0;
    else nextPartial.maxAgentTurns = Math.max(1, Math.min(50, Number.isFinite(n) && n > 0 ? n : 8));
  }
  if ('exploreMaxParallel' in nextPartial) {
    const n = Number(nextPartial.exploreMaxParallel);
    if (!Number.isFinite(n)) nextPartial.exploreMaxParallel = 2;
    else nextPartial.exploreMaxParallel = Math.max(1, Math.min(3, Math.floor(n)));
  }
  if ('permissionMode' in nextPartial) {
    if (!PERMISSION_MODES.has(nextPartial.permissionMode)) {
      delete nextPartial.permissionMode;
    }
  }
  if ('executionPolicy' in nextPartial) {
    if (!['strict-isolated', 'workspace-write', 'host-unconfined'].includes(nextPartial.executionPolicy)) {
      delete nextPartial.executionPolicy;
    }
  }
  if ('defaultAgentMode' in nextPartial) {
    nextPartial.defaultAgentMode = normalizeAgentMode(nextPartial.defaultAgentMode);
  }
  if ('verifyCommand' in nextPartial) {
    nextPartial.verifyCommand = String(nextPartial.verifyCommand ?? '');
  }
  if ('verificationProfiles' in nextPartial) {
    // Commands can be saved only after resolving a sender-owned project
    // binding through engineering:verification:profile:*.
    delete nextPartial.verificationProfiles;
  }
  if ('mcpServers' in nextPartial) {
    const incoming = sanitizeMcpServers(nextPartial.mcpServers);
    // Keep paths for roots that were already authorized by main. A renderer
    // payload may carry only rootId/label; arbitrary submitted paths never
    // enter settings through this handler.
    const currentByServer = new Map((currentSettings.mcpServers || []).map((server) => [server.name, server]));
    nextPartial.mcpServers = incoming.map((server) => {
      const previous = currentByServer.get(server.name);
      const previousRoots = new Map((previous?.roots || []).map((root) => [root.rootId, root]));
      const sameTransport = previous && previous.transport === server.transport;
      const preserved = sameTransport
        ? {
          ...(server.transport === 'stdio' && server.args === undefined && Array.isArray(previous.args) ? { args: previous.args } : {}),
          ...(server.transport === 'stdio' && server.cwd === undefined && previous.cwd ? { cwd: previous.cwd } : {}),
          ...(server.transport === 'stdio' && server.env === undefined && previous.env ? { env: previous.env } : {}),
          ...(server.transport !== 'stdio' && server.headers === undefined && previous.headers ? { headers: previous.headers } : {}),
        }
        : {};
      return {
        ...server,
        ...preserved,
        roots: (server.roots || []).map((root) => {
          const persistedRootId = resolvePublicRootId(event.sender.id, server.name, root.rootId) || root.rootId;
          const authorized = previousRoots.get(persistedRootId);
          return authorized ? { ...root, rootId: authorized.rootId, label: authorized.label, path: authorized.path } : null;
        }).filter(Boolean),
      };
    });
    const incomingByName = new Map(nextPartial.mcpServers.map((server) => [server.name, server]));
    const locked = [];
    for (const current of currentSettings.mcpServers || []) {
      if (getMcpTaskManager().canChangeServer(current.name)) continue;
      const incoming = incomingByName.get(current.name);
      if (!incoming || configFingerprint(current) !== configFingerprint(incoming)) {
        locked.push({
          server: current.name,
          tasks: getMcpTaskManager().list({ server: current.name })
            .filter((task) => task.canCancel || task.canAbandon),
        });
      }
    }
    if (locked.length) {
      return { ok: false, code: 'MCP_TASKS_CONFIG_LOCKED', error: '该 MCP 服务器仍有后台任务，请先取消或遗弃任务引用', locked };
    }
  }
  const saved = saveSettings(userDataPath(), nextPartial, { resolveLegacyApiKey: false });
  if (modelPolicyRevision(currentSettings) !== modelPolicyRevision(saved)) {
    for (const plan of planState.plans.values()) planState.expireBinding({ planId: plan.planId });
    if (hostPermissionsRevoked(currentSettings, saved)) {
      abortActiveRun();
      try { activeRun?.gate?.cancelPending('宿主权限已撤销'); } catch { /* no stale permission */ }
      for (const controllers of activeModelRequests.values()) for (const controller of controllers) controller.abort();
    }
  }
  if ('mcpServers' in nextPartial) {
    await getMcpSessionManager().invalidate(
      (entry) => getMcpTaskManager().canChangeServer(entry.serverName),
      'config-changed',
    );
  }
  return toPublicSettings(saved, event.sender.id);
});

ipcMain.handle('isolation:getStatus', async () => {
  const { probeIsolationCapabilities } = require('./ai/os-isolation');
  const caps = probeIsolationCapabilities();
  const settings = modelSettings();
  const executionPolicy = settings.executionPolicy || 'strict-isolated';
  const hostSelected = String(executionPolicy).toLowerCase().replace(/_/g, '-') === 'host-unconfined';
  return {
    ok: true,
    capabilities: { ...caps, activeMode: hostSelected ? 'host-unconfined' : caps.activeMode, requiresHostConfirmation: hostSelected || caps.requiresHostConfirmation },
    executionPolicy,
    modeSource: 'configured-default; actual isolation evidence is returned per command',
  };
});

ipcMain.handle('isolation:requestElevation', async () => ({
  ok: false, code: 'COMMAND_REQUIRED',
  error: '宿主执行只在运行具体命令时逐次确认，不能授予会话级无限制权限。',
}));

// Sandboxed preload cannot require local modules. Only these bounded, pure
// projections are exposed synchronously; no filesystem or asynchronous work.
ipcMain.on?.('message:project', (event, payload = {}) => {
  const schema = require('./ai/message-schema');
  const methods = { storage: schema.projectToStorageJson, ui: schema.projectToUiModel, normalize: schema.normalizeMessage };
  try {
    const method = Object.hasOwn(methods, payload.kind) ? methods[payload.kind] : null;
    event.returnValue = method ? method(payload.message) : null;
  } catch { event.returnValue = null; }
});

ipcMain.handle('mcp:testServer', async (_e, rawCfg) => {
  const list = sanitizeMcpServers([rawCfg]);
  if (!list.length) return { ok: false, error: '无效配置' };
  let cfg = list[0];
  const saved = modelSettings().mcpServers.find((server) => server.name === cfg.name);
  if (saved && rawCfg && typeof rawCfg === 'object') {
    const sameTransport = saved.transport === cfg.transport;
    const preserved = sameTransport
      ? {
        ...(cfg.transport === 'stdio' && !Object.prototype.hasOwnProperty.call(rawCfg, 'args') && Array.isArray(saved.args) ? { args: saved.args } : {}),
        ...(cfg.transport === 'stdio' && !Object.prototype.hasOwnProperty.call(rawCfg, 'cwd') && saved.cwd ? { cwd: saved.cwd } : {}),
        ...(cfg.transport === 'stdio' && !Object.prototype.hasOwnProperty.call(rawCfg, 'env') && saved.env ? { env: saved.env } : {}),
        ...(cfg.transport !== 'stdio' && !Object.prototype.hasOwnProperty.call(rawCfg, 'headers') && saved.headers ? { headers: saved.headers } : {}),
      }
      : {};
    cfg = { ...saved, ...cfg, ...preserved };
  }
  const { createMcpClient } = require('./ai/mcp-client');
  const manager = cfg.auth === 'oauth' ? getMcpOAuthManager() : null;
  const client = createMcpClient({
    ...cfg,
    timeoutMs: Math.min(cfg.timeoutMs || 15000, 15000),
    allowPrivate: cfg.allowPrivate === true,
    authProvider: manager?.getAuthProvider?.(cfg.name, cfg),
  });
  try {
    await client.start();
    const tools = await client.listTools();
    let resourcesCount = 0;
    try {
      const res = await client.listResources();
      resourcesCount = Array.isArray(res) ? res.length : 0;
    } catch { /* ignore */ }
    let promptsCount = 0;
    try {
      const prompts = await client.listPrompts?.();
      promptsCount = Array.isArray(prompts) ? prompts.length : 0;
    } catch { /* ignore */ }
    await client.close();
    return { ok: true, toolsCount: tools.length, resourcesCount, promptsCount, transport: cfg.transport };
  } catch (err) {
    try { await client.close(); } catch { /* */ }
    return { ok: false, error: err.message || String(err), transport: cfg.transport };
  }
});

function publicSessionStatus(status) {
  return {
    state: ['disabled', 'idle', 'connected', 'reconnecting', 'error'].includes(status?.state) ? status.state : 'idle',
    reusable: status?.reusable === true,
    lastErrorCode: status?.lastErrorCode ? String(status.lastErrorCode).slice(0, 64) : null,
  };
}

function savedMcpServer(name) {
  const settings = modelSettings();
  const server = settings.mcpServers.find((item) => item.name === String(name || '').trim());
  return { settings, server };
}

function canonicalDirectory(rawPath) {
  const candidate = String(rawPath || '').trim();
  if (!candidate || !path.isAbsolute(candidate) || !fs.existsSync(candidate)) return '';
  try {
    const canonical = fs.realpathSync.native ? fs.realpathSync.native(candidate) : fs.realpathSync(candidate);
    if (!fs.statSync(canonical).isDirectory()) return '';
    return canonical;
  } catch { return ''; }
}

function makeRootId() {
  return `root_${crypto.randomBytes(18).toString('base64url')}`;
}

ipcMain.handle('mcp:roots:choose', async (event, payload = {}) => {
  const name = String(payload?.name || '').trim();
  const { settings, server } = savedMcpServer(name);
  if (!server) return { ok: false, code: 'MCP_SERVER_NOT_FOUND', error: 'MCP 服务器未保存' };
  if (!getMcpTaskManager().canChangeServer(name)) {
    return { ok: false, code: 'MCP_TASKS_CONFIG_LOCKED', error: '该 MCP 服务器仍有后台任务，请先取消或遗弃任务引用' };
  }
  const currentRoots = Array.isArray(server.roots) ? server.roots : [];
  if (currentRoots.length >= 8) return { ok: false, code: 'MCP_ROOT_LIMIT', error: '每个 MCP 服务器最多授权 8 个目录' };
  const win = windowFromEvent(event);
  const result = await dialog.showOpenDialog(win || undefined, {
    title: `为 ${name} 授权 MCP 目录`,
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
  const canonical = canonicalDirectory(result.filePaths[0]);
  if (!canonical) return { ok: false, code: 'MCP_ROOT_INVALID', error: '所选路径不是有效目录' };
  const existing = currentRoots.find((item) => item?.path && canonicalDirectory(item.path) === canonical);
  if (existing) {
    return {
      ok: true,
      root: { rootId: makePublicRootToken(event.sender.id, name, existing.rootId), label: existing.label },
      settings: toPublicSettings(settings, event.sender.id),
    };
  }
  const root = {
    rootId: makeRootId(),
    label: path.basename(canonical) || canonical,
    path: canonical,
  };
  const nextServers = settings.mcpServers.map((item) => item.name === name
    ? { ...item, roots: [...currentRoots, root].slice(0, 8) }
    : item);
  const saved = saveSettings(userDataPath(), { mcpServers: nextServers });
  await getMcpSessionManager().notifyRootsChanged?.(name);
  await getMcpSessionManager().invalidate(name, 'roots-changed');
  return { ok: true, root: { rootId: makePublicRootToken(event.sender.id, name, root.rootId), label: root.label }, settings: toPublicSettings(saved, event.sender.id) };
});

ipcMain.handle('mcp:roots:remove', async (event, payload = {}) => {
  const name = String(payload?.name || '').trim();
  const rootId = String(payload?.rootId || '').trim();
  if (!name || !rootId) return { ok: false, code: 'MCP_ROOT_INVALID', error: 'name/rootId 必填' };
  const persistedRootId = resolvePublicRootId(event.sender.id, name, rootId);
  if (!persistedRootId) return { ok: false, code: 'MCP_ROOT_OWNER', error: '无权操作此目录授权' };
  const { settings, server } = savedMcpServer(name);
  if (!server) return { ok: false, code: 'MCP_SERVER_NOT_FOUND', error: 'MCP 服务器未保存' };
  if (!getMcpTaskManager().canChangeServer(name)) {
    return { ok: false, code: 'MCP_TASKS_CONFIG_LOCKED', error: '该 MCP 服务器仍有后台任务，请先取消或遗弃任务引用' };
  }
  const roots = (server.roots || []).filter((root) => root.rootId !== persistedRootId);
  if (roots.length === (server.roots || []).length) return { ok: false, code: 'MCP_ROOT_NOT_FOUND', error: '目录授权不存在' };
  const saved = saveSettings(userDataPath(), { mcpServers: settings.mcpServers.map((item) => item.name === name ? { ...item, roots } : item) });
  await getMcpSessionManager().notifyRootsChanged?.(name);
  await getMcpSessionManager().invalidate(name, 'roots-changed');
  return { ok: true, settings: toPublicSettings(saved, event.sender.id) };
});

ipcMain.handle('mcp:session:status', async (_event, payload = {}) => {
  const name = payload?.name ? String(payload.name).trim() : '';
  const statuses = getMcpSessionManager().status(name).map((status) => ({ name: status.server, session: publicSessionStatus(status) }));
  const settings = modelSettings();
  if (name) return { ok: true, name, session: statuses[0]?.session || { state: 'disabled', reusable: false, lastErrorCode: null } };
  return {
    ok: true,
    sessions: settings.mcpServers.map((server) => ({ name: server.name, session: statuses.find((item) => item.name === server.name)?.session || { state: server.sessionRecovery ? 'idle' : 'disabled', reusable: server.sessionRecovery === true, lastErrorCode: null } })),
  };
});

ipcMain.handle('mcp:session:reset', async (_event, payload = {}) => {
  const name = payload?.name ? String(payload.name).trim() : null;
  if (!getMcpTaskManager().canChangeServer(name || undefined)) {
    return { ok: false, code: 'MCP_TASKS_CONFIG_LOCKED', error: '该 MCP 服务器仍有后台任务，请先取消或遗弃任务引用' };
  }
  await getMcpSessionManager().invalidate(name, 'manual-reset');
  return { ok: true };
});

function taskRefFromPayload(payload) {
  const ref = String(payload?.taskRef || '').trim();
  if (!/^mcp_task_[a-f0-9]{16,64}$/.test(ref)) {
    const error = new Error('任务引用无效');
    error.code = 'MCP_TASK_INVALID';
    throw error;
  }
  return ref;
}

ipcMain.handle('mcp:tasks:list', async (_event, payload = {}) => {
  const server = payload?.server ? String(payload.server).trim().slice(0, 96) : '';
  const limit = Number(payload?.limit);
  return { ok: true, persistence: getMcpTaskManager().persistence(), tasks: getMcpTaskManager().list({ server, limit }) };
});

ipcMain.handle('mcp:tasks:get', async (_event, payload = {}) => {
  try { return { ok: true, task: getMcpTaskManager().get(taskRefFromPayload(payload)) }; }
  catch (error) { return { ok: false, code: error.code || 'MCP_TASK_NOT_FOUND', error: error.message }; }
});

ipcMain.handle('mcp:tasks:result', async (_event, payload = {}) => {
  try {
    const result = await getMcpTaskManager().result(taskRefFromPayload(payload));
    return { ok: true, result };
  } catch (error) { return { ok: false, code: error.code || 'MCP_TASK_RESULT_UNAVAILABLE', error: error.message }; }
});

ipcMain.handle('mcp:tasks:result:prepare', async (_event, payload = {}) => {
  try {
    const targetSessionId = String(payload?.targetSessionId || '').trim().slice(0, 160);
    if (!targetSessionId) return { ok: false, code: 'MCP_TASK_CLAIM_INVALID', error: '目标会话不能为空' };
    return await getMcpTaskManager().prepareResultClaim(taskRefFromPayload(payload), targetSessionId);
  } catch (error) { return { ok: false, code: error.code || 'MCP_TASK_CLAIM_INVALID', error: error.message }; }
});

ipcMain.handle('mcp:tasks:result:commit', async (_event, payload = {}) => {
  try {
    const claimId = String(payload?.claimId || '').trim();
    if (!/^mcp_claim_[a-f0-9]{16,64}$/.test(claimId)) return { ok: false, code: 'MCP_TASK_CLAIM_INVALID', error: '认领凭证无效' };
    return await getMcpTaskManager().commitResultClaim(claimId, String(payload?.targetSessionId || '').trim().slice(0, 160));
  } catch (error) { return { ok: false, code: error.code || 'MCP_TASK_CLAIM_INVALID', error: error.message }; }
});

ipcMain.handle('mcp:tasks:cancel', async (_event, payload = {}) => {
  try { return { ok: true, task: await getMcpTaskManager().cancel(taskRefFromPayload(payload)) }; }
  catch (error) { return { ok: false, code: error.code || 'MCP_TASK_CANCEL_FAILED', error: error.message }; }
});

ipcMain.handle('mcp:tasks:abandon', async (_event, payload = {}) => {
  try { return { ok: true, task: getMcpTaskManager().abandon(taskRefFromPayload(payload)) }; }
  catch (error) { return { ok: false, code: error.code || 'MCP_TASK_NOT_FOUND', error: error.message }; }
});

ipcMain.handle('mcp:elicitation:respond', async (event, payload = {}) => {
  try {
    const id = String(payload?.elicitationId || '').trim();
    const action = String(payload?.action || '').trim();
    const content = payload?.content && typeof payload.content === 'object' && !Array.isArray(payload.content) ? payload.content : undefined;
    return { ok: true, response: getMcpElicitationController().respond(id, action, content, event.sender.id) };
  } catch (error) { return { ok: false, code: error.code || 'MCP_ELICITATION_SCHEMA_INVALID', error: error.message }; }
});

ipcMain.handle('mcp:elicitation:cancel', async (event, payload = {}) => {
  try { return { ok: true, cancelled: getMcpElicitationController().cancel(String(payload?.elicitationId || ''), event.sender.id) }; }
  catch (error) { return { ok: false, code: error.code || 'MCP_ELICITATION_CANCELLED', error: error.message }; }
});

ipcMain.handle('mcp:elicitation:open-url', async (event, payload = {}) => {
  try { return await getMcpElicitationController().openUrl(String(payload?.elicitationId || ''), event.sender.id); }
  catch (error) { return { ok: false, code: error.code || 'MCP_ELICITATION_OPEN_FAILED', error: error.message }; }
});

async function withPromptHub(senderId, payload, callback) {
  const settings = modelSettings();
  const projectPath = mcpProjectBySender.get(Number(senderId)) || '';
  const requestedServer = payload?.server ? String(payload.server).trim() : '';
  const serverConfigs = requestedServer
    ? settings.mcpServers.filter((server) => server.name === requestedServer)
    : settings.mcpServers;
  const hub = createMcpHub({ sessionManager: getMcpSessionManager() });
  try {
    await hub.startAll(serverConfigs, {
      cwd: projectPath || undefined,
      project: projectPath ? { path: projectPath, name: path.basename(projectPath) } : null,
      oauthManager: getMcpOAuthManager(),
    });
    return await callback(hub, settings);
  } finally {
    await hub.stopAll();
  }
}

ipcMain.handle('mcp:prompts:list', async (event, payload = {}) => {
  const name = payload?.server ? String(payload.server).trim() : '';
  const { server } = name ? savedMcpServer(name) : { server: true };
  if (name && !server) return { ok: false, code: 'MCP_SERVER_NOT_FOUND', error: 'MCP 服务器未保存' };
  try { return await withPromptHub(event.sender.id, payload, (hub) => hub.listPrompts(name)); } catch (error) { return { ok: false, code: error?.code || 'MCP_PROMPT_FAILED', error: error?.message || String(error) }; }
});

ipcMain.handle('mcp:prompts:get', async (event, payload = {}) => {
  const server = String(payload?.server || '').trim();
  const name = String(payload?.name || '').trim();
  const saved = savedMcpServer(server).server;
  if (!saved) return { ok: false, code: 'MCP_SERVER_NOT_FOUND', error: 'MCP 服务器未保存' };
  if (!name) return { ok: false, code: 'MCP_PROMPT_ARGUMENTS_INVALID', error: 'prompt name 必填' };
  try { return await withPromptHub(event.sender.id, payload, (hub) => hub.getPrompt(server, name, payload.arguments)); } catch (error) { return { ok: false, code: error?.code || 'MCP_PROMPT_FAILED', error: error?.message || String(error) }; }
});

ipcMain.handle('mcp:oauth:status', async () => {
  const settings = modelSettings();
  return {
    ok: true,
    statuses: getMcpOAuthManager().statuses(settings.mcpServers),
  };
});

ipcMain.handle('mcp:oauth:authorize', async (event, payload = {}) => {
  const name = String(payload?.name || '').trim();
  const settings = modelSettings();
  const cfg = settings.mcpServers.find((item) => item.name === name);
  if (!cfg || cfg.auth !== 'oauth') return { ok: false, code: 'MCP_OAUTH_METADATA_INVALID', error: '请先保存有效的 OAuth MCP 配置' };
  if (oauthPendingOwnersByName.has(name)) return { ok: false, code: 'MCP_OAUTH_CALLBACK_TIMEOUT', error: '该服务器已有授权流程正在进行' };
  const manager = getMcpOAuthManager();
  oauthPendingOwnersByName.set(name, event.sender.id);
  try {
    const status = await manager.authorize(name, cfg);
    return { ok: true, status };
  } catch (error) {
    return {
      ok: false,
      code: error?.code || 'MCP_OAUTH_TOKEN_FAILED',
      error: error?.message || 'OAuth 授权失败',
    };
  } finally {
    oauthPendingOwnersByName.delete(name);
  }
});

ipcMain.handle('mcp:oauth:cancel', async (event, payload = {}) => {
  const flowId = String(payload?.flowId || '').trim();
  if (!flowId || oauthFlowOwners.get(flowId) !== event.sender.id) {
    return { ok: false, code: 'MCP_OAUTH_STATE_MISMATCH', error: '无权取消此授权流程' };
  }
  const ok = getMcpOAuthManager().cancel(flowId);
  return ok ? { ok: true } : { ok: false, code: 'MCP_OAUTH_STATE_MISMATCH', error: '授权流程不存在' };
});

ipcMain.handle('mcp:oauth:logout', async (_event, payload = {}) => {
  const name = String(payload?.name || '').trim();
  const settings = modelSettings();
  const cfg = settings.mcpServers.find((item) => item.name === name);
  if (!cfg || cfg.auth !== 'oauth') return { ok: false, code: 'MCP_OAUTH_METADATA_INVALID', error: 'OAuth MCP 配置不存在' };
  if (!getMcpTaskManager().canChangeServer(name)) {
    return { ok: false, code: 'MCP_TASKS_CONFIG_LOCKED', error: '该 MCP 服务器仍有后台任务，请先取消或遗弃任务引用' };
  }
  try {
    const result = await getMcpOAuthManager().logout(name, cfg);
    await getMcpSessionManager().invalidate(name, 'oauth-logout');
    return result;
  } catch (error) {
    return { ok: false, code: error?.code || 'MCP_OAUTH_STORE_UNAVAILABLE', error: error?.message || '退出授权失败' };
  }
});

ipcMain.handle('skills:list', async (_e, payload = {}) => {
  const skills = discoverSkills({
    projectPath: payload.projectPath || null,
    userDataPath: userDataPath(),
    bundledDir: bundledSkillsDir(),
  });
  return {
    ok: true,
    skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source })),
  };
});

ipcMain.handle('skills:get', async (_e, payload = {}) => {
  const skills = discoverSkills({
    projectPath: payload.projectPath || null,
    userDataPath: userDataPath(),
    bundledDir: bundledSkillsDir(),
  });
  const name = String(payload.name || '').trim().toLowerCase();
  const meta = skills.find((s) => s.name === name);
  if (!meta) return { ok: false, error: '未找到 skill: ' + name };
  return loadSkillBody(meta);
});

ipcMain.handle('hooks:summary', async (_e, payload = {}) => {
  const settings = modelSettings();
  const projectPath = payload.projectPath ? String(payload.projectPath) : null;
  const resolved = loadHooks({
    userDataPath: userDataPath(),
    projectPath,
  });
  return {
    enabled: settings.hooksEnabled !== false,
    userPath: resolved.userPath,
    projectPath: resolved.projectPath,
    countsByEvent: resolved.countsByEvent,
    errors: resolved.errors,
  };
});

/** Compact has the same foreground lease, accepted model, cancellation and task identity as chat. */
ipcMain.handle('session:compact', async (event, payload = {}) => startForegroundModelRun(event, payload, {}, 'session_compact'));

async function compactAcceptedHistory(messages, payload, lease, manual) {
  const { settings, binding, contextPolicy } = lease;
  const plan = planCompact(messages, {
    keepMessages: manual ? clampInt(payload.keepMessages, 6, 80, settings.compactKeepMessages) : settings.compactKeepMessages,
    maxMessages: settings.compactMaxMessages, maxApproxTokens: settings.compactMaxApproxTokens,
    force: manual && payload.force === true,
  });
  if (!plan.needed) return { ok: true, needed: false, approxTokens: plan.approxTokens, candidates: [] };
  if (lease.abort.signal.aborted) throwAborted();
  let compactUsage = null;
  const onUsage = (usage) => {
    if (usage.kind === 'compact') compactUsage = usage;
    lease.emit(usage);
  };
  const candidateLimit = contextPolicy.projectMemory && settings.memoryCandidateEnabled !== false
    ? clampInt(payload.candidateLimit, 0, 5, manual ? 0 : 5) : 0;
  const artifacts = await generateCompactArtifacts({
    transcript: serializeOlderTranscript(plan.older), settings, modelBinding: binding,
    signal: lease.abort.signal, candidateLimit,
    chatFn: boundModelChat(binding, settings, { kind: 'compact', signal: lease.abort.signal, onUsage }),
    candidateChatFn: boundModelChat(binding, settings, { kind: 'memory-candidate', signal: lease.abort.signal, onUsage }),
  });
  if (lease.abort.signal.aborted) throwAborted();
  const compacted = applyCompact(messages, plan, artifacts.summary);
  if (compacted[0]) compacted[0] = { ...compacted[0], modelSource: lease.modelSource };
  return { ok: true, needed: true, messages: compacted, compactedCount: plan.older.length,
    approxTokens: plan.approxTokens, olderApproxTokens: plan.olderApproxTokens, usage: compactUsage,
    candidates: artifacts.candidates, candidateWarning: artifacts.candidateWarning };
}

async function executeAcceptedCompact(payload, lease) {
  return compactAcceptedHistory(Array.isArray(payload.messages) ? payload.messages : [], payload, lease, true);
}

/** Phase D.1 export: serialize here, then write wherever the user picks. */
ipcMain.handle('session:export', async (_e, payload = {}) => {
  try {
    const format = payload.format === 'json' ? 'json' : 'md';
    const session = payload.session && typeof payload.session === 'object' ? payload.session : {};
    const content = format === 'json' ? exportSessionJson(session) : exportSessionMarkdown(session);
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showSaveDialog(win || undefined, {
      title: '导出会话',
      defaultPath: defaultExportFilename(session, format),
      filters: format === 'json'
        ? [{ name: 'JSON', extensions: ['json'] }]
        : [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { ok: true, path: result.filePath, bytes: Buffer.byteLength(content, 'utf8') };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

/**
 * Phase D.2 memory channels — UI-driven, so no PermissionGate (the tiers gate
 * the model, not the user). All the logic lives in the pure handlers.
 */
ipcMain.handle('memory:list', async (_e, payload = {}) => memoryList({
  settings: modelSettings(), userDataPath: userDataPath(), payload,
}));

ipcMain.handle('memory:add', async (_e, payload = {}) => memoryAdd({
  settings: modelSettings(), userDataPath: userDataPath(), payload,
}));

ipcMain.handle('memory:delete', async (_e, payload = {}) => memoryDelete({
  settings: modelSettings(), userDataPath: userDataPath(), payload,
}));

ipcMain.handle('memory:accept', async (_e, payload = {}) => memoryAccept({
  settings: modelSettings(), userDataPath: userDataPath(), payload,
}));

ipcMain.handle('memory:update', async (_e, payload = {}) => memoryUpdate({
  settings: modelSettings(), userDataPath: userDataPath(), payload,
}));

// Phase D.5 worktree results. Only bind accepts a project path; every later
// call routes through the sender-scoped opaque binding token.
ipcMain.handle('worktree:bind', async (event, payload = {}) => {
  const previousPaths = worktreeIpc.listProjectPaths(event);
  const result = worktreeIpc.bind(event, payload);
  if (result?.ok) {
    revokeInvalidProjectModelBindings(event);
    planState.expireBinding({ senderId: event.sender.id, projectId: payload.projectId });
    const engineering = getEngineeringIpc();
    for (const root of previousPaths) {
      if (!worktreeIpc.hasProjectBinding(event, root)) engineering.dropProject(event, root);
    }
    engineering.syncOwnerBindings(event, worktreeIpc.listProjectPaths(event));
  }
  return result;
});
ipcMain.handle('worktree:unbind', async (event, payload = {}) => {
  const binding = worktreeIpc.resolveBinding(event, payload);
  const result = worktreeIpc.unbind(event, payload);
  if (result?.ok) {
    revokeInvalidProjectModelBindings(event);
    planState.expireBinding({ senderId: event.sender.id, projectBindingId: payload.projectBindingId });
  }
  if (result?.ok && binding?.projectPath && !worktreeIpc.hasProjectBinding(event, binding.projectPath)) {
    engineeringIpc?.dropProject(event, binding.projectPath);
  }
  return result;
});
ipcMain.handle('worktree:list', async (event, payload = {}) => worktreeIpc.list(event, payload));
ipcMain.handle('worktree:get', async (event, payload = {}) => worktreeIpc.get(event, payload));
ipcMain.handle('worktree:apply', async (event, payload = {}) => worktreeIpc.apply(event, payload));
ipcMain.handle('worktree:discard', async (event, payload = {}) => worktreeIpc.discard(event, payload));
ipcMain.handle('worktree:retryCollect', async (event, payload = {}) => worktreeIpc.retryCollect(event, payload));
ipcMain.handle('worktree:cleanup', async (event, payload = {}) => worktreeIpc.cleanup(event, payload));
ipcMain.handle('worktree:open', async (event, payload = {}) => worktreeIpc.open(event, payload));
ipcMain.handle('worktree:pr:preflight', async (event, payload = {}) => worktreeIpc.preflight(event, payload));
ipcMain.handle('worktree:pr:create', async (event, payload = {}) => worktreeIpc.createPr(event, payload));
ipcMain.handle('worktree:pr:retry', async (event, payload = {}) => worktreeIpc.retryPr(event, payload));
ipcMain.handle('worktree:pr:cleanup', async (event, payload = {}) => worktreeIpc.cleanupPr(event, payload));
ipcMain.handle('worktree:pr:list', async (event, payload = {}) => worktreeIpc.listPrs(event, payload));
ipcMain.handle('worktree:pr:get', async (event, payload = {}) => worktreeIpc.getPr(event, payload));
ipcMain.handle('worktree:pr:edit', async (event, payload = {}) => worktreeIpc.editPr(event, payload));
ipcMain.handle('worktree:pr:comment', async (event, payload = {}) => worktreeIpc.commentPr(event, payload));
ipcMain.handle('worktree:pr:close', async (event, payload = {}) => worktreeIpc.closeLifecyclePr(event, payload));
ipcMain.handle('worktree:pr:reopen', async (event, payload = {}) => worktreeIpc.reopenPr(event, payload));
ipcMain.handle('worktree:pr:ready', async (event, payload = {}) => worktreeIpc.readyPr(event, payload));
ipcMain.handle('worktree:pr:merge', async (event, payload = {}) => worktreeIpc.mergePr(event, payload));
ipcMain.handle('worktree:pr:open', async (event, payload = {}) => worktreeIpc.openPr(event, payload));

// Phase D.11 engineering center. All project access is resolved through the
// sender-owned worktree binding; renderer payloads never carry a path/command.
ipcMain.handle('engineering:index:ensure', async (event, payload = {}) => getEngineeringIpc().ensure(event, payload));
ipcMain.handle('engineering:index:status', async (event, payload = {}) => getEngineeringIpc().status(event, payload));
ipcMain.handle('engineering:index:rebuild', async (event, payload = {}) => getEngineeringIpc().rebuild(event, payload));
ipcMain.handle('engineering:index:clear', async (event, payload = {}) => getEngineeringIpc().clear(event, payload));
ipcMain.handle('engineering:index:search', async (event, payload = {}) => getEngineeringIpc().search(event, payload));
ipcMain.handle('engineering:index:location', async (event, payload = {}) => getEngineeringIpc().location(event, payload));
ipcMain.handle('engineering:verification:profiles', async (event, payload = {}) => getEngineeringIpc().profiles(event, payload));
ipcMain.handle('engineering:verification:profile:save', async (event, payload = {}) => getEngineeringIpc().saveProfile(event, payload));
ipcMain.handle('engineering:verification:profile:delete', async (event, payload = {}) => getEngineeringIpc().deleteProfile(event, payload));
ipcMain.handle('engineering:verification:run', async (event, payload = {}) => getEngineeringIpc().run(event, payload));
ipcMain.handle('engineering:verification:list', async (event, payload = {}) => getEngineeringIpc().list(event, payload));
ipcMain.handle('engineering:verification:get', async (event, payload = {}) => getEngineeringIpc().get(event, payload));
ipcMain.handle('engineering:verification:result', async (event, payload = {}) => getEngineeringIpc().result(event, payload));
ipcMain.handle('engineering:verification:cancel', async (event, payload = {}) => getEngineeringIpc().cancel(event, payload));
ipcMain.handle('engineering:verification:rerun', async (event, payload = {}) => getEngineeringIpc().rerun(event, payload));
ipcMain.handle('engineering:verification:revoke-grant', async (event, payload = {}) => getEngineeringIpc().revokeGrant(event, payload));
ipcMain.handle('engineering:workflow:list', async (event, payload = {}) => getEngineeringIpc().workflows(event, payload));
ipcMain.handle('engineering:workflow:get', async (event, payload = {}) => getEngineeringIpc().workflowGet(event, payload));
ipcMain.handle('engineering:workflow:save', async (event, payload = {}) => getEngineeringIpc().workflowSave(event, payload));
ipcMain.handle('engineering:workflow:delete', async (event, payload = {}) => getEngineeringIpc().workflowDelete(event, payload));
ipcMain.handle('engineering:workflow:run', async (event, payload = {}) => getEngineeringIpc().workflowRun(event, payload));
ipcMain.handle('engineering:workflow:runs', async (event, payload = {}) => getEngineeringIpc().workflowRuns(event, payload));
ipcMain.handle('engineering:workflow:result', async (event, payload = {}) => getEngineeringIpc().workflowResult(event, payload));
ipcMain.handle('engineering:workflow:cancel', async (event, payload = {}) => getEngineeringIpc().workflowCancel(event, payload));
ipcMain.handle('engineering:workflow:rerun', async (event, payload = {}) => getEngineeringIpc().workflowRerun(event, payload));
ipcMain.handle('engineering:workflow:gate-check', async (event, payload = {}) => getEngineeringIpc().workflowGateCheck(event, payload));
ipcMain.handle('engineering:repair:list', async (event, payload = {}) => getEngineeringIpc().repairList(event, payload));
ipcMain.handle('engineering:ci-watch:start', (event, payload = {}) => getEngineeringIpc().ciWatchStart(event, payload));
ipcMain.handle('engineering:ci-watch:list', (event, payload = {}) => getEngineeringIpc().ciWatchList(event, payload));
ipcMain.handle('engineering:ci-watch:get', (event, payload = {}) => getEngineeringIpc().ciWatchGet(event, payload));
ipcMain.handle('engineering:ci-watch:stop', (event, payload = {}) => getEngineeringIpc().ciWatchStop(event, payload));
ipcMain.handle('engineering:ci-watch:ack', (event, payload = {}) => getEngineeringIpc().ciWatchAck(event, payload));
ipcMain.handle('engineering:pr-review:threads', (event, payload = {}) => getEngineeringIpc().prReviewThreads(event, payload));
ipcMain.handle('engineering:pr-review:get', (event, payload = {}) => getEngineeringIpc().prReviewGet(event, payload));
ipcMain.handle('engineering:pr-review:snapshot', (event, payload = {}) => getEngineeringIpc().prReviewSnapshot(event, payload));
ipcMain.handle('engineering:pr-review:source', (event, payload = {}) => getEngineeringIpc().prReviewSource(event, payload));
ipcMain.handle('engineering:pr-review:reply', (event, payload = {}) => getEngineeringIpc().prReviewReply(event, payload));
ipcMain.handle('engineering:pr-review:resolve', (event, payload = {}) => getEngineeringIpc().prReviewResolve(event, payload));
ipcMain.handle('engineering:pr-review:update-pr', (event, payload = {}) => getEngineeringIpc().prReviewUpdatePr(event, payload));
ipcMain.handle('engineering:pr-audit:start', (event, payload = {}) => getEngineeringIpc().prAuditStart(event, payload));
ipcMain.handle('engineering:pr-audit:tracking:list', (event, payload = {}) => getEngineeringIpc().prAuditTrackingList(event, payload));
ipcMain.handle('engineering:pr-audit:tracking:get', (event, payload = {}) => getEngineeringIpc().prAuditTrackingGet(event, payload));
ipcMain.handle('engineering:pr-audit:recheck:start', (event, payload = {}) => getEngineeringIpc().prAuditRecheckStart(event, payload));
ipcMain.handle('engineering:pr-audit:recheck:list', (event, payload = {}) => getEngineeringIpc().prAuditRecheckList(event, payload));
ipcMain.handle('engineering:pr-audit:recheck:get', (event, payload = {}) => getEngineeringIpc().prAuditRecheckGet(event, payload));
ipcMain.handle('engineering:pr-audit:recheck:cancel', (event, payload = {}) => getEngineeringIpc().prAuditRecheckCancel(event, payload));
ipcMain.handle('engineering:pr-audit:recheck:context', (event, payload = {}) => getEngineeringIpc().prAuditRecheckContext(event, payload));
ipcMain.handle('engineering:pr-audit:recheck:repair-snapshot', (event, payload = {}) => getEngineeringIpc().prAuditRecheckRepairSnapshot(event, payload));
ipcMain.handle('engineering:pr-audit:recheck:repair-source', (event, payload = {}) => getEngineeringIpc().prAuditRecheckRepairSource(event, payload));
ipcMain.handle('engineering:pr-audit:recheck:update-pr', (event, payload = {}) => getEngineeringIpc().prAuditRecheckUpdatePr(event, payload));
ipcMain.handle('engineering:pr-audit:list', (event, payload = {}) => getEngineeringIpc().prAuditList(event, payload));
ipcMain.handle('engineering:pr-audit:get', (event, payload = {}) => getEngineeringIpc().prAuditGet(event, payload));
ipcMain.handle('engineering:pr-audit:cancel', (event, payload = {}) => getEngineeringIpc().prAuditCancel(event, payload));
ipcMain.handle('engineering:pr-audit:context', (event, payload = {}) => getEngineeringIpc().prAuditContext(event, payload));
ipcMain.handle('engineering:pr-audit:prepare', (event, payload = {}) => getEngineeringIpc().prAuditPrepare(event, payload));
ipcMain.handle('engineering:pr-audit:publish', (event, payload = {}) => getEngineeringIpc().prAuditPublish(event, payload));
ipcMain.handle('engineering:pr-audit:reconcile', (event, payload = {}) => getEngineeringIpc().prAuditReconcile(event, payload));
ipcMain.handle('engineering:pr-audit:repair-snapshot', (event, payload = {}) => getEngineeringIpc().prAuditRepairSnapshot(event, payload));
ipcMain.handle('engineering:pr-audit:repair-source', (event, payload = {}) => getEngineeringIpc().prAuditRepairSource(event, payload));
ipcMain.handle('engineering:pr-audit:update-pr', (event, payload = {}) => getEngineeringIpc().prAuditUpdatePr(event, payload));
ipcMain.handle('engineering:remote-ci:failures', (event, payload = {}) => getEngineeringIpc().remoteCiFailures(event, payload));
ipcMain.handle('engineering:remote-ci:snapshot', (event, payload = {}) => getEngineeringIpc().remoteCiSnapshot(event, payload));
ipcMain.handle('engineering:remote-ci:list', (event, payload = {}) => getEngineeringIpc().remoteCiList(event, payload));
ipcMain.handle('engineering:remote-ci:get', (event, payload = {}) => getEngineeringIpc().remoteCiGet(event, payload));
ipcMain.handle('engineering:remote-ci:rerun', (event, payload = {}) => getEngineeringIpc().remoteCiRerun(event, payload));
ipcMain.handle('engineering:remote-ci:update-pr', (event, payload = {}) => getEngineeringIpc().remoteCiUpdatePr(event, payload));
ipcMain.handle('engineering:repair:get', async (event, payload = {}) => getEngineeringIpc().repairGet(event, payload));
ipcMain.handle('engineering:repair:result', async (event, payload = {}) => getEngineeringIpc().repairResult(event, payload));
ipcMain.handle('engineering:repair:start', async (event, payload = {}) => getEngineeringIpc().repairStart(event, payload));
ipcMain.handle('engineering:repair:retry', async (event, payload = {}) => getEngineeringIpc().repairRetry(event, payload));
ipcMain.handle('engineering:repair:cancel', async (event, payload = {}) => getEngineeringIpc().repairCancel(event, payload));
ipcMain.handle('engineering:repair:validate', async (event, payload = {}) => getEngineeringIpc().repairValidate(event, payload));
ipcMain.handle('engineering:repair:validate-cancel', async (event, payload = {}) => getEngineeringIpc().repairValidateCancel(event, payload));

ipcMain.handle('dialog:selectDirectory', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win || undefined, {
    title: '选择项目目录',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths?.[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('shell:openPath', async (_e, targetPath) => {
  if (!targetPath || !fs.existsSync(targetPath)) throw new Error('路径不存在');
  const err = await shell.openPath(targetPath);
  if (err) throw new Error(err);
  return true;
});

ipcMain.handle('project:listTree', async (_e, projectPath, opts) => listTree(projectPath, opts || {}));
ipcMain.handle('project:readFile', async (_e, projectPath, relPath) => readFile(projectPath, relPath));
ipcMain.handle('project:writeFile', async (_e, projectPath, relPath, content) => writeFile(projectPath, relPath, content));
ipcMain.handle('project:deletePath', async (_e, projectPath, relPath) => deletePath(projectPath, relPath));

// Read-only git IPC (no commit — commit only via agent tool)
ipcMain.handle('git:status', async (_e, payload = {}) => {
  const projectPath = payload?.projectPath;
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    return { ok: false, branch: '', entries: [], summary: '', error: 'projectPath 无效' };
  }
  return gitStatus(projectPath);
});

ipcMain.handle('git:diff', async (_e, payload = {}) => {
  const projectPath = payload?.projectPath;
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    return {
      ok: false,
      text: '',
      truncated: false,
      staged: !!payload?.staged,
      error: 'projectPath 无效',
    };
  }
  return gitDiff(projectPath, {
    path: payload.path,
    staged: payload.staged,
    maxBytes: payload.maxBytes,
  });
});

ipcMain.handle('chat:stop', async (event, payload = {}) => {
  // Aborting never releases the lease: finally must finish readers, tools and gates.
  // Manual terminals, audits and diagnostics have independent owners/controllers.
  return foregroundModels.cancel({ senderId: event.sender.id, sessionId: payload.sessionId,
    runId: payload.runId, clientRequestId: payload.clientRequestId });
});

ipcMain.handle('chat:approve', async (event, payload = {}) => {
  const approvalId = payload?.approvalId;
  const decision = payload?.decision;
  if (!approvalId) {
    return { ok: false, error: 'no-active-approval' };
  }
  const normalized =
    decision === 'allow' || decision === 'allow_session' ? decision : 'deny';
  // Try active chat gate first, then manual terminal gate.
  const candidates = [
    activeRun ? { gate: activeRun.gate, sender: activeRun.sender, runId: activeRun.runId } : null,
    manualTerm ? { gate: manualTerm.gate, sender: manualTerm.sender, runId: activeRun?.runId ?? null } : null,
    // Background D11 verification approvals are owned by the invoking
    // renderer sender and are resolved without attaching them to chat history.
    getEngineeringIpc() ? { gate: { resolveApproval: (id, d) => getEngineeringIpc().resolveApproval(event, id, d) }, sender: event.sender, runId: null } : null,
  ].filter(Boolean);

  if (!candidates.length) {
    return { ok: false, error: 'no-active-approval' };
  }

  for (const c of candidates) {
    if (c.sender && c.sender !== event.sender) continue;
    if (payload?.runId && c.runId && String(payload.runId) !== String(c.runId)) continue;
    if (c.gate.resolveApproval(approvalId, normalized)) {
      safeSend(c.sender, 'chat:event', {
        type: AGENT_EVENTS.APPROVAL_RESOLVED,
        runId: c.runId,
        approvalId,
        decision: normalized,
      });
      return { ok: true };
    }
  }
  return { ok: false, error: '无待审批项' };
});

// --- Manual terminal panel IPC (one run at a time; independent of chat:stop) ---

ipcMain.handle('terminal:run', async (event, payload = {}) => {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
  const projectPath = typeof payload.projectPath === 'string' ? payload.projectPath.trim() : '';
  const command = String(payload.command || '').trim();
  const cwdOpt = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : undefined;
  const sender = event.sender;

  if (worktreeMutation) {
    return { ok: false, code: 'BUSY', error: '隔离改动正在应用或清理，请稍后重试' };
  }

  if (!sessionId || !projectPath || !command) {
    return { ok: false, error: '参数无效：需要 sessionId、projectPath、command' };
  }
  if (manualTerm) {
    return { ok: false, error: '已有命令在运行，请先停止或等待结束' };
  }
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    return { ok: false, error: '项目路径无效' };
  }

  const settings = modelSettings();
  if (!settings.terminalEnabled) {
    return { ok: false, error: '终端未启用。请在设置中打开「允许终端」。' };
  }

  const abort = new AbortController();
  const signal = abort.signal;
  const termId = makeTermId();

  const gate = createPermissionGate({
    policyLevel: settings.executionPolicy,
    requestHostExecution: (request) => requestHostExecution(sender, request),
    permissionMode: PERMISSION_MODES.has(settings.permissionMode)
      ? settings.permissionMode
      : 'confirm-writes',
    terminalEnabled: Boolean(settings.terminalEnabled),
    terminalRequireConfirm: settings.terminalRequireConfirm !== false,
    onApprovalNeeded: async (approvalPayload) => {
      safeSend(sender, 'chat:event', {
        type: AGENT_EVENTS.APPROVAL_NEEDED,
        runId: activeRun?.runId ?? null,
        source: 'user',
        ...approvalPayload,
      });
    },
  });

  manualTerm = { abort, gate, sessionId, sender, termId };

  const emit = (e) => {
    safeSend(sender, 'chat:event', { runId: null, source: 'user', ...e });
  };

  try {
    const auth = await gate.authorize({
      tool: 'run_terminal',
      risk: 'terminal',
      summary: `手动执行: ${command.slice(0, 120)}`,
      detail: command, args: { command, cwd: cwdOpt }, projectRoot: projectPath,
      path: '.',
      sessionKey: sessionId,
      signal,
    });
    if (!auth.allowed) {
      return { ok: false, error: auth.reason || '用户拒绝' };
    }
    if (signal.aborted) {
      return { ok: false, error: '已停止', aborted: true };
    }

    const cwdDisplay = cwdOpt || projectPath;
    emit({
      type: AGENT_EVENTS.TERMINAL_START,
      termId,
      command,
      cwd: cwdDisplay,
      source: 'user',
    });

    let result;
    try {
      result = await runTerminal(projectPath, command, {
        sessionKey: sessionId, hostExecutionGrant: auth.hostExecutionGrant,
        policyLevel: settings.executionPolicy,
        cwd: cwdOpt,
        timeoutMs: settings.terminalTimeoutMs || 60000,
        signal,
        onStdout: (chunk) => emit({
          type: AGENT_EVENTS.TERMINAL_OUTPUT,
          termId,
          stream: 'stdout',
          chunk: String(chunk),
        }),
        onStderr: (chunk) => emit({
          type: AGENT_EVENTS.TERMINAL_OUTPUT,
          termId,
          stream: 'stderr',
          chunk: String(chunk),
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const aborted = isAbortError(err, signal);
      emit({
        type: AGENT_EVENTS.TERMINAL_END,
        termId,
        code: -1,
        ok: false,
        timedOut: false,
        aborted,
        summary: msg,
      });
      return { ok: false, error: msg, aborted, termId };
    }

    emit({
      type: AGENT_EVENTS.TERMINAL_END,
      termId,
      code: result.code,
      ok: result.ok,
      timedOut: result.timedOut,
      aborted: result.aborted,
      summary: `exit=${result.code}`,
    });
    return { ok: true, termId, ...result };
  } catch (err) {
    if (isAbortError(err, signal)) {
      return { ok: false, error: '已停止', aborted: true, termId };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err), termId };
  } finally {
    if (manualTerm && manualTerm.termId === termId) {
      manualTerm = null;
    }
  }
});

ipcMain.handle('terminal:stop', async (event, payload = {}) => {
  if (!manualTerm) return { ok: true, stopped: false };
  if (manualTerm.sender !== event.sender) return { ok: false, error: '终端属于其他窗口' };
  if (payload?.sessionId && manualTerm.sessionId !== payload.sessionId) {
    return { ok: false, error: '会话不匹配' };
  }
  abortManualTerm();
  return { ok: true, stopped: true };
});

ipcMain.handle('terminal:clear', async () => {
  // Clear is UI-local; main acknowledges for symmetry / future history wipe.
  return { ok: true };
});

ipcMain.handle('atRef:complete', async (_e, payload = {}) => {
  const projectPath = payload.projectPath || payload.project?.path || null;
  const prefix = payload.prefix != null ? String(payload.prefix) : '';
  if (!projectPath) return { items: [] };
  try {
    const items = completeAtPath(projectPath, prefix, {
      limit: payload.limit != null ? Number(payload.limit) : undefined,
    });
    return { items };
  } catch (err) {
    return { items: [], error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('atRef:expand', async (_e, payload = {}) => {
  const projectPath = payload.projectPath || payload.project?.path || null;
  const text = payload.text != null ? String(payload.text) : '';
  try {
    return expandAtRefs(projectPath, text);
  } catch (err) {
    return {
      contextBlock: null,
      refs: [],
      warnings: [err instanceof Error ? err.message : String(err)],
    };
  }
});

/**
 * Shared chat run entry for chat:send and chat:approvePlan.
 * @param {Electron.IpcMainInvokeEvent} event
 * @param {object} payload
 * @param {{ stopPrevious?: boolean }} [opts]
 */
function acceptedRunMetadata(lease) {
  return { runId: lease.runId, sessionId: lease.sessionId, clientRequestId: lease.clientRequestId,
    modelSource: lease.modelSource, task: lease.task.toSummary() };
}

function emitAcceptedRun(lease, event) {
  if (!event || lease.terminalEmitted) return;
  const terminal = [AGENT_EVENTS.DONE, AGENT_EVENTS.ERROR, AGENT_EVENTS.ABORTED,
    'compact-done', 'compact-error', 'compact-cancelled'].includes(event.type);
  if (event.type === AGENT_EVENTS.USAGE) persistUsageEvent(lease.settings, lease.sessionId, event);
  if (terminal) {
    lease.terminalEmitted = true;
    if ([AGENT_EVENTS.ABORTED, 'compact-cancelled'].includes(event.type)) lease.task.cancel();
    else if ([AGENT_EVENTS.ERROR, 'compact-error'].includes(event.type)) lease.task.fail(event.message || event.error);
    else lease.task.complete();
  }
  safeSend(lease.sender, 'chat:event', { ...event, ...acceptedRunMetadata(lease) });
}

function preflightAcceptedRun(binding, settings, contextPolicy, project, payload, kind) {
  if (settings.mode !== 'api') return;
  // Pure, no @ref expansion, project files, credentials, events or physical attempts.
  const projected = messagesForModel(Array.isArray(payload.messages) ? payload.messages : [], null);
  const messages = [{ role: 'system', content: binding.assistant.systemPrompt || '你是一位 AI 助手。' },
    ...(projected.length ? projected : [{ role: 'user', content: '总结此会话。' }])];
  const intendedAgent = kind === 'chat' && contextPolicy.toolsAllowed && settings.agentEnabled !== false
    && (project?.path || settings.memoryEnabled !== false);
  if (intendedAgent && binding.compatibility.toolMode === 'native' && binding.capabilities.nativeTools.state !== 'supported') {
    const state = binding.capabilities.nativeTools.state;
    const error = new (require('./ai/model-adapters/common').ModelError)('MODEL_CAPABILITY_REQUIRED', '原生工具能力尚未验证或不受支持；请先诊断或显式选择文本兼容模式。');
    error.capabilityState = state;
    error.publicCode = state === 'unsupported' ? 'MODEL_CAPABILITY_UNSUPPORTED' : 'MODEL_CAPABILITY_UNKNOWN';
    throw error;
  }
  preflightModelRequest({ binding, messages });
}

async function startForegroundModelRun(event, payload = {}, opts = {}, kind = 'chat') {
  if (worktreeMutation || foregroundModels.current) return busyRunResult();
  let lease;
  try {
    payload = structuredClone(payload);
    const runId = makeRunId();
    const sessionId = String(payload.sessionId || '');
    const clientRequestId = String(payload.clientRequestId || '');
    const { binding, project, contextPolicy } = resolveModelContext(event, payload, { runId, clientRequestId, kind });
    const settings = modelSettings();
    const agentMode = normalizeAgentMode(payload.agentMode);
    preflightAcceptedRun(binding, settings, contextPolicy, project, payload, kind);
    const planBinding = kind === 'chat' && agentMode === 'plan' ? resolvePlanBinding(event, payload, binding) : null;
    lease = foregroundModels.acquire({ senderId: event.sender.id, sessionId, clientRequestId, runId, kind, binding,
      sender: event.sender, settings, project, contextPolicy, agentMode, planBinding });
    lease.modelSource = publicModelSource(binding, { kind: settings.mode === 'api' ? 'api' : 'local-demo' });
    lease.task = new TaskHandle({ taskId: runId, kind: kind === 'chat' ? TASK_KINDS.CHAT_RUN : TASK_KINDS.SESSION_COMPACT,
      sessionId, projectId: project?.id, ownerId: event.sender.id, abortController: lease.abort,
      onStatusChange: (status) => safeSend(event.sender, 'chat:event', { type: 'task-status', ...acceptedRunMetadata(lease),
        data: createTaskEventEnvelope({ ...status, sessionId, projectId: project?.id, type: 'status', data: status }) }),
    });
    lease.emit = (entry) => emitAcceptedRun(lease, entry);
    activeRun = lease;
    // Spend Plan authority synchronously before any accepted execution can run.
    opts.onExecutionStarted?.(runId);
    lease.completion = (async () => {
      await new Promise((resolve) => setImmediate(resolve));
      let result; let failure;
      try {
        lease.task.start();
        lease.emit({ type: kind === 'chat' ? AGENT_EVENTS.RUN_START : 'compact-start',
          ...(opts.userMessage ? { userMessage: opts.userMessage } : {}) });
        result = kind === 'chat' ? await executeAcceptedChat(event, payload, opts, lease) : await executeAcceptedCompact(payload, lease);
        if (!lease.terminalEmitted) lease.emit({ type: kind === 'chat' ? AGENT_EVENTS.DONE : 'compact-done', ...result });
      } catch (error) {
        failure = error;
        const aborted = isAbortError(error, lease.abort.signal);
        const projected = publicRunError(error, lease.modelSource);
        const message = projected.safeMessage;
        result = { ...projected, ok: false, error: message, aborted };
        lease.emit({ type: kind === 'chat' ? (aborted ? AGENT_EVENTS.ABORTED : AGENT_EVENTS.ERROR)
          : (aborted ? 'compact-cancelled' : 'compact-error'), message, ...result });
      } finally {
        try { lease.gate?.cancelPending('运行已结束'); } catch { /* no authority remains */ }
        try { await lease.cleanup?.(); } catch { /* cleanup cannot turn a failed attempt into success */ }
        result = redactSecrets({ ok: true, ...result, accepted: true, mode: result?.mode || settings.mode, ...acceptedRunMetadata(lease) });
        try { await opts.onSettled?.(result, failure); } catch { /* completion cannot revive spent authority */ }
        foregroundModels.release(lease);
        if (activeRun === lease) activeRun = null;
      }
      return result;
    })();
    // Acceptance is carried by run-start/compact-start; invoke keeps its final-result contract.
    return await lease.completion;
  } catch (error) {
    if (lease) { foregroundModels.release(lease); if (activeRun === lease) activeRun = null; }
    const projected = publicRunError(error);
    return { ...projected, ok: false, error: projected.safeMessage };
  }
}

async function startChatRun(event, payload = {}, opts = {}) {
  return startForegroundModelRun(event, payload, opts, 'chat');
}

async function executeAcceptedChat(event, payload, opts, lease) {
  const { runId, abort, sender, agentMode, sessionId, clientRequestId, settings, project, contextPolicy, binding: modelBinding, planBinding, modelSource } = lease;
  const signal = abort.signal;
  const gate = createPermissionGate({
    projectRoot: project?.path,
    projectId: JSON.stringify([sender.id, modelBinding.projectBindingId || '', project?.id || '']),
    policyLevel: settings.executionPolicy,
    requestHostExecution: (request) => requestHostExecution(sender, request),
    permissionMode: PERMISSION_MODES.has(settings.permissionMode)
      ? settings.permissionMode
      : 'confirm-writes',
    terminalEnabled: Boolean(settings.terminalEnabled),
    terminalRequireConfirm: settings.terminalRequireConfirm !== false,
    webEnabled: settings.webEnabled === true,
    webRequireConfirm: settings.webRequireConfirm !== false,
    agentMode,
    onApprovalNeeded: async (approvalPayload) => {
      const approvalEvent = {
        type: AGENT_EVENTS.APPROVAL_NEEDED,
        ...approvalPayload,
        runId, sessionId, clientRequestId, modelSource, task: lease.task.toSummary(),
      };
      // Engineering callers can explicitly route approvals (for example,
      // repair validation); ordinary verification still uses its own panel.
      // Keep ordinary chat approvals source-less so they remain on chatRun.
      if (approvalPayload.source) approvalEvent.source = approvalPayload.source;
      else if (approvalPayload.tool === 'verification_start') approvalEvent.source = 'verification';
      safeSend(sender, 'chat:event', approvalEvent);
    },
  });

  const task = lease.task;
  lease.gate = gate;
  const emit = (entry) => {
    if (!entry || lease.terminalEmitted) return;
    if (entry.type === AGENT_EVENTS.PLAN_READY && sessionId) {
      const accepted = planBinding || resolvePlanBinding(event, payload, modelBinding);
      // The optimistic registry revision was checked at acceptance. Evidence may
      // advance it within this same run; only actual binding/policy changes revoke Plan rights.
      const current = resolvePlanBinding(event, { ...payload, expectedRegistryRevision: undefined });
      if (Object.keys(accepted).some((key) => String(accepted[key]) !== String(current[key]))) {
        throw Object.assign(new Error('模型、助手、权限或项目绑定已改变，请重新生成计划。'), { code: 'PLAN_BINDING_CHANGED' });
      }
      const previous = planState.getPending(sessionId, accepted);
      const plan = planState.propose({ ...entry, ...accepted });
      if (previous && previous.planId !== plan.planId) lease.emit({ type: 'plan-superseded', planId: previous.planId, newPlanId: plan.planId });
    }
    lease.emit(entry);
  };

  try {
    if (signal.aborted) throwAborted();

    let messages = Array.isArray(payload.messages) ? payload.messages : [];
    if (settings.autoCompact === true && messages.at(-1)?.role === 'user') {
      const history = messages.slice(0, -1);
      const compacted = await compactAcceptedHistory(history, payload, lease, false);
      if (compacted.needed) {
        emit({ type: 'session-compacted', ...compacted });
        messages = [...compacted.messages, messages.at(-1)];
      }
    }
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const userText = lastUser?.content || '';
    const senderBinding = payload.projectBindingId
      ? worktreeIpc.resolveBinding(event, { projectBindingId: String(payload.projectBindingId) })
      : null;
    const engineeringRoot = senderBinding?.projectPath
      && canonicalDirectory(project?.path) === senderBinding.projectPath
      ? senderBinding.projectPath
      : '';
    mcpProjectBySender.set(sender.id, project ? (canonicalDirectory(project.path) || '') : '');
    // A retained MCP session is scoped to the bound project. Drop sessions
    // from older project bindings before a new run can serve roots or
    // sampling requests through them.
    await getMcpSessionManager().invalidateOtherProjects(project?.path || '', 'project-changed');
    const samplingController = createMcpSamplingController({
      settings: { ...settings, model: modelBinding.model, baseUrl: modelBinding.baseUrl },
      modelBinding,
      chatFn: boundModelChat(modelBinding, settings, { kind: 'mcp-sampling' }),
      gate,
      sessionKey: sessionId,
      signal,
      serverConfig: (name) => settings.mcpServers.find((server) => server.name === String(name || '').trim()),
      getServerSummary: (name) => {
        const server = settings.mcpServers.find((item) => item.name === String(name || '').trim());
        if (!server) return '';
        return JSON.stringify({
          name: server.name,
          transport: server.transport,
          capabilities: ['tools', 'resources', 'prompts'],
        }).slice(0, 4096);
      },
      onEvent: emit,
    });
    const taskManager = getMcpTaskManager();
    const elicitation = getMcpElicitationController();
    const taskHandler = (server, method, params, requestSignal) => taskManager.handleTaskRequest(server, method, params, requestSignal);
    const elicitationHandler = (server, params, requestSignal, releaseConnection) => {
      const cfg = settings.mcpServers.find((item) => item.name === String(server || '').trim());
      if (!cfg || cfg.elicitation?.enabled === false) {
        const error = new Error('MCP elicitation disabled');
        error.code = 'MCP_ELICITATION_DISABLED';
        throw error;
      }
      const response = elicitation.create(server, params, sender.id);
      const elicitationId = response?.elicitationId;
      const cancelOnAbort = () => {
        try { if (elicitationId) elicitation.cancel(elicitationId, sender.id); } catch { /* request may already be complete */ }
      };
      requestSignal?.addEventListener?.('abort', cancelOnAbort, { once: true });
      const taskEnabled = cfg.tasks?.enabled === true && params?.task;
      if (taskEnabled) {
        const created = taskManager.receiverResult({
          serverName: server,
          transport: cfg.transport,
          kind: 'elicitation',
          remoteTaskId: params.task.taskId,
          ttl: params.task.ttl,
          sourceSessionId: sessionId,
          sourceProjectPath: project?.path,
          status: 'input_required',
          execute: () => response,
          cancelExecution: async () => cancelOnAbort(),
          releaseConnection,
        });
        return created.task;
      }
      return response;
    };
    const samplingHandler = (server, params, requestSignal, releaseConnection) => {
      const cfg = settings.mcpServers.find((item) => item.name === String(server || '').trim());
      const taskEnabled = cfg?.tasks?.enabled === true && params?.task;
      const response = samplingController.createMessage(server, params, requestSignal, { detached: taskEnabled });
      if (taskEnabled) {
        const created = taskManager.receiverResult({
          serverName: server,
          transport: cfg.transport,
          kind: 'sampling',
          remoteTaskId: params.task.taskId,
          ttl: params.task.ttl,
          sourceSessionId: sessionId,
          sourceProjectPath: project?.path,
          execute: () => response,
          releaseConnection,
        });
        return created.task;
      }
      return response;
    };
    const runExtensions = {
      modelBinding,
      contextPolicy,
      createBoundChat: (kind, callOptions = {}) => boundModelChat(modelBinding, settings, { kind, signal: callOptions.signal || signal, onUsage: callOptions.onUsage || emit }),
      userDataPath: userDataPath(),
      worktreeManager,
      mcpOAuthManager: getMcpOAuthManager(),
      mcpSessionManager: getMcpSessionManager(),
      mcpTaskManager: taskManager,
      mcpTaskHandler: taskHandler,
      mcpElicitation: elicitationHandler,
      mcpElicitationComplete: (server, params) => {
        const id = String(params?.elicitationId || '').trim();
        if (!id) return false;
        try { return elicitation.complete(id); } catch { return false; }
      },
      mcpSampling: (server, params, _ctx, requestSignal, releaseConnection) => samplingHandler(server, params, requestSignal, releaseConnection),
      engineering: {
        indexStatus: (root) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().indexStatus(engineeringRoot)
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        indexSearch: (root, query) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().indexSearch(engineeringRoot, query)
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        verificationProfiles: (root) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().verificationProfiles(engineeringRoot)
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        verificationStart: (root, profileId, ctx) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().verificationStart(engineeringRoot, profileId, {
          ...ctx,
          ownerId: event.sender.id,
        })
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        verificationGet: (root, jobRef) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().verificationGet(engineeringRoot, jobRef)
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        verificationResult: (root, jobRef) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().verificationResult(engineeringRoot, jobRef)
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        engineeringWorkflows: (root) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().engineeringWorkflows(engineeringRoot)
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        workflowStart: (root, workflowId, ctx) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().workflowStart(engineeringRoot, workflowId, { ...ctx, ownerId: event.sender.id, agentRunId: runId })
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        workflowGetRun: (root, workflowRunRef) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().workflowGetRun(engineeringRoot, workflowRunRef)
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        workflowResultForAgent: (root, workflowRunRef) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().workflowResultForAgent(engineeringRoot, workflowRunRef)
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        workflowCancelForAgent: (root, workflowRunRef) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().workflowCancelForAgent(engineeringRoot, workflowRunRef, { agentRunId: runId })
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        remoteCiList: (root, limit) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().remoteCiListForAgent(engineeringRoot, limit) : { ok: false, code: 'REMOTE_CI_PROJECT_BINDING_INVALID' },
        remoteCiGet: (root, ref) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().remoteCiGetForAgent(engineeringRoot, ref) : { ok: false, code: 'REMOTE_CI_PROJECT_BINDING_INVALID' },
        repairList: (root, limit) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().repairListForAgent(engineeringRoot, limit)
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        repairGet: (root, repairRef) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().repairGetForAgent(engineeringRoot, repairRef)
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        repairResult: (root, repairRef) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().repairResultForAgent(engineeringRoot, repairRef)
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        repairStartForAgent: (root, payload, ctx) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().repairStartForAgent(engineeringRoot, payload, { ...ctx, ownerId: event.sender.id, agentRunId: runId })
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        repairCancelForAgent: (root, repairRef, ctx) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().repairCancelForAgent(engineeringRoot, repairRef, { ...ctx, agentRunId: runId })
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
      },
    };
    // Expand @refs only on the copy fed to the model (history keeps original).
    const modelMessages = messagesForModel(messages, contextPolicy.projectContext ? project?.path : null);

    // Host shortcuts are tools too; never substitute them for a denied role tool.
    const shortcutToolAllowed = (name) => { try { assertAssistantToolAllowed(name, modelBinding); return true; } catch { return false; } };
    const shortcutWantsSave = isStructureIntent(userText) || /保存|写入|生成\s*\.md|PROJECT_STRUCTURE/i.test(userText);
    if (project?.path && contextPolicy.toolsAllowed && shortcutToolAllowed('list_dir')
      && (!shortcutWantsSave || shortcutToolAllowed('write_file')) && (isListIntent(userText) || isStructureIntent(userText))) {
      const authorization = await gate.authorize({ tool: 'list_dir', risk: 'read', summary: '读取项目目录结构',
        path: '.', sessionKey: sessionId, signal, agentMode });
      if (!authorization.allowed) throw Object.assign(new Error(authorization.reason || '项目读取未获授权。'), { code: 'TOOL_PERMISSION_DENIED' });
      if (signal.aborted) throwAborted();
      emit({
        type: AGENT_EVENTS.TOOL_START,
        tool: 'host:listTree',
        args: { path: project.path },
      });
      let toolEndEmitted = false;
      try {
        const reply = buildTreeReply(project, userText);
        let content = reply.content;
        const applied = [];
        const fileChanges = [];
        const wantSave = isStructureIntent(userText) || /保存|写入|生成\s*\.md|PROJECT_STRUCTURE/i.test(userText);
        if (wantSave && reply.structureMarkdown) {
          assertAssistantToolAllowed('write_file', modelBinding);
          const outName = /保存为\s*([^\s]+)/i.test(userText)
            ? userText.match(/保存为\s*([^\s]+)/i)[1].replace(/[\\/]/g, '')
            : 'PROJECT_STRUCTURE.md';
          try {
            // Honor permissionMode / allow_session for host structure-save;
            // pass unified diff like agent writes so confirm-writes can show changes.
            let before = '';
            try {
              const existingFull = path.join(project.path, outName);
              if (fs.existsSync(existingFull) && fs.statSync(existingFull).isFile()) {
                before = fs.readFileSync(existingFull, 'utf8');
              }
            } catch {
              before = '';
            }
            const after = String(reply.structureMarkdown);
            const computed = computeUnifiedDiff(outName, before, after);
            const truncated = truncateDiff(computed.text);
            const diffPayload = {
              path: outName,
              text: truncated.text,
              stats: computed.stats,
              isBinary: computed.isBinary,
              truncated: truncated.truncated,
            };
            const detailForGate = computed.isBinary
              ? '(binary or non-text content)'
              : truncated.text.slice(0, 2000) || String(after).slice(0, 2000);

            const auth = await gate.authorize({
              tool: 'write_file',
              risk: 'write',
              summary: `写入 ${outName}`,
              detail: detailForGate,
              path: outName,
              sessionKey: sessionId,
              signal,
              diff: diffPayload,
              agentMode,
            });
            if (signal.aborted) throwAborted();
            if (!auth.allowed) {
              const reason = auth.reason || '用户拒绝';
              applied.push({ path: outName, ok: false, error: reason });
              content += `\n\n未写入（${reason}）：\`${outName}\``;
            } else {
              const w = writeFile(project.path, outName, reply.structureMarkdown);
              applied.push({ path: w.path, ok: true, bytes: w.bytes });
              fileChanges.push({
                path: w.path,
                op: before ? 'write' : 'create',
                stats: computed.stats,
              });
              content += `\n\n---\n📁 已写入真实文件：\`${w.path}\`（${w.bytes} bytes）`;
            }
          } catch (e) {
            if (isAbortError(e, signal)) throw e;
            applied.push({ path: outName, ok: false, error: e.message });
            content += `\n\n写入失败：${e.message}`;
          }
        }
        if (signal.aborted) throwAborted();
        emit({
          type: AGENT_EVENTS.TOOL_END,
          tool: 'host:listTree',
          ok: true,
          summary: applied.length ? `listTree + ${applied.length} write(s)` : 'listTree',
        });
        toolEndEmitted = true;
        const result = {
          content,
          applied,
          fileChanges,
          hostTool: 'listTree',
          runId,
          mode: 'host',
          agentMode,
        };
        emit({ type: AGENT_EVENTS.DONE, ...result });
        return result;
      } catch (err) {
        if (!toolEndEmitted) {
          const aborted = isAbortError(err, signal);
          emit({
            type: AGENT_EVENTS.TOOL_END,
            tool: 'host:listTree',
            ok: false,
            summary: aborted ? '已停止' : (err.message || String(err)),
          });
        }
        if (isAbortError(err, signal)) throwAborted();
        throw new Error(`本机扫盘失败: ${err.message || err}`);
      }
    }

    // Multi-turn Agent (API + project + agentEnabled)
    const useAgent = contextPolicy.toolsAllowed && shouldUseAgent({ settings, project, modelBinding });

    if (useAgent) {
      const result = await runAgentLoop({
        project,
        settings,
        modelBinding,
        chatFn: boundModelChat(modelBinding, settings, { signal, onUsage: emit }),
        messages: modelMessages,
        gate,
        onEvent: emit,
        sessionKey: sessionId,
        signal,
        agentMode,
        registry: project?.path ? undefined : createMemoryOnlyRegistry(),
        extensions: runExtensions,
      });
      const out = {
        content: result.content,
        applied: result.applied,
        fileChanges: result.fileChanges || [],
        agentLog: result.agentLog,
        turns: result.turns,
        mode: 'agent',
        agentMode,
        runId,
      };
      emit({ type: AGENT_EVENTS.DONE, ...out });
      return out;
    }

    // Fallback single-shot
    const systemParts = [modelBinding.assistant.systemPrompt || '你是一位 AI 助手。回答清楚、准确，不编造外部操作的结果。'];
    if (contextPolicy.projectContext && project) systemParts.push(buildProjectSystemPrompt(project));

    let content;
    let streamedText = false;
    if (settings.mode === 'api') {
      const sentMessages = [{ role: 'system', content: systemParts.join('\n\n') }, ...modelMessages];
      const msg = await boundModelChat(modelBinding, settings, { signal, onUsage: emit })({
        modelBinding,
        messages: sentMessages,
        signal,
        onDelta: (delta) => {
          if (!delta?.text || signal.aborted) return;
          streamedText = true;
          emit({ type: AGENT_EVENTS.TEXT_DELTA, text: String(delta.text) });
        },
      });
      content = String(msg?.content || '');
      if (!content) throw Object.assign(new Error('模型返回空内容。'), { code: 'MODEL_EMPTY_RESPONSE' });
    } else {
      content = generateLocalReply(userText, { project: contextPolicy.projectContext ? project : null });
    }

    if (signal.aborted) throwAborted();

    let applied = [];
    const fileChanges = [];
    let displayContent = content;
    // Single-shot write fences must go through the same PermissionGate
    if (project?.path && contextPolicy.toolsAllowed && modelBinding.compatibility.toolMode === 'text-compat') {
      const result = await applyWriteFencesWithGate(project.path, content, {
        modelBinding,
        gate,
        settings,
        sessionKey: sessionId,
        signal,
        onEvent: emit,
        fileChanges,
        agentMode,
      });
      applied = result.applied;
      displayContent = result.displayContent;
      if (applied.length) {
        const ok = applied.filter((a) => a.ok).length;
        const fail = applied.length - ok;
        displayContent += `\n\n---\n📁 文件变更：成功 ${ok}，失败 ${fail}`;
        for (const a of applied) {
          displayContent += a.ok
            ? `\n- ✅ ${a.path} (${a.bytes} bytes)`
            : `\n- ❌ ${a.path}: ${a.error}`;
        }
      }
    }

    if (!streamedText) emit({ type: AGENT_EVENTS.TEXT_DELTA, text: displayContent });
    const out = {
      content: displayContent,
      applied,
      fileChanges,
      mode: settings.mode,
      agentMode,
      runId,
    };
    emit({ type: AGENT_EVENTS.DONE, ...out });
    return out;
  } catch (err) {
    const projected = publicRunError(err, modelSource);
    emit({ type: isAbortError(err, signal) ? AGENT_EVENTS.ABORTED : AGENT_EVENTS.ERROR, ...projected });
    throw err;
  } finally {
    if (!task.isTerminal()) { if (signal.aborted) task.cancel(); else task.complete(); }
    // The accepting entry owns release, after this task's cleanup has settled.
  }
}

ipcMain.handle('chat:send', async (event, payload = {}) => startChatRun(event, payload));

ipcMain.handle('chat:approvePlan', async (event, payload = {}) => {
  const { sessionId, planId } = payload;
  if (worktreeMutation || foregroundModels.current) return busyRunResult();
  let claim; let userMessage; let executionStarted = false; let approvalFailure;
  const failApproval = (error, result) => {
    if (approvalFailure) return approvalFailure;
    const projected = publicRunError(error, result?.modelSource);
    const message = projected.safeMessage;
    const publicError = message + (executionStarted
      ? '\n执行已开始，可能已经产生变更；请先检查现场并生成新计划，不能直接重试旧计划。' : '');
    let isRetryable = false;
    if (claim) {
      try {
        const settled = executionStarted ? planState.fail(planId, claim.claimId, publicError)
          : planState.rollback(planId, claim.claimId, publicError);
        isRetryable = settled.status === 'proposed';
      } catch { /* expired or spent authority must never be restored */ }
      safeSend(event.sender, 'chat:event', { type: 'plan-approval-failed', ...projected, planId, sessionId,
        ...(result?.runId ? { runId: result.runId, sessionId: result.sessionId, clientRequestId: result.clientRequestId,
          modelSource: result.modelSource, task: result.task } : { clientRequestId: payload.clientRequestId }),
        reason: publicError, error: publicError, isRetryable, status: isRetryable ? 'proposed' : 'expired' });
    }
    approvalFailure = { ...result, ...projected, ok: false,
      ...(result?.modelSource ? { modelSource: result.modelSource } : {}),
      aborted: result?.aborted === true || isAbortError(error), isRetryable, error: publicError, agentMode: 'agent', userMessage };
    return approvalFailure;
  };
  try {
    claim = planState.claimApprove(planId, resolvePlanBinding(event, payload));
    userMessage = createMessageV2({ sessionId, role: 'user', content: buildApproveExecutionMessage(claim.plan), createdAt: Date.now() });
    const accepted = await startChatRun(event, { ...payload, agentMode: 'agent', sessionId,
      messages: [...(Array.isArray(payload.messages) ? payload.messages : []), userMessage],
    }, {
      userMessage,
      onExecutionStarted: () => {
        planState.markStarted(planId, claim.claimId); executionStarted = true;
        safeSend(event.sender, 'chat:event', { type: 'plan-approving', planId, sessionId, ...acceptedRunMetadata(foregroundModels.current) });
      },
      onSettled: (result, error) => {
        if (error || result?.ok === false || result?.aborted) {
          failApproval(error || Object.assign(new Error(result?.error || '计划执行未完成。'), { code: result?.code }), result);
          return;
        }
        try {
          planState.complete(planId, claim.claimId);
          safeSend(event.sender, 'chat:event', { type: AGENT_EVENTS.PLAN_APPROVED, planId, sessionId,
            ...acceptedRunMetadata(foregroundModels.current) });
        } catch (failure) { failApproval(failure, result); }
      },
    });
    if (approvalFailure) return approvalFailure;
    if (accepted?.ok === false) return failApproval(Object.assign(new Error(accepted.error || '无法接受计划执行。'), { code: accepted.code }), accepted);
    // invoke resolves after execution and cleanup; run-start alone carries acceptance.
    return { ...accepted, agentMode: 'agent', userMessage, result: accepted };
  } catch (error) { return failApproval(error); }
});

ipcMain.handle('chat:rejectPlan', async (event, payload = {}) => {
  try {
    const plan = planState.reject(payload.planId, resolvePlanBinding(event, payload));
    safeSend(event.sender, 'chat:event', { type: AGENT_EVENTS.PLAN_REJECTED, planId: plan.planId, sessionId: plan.sessionId, reason: String(payload.reason || '').slice(0, 1000) });
    return { ok: true };
  } catch (err) { const projected = publicRunError(err); return { ...projected, ok: false, error: projected.safeMessage }; }
});

ipcMain.handle('chat:getPendingPlan', async (event, payload = {}) => {
  try { return { ok: true, plan: planState.getPending(payload.sessionId, resolvePlanBinding(event, payload)) }; }
  catch (err) { const projected = publicRunError(err); return { ...projected, ok: false, error: projected.safeMessage }; }
});

ipcMain.handle('web:fetch', async (_event, payload = {}) => {
  const settings = modelSettings();
  if (settings.webEnabled !== true) {
    return { ok: false, error: '网页访问未启用' };
  }
  try {
    return await fetchUrl(String(payload.url || ''), {
      allowDomains: settings.webAllowDomains,
      denyDomains: settings.webDenyDomains,
      maxBytes: settings.webMaxBytes,
      timeoutMs: settings.webTimeoutMs,
      maxChars: settings.webMaxChars,
    });
  } catch (err) {
    return { ok: false, code: 'NETWORK', error: err?.message || String(err) };
  }
});

ipcMain.handle('usage:summary', async (_event, payload = {}) => {
  const settings = modelSettings();
  if (settings.usageEnabled === false) {
    return { ok: false, error: '用量统计未启用' };
  }
  try {
    const { records, skipped } = readRecords(usageFilePath(userDataPath()));
    const from = Number(payload.from) || 0;
    const to = Number(payload.to) || Infinity;
    const currency = String(settings.usageCurrency || '$');
    const recordsInRange = records.filter((record) => record.ts >= from && record.ts <= to);
    const filtered = recordsInRange
      .map((record) => record.cur === currency ? record : { ...record, cost: null });
    const currencies = [...new Set(recordsInRange.map((record) => record.cur).filter(Boolean))];
    const { totals, groups } = aggregate(filtered, { groupBy: payload.groupBy });
    return {
      ok: true,
      totals,
      groups,
      skipped,
      currency,
      mixedCurrencies: currencies.filter((value) => value !== currency),
    };
  } catch {
    return { ok: false, error: '读取用量记录失败' };
  }
});

ipcMain.handle('usage:clear', async () => {
  const settings = modelSettings();
  if (settings.usageEnabled === false) {
    return { ok: false, error: '用量统计未启用' };
  }
  try {
    clearRecords(usageFilePath(userDataPath()));
    return { ok: true };
  } catch {
    return { ok: false, error: '清空用量记录失败' };
  }
});
