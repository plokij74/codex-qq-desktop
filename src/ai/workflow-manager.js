'use strict';

const crypto = require('node:crypto');
const { canonicalProjectPath, projectKey } = require('./project-index');
const {
  normalizeWorkflow, publicWorkflow, workflowFingerprint, stableTopologicalSort,
  validWorkflowId, MAX_WORKFLOWS,
} = require('./workflow-config');
const {
  createWorkflowStore, MAX_PROJECT_RUNS, MAX_RUNS,
} = require('./workflow-store');
const {
  profileFingerprint, workspaceFingerprint,
} = require('./verification-manager');

const ACTIVE = new Set(['queued', 'running']);
const TERMINAL = new Set(['passed', 'failed', 'cancelled', 'timed_out', 'stale', 'interrupted', 'configuration_changed']);
const NODE_TERMINAL = new Set(['passed', 'failed', 'cancelled', 'timed_out', 'stale', 'interrupted', 'configuration_changed', 'skipped']);

function error(code, message) {
  return { ok: false, code, error: String(message || code).slice(0, 500) };
}
function clean(value, max = 500) { return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max); }
function runRef() { return `wf_run_${crypto.randomBytes(12).toString('hex')}`; }
function validWorkflowRunRef(value) { return /^wf_run_[a-f0-9]{24}$/.test(String(value || '')); }
function statusIsFailure(status) { return ['failed', 'cancelled', 'timed_out', 'stale', 'interrupted', 'configuration_changed', 'error'].includes(status); }
function cancelledNodeStatus(run) {
  if (run.cancelReason === 'timed_out') return 'timed_out';
  if (run.cancelReason === 'stale') return 'stale';
  if (run.cancelReason === 'configuration_changed') return 'configuration_changed';
  return 'cancelled';
}

function nodeSummary(node) {
  return {
    nodeId: node.nodeId,
    profileId: node.profileId,
    dependsOn: [...(node.dependsOn || [])],
    continueOnFailure: node.continueOnFailure === true,
    status: node.status,
    jobRef: node.jobRef || undefined,
    createdAt: node.createdAt,
    startedAt: node.startedAt,
    finishedAt: node.finishedAt,
    exitCode: Number.isFinite(node.exitCode) ? node.exitCode : undefined,
    diagnosticCount: Number(node.diagnosticCount) || 0,
    statusMessage: node.statusMessage ? clean(node.statusMessage, 300) : undefined,
  };
}

function publicRun(run, includeNodes = true) {
  if (!run) return null;
  return {
    workflowRunRef: run.workflowRunRef,
    workflowId: run.workflowId,
    workflowName: clean(run.workflowName, 80),
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    completedAt: run.finishedAt,
    startWorkspaceFingerprint: run.startWorkspaceFingerprint,
    endWorkspaceFingerprint: run.endWorkspaceFingerprint,
    workspaceChanged: run.workspaceChanged === true,
    nodeCount: run.nodes?.length || 0,
    passedCount: run.nodes?.filter((node) => node.status === 'passed').length || 0,
    failedCount: run.nodes?.filter((node) => statusIsFailure(node.status)).length || 0,
    ...(includeNodes ? { nodes: (run.nodes || []).map(nodeSummary) } : {}),
    statusMessage: run.statusMessage ? clean(run.statusMessage, 500) : undefined,
  };
}

