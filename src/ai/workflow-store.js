'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STORE_VERSION = 1;
const MAX_PROJECT_RUNS = 50;
const MAX_RUNS = 200;

class WorkflowStore {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.safeStorage = options.safeStorage;
    this.workflowPath = options.workflowPath || (options.userDataPath ? path.join(options.userDataPath, 'engineering-workflows.json') : '');
    this.runPath = options.runPath || (options.userDataPath ? path.join(options.userDataPath, 'engineering-workflow-runs.json') : '');
    this.mode = this.canEncrypt() ? 'encrypted' : 'memory';
    this.error = null;
    this.corrupt = new Set();
    this.workflows = new Map();
    this.runs = new Map();
    this.load();
  }

  canEncrypt() {
    try { return !!(this.safeStorage?.isEncryptionAvailable?.() && this.safeStorage.encryptString && this.safeStorage.decryptString); } catch { return false; }
  }

  _read(file) {
    if (!file || !this.fs.existsSync(file)) return null;
    try {
      const envelope = JSON.parse(this.fs.readFileSync(file, 'utf8'));
      if (envelope.version !== STORE_VERSION || envelope.cipher !== 'electron-safeStorage') throw new Error('invalid envelope');
      return JSON.parse(this.safeStorage.decryptString(Buffer.from(String(envelope.payload || ''), 'base64')));
    } catch {
      this.corrupt.add(file); this.error = 'WORKFLOW_STORE_CORRUPT'; return null;
    }
  }

  load() {
    if (this.mode !== 'encrypted') return;
    const workflows = this._read(this.workflowPath);
    if (Array.isArray(workflows)) for (const item of workflows) if (item?.workflowId && item?.projectKey) this.workflows.set(`${item.projectKey}:${item.workflowId}`, item);
    const runs = this._read(this.runPath);
    if (Array.isArray(runs)) for (const item of runs) if (item?.workflowRunRef && item?.projectKey) this.runs.set(item.workflowRunRef, item);
  }

  _write(file, value) {
    if (this.mode !== 'encrypted' || !file || this.corrupt.has(file)) return;
    let temp = '';
    try {
      const payload = this.safeStorage.encryptString(JSON.stringify(value));
      this.fs.mkdirSync(path.dirname(file), { recursive: true });
      temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      this.fs.writeFileSync(temp, JSON.stringify({ version: STORE_VERSION, cipher: 'electron-safeStorage', payload: Buffer.from(payload).toString('base64') }), 'utf8');
      this.fs.renameSync(temp, file);
    } catch {
      this.error = 'WORKFLOW_STORE_UNAVAILABLE';
      if (temp) { try { this.fs.unlinkSync(temp); } catch {} }
    }
  }

  _prune() {
    const byProject = new Map();
    for (const run of this.runs.values()) {
      let list = byProject.get(run.projectKey); if (!list) { list = []; byProject.set(run.projectKey, list); }
      list.push(run);
    }
    for (const list of byProject.values()) {
      if (list.length <= MAX_PROJECT_RUNS) continue;
      const removable = list.filter((run) => !['queued', 'running'].includes(run.status)).sort((a, b) => String(a.finishedAt || a.createdAt).localeCompare(String(b.finishedAt || b.createdAt)));
      for (const run of removable.slice(0, Math.max(0, list.length - MAX_PROJECT_RUNS))) this.runs.delete(run.workflowRunRef);
    }
    if (this.runs.size > MAX_RUNS) {
      const removable = [...this.runs.values()].filter((run) => !['queued', 'running'].includes(run.status)).sort((a, b) => String(a.finishedAt || a.createdAt).localeCompare(String(b.finishedAt || b.createdAt)));
      for (const run of removable.slice(0, Math.max(0, this.runs.size - MAX_RUNS))) this.runs.delete(run.workflowRunRef);
    }
  }

  saveWorkflows(items) {
    this.workflows = new Map();
    for (const item of Array.isArray(items) ? items : []) if (item?.workflowId && item?.projectKey) this.workflows.set(`${item.projectKey}:${item.workflowId}`, item);
    this._write(this.workflowPath, [...this.workflows.values()]);
  }
  saveRuns(items) {
    this.runs = new Map();
    for (const item of Array.isArray(items) ? items : []) if (item?.workflowRunRef && item?.projectKey) this.runs.set(item.workflowRunRef, item);
    this._prune(); this._write(this.runPath, [...this.runs.values()]);
  }
  putWorkflow(item) { this.workflows.set(`${item.projectKey}:${item.workflowId}`, item); this._write(this.workflowPath, [...this.workflows.values()]); }
  saveWorkflow(item) { this.putWorkflow(item); return item; }
  deleteWorkflow(projectKey, workflowId) { const removed = this.workflows.delete(`${projectKey}:${workflowId}`); if (removed) this._write(this.workflowPath, [...this.workflows.values()]); return removed; }
  listWorkflows(projectKey) { return [...this.workflows.values()].filter((item) => !projectKey || item.projectKey === projectKey); }
  getWorkflow(projectKey, workflowId) { return this.workflows.get(`${projectKey}:${workflowId}`) || null; }
  putRun(item) { this.runs.set(item.workflowRunRef, item); this._prune(); this._write(this.runPath, [...this.runs.values()]); }
  saveRun(item) { this.putRun(item); return item; }
  listRuns(projectKey) { return [...this.runs.values()].filter((item) => !projectKey || item.projectKey === projectKey).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); }
  getRun(ref, projectKey) { const item = this.runs.get(String(ref || '')); return item && (!projectKey || item.projectKey === projectKey) ? item : null; }
  list(kind, projectKey) { return kind === 'workflows' || kind === 'workflow' ? this.listWorkflows(projectKey) : this.listRuns(projectKey); }
  get(kind, ref, projectKey) { return kind === 'workflow' ? this.getWorkflow(projectKey, ref) : this.getRun(ref, projectKey); }
  persistenceStatus() { return { persistence: this.mode, error: this.error }; }
}

function createWorkflowStore(options) { return new WorkflowStore(options); }

module.exports = { WorkflowStore, createWorkflowStore, STORE_VERSION, MAX_PROJECT_RUNS, MAX_RUNS };
