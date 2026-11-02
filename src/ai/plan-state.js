'use strict';
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function canonical(p) { if (!p) return ''; return fs.realpathSync.native(p); }
function bindingOf(value) {
  const b = {};
  for (const key of ['sessionId', 'projectId', 'projectBindingId', 'senderId', 'assistantId', 'assistantRevision', 'providerId', 'providerRevision', 'modelProfileId', 'modelRevision', 'bindingRevision', 'policyRevision']) b[key] = String(value[key] ?? '');
  b.projectPath = canonical(value.projectPath);
  if (!b.sessionId || !b.senderId || (b.projectPath && (!b.projectId || !b.projectBindingId))) throw failure('INVALID_BINDING', '计划缺少可信项目或发送者绑定');
  return b;
}
class PlanStateManager {
  constructor({ now = Date.now, ttlMs = 24 * 60 * 60 * 1000 } = {}) { this.plans = new Map(); this.now = now; this.ttlMs = ttlMs; }
  propose(input) {
    const binding = bindingOf(input);
    const planId = String(input.planId || randomUUID());
    if (this.plans.has(planId)) throw failure('DUPLICATE_PLAN', '计划标识已存在');
    for (const p of this.plans.values()) if (p.sessionId === binding.sessionId && p.senderId === binding.senderId && p.status === 'proposed') { p.status = 'superseded'; p.resolvedAt = this.now(); }
    const plan = { ...binding, planId, title: String(input.title || ''), markdown: String(input.markdown || ''), steps: Array.isArray(input.steps) ? input.steps.map(String) : [], status: 'proposed', createdAt: this.now(), resolvedAt: null };
    this.plans.set(planId, plan); return structuredClone(plan);
  }
  create(input) { return this.propose(input); }
  _get(id) {
    const p = this.plans.get(id);
    if (!p) throw failure('PLAN_NOT_FOUND', '计划不存在，请重新生成');
    if (p.status === 'proposed' && this.now() - p.createdAt >= this.ttlMs) { p.status = 'expired'; p.resolvedAt = this.now(); }
    return p;
  }
  _bound(id, binding) {
    const p = this._get(id); const b = bindingOf(binding);
    for (const key of Object.keys(b)) if (p[key] !== b[key]) throw failure('PLAN_BINDING_CHANGED', '项目绑定已变更，请重新生成计划');
    return p;
  }
  claimApprove(id, binding) {
    const p = this._bound(id, binding);
    if (p.status !== 'proposed') throw failure('PLAN_NOT_PROPOSED', '计划已处理或过期');
    p.status = 'executing'; p.claimId = randomUUID(); p.executionStarted = false;
    return { plan: structuredClone(p), claimId: p.claimId };
  }
  _claim(id, claimId) { const p = this._get(id); if (p.status !== 'executing' || !claimId || p.claimId !== claimId) throw failure('INVALID_CLAIM', '计划执行凭证无效'); return p; }
  markStarted(id, claimId) { const p = this._claim(id, claimId); p.executionStarted = true; return structuredClone(p); }
  rollback(id, claimId, reason = '') {
    const p = this._claim(id, claimId);
    if (p.executionStarted) throw failure('PLAN_EXECUTION_ALREADY_STARTED', '计划执行已开始，须检查现场并生成新计划');
    p.status = 'proposed'; p.resolutionReason = String(reason); delete p.claimId; return structuredClone(p);
  }
  fail(id, claimId, reason = '') { const p = this._claim(id, claimId); p.status = 'expired'; p.resolutionReason = String(reason); p.resolvedAt = this.now(); delete p.claimId; return structuredClone(p); }
  complete(id, claimId) { const p = this._claim(id, claimId); p.status = 'approved'; p.resolvedAt = this.now(); delete p.claimId; return structuredClone(p); }
  reject(id, binding) { const p = this._bound(id, binding); if (p.status !== 'proposed') throw failure('PLAN_NOT_PROPOSED', '计划已处理或过期'); p.status = 'rejected'; p.resolvedAt = this.now(); return structuredClone(p); }
  getPending(sessionId, binding) { for (const p of [...this.plans.values()].reverse()) { if (p.sessionId === sessionId && this._get(p.planId).status === 'proposed') { try { return structuredClone(this._bound(p.planId, binding)); } catch { return null; } } } return null; }
  expireBinding(binding) { for (const p of this.plans.values()) if (Object.entries(binding).every(([k,v]) => p[k] === (k === 'projectPath' ? canonical(v) : String(v))) && ['proposed','executing'].includes(p.status)) { p.status = 'expired'; p.resolvedAt = this.now(); delete p.claimId; } }
  expireSender(senderId) { this.expireBinding({ senderId }); }
}
module.exports = { PlanStateManager };
