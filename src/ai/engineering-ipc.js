'use strict';

const { createProjectIndex, canonicalProjectPath, projectKey } = require('./project-index');
const { createVerificationManager } = require('./verification-manager');
const { createWorkflowManager, validWorkflowRunRef } = require('./workflow-manager');
const { createRepairManager } = require('./repair-manager');
const { isRepairRef } = require('./repair-state');

function error(code, message) {
  return { ok: false, code, error: String(message || code).slice(0, 500) };
}

function ownerId(event) {
  const value = Number(event?.sender?.id);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function validBindingId(value) { return /^pb_[a-f0-9]{32}$/.test(String(value || '')); }
function validJobRef(value) { return /^vfy_job_[a-f0-9]{24}$/.test(String(value || '')); }
function validProfileId(value) { return /^vfy_[a-f0-9]{8,64}$/.test(String(value || '')); }

function profilePayload(payload = {}) {
  const profile = payload.profile && typeof payload.profile === 'object' && !Array.isArray(payload.profile)
    ? payload.profile
    : {};
  return {
    id: String(profile.id || ''),
    name: String(profile.name || ''),
    kind: String(profile.kind || ''),
    command: String(profile.command || ''),
    cwd: String(profile.cwd || '.'),
    timeoutMs: profile.timeoutMs,
    enabled: profile.enabled !== false,
  };
}

function createEngineeringIpcHandlers(options = {}) {
  const localBindings = options.bindings || new Map();
  const indexes = new Map();
  const approvalGates = new Map();
  const ownerProjects = new Map();
  const projectOwners = new Map();
  const workflowGates = new Map();
  let verification = null;
  let workflows = null;
  let repairs = null;

  const resolve = typeof options.resolveBinding === 'function'
    ? options.resolveBinding
    : (event, payload) => {
      const owner = ownerId(event);
      return owner == null ? null : localBindings.get(owner)?.get(String(payload?.projectBindingId || '')) || null;
    };

  function rememberOwner(owner, projectPath) {
    if (owner == null) return;
    const key = projectKey(projectPath);
    let projects = ownerProjects.get(owner);
    if (!projects) { projects = new Set(); ownerProjects.set(owner, projects); }
    projects.add(key);
    let owners = projectOwners.get(key);
    if (!owners) { owners = new Set(); projectOwners.set(key, owners); }
    owners.add(owner);
  }

  function forgetOwner(owner) {
    const projects = ownerProjects.get(owner);
    ownerProjects.delete(owner);
    for (const key of projects || []) {
      const owners = projectOwners.get(key);
      owners?.delete(owner);
      if (owners?.size) continue;
      projectOwners.delete(key);
      for (const [root, index] of indexes) {
        if (projectKey(root) !== key) continue;
        index.close();
        indexes.delete(root);
      }
    }
  }

  function forgetOwnerProject(owner, projectPath) {
    if (owner == null || !projectPath) return;
    const key = projectKey(projectPath);
    const projects = ownerProjects.get(owner);
    projects?.delete(key);
    if (projects?.size) {
      ownerProjects.set(owner, projects);
    } else {
      ownerProjects.delete(owner);
    }
    const owners = projectOwners.get(key);
    owners?.delete(owner);
    if (owners?.size) return;
    projectOwners.delete(key);
    for (const [root, index] of indexes) {
      if (projectKey(root) !== key) continue;
      index.close();
      indexes.delete(root);
    }
  }

  function getBinding(event, payload) {
    if (!validBindingId(payload?.projectBindingId)) return null;
    const binding = resolve(event, payload);
    if (!binding?.projectPath) return null;
    const projectPath = canonicalProjectPath(binding.projectPath);
    if (!projectPath) return null;
    rememberOwner(ownerId(event), projectPath);
    return { ...binding, projectPath };
  }

  function getIndex(binding) {
    const root = canonicalProjectPath(binding.projectPath);
    let index = indexes.get(root);
    if (!index) {
      index = createProjectIndex({
        projectPath: root,
        enabled: options.isIndexEnabled ? options.isIndexEnabled() : true,
        storePath: options.indexStorePathFor ? options.indexStorePathFor(root) : '',
        safeStorage: options.safeStorage,
      });
      indexes.set(root, index);
    }
    if (options.isIndexEnabled) index.enabled = options.isIndexEnabled() !== false;
    return index;
  }

  function refreshIndexSwitch(index) {
    if (options.isIndexEnabled) index.enabled = options.isIndexEnabled() !== false;
    return index;
  }

  function getVerification() {
    if (!verification) {
      verification = createVerificationManager({
        userDataPath: options.userDataPath,
        safeStorage: options.safeStorage,
        runTerminal: options.runTerminal,
        onJobEvent: (event) => {
          const owners = [...(projectOwners.get(event.projectKey) || [])];
          if (typeof options.onEvent === 'function') options.onEvent({ ...event }, owners);
        },
      });
    }
    return verification;
  }

  function syncProfiles(projectPath) {
    const manager = getVerification();
    const profiles = typeof options.getProfiles === 'function' ? options.getProfiles(projectPath) : [];
    manager.replaceProfiles(projectPath, Array.isArray(profiles) ? profiles : []);
    return manager;
  }

  function getWorkflows() {
    if (!workflows) {
      workflows = createWorkflowManager({
        userDataPath: options.userDataPath,
        safeStorage: options.safeStorage,
        verificationManager: getVerification(),
        getProfiles: (projectPath) => syncProfiles(projectPath).listProfiles(projectPath, { includeDisabled: true, includeCommand: true }),
        startVerification: (args) => getVerification().start(args),
        getVerification: (ref, root) => getVerification().get(ref, root),
        cancelVerification: (ref, root) => getVerification().cancel(ref, root),
        workspaceFingerprint: options.workspaceFingerprint,
        onEvent: (event) => {
          if (event?.workflowRunRef && ['finished', 'interrupted'].includes(event.reason)) {
            const held = workflowGates.get(event.workflowRunRef);
            if (held) {
              unregisterGate(held.owner, held.gate);
              workflowGates.delete(event.workflowRunRef);
            }
          }
          const owners = [...(projectOwners.get(event.projectKey) || [])];
          if (typeof options.onEvent === 'function') options.onEvent({ ...event }, owners);
        },
      });
    }
    return workflows;
  }

  function getRepairs() {
    if (!repairs) {
      repairs = createRepairManager({
        userDataPath: options.userDataPath,
        safeStorage: options.safeStorage,
        verificationManager: getVerification(),
        workflowManager: getWorkflows(),
        worktreeManager: options.worktreeManager,
        subagentRuntime: options.subagentRuntime,
        runLoop: options.runLoop,
        getProfiles: options.getProfiles,
        getSettings: options.getSettings,
        workspaceFingerprint: options.workspaceFingerprint,
        onEvent: (event) => {
          const owners = [...(projectOwners.get(event.projectKey) || [])];
          if (typeof options.onEvent === 'function') options.onEvent({ ...event }, owners);
        },
      });
    }
    return repairs;
  }

  function workflowPayload(payload = {}) {
    const raw = payload.workflow && typeof payload.workflow === 'object' && !Array.isArray(payload.workflow) ? payload.workflow : payload;
    return {
      workflowId: String(raw.workflowId || raw.id || ''),
      name: String(raw.name || ''),
      enabled: raw.enabled !== false,
      failFast: raw.failFast !== false,
      maxParallel: raw.maxParallel,
      timeoutMs: raw.timeoutMs,
      nodes: Array.isArray(raw.nodes) ? raw.nodes.map((node) => ({
        nodeId: String(node?.nodeId || ''),
        profileId: String(node?.profileId || ''),
        dependsOn: Array.isArray(node?.dependsOn) ? node.dependsOn : [],
        continueOnFailure: node?.continueOnFailure === true,
      })) : raw.nodes,
    };
  }

  function persistProfiles(projectPath, manager) {
    const profiles = manager.listProfiles(projectPath, { includeDisabled: true, includeCommand: true });
    if (typeof options.setProfiles === 'function') options.setProfiles(projectPath, profiles);
    return profiles;
  }

  function withBinding(event, payload, fn) {
    const binding = getBinding(event, payload);
    if (!binding) return Promise.resolve(error('ENGINEERING_PROJECT_BINDING_INVALID', '项目绑定已失效'));
    return Promise.resolve().then(() => fn(binding));
  }

  function registerGate(owner, gate) {
    if (owner == null || !gate) return;
    let gates = approvalGates.get(owner);
    if (!gates) { gates = new Set(); approvalGates.set(owner, gates); }
    gates.add(gate);
  }

  function unregisterGate(owner, gate) {
    const gates = approvalGates.get(owner);
    gates?.delete(gate);
    if (gates?.size === 0) approvalGates.delete(owner);
  }

  function permissionContext(event, payload, settings) {
    const gate = options.createPermissionGate ? options.createPermissionGate(event, settings) : null;
    const owner = ownerId(event);
    registerGate(owner, gate);
    return {
      gate,
      owner,
      options: {
        settings,
        permissionGate: gate,
        sessionKey: String(payload.sessionId || ''),
        requireApproval: options.requireApproval,
      },
    };
  }

  return {
    // Agent bridge. The project path has already been validated by main and
    // these methods are intentionally absent from preload.
    indexStatus: (projectPath) => {
      const index = refreshIndexSwitch(getIndex({ projectPath }));
      return index.enabled ? index.status() : error('INDEX_DISABLED', '代码索引未启用');
    },
    indexSearch: async (projectPath, payload) => {
      const index = refreshIndexSwitch(getIndex({ projectPath }));
      if (!index.enabled) return error('INDEX_DISABLED', '代码索引未启用');
      if (index.state === 'idle') await index.ensure();
      return index.search(payload);
    },
    verificationProfiles: (projectPath) => ({ ok: true, profiles: syncProfiles(projectPath).listProfiles(projectPath) }),
    verificationStart: (projectPath, profileId, context = {}) => {
      rememberOwner(Number.isInteger(context.ownerId) ? context.ownerId : null, projectPath);
      return syncProfiles(projectPath).start({
        projectPath,
        profileId,
        settings: context.settings,
        permissionGate: context.gate,
        sessionKey: context.sessionKey,
        signal: context.signal,
      });
    },
    verificationGet: (projectPath, jobRef) => syncProfiles(projectPath).get(jobRef, projectPath)
      || error('VERIFICATION_JOB_NOT_FOUND', '作业不存在'),
    verificationResult: (projectPath, jobRef) => syncProfiles(projectPath).result(jobRef, projectPath),
    engineeringWorkflows: (projectPath) => getWorkflows().listWorkflows(projectPath),
    workflowList: (projectPath) => getWorkflows().listWorkflows(projectPath),
    workflowGetDefinition: (projectPath, workflowId) => getWorkflows().getWorkflow(projectPath, workflowId),
    workflowStartAgent: async (projectPath, workflowId, context = {}) => {
      const owner = Number.isInteger(context.ownerId) ? context.ownerId : null;
      rememberOwner(owner, projectPath);
      if (context.gate) registerGate(owner, context.gate);
      const result = await getWorkflows().run(projectPath, workflowId, { ...context, permissionGate: context.permissionGate || context.gate });
      if (result?.ok && result.workflowRunRef && context.gate) workflowGates.set(result.workflowRunRef, { owner, gate: context.gate });
      else unregisterGate(owner, context.gate);
      return result;
    },
    workflowGetRun: (projectPath, workflowRunRef) => getWorkflows().getRun(projectPath, workflowRunRef),
    workflowResultForAgent: (projectPath, workflowRunRef) => getWorkflows().result(projectPath, workflowRunRef),
    workflowCancelForAgent: (projectPath, workflowRunRef, context = {}) => getWorkflows().cancelForAgent(projectPath, workflowRunRef, context.agentRunId),
    workflowStart: async (projectPath, workflowId, context = {}) => {
      const owner = Number.isInteger(context.ownerId) ? context.ownerId : null;
      rememberOwner(owner, projectPath);
      if (context.gate) registerGate(owner, context.gate);
      const result = await getWorkflows().run(projectPath, workflowId, { ...context, permissionGate: context.permissionGate || context.gate });
      if (result?.ok && result.workflowRunRef && context.gate) workflowGates.set(result.workflowRunRef, { owner, gate: context.gate });
      else unregisterGate(owner, context.gate);
      return result;
    },
    repairListForAgent: async (projectPath, limit) => {
      if (typeof options.isBusy !== 'function' || !options.isBusy()) await getRepairs().restoreAtStartup(projectPath);
      return getRepairs().list(projectPath, limit);
    },
    repairGetForAgent: (projectPath, repairRef) => getRepairs().get(projectPath, repairRef),
    repairResultForAgent: (projectPath, repairRef) => getRepairs().result(projectPath, repairRef),
    repairStartForAgent: (projectPath, payload, context = {}) => getRepairs().start(projectPath, payload, context),
    repairCancelForAgent: (projectPath, repairRef, context = {}) => getRepairs().cancel(projectPath, repairRef, context),

    // Standalone/test binding support. Production resolves the worktree-owned
    // token via resolveBinding and never calls this method from preload.
    bind: (event, payload = {}) => {
      const owner = ownerId(event);
      const token = String(payload.projectBindingId || '');
      const projectPath = canonicalProjectPath(payload.projectPath);
      if (owner == null || !validBindingId(token) || !projectPath) return error('ENGINEERING_PROJECT_BINDING_INVALID', '项目绑定参数无效');
      let own = localBindings.get(owner);
      if (!own) { own = new Map(); localBindings.set(owner, own); }
      own.set(token, { projectPath, projectId: String(payload.projectId || '') });
      return { ok: true, projectBindingId: token };
    },
    unbind: (event, payload = {}) => {
      const owner = ownerId(event);
      const own = localBindings.get(owner);
      if (!own?.delete(String(payload.projectBindingId || ''))) return error('ENGINEERING_PROJECT_BINDING_INVALID', '项目绑定已失效');
      if (own.size === 0) localBindings.delete(owner);
      forgetOwner(owner);
      return { ok: true };
    },

    ensure: (event, payload = {}) => withBinding(event, payload, async (binding) => {
      try {
        const index = getIndex(binding);
        const status = await index.ensure();
        index.startWatcher();
        return status;
      } catch (cause) { return error(cause.code || 'INDEX_BUILDING', cause.message); }
    }),
    status: (event, payload = {}) => withBinding(event, payload, (binding) => getIndex(binding).status()),
    rebuild: (event, payload = {}) => withBinding(event, payload, async (binding) => {
      try {
        const index = getIndex(binding);
        const status = await index.rebuild();
        index.startWatcher();
        return status;
      } catch (cause) { return error(cause.code || 'INDEX_BUILDING', cause.message); }
    }),
    clear: (event, payload = {}) => withBinding(event, payload, (binding) => getIndex(binding).clear()),
    search: (event, payload = {}) => withBinding(event, payload, (binding) => {
      try { return getIndex(binding).search(payload); } catch (cause) { return error(cause.code || 'INDEX_QUERY_INVALID', cause.message); }
    }),
    location: (event, payload = {}) => withBinding(event, payload, (binding) => {
      try { return getIndex(binding).location(payload); } catch (cause) { return error(cause.code || 'INDEX_LOCATION_INVALID', cause.message); }
    }),

    profiles: (event, payload = {}) => withBinding(event, payload, (binding) => {
      const manager = syncProfiles(binding.projectPath);
      return {
        ok: true,
        profiles: manager.listProfiles(binding.projectPath, { includeDisabled: true, includeCommand: true }),
        candidates: manager.detectProfiles(binding.projectPath),
      };
    }),
    saveProfile: (event, payload = {}) => withBinding(event, payload, (binding) => {
      const manager = syncProfiles(binding.projectPath);
      try {
        const profile = manager.saveProfile(binding.projectPath, profilePayload(payload));
        persistProfiles(binding.projectPath, manager);
        return { ok: true, profile };
      } catch (cause) {
        syncProfiles(binding.projectPath);
        return error(cause.code || 'VERIFICATION_PROFILE_INVALID', cause.message);
      }
    }),
    deleteProfile: (event, payload = {}) => withBinding(event, payload, (binding) => {
      if (!validProfileId(payload.profileId)) return error('VERIFICATION_PROFILE_NOT_FOUND', '验证 profile 不存在');
      const manager = syncProfiles(binding.projectPath);
      if (!manager.removeProfile(binding.projectPath, payload.profileId)) return error('VERIFICATION_PROFILE_NOT_FOUND', '验证 profile 不存在');
      persistProfiles(binding.projectPath, manager);
      return { ok: true };
    }),
    run: (event, payload = {}) => withBinding(event, payload, async (binding) => {
      const manager = syncProfiles(binding.projectPath);
      const settings = options.getSettings ? options.getSettings() : {};
      const context = permissionContext(event, payload, settings);
      try {
        return await manager.start({ ...context.options, projectPath: binding.projectPath, profileId: String(payload.profileId || '') });
      } finally { unregisterGate(context.owner, context.gate); }
    }),
    resolveApproval: (event, approvalId, decision) => {
      for (const gate of approvalGates.get(ownerId(event)) || []) {
        if (gate.resolveApproval?.(String(approvalId || ''), decision)) return true;
      }
      return false;
    },
    list: (event, payload = {}) => withBinding(event, payload, (binding) => syncProfiles(binding.projectPath).list({ projectPath: binding.projectPath, limit: payload.limit })),
    get: (event, payload = {}) => withBinding(event, payload, (binding) => {
      if (!validJobRef(payload.jobRef)) return error('VERIFICATION_JOB_NOT_FOUND', '作业引用无效');
      return syncProfiles(binding.projectPath).get(payload.jobRef, binding.projectPath) || error('VERIFICATION_JOB_NOT_FOUND', '作业不存在');
    }),
    result: (event, payload = {}) => withBinding(event, payload, (binding) => validJobRef(payload.jobRef)
      ? syncProfiles(binding.projectPath).result(payload.jobRef, binding.projectPath)
      : error('VERIFICATION_JOB_NOT_FOUND', '作业引用无效')),
    cancel: (event, payload = {}) => withBinding(event, payload, (binding) => validJobRef(payload.jobRef)
      ? syncProfiles(binding.projectPath).cancel(payload.jobRef, binding.projectPath)
      : error('VERIFICATION_JOB_NOT_FOUND', '作业引用无效')),
    rerun: (event, payload = {}) => withBinding(event, payload, async (binding) => {
      if (!validJobRef(payload.jobRef)) return error('VERIFICATION_JOB_NOT_FOUND', '作业引用无效');
      const manager = syncProfiles(binding.projectPath);
      const settings = options.getSettings ? options.getSettings() : {};
      const context = permissionContext(event, payload, settings);
      try {
        return await manager.rerun(payload.jobRef, { ...context.options, projectPath: binding.projectPath });
      } finally { unregisterGate(context.owner, context.gate); }
    }),
    // A blank or forged profileId must never be read as "revoke every grant in
    // this project": preload always sends a string, so '' would otherwise clear
    // authorizations the user never asked to drop, and still report ok.
    revokeGrant: (event, payload = {}) => withBinding(event, payload, (binding) => {
      if (!validProfileId(payload.profileId)) return error('VERIFICATION_PROFILE_NOT_FOUND', '验证档案不存在');
      return syncProfiles(binding.projectPath).revokeGrant(binding.projectPath, payload.profileId);
    }),
    workflows: (event, payload = {}) => withBinding(event, payload, (binding) => getWorkflows().listWorkflows(binding.projectPath, { includeDisabled: payload.includeDisabled === true })),
    workflowGet: (event, payload = {}) => withBinding(event, payload, (binding) => getWorkflows().getWorkflow(binding.projectPath, String(payload.workflowId || ''))),
    workflowSave: (event, payload = {}) => withBinding(event, payload, (binding) => getWorkflows().saveWorkflow(binding.projectPath, workflowPayload(payload))),
    workflowDelete: (event, payload = {}) => withBinding(event, payload, (binding) => getWorkflows().deleteWorkflow(binding.projectPath, String(payload.workflowId || ''))),
    workflowRun: (event, payload = {}) => withBinding(event, payload, async (binding) => {
      const settings = options.getSettings ? options.getSettings() : {};
      const context = permissionContext(event, payload, settings);
      try {
        const result = await getWorkflows().run(binding.projectPath, String(payload.workflowId || ''), { ...context.options, gate: context.gate, ownerId: ownerId(event) });
        if (result?.ok && result.workflowRunRef && context.gate) workflowGates.set(result.workflowRunRef, { owner: context.owner, gate: context.gate });
        else unregisterGate(context.owner, context.gate);
        return result;
      } catch (cause) { unregisterGate(context.owner, context.gate); throw cause; }
    }),
    workflowRuns: (event, payload = {}) => withBinding(event, payload, (binding) => getWorkflows().listRuns(binding.projectPath, payload.limit)),
    workflowResult: (event, payload = {}) => withBinding(event, payload, (binding) => validWorkflowRunRef(payload.workflowRunRef)
      ? getWorkflows().result(binding.projectPath, payload.workflowRunRef)
      : error('WORKFLOW_RUN_NOT_FOUND', 'workflow run 引用无效')),
    workflowCancel: (event, payload = {}) => withBinding(event, payload, (binding) => validWorkflowRunRef(payload.workflowRunRef)
      ? getWorkflows().cancel(binding.projectPath, payload.workflowRunRef)
      : error('WORKFLOW_RUN_NOT_FOUND', 'workflow run 引用无效')),
    workflowRerun: (event, payload = {}) => withBinding(event, payload, async (binding) => {
      if (!validWorkflowRunRef(payload.workflowRunRef)) return error('WORKFLOW_RUN_NOT_FOUND', 'workflow run 引用无效');
      const settings = options.getSettings ? options.getSettings() : {};
      const context = permissionContext(event, payload, settings);
      try {
        const old = getWorkflows().getRun(binding.projectPath, payload.workflowRunRef);
        if (!old?.ok) return old;
        const result = await getWorkflows().rerun(binding.projectPath, payload.workflowRunRef, { ...context.options, gate: context.gate, ownerId: ownerId(event) });
        if (result?.ok && result.workflowRunRef && context.gate) workflowGates.set(result.workflowRunRef, { owner: context.owner, gate: context.gate });
        else unregisterGate(context.owner, context.gate);
        return result;
      } catch (cause) { unregisterGate(context.owner, context.gate); throw cause; }
    }),
    workflowGateCheck: (event, payload = {}) => withBinding(event, payload, (binding) => getWorkflows().checkGate(binding.projectPath, {
      workflowRunRef: String(payload.workflowRunRef || ''),
      action: ['apply', 'create_pr', 'merge'].includes(payload.action) ? payload.action : undefined,
      expectedFingerprint: payload.expectedFingerprint ? String(payload.expectedFingerprint) : '',
    })),
    repairList: (event, payload = {}) => withBinding(event, payload, async (binding) => {
      const recovery = typeof options.isBusy === 'function' && options.isBusy()
        ? { recovery: { ok: true, deferred: true, recovered: 0, warnings: 0 } }
        : await getRepairs().restoreAtStartup(binding.projectPath);
      const listed = getRepairs().list(binding.projectPath, payload.limit);
      return recovery?.recovery && listed?.ok
        ? { ...listed, recovery: recovery.recovery }
        : listed;
    }),
    repairGet: (event, payload = {}) => withBinding(event, payload, (binding) => {
      if (!isRepairRef(payload.repairRef)) return error('REPAIR_INVALID', '修复引用无效');
      return getRepairs().get(binding.projectPath, String(payload.repairRef));
    }),
    repairResult: (event, payload = {}) => withBinding(event, payload, (binding) => {
      if (!isRepairRef(payload.repairRef)) return error('REPAIR_INVALID', '修复引用无效');
      return getRepairs().result(binding.projectPath, String(payload.repairRef));
    }),
    repairStart: (event, payload = {}) => withBinding(event, payload, async (binding) => {
      const settings = options.getSettings ? options.getSettings() : {};
      const context = permissionContext(event, payload, settings);
      try { return await getRepairs().start(binding.projectPath, { source: payload.source, note: payload.note }, { ...context.options, projectBindingId: payload.projectBindingId }); }
      finally { unregisterGate(context.owner, context.gate); }
    }),
    repairRetry: (event, payload = {}) => withBinding(event, payload, async (binding) => {
      if (!isRepairRef(payload.repairRef)) return error('REPAIR_INVALID', '修复引用无效');
      const settings = options.getSettings ? options.getSettings() : {};
      const context = permissionContext(event, payload, settings);
      try { return await getRepairs().retry(binding.projectPath, String(payload.repairRef || ''), { note: payload.note }, { ...context.options, projectBindingId: payload.projectBindingId }); }
      finally { unregisterGate(context.owner, context.gate); }
    }),
    repairCancel: (event, payload = {}) => withBinding(event, payload, (binding) => {
      if (!isRepairRef(payload.repairRef)) return error('REPAIR_INVALID', '修复引用无效');
      return getRepairs().cancel(binding.projectPath, String(payload.repairRef), { ownerId: ownerId(event) });
    }),
    repairValidate: (event, payload = {}) => withBinding(event, payload, async (binding) => {
      if (!isRepairRef(payload.repairRef)) return error('REPAIR_INVALID', '修复引用无效');
      const settings = options.getSettings ? options.getSettings() : {};
      const context = permissionContext(event, payload, settings);
      try { return await getRepairs().validate(binding.projectPath, String(payload.repairRef || ''), context.options); }
      finally { unregisterGate(context.owner, context.gate); }
    }),
    repairValidateCancel: (event, payload = {}) => withBinding(event, payload, (binding) => {
      if (!isRepairRef(payload.repairRef)) return error('REPAIR_INVALID', '修复引用无效');
      return getRepairs().validateCancel(binding.projectPath, String(payload.repairRef));
    }),

    syncOwnerBindings: (eventOrId, projectPaths = []) => {
      const owner = typeof eventOrId === 'number' ? eventOrId : ownerId(eventOrId);
      if (owner == null) return;
      forgetOwner(owner);
      for (const projectPath of projectPaths) rememberOwner(owner, projectPath);
    },
    dropSender: (eventOrId) => {
      const owner = typeof eventOrId === 'number' ? eventOrId : ownerId(eventOrId);
      if (owner == null) return;
      for (const gate of approvalGates.get(owner) || []) gate.cancelPending?.();
      approvalGates.delete(owner);
      for (const [ref, held] of workflowGates) if (held.owner === owner) workflowGates.delete(ref);
      localBindings.delete(owner);
      forgetOwner(owner);
    },
    // Called by main after worktree:unbind. It releases only the unbound
    // project, preserving other project bindings owned by the same window.
    dropBinding: (event, payload = {}) => {
      const binding = getBinding(event, payload);
      if (!binding) return false;
      forgetOwnerProject(ownerId(event), binding.projectPath);
      return true;
    },
    dropProject: (eventOrId, projectPath) => {
      const owner = typeof eventOrId === 'number' ? eventOrId : ownerId(eventOrId);
      const root = canonicalProjectPath(projectPath);
      if (owner == null || !root) return false;
      forgetOwnerProject(owner, root);
      return true;
    },
    // Constructing the manager decrypts the job/grant stores and rewrites any
    // queued/running record as interrupted. Without an explicit startup call
    // that only happens once the user opens the engineering center, leaving a
    // stale "running" job on disk in the meantime. It never starts a command.
    restoreAtStartup: () => {
      const manager = getVerification();
      const jobs = manager.list().jobs || [];
      const workflowState = getWorkflows().restoreAtStartup();
      const repairState = getRepairs().restoreAtStartup();
      return {
        ok: true,
        persistence: manager.persistenceStatus?.() ?? null,
        interrupted: jobs.filter((job) => job.status === 'interrupted').length,
        jobs: jobs.length,
        workflows: workflowState,
        repairs: repairState,
      };
    },
    close: () => {
      for (const index of indexes.values()) index.close();
      workflows?.close();
      verification?.close();
      repairs?.close();
      indexes.clear();
      approvalGates.clear();
      workflowGates.clear();
      ownerProjects.clear();
      projectOwners.clear();
    },
    indexes,
    get verification() { return verification; },
    get workflowManager() { return workflows; },
    get repairManager() { return repairs; },
  };
}

module.exports = { createEngineeringIpcHandlers, validBindingId, validJobRef, validProfileId, isRepairRef, profilePayload };