class WorkflowManager {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.getProfiles = options.getProfiles || ((root) => options.profileManager?.listProfiles?.(root, { includeDisabled: true, includeCommand: true }) || []);
    this.verification = options.verificationManager;
    this.startVerification = options.startVerification || ((args) => this.verification?.start(args));
    this.getVerification = options.getVerification || ((ref, root) => this.verification?.get(ref, root));
    this.cancelVerification = options.cancelVerification || ((ref, root) => this.verification?.cancel(ref, root));
    this.fingerprint = options.workspaceFingerprint || workspaceFingerprint;
    this.store = options.store || createWorkflowStore(options);
    this.workflows = new Map();
    this.runs = new Map();
    this.activeByProject = new Map();
    this.listeners = new Set();
    this.onWorkflowEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
    this.timers = new Set();
    this.closing = false;
    this.globalActive = 0;
    for (const item of this.store.listWorkflows()) this.workflows.set(`${item.projectKey}:${item.workflowId}`, item);
    for (const item of this.store.listRuns()) {
      const run = this._hydrateRun(item);
      this.runs.set(run.workflowRunRef, run);
    }
  }

  _hydrateRun(raw) {
    return {
      ...raw,
      nodes: Array.isArray(raw.nodes) ? raw.nodes.map((node) => ({ ...node, dependsOn: Array.isArray(node.dependsOn) ? node.dependsOn : [], status: NODE_TERMINAL.has(node.status) ? node.status : 'interrupted' })) : [],
    };
  }
  onEvent(fn) { if (typeof fn === 'function') this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(run, reason = 'updated') {
    const item = { type: 'engineering:workflow:event', reason, ...publicRun(run) };
    Object.defineProperty(item, 'projectKey', { value: run.projectKey, enumerable: false });
    for (const fn of this.listeners) { try { fn(item); } catch {} }
    try { this.onWorkflowEvent?.(item); } catch {}
  }
  _key(root, id) { return `${projectKey(root)}:${id}`; }
  _profiles(root) {
    const source = this.getProfiles(root);
    if (source && typeof source.listProfiles === 'function') return source.listProfiles(root, { includeDisabled: true, includeCommand: true });
    return Array.isArray(source) ? source : [];
  }
  _profileMap(root) { return new Map(this._profiles(root).filter((profile) => profile?.id).map((profile) => [String(profile.id), profile])); }
  _workflow(root, id) { return this.workflows.get(this._key(root, id)) || null; }

  saveWorkflow(projectPath, raw) {
    const root = canonicalProjectPath(projectPath);
    if (!root) return error('WORKFLOW_PROJECT_BINDING_INVALID', '项目绑定无效');
    try {
      const requestedId = String(raw?.workflowId || raw?.id || '');
      const current = requestedId ? this._workflow(root, requestedId) : null;
      if (requestedId && !current) return error('WORKFLOW_RUN_NOT_FOUND', 'workflow 不存在');
      const now = this.now();
      const profiles = this._profileMap(root);
      const normalized = normalizeWorkflow({
        ...raw,
        workflowId: current?.workflowId || '',
        createdAt: current?.createdAt || now,
        updatedAt: now,
        revision: current ? current.revision + 1 : 1,
      }, profiles);
      const key = this._key(root, normalized.workflowId);
      const count = [...this.workflows.values()].filter((item) => item.projectKey === projectKey(root) && item.workflowId !== normalized.workflowId).length;
      if (!current && count >= MAX_WORKFLOWS) return error('WORKFLOW_LIMIT', 'workflow 数量已达上限');
      const profileFingerprints = Object.fromEntries(normalized.nodes.map((node) => [
        node.nodeId,
        profileFingerprint(profiles.get(node.profileId)),
      ]));
      const stored = { ...normalized, profileFingerprints, projectKey: projectKey(root) };
      this.workflows.set(key, stored); this.store.putWorkflow(stored);
      return { ok: true, workflow: publicWorkflow(stored) };
    } catch (cause) { return error(cause.code || 'WORKFLOW_INVALID', cause.message); }
  }

  listWorkflows(projectPath, options = {}) {
    const root = canonicalProjectPath(projectPath);
    if (!root) return error('WORKFLOW_PROJECT_BINDING_INVALID', '项目绑定无效');
    const rows = [...this.workflows.values()].filter((item) => item.projectKey === projectKey(root) && (options.includeDisabled || item.enabled !== false));
    return {
      ok: true,
      workflows: rows.sort((a, b) => a.name.localeCompare(b.name) || a.workflowId.localeCompare(b.workflowId))
        .map((workflow) => this._publicWorkflow(root, workflow)),
      persistence: this.store.persistenceStatus(),
    };
  }
  getWorkflow(projectPath, id) {
    const root = canonicalProjectPath(projectPath);
    const item = validWorkflowId(id) ? this._workflow(root, id) : null;
    return item ? { ok: true, workflow: this._publicWorkflow(root, item) } : error('WORKFLOW_RUN_NOT_FOUND', 'workflow 不存在');
  }
  deleteWorkflow(projectPath, id) {
    const root = canonicalProjectPath(projectPath); const item = validWorkflowId(id) ? this._workflow(root, id) : null;
    if (!item) return error('WORKFLOW_RUN_NOT_FOUND', 'workflow 不存在');
    if (this.activeByProject.has(projectKey(root))) return error('WORKFLOW_ALREADY_RUNNING', '项目已有运行中的 workflow');
    this.workflows.delete(this._key(root, id)); this.store.deleteWorkflow(projectKey(root), id);
    return { ok: true };
  }

  _persist(run) {
    // Only opaque workflow metadata is persisted. In particular, permission
    // context can contain API/settings data and must never enter the store.
    const safe = {
      ...run,
      projectPath: undefined,
      permission: undefined,
      abort: undefined,
      timer: undefined,
      startedByAgentRunId: undefined,
      projectKey: run.projectKey,
      nodes: run.nodes.map((node) => ({ ...node, profile: undefined })),
    };
    this.store.putRun(safe);
  }
  _publicWorkflow(root, workflow) {
    const preflight = this._startPreflight(root, workflow);
    return {
      ...publicWorkflow(workflow),
      runnable: workflow.enabled !== false && !preflight.error,
      unavailableReason: preflight.error?.code,
    };
  }
  _startPreflight(root, workflow) {
    const profiles = this._profileMap(root);
    const fingerprints = {};
    for (const node of workflow.nodes) {
      const profile = profiles.get(node.profileId);
      if (!profile) return { error: error('WORKFLOW_PROFILE_NOT_FOUND', 'workflow profile 不存在') };
      if (profile.enabled === false) return { error: error('WORKFLOW_PROFILE_DISABLED', 'workflow profile 已禁用') };
      fingerprints[node.nodeId] = profileFingerprint(profile);
      const frozen = workflow.profileFingerprints?.[node.nodeId];
      if (frozen && frozen !== fingerprints[node.nodeId]) {
        return { error: error('WORKFLOW_PROFILE_CHANGED', 'workflow profile 配置已变化') };
      }
    }
    return { fingerprints };
  }

  async run(projectPath, workflowId, options = {}) {
    if (projectPath && typeof projectPath === 'object') {
      options = projectPath;
      workflowId = options.workflowId || options.id;
      projectPath = options.projectPath;
    }
    const root = canonicalProjectPath(projectPath);
    if (!root) return error('WORKFLOW_PROJECT_BINDING_INVALID', '项目绑定无效');
    const workflow = this._workflow(root, String(workflowId || ''));
    if (!workflow) return error('WORKFLOW_RUN_NOT_FOUND', 'workflow 不存在');
    if (workflow.enabled === false) return error('WORKFLOW_INVALID', 'workflow 已禁用');
    const key = projectKey(root);
    if (this.activeByProject.has(key)) return error('WORKFLOW_ALREADY_RUNNING', '项目已有运行中的 workflow');
    if (this.globalActive >= 2) return error('WORKFLOW_ALREADY_RUNNING', '当前已有过多运行中的 workflow');
    const preflight = this._startPreflight(root, workflow);
    if (preflight.error) return preflight.error;
    let startFp = '';
    try { startFp = this.fingerprint(root); } catch { startFp = ''; }
    if (!startFp) return error('WORKFLOW_STALE', '无法建立工作区 fingerprint');
    const createdAt = new Date(this.now()).toISOString();
    const run = {
      workflowRunRef: runRef(), workflowId: workflow.workflowId, workflowName: workflow.name, workflowFingerprint: workflow.workflowFingerprint,
      projectKey: key, projectPath: root, status: 'queued', createdAt, startedAt: undefined, finishedAt: undefined,
      startWorkspaceFingerprint: startFp, endWorkspaceFingerprint: '', workspaceChanged: false,
      profileFingerprints: preflight.fingerprints, nodes: workflow.nodes.map((node) => ({ ...node, status: 'pending', createdAt })),
      failFast: workflow.failFast, maxParallel: workflow.maxParallel, timeoutMs: workflow.timeoutMs,
      permission: {
        settings: options.settings,
        permissionGate: options.permissionGate || options.gate,
        sessionKey: options.sessionKey,
        requireApproval: options.requireApproval,
        persistGrant: options.persistGrant,
        preAuthorized: options.preAuthorized,
      },
      abort: new AbortController(),
      startedByAgentRunId: clean(options.agentRunId, 100) || undefined,
    };
    this.runs.set(run.workflowRunRef, run); this.activeByProject.set(key, run.workflowRunRef); this.globalActive += 1;
    this._persist(run); this.emit(run, 'queued');
    void this._execute(run, workflow).catch(() => this._finish(run, 'failed', 'workflow 执行失败'));
    return { ok: true, workflowRunRef: run.workflowRunRef, run: publicRun(run) };
  }
  start(projectPath, workflowId, options) { return this.run(projectPath, workflowId, options); }
  startWorkflow(projectPath, workflowId, options) { return this.run(projectPath, workflowId, options); }

  async _execute(run, workflow) {
    run.status = 'running'; run.startedAt = new Date(this.now()).toISOString(); this._persist(run); this.emit(run, 'started');
    const timeout = setTimeout(() => this._requestCancel(run, 'timed_out'), workflow.timeoutMs);
    this.timers.add(timeout); run.timer = timeout;
    try {
      while (ACTIVE.has(run.status)) {
        if (run.cancelRequested) {
          for (const node of run.nodes) if (node.status === 'pending' || node.status === 'ready') node.status = run.cancelReason === 'timed_out' ? 'timed_out' : 'cancelled';
          for (const node of run.nodes.filter((item) => item.status === 'running')) await this._cancelNode(run, node);
          if (!run.nodes.some((node) => node.status === 'running')) {
            const terminalStatus = run.cancelReason === 'timed_out' ? 'timed_out'
              : run.cancelReason === 'stale' ? 'stale'
                : run.cancelReason === 'configuration_changed' ? 'configuration_changed'
                  : run.cancelReason === 'failed' ? 'failed' : 'cancelled';
            this._finish(run, terminalStatus, run.cancelReason === 'timed_out' ? 'workflow 超时' : run.cancelReason === 'failed' ? '节点失败' : run.cancelReason === 'cancelled' ? '已取消' : undefined);
            return;
          }
        } else {
          // Fingerprints are checked at node completion and before scheduling
          // the next batch. Avoid hashing the entire project every polling tick.
          if (!run.nodes.some((node) => node.status === 'running')) {
            let currentFp = ''; try { currentFp = this.fingerprint(run.projectPath); } catch {}
            if (currentFp && run.startWorkspaceFingerprint && currentFp !== run.startWorkspaceFingerprint) {
              run.workspaceChanged = true;
              for (const node of run.nodes) if (node.status === 'pending' || node.status === 'ready') node.status = 'stale';
              run.cancelRequested = true; run.cancelReason = 'stale';
            }
          }
          const currentProfiles = this._profileMap(run.projectPath);
          const currentWorkflow = this._workflow(run.projectPath, run.workflowId);
          if (!currentWorkflow || currentWorkflow.workflowFingerprint !== run.workflowFingerprint) {
            for (const node of run.nodes) if (node.status === 'pending' || node.status === 'ready') node.status = 'configuration_changed';
            run.cancelRequested = true; run.cancelReason = 'configuration_changed';
          }
          for (const node of run.nodes) {
            if (!['pending', 'ready'].includes(node.status)) continue;
            const profile = currentProfiles.get(node.profileId);
            if (!profile || profile.enabled === false || profileFingerprint(profile) !== run.profileFingerprints[node.nodeId]) {
              node.status = 'configuration_changed'; node.statusMessage = 'profile 配置已变化';
              run.cancelRequested = true; run.cancelReason = 'configuration_changed';
            }
          }
          this._markReady(run, workflow);
          const slots = Math.max(0, workflow.maxParallel - run.nodes.filter((node) => node.status === 'running').length);
          for (const node of run.nodes.filter((item) => item.status === 'ready').sort((a, b) => a.nodeId.localeCompare(b.nodeId)).slice(0, slots)) void this._executeNode(run, node, workflow);
          if (!run.nodes.some((node) => ['pending', 'ready', 'running'].includes(node.status))) {
            const final = run.workspaceChanged ? 'stale' : this._deriveFinal(run);
            this._finish(run, final); return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    } finally { clearTimeout(timeout); this.timers.delete(timeout); run.timer = undefined; }
  }

  _markReady(run, workflow) {
    const byId = new Map(run.nodes.map((node) => [node.nodeId, node]));
    for (const node of run.nodes) {
      if (node.status !== 'pending') continue;
      const deps = node.dependsOn.map((id) => byId.get(id));
      if (!deps.every(Boolean) || !deps.every((dep) => NODE_TERMINAL.has(dep.status))) continue;
      if (deps.every((dep) => dep.status === 'passed')) { node.status = 'ready'; continue; }
      const disallowed = deps.some((dep) => ['stale', 'timed_out', 'interrupted', 'configuration_changed', 'skipped'].includes(dep.status));
      if (!workflow.failFast && node.continueOnFailure && !disallowed) node.status = 'ready';
      else node.status = 'skipped';
    }
    if (workflow.failFast && run.nodes.some((node) => statusIsFailure(node.status))) {
      for (const node of run.nodes) if (node.status === 'pending' || node.status === 'ready') node.status = 'cancelled';
      run.cancelRequested = true; run.cancelReason = run.cancelReason || 'failed';
    }
  }

  async _executeNode(run, node, workflow) {
    if (node.status !== 'ready' || run.cancelRequested) return;
    const current = this._profileMap(run.projectPath).get(node.profileId);
    if (!current || current.enabled === false) { node.status = 'configuration_changed'; node.statusMessage = 'profile 已修改或禁用'; run.cancelRequested = true; run.cancelReason = 'configuration_changed'; return; }
    if (profileFingerprint(current) !== run.profileFingerprints[node.nodeId]) { node.status = 'configuration_changed'; node.statusMessage = 'profile 配置已变化'; run.cancelRequested = true; run.cancelReason = 'configuration_changed'; return; }
    node.status = 'running'; node.startedAt = new Date(this.now()).toISOString(); this._persist(run); this.emit(run, 'node-started');
    let started;
    try {
      started = await this.startVerification({
        projectPath: run.projectPath,
        profileId: node.profileId,
        settings: run.permission.settings,
        permissionGate: run.permission.permissionGate,
        sessionKey: run.permission.sessionKey,
        signal: run.abort.signal,
        requireApproval: run.permission.requireApproval,
        persistGrant: run.permission.persistGrant,
        preAuthorized: run.permission.preAuthorized,
      });
    } catch (cause) { started = error(cause.code || 'WORKFLOW_NODE_FAILED', cause.message); }
    if (node.status !== 'running' || !ACTIVE.has(run.status)) return;
    if (run.cancelRequested) {
      node.status = cancelledNodeStatus(run);
      node.statusMessage = node.status === 'cancelled' ? '已取消' : undefined;
      node.finishedAt = new Date(this.now()).toISOString();
      this._persist(run); this.emit(run, 'node-finished');
      return;
    }
    if (!started?.ok || !started.jobRef) { node.status = started?.code === 'VERIFICATION_PROFILE_CHANGED' ? 'configuration_changed' : 'failed'; node.statusMessage = started?.error || '节点启动失败'; node.finishedAt = new Date(this.now()).toISOString(); this._persist(run); this.emit(run, 'node-finished'); return; }
    node.jobRef = started.jobRef;
    let job;
    while (node.status === 'running') {
      job = this.getVerification(node.jobRef, run.projectPath);
      if (job?.ok && job.job) job = job.job;
      if (job && !['queued', 'running'].includes(job.status)) break;
      if (run.cancelRequested) await this._cancelNode(run, node);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    if (node.status !== 'running') return;
    const status = job?.status || 'failed';
    node.status = run.cancelRequested
      ? cancelledNodeStatus(run)
      : (['passed', 'failed', 'cancelled', 'timed_out', 'stale', 'interrupted'].includes(status) ? status : 'failed');
    node.exitCode = job?.exitCode; node.diagnosticCount = job?.diagnosticCount || 0; node.statusMessage = job?.statusMessage; node.finishedAt = new Date(this.now()).toISOString();
    let endFp = ''; try { endFp = this.fingerprint(run.projectPath); } catch {}
    if (endFp && run.startWorkspaceFingerprint && endFp !== run.startWorkspaceFingerprint) {
      run.workspaceChanged = true;
      if (node.status === 'passed') node.status = 'stale';
      run.cancelRequested = true; run.cancelReason = 'stale';
    }
    if (workflow.failFast && statusIsFailure(node.status)) { run.cancelRequested = true; run.cancelReason = run.cancelReason || 'failed'; }
    this._persist(run); this.emit(run, 'node-finished');
  }
  async _cancelNode(run, node) { if (node.status !== 'running' || !node.jobRef) return; try { await this.cancelVerification(node.jobRef, run.projectPath); } catch {} }
  _deriveFinal(run) {
    if (run.nodes.every((node) => node.status === 'passed')) return 'passed';
    if (run.nodes.some((node) => node.status === 'configuration_changed')) return 'configuration_changed';
    if (run.nodes.some((node) => node.status === 'stale')) return 'stale';
    if (run.nodes.some((node) => node.status === 'timed_out')) return 'timed_out';
    if (run.nodes.some((node) => node.status === 'interrupted')) return 'interrupted';
    return 'failed';
  }
  _requestCancel(run, reason = 'cancelled') {
    if (!ACTIVE.has(run.status)) return;
    run.cancelRequested = true;
    run.cancelReason = reason;
    try { run.abort?.abort(); } catch {}
    for (const node of run.nodes.filter((item) => item.status === 'running')) void this._cancelNode(run, node);
  }
  _finish(run, status, message = '') {
    if (!ACTIVE.has(run.status)) return;
    run.status = status; run.statusMessage = message || undefined; run.finishedAt = new Date(this.now()).toISOString();
    try { run.endWorkspaceFingerprint = this.fingerprint(run.projectPath); } catch { run.endWorkspaceFingerprint = run.startWorkspaceFingerprint || ''; }
    run.workspaceChanged ||= Boolean(run.startWorkspaceFingerprint && run.endWorkspaceFingerprint && run.startWorkspaceFingerprint !== run.endWorkspaceFingerprint);
    this.activeByProject.delete(run.projectKey); this.globalActive = Math.max(0, this.globalActive - 1); this._persist(run); this.emit(run, 'finished');
  }

  listRuns(projectPath, limit = 50) { const root = canonicalProjectPath(projectPath); if (!root) return error('WORKFLOW_PROJECT_BINDING_INVALID', '项目绑定无效'); return { ok: true, runs: [...this.runs.values()].filter((run) => run.projectKey === projectKey(root)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, Math.min(200, Number(limit) || 50)).map((run) => publicRun(run, false)) }; }
  list(projectPath, limit = 50) { return this.listRuns(projectPath, limit); }
  getRun(projectPath, ref) { const root = canonicalProjectPath(projectPath); const run = validWorkflowRunRef(ref) ? this.runs.get(ref) : null; return run && run.projectKey === projectKey(root) ? { ok: true, run: publicRun(run) } : error('WORKFLOW_RUN_NOT_FOUND', 'workflow run 不存在'); }
  // Main-internal D13 lookup. Keep authoritative node/profile fingerprints and
  // the frozen workspace fields available without widening the public run API.
  getRunForRepair(projectPath, ref) {
    const root = canonicalProjectPath(projectPath);
    const run = validWorkflowRunRef(ref) ? this.runs.get(ref) : null;
    return run && run.projectKey === projectKey(root) ? run : null;
  }
  get(projectPath, ref) { return this.getRun(projectPath, ref); }
  result(projectPath, ref) { return this.getRun(projectPath, ref); }
  getResult(projectPath, ref) { return this.result(projectPath, ref); }
  cancel(projectPath, ref) { const root = canonicalProjectPath(projectPath); const run = validWorkflowRunRef(ref) ? this.runs.get(ref) : null; if (!run || run.projectKey !== projectKey(root)) return error('WORKFLOW_RUN_NOT_FOUND', 'workflow run 不存在'); if (!ACTIVE.has(run.status)) return { ok: true, run: publicRun(run) }; this._requestCancel(run, 'cancelled'); return { ok: true, run: publicRun(run) }; }
  cancelWorkflow(projectPath, ref) { return this.cancel(projectPath, ref); }
  cancelForAgent(projectPath, ref, agentRunId) {
    const root = canonicalProjectPath(projectPath);
    const run = validWorkflowRunRef(ref) ? this.runs.get(ref) : null;
    const owner = clean(agentRunId, 100);
    if (!run || run.projectKey !== projectKey(root) || !owner || run.startedByAgentRunId !== owner) {
      return error('WORKFLOW_RUN_NOT_FOUND', 'workflow run 不存在');
    }
    return this.cancel(root, ref);
  }
  rerun(projectPath, ref, options = {}) { const root = canonicalProjectPath(projectPath); const old = validWorkflowRunRef(ref) ? this.runs.get(ref) : null; if (!old || old.projectKey !== projectKey(root)) return error('WORKFLOW_RUN_NOT_FOUND', 'workflow run 不存在'); return this.run(root, old.workflowId, options); }
  rerunWorkflow(projectPath, ref, options = {}) { return this.rerun(projectPath, ref, options); }

  checkGate(projectPath, input = {}) {
    const root = canonicalProjectPath(projectPath); const run = validWorkflowRunRef(input.workflowRunRef) ? this.runs.get(input.workflowRunRef) : null;
    const summary = run ? {
      workflowRunRef: run.workflowRunRef,
      completedAt: run.finishedAt,
      nodeCount: run.nodes?.length || 0,
      passedCount: run.nodes?.filter((node) => node.status === 'passed').length || 0,
    } : { workflowRunRef: String(input.workflowRunRef || ''), completedAt: undefined, nodeCount: 0, passedCount: 0 };
    if (!run) return { ok: false, reason: 'WORKFLOW_RUN_NOT_FOUND', summary };
    if (run.projectKey !== projectKey(root)) return { ok: false, reason: 'WORKFLOW_PROJECT_MISMATCH', summary };
    if (run.status !== 'passed') return { ok: false, reason: run.status === 'stale' ? 'WORKFLOW_STALE' : 'WORKFLOW_NOT_PASSED', summary };
    const current = this._workflow(root, run.workflowId);
    if (!current || workflowFingerprint(current) !== run.workflowFingerprint) return { ok: false, reason: 'WORKFLOW_CONFIG_CHANGED', summary };
    const preflight = this._startPreflight(root, current);
    if (preflight.error || Object.keys(preflight.fingerprints).some((id) => preflight.fingerprints[id] !== run.profileFingerprints?.[id])) return { ok: false, reason: 'WORKFLOW_CONFIG_CHANGED', summary };
    const expected = String(input.expectedFingerprint || '');
    let actual = ''; try { actual = this.fingerprint(root); } catch {}
    if (!expected || (run.endWorkspaceFingerprint && expected !== run.endWorkspaceFingerprint)) return { ok: false, reason: 'WORKFLOW_FINGERPRINT_MISMATCH', summary };
    if (actual && run.endWorkspaceFingerprint && actual !== run.endWorkspaceFingerprint) return { ok: false, reason: 'WORKFLOW_STALE', summary };
    if (run.workspaceChanged) return { ok: false, reason: 'WORKFLOW_STALE', summary };
    return { ok: true, summary };
  }
  checkWorkflowGate(projectPath, input = {}) { return this.checkGate(projectPath, input); }

  close() { if (this.closing) return; this.closing = true; for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); for (const run of this.runs.values()) if (ACTIVE.has(run.status)) { try { run.abort?.abort(); } catch {} run.status = 'interrupted'; run.finishedAt = new Date(this.now()).toISOString(); for (const node of run.nodes) if (['pending', 'ready', 'running'].includes(node.status)) node.status = 'interrupted'; for (const node of run.nodes.filter((item) => item.jobRef && item.status === 'interrupted')) void this.cancelVerification(node.jobRef, run.projectPath); this._persist(run); this.emit(run, 'interrupted'); } this.activeByProject.clear(); this.globalActive = 0; }
  persistenceStatus() { return this.store.persistenceStatus(); }
  restoreAtStartup() {
    let interrupted = 0;
    for (const run of this.runs.values()) {
      if (!ACTIVE.has(run.status)) continue;
      run.status = 'interrupted'; run.finishedAt = new Date(this.now()).toISOString(); run.statusMessage = '应用退出时工作流尚未结束';
      for (const node of run.nodes) if (['pending', 'ready', 'running'].includes(node.status)) node.status = 'interrupted';
      this._persist(run); interrupted += 1;
    }
    return { ok: true, interrupted, runs: this.runs.size, persistence: this.persistenceStatus() };
  }
}

function createWorkflowManager(options) { return new WorkflowManager(options); }

module.exports = {
  WorkflowManager, createWorkflowManager, validWorkflowRunRef,
  publicRun, nodeSummary, ACTIVE, TERMINAL, MAX_PROJECT_RUNS, MAX_RUNS,
};
