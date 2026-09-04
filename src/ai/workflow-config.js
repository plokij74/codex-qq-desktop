'use strict';

const crypto = require('node:crypto');

const MAX_WORKFLOWS = 50;
const MAX_NODES = 32;
const MAX_EDGES = 64;
const MAX_DEPTH = 16;
const MIN_TIMEOUT = 60 * 1000;
const MAX_TIMEOUT = 24 * 60 * 60 * 1000;

function configError(code, message) {
  const error = new Error(String(message || code).slice(0, 500));
  error.code = code;
  return error;
}

function clean(value, max = 500) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, max);
}

function validWorkflowId(value) { return /^wf_[a-f0-9]{16,64}$/.test(String(value || '')); }
function validNodeId(value) { return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(value || '')); }

function profileMap(profiles) {
  if (profiles instanceof Map) return profiles;
  const map = new Map();
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (profile?.id) map.set(String(profile.id), profile);
  }
  return map;
}

function profileFor(profiles, id) {
  if (profiles && typeof profiles.getProfile === 'function') return profiles.getProfile(id);
  return profileMap(profiles).get(String(id || '')) || null;
}

function stableTopologicalSort(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map(list.map((node) => [node.nodeId, node]));
  const indegree = new Map(list.map((node) => [node.nodeId, node.dependsOn.length]));
  const outgoing = new Map(list.map((node) => [node.nodeId, []]));
  for (const node of list) for (const dep of node.dependsOn) outgoing.get(dep).push(node.nodeId);
  const ready = [...list.filter((node) => indegree.get(node.nodeId) === 0).map((node) => node.nodeId)].sort();
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const next of outgoing.get(id).sort()) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }
  if (order.length !== list.length) throw configError('WORKFLOW_CYCLE', 'workflow 依赖存在环');
  return order;
}

function graphDepth(nodes, order) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const depth = new Map();
  for (const id of order) {
    const node = byId.get(id);
    depth.set(id, node.dependsOn.length ? Math.max(...node.dependsOn.map((dep) => depth.get(dep) || 0)) + 1 : 1);
  }
  return Math.max(0, ...depth.values());
}

function workflowFingerprint(workflow) {
  const canonical = {
    name: workflow.name,
    enabled: workflow.enabled !== false,
    failFast: workflow.failFast !== false,
    maxParallel: workflow.maxParallel,
    timeoutMs: workflow.timeoutMs,
    nodes: workflow.nodes.map((node) => ({
      nodeId: node.nodeId,
      profileId: node.profileId,
      dependsOn: [...node.dependsOn].sort(),
      continueOnFailure: node.continueOnFailure === true,
    })).sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function normalizeWorkflow(raw, profiles, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw configError('WORKFLOW_INVALID', 'workflow 无效');
  const allowed = new Set(['workflowId', 'id', 'name', 'enabled', 'failFast', 'maxParallel', 'timeoutMs', 'nodes', 'createdAt', 'updatedAt', 'revision', 'workflowFingerprint']);
  if (options.rejectUnknown !== false) {
    for (const key of Object.keys(raw)) if (!allowed.has(key)) throw configError('WORKFLOW_INVALID', `workflow 字段无效: ${key}`);
  }
  const name = clean(raw.name, 80);
  if (!name) throw configError('WORKFLOW_INVALID', 'workflow 名称不能为空');
  const workflowId = String(raw.workflowId || raw.id || '');
  if (workflowId && !validWorkflowId(workflowId)) throw configError('WORKFLOW_INVALID', 'workflow 引用无效');
  const nodesRaw = raw.nodes;
  if (!Array.isArray(nodesRaw) || nodesRaw.length === 0) throw configError('WORKFLOW_NODE_LIMIT', 'workflow 至少需要一个节点');
  if (nodesRaw.length > MAX_NODES) throw configError('WORKFLOW_NODE_LIMIT', 'workflow 节点数超限');
  const pmap = profileMap(profiles);
  const seen = new Set();
  let edges = 0;
  const nodes = nodesRaw.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw configError('WORKFLOW_INVALID', '节点无效');
    const nodeAllowed = new Set(['nodeId', 'profileId', 'dependsOn', 'continueOnFailure']);
    if (options.rejectUnknown !== false) for (const key of Object.keys(item)) if (!nodeAllowed.has(key)) throw configError('WORKFLOW_INVALID', `节点字段无效: ${key}`);
    const nodeId = String(item.nodeId || '');
    if (!validNodeId(nodeId) || seen.has(nodeId)) throw configError('WORKFLOW_INVALID', '节点 id 重复或无效');
    seen.add(nodeId);
    const profileId = String(item.profileId || '');
    if (!/^vfy_[a-f0-9]{8,64}$/.test(profileId)) throw configError('WORKFLOW_PROFILE_NOT_FOUND', '节点 profile 不存在');
    const profile = pmap.get(profileId);
    if (!profile) throw configError('WORKFLOW_PROFILE_NOT_FOUND', '节点 profile 不存在');
    if (profile.enabled === false) throw configError('WORKFLOW_PROFILE_DISABLED', '节点 profile 已禁用');
    const dependsOn = item.dependsOn == null ? [] : item.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some((dep) => typeof dep !== 'string')) throw configError('WORKFLOW_INVALID', '节点依赖无效');
    const uniqueDeps = [...new Set(dependsOn.map(String))].sort();
    if (uniqueDeps.includes(nodeId)) throw configError('WORKFLOW_INVALID', '节点不能依赖自身');
    edges += uniqueDeps.length;
    return { nodeId, profileId, dependsOn: uniqueDeps, continueOnFailure: item.continueOnFailure === true };
  });
  if (edges > MAX_EDGES) throw configError('WORKFLOW_EDGE_LIMIT', 'workflow 依赖边数超限');
  const ids = new Set(nodes.map((node) => node.nodeId));
  for (const node of nodes) for (const dep of node.dependsOn) if (!ids.has(dep)) throw configError('WORKFLOW_INVALID', '节点依赖不存在');
  const order = stableTopologicalSort(nodes);
  if (graphDepth(nodes, order) > MAX_DEPTH) throw configError('WORKFLOW_LIMIT', 'workflow 深度超限');
  const maxParallel = Number.isFinite(Number(raw.maxParallel)) ? Math.floor(Number(raw.maxParallel)) : 4;
  if (maxParallel < 1 || maxParallel > 4) throw configError('WORKFLOW_LIMIT', '并行数必须为 1-4');
  const timeoutMs = Number.isFinite(Number(raw.timeoutMs)) ? Math.floor(Number(raw.timeoutMs)) : 60 * 60 * 1000;
  if (timeoutMs < MIN_TIMEOUT || timeoutMs > MAX_TIMEOUT) throw configError('WORKFLOW_LIMIT', '超时时间超出范围');
  const now = Date.now();
  const normalized = {
    workflowId: workflowId || `wf_${crypto.randomBytes(8).toString('hex')}`,
    name,
    enabled: raw.enabled !== false,
    failFast: raw.failFast !== false,
    maxParallel,
    timeoutMs,
    nodes,
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : now,
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : now,
    revision: Number.isFinite(Number(raw.revision)) && Number(raw.revision) > 0 ? Math.floor(Number(raw.revision)) : 1,
  };
  normalized.workflowFingerprint = workflowFingerprint(normalized);
  return normalized;
}

function validateWorkflow(raw, profiles, options = {}) {
  return normalizeWorkflow(raw, profiles, options);
}

function topologicalSort(nodes) {
  return stableTopologicalSort(nodes);
}

function publicWorkflow(workflow) {
  if (!workflow) return null;
  return {
    workflowId: workflow.workflowId,
    name: workflow.name,
    enabled: workflow.enabled !== false,
    failFast: workflow.failFast !== false,
    maxParallel: workflow.maxParallel,
    timeoutMs: workflow.timeoutMs,
    nodeCount: workflow.nodes.length,
    nodes: workflow.nodes.map((node) => ({ ...node, dependsOn: [...node.dependsOn] })),
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    revision: workflow.revision,
    workflowFingerprint: workflow.workflowFingerprint,
  };
}

module.exports = {
  MAX_WORKFLOWS, MAX_NODES, MAX_EDGES, MAX_DEPTH, MIN_TIMEOUT, MAX_TIMEOUT,
  configError, validWorkflowId, validNodeId, stableTopologicalSort, graphDepth,
  topologicalSort, validateWorkflow,
  workflowFingerprint, computeWorkflowFingerprint: workflowFingerprint,
  normalizeWorkflow, publicWorkflow,
};
