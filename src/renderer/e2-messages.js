(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.E2Messages = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  function restore(message, schema) {
    const m = schema.projectToStorageJson(schema.normalizeMessage(message));
    for (const p of m.parts || []) if (p.type === 'plan' && ['proposed', 'executing'].includes(p.status)) { p.status = 'expired'; p.resolutionReason = '历史计划需重新生成'; }
    if (['proposed', 'executing'].includes(m.planStatus)) m.planStatus = 'expired';
    return m;
  }
  function collect(run, ev, schema, now = Date.now()) {
    const items = run.trajectory || (run.trajectory = []);
    const type = ev.type;
    const tool = ev.tool || ev.name || '';
    const id = ev.callId || ev.toolCallId || ev.id;
    let record;
    if (type === 'tool-start') items.push({ kind: 'tool', callId: id, tool, argsSummary: JSON.stringify(ev.args || {}), status: 'running', timestamp: now });
    if (type === 'tool-end') {
      record = items.find((x) => x.kind === 'tool' && x.status === 'running' && (id ? x.callId === id : x.tool === tool));
      if (!record) { record = { kind: 'tool', callId: id, tool, timestamp: now }; items.push(record); }
      Object.assign(record, { status: ev.ok === false ? 'error' : 'success', durationMs: Math.max(0, now - record.timestamp), summary: ev.summary || '', detail: { output: ev.output || ev.result || '' } });
    }
    if (type === 'approval-needed') items.push({ kind: 'approval', id: ev.approvalId, tool, description: ev.description || '', status: 'pending', decision: 'pending', timestamp: now });
    if (type === 'approval-resolved') {
      record = items.find((x) => x.kind === 'approval' && x.id === ev.approvalId);
      if (!record) { record = { kind: 'approval', id: ev.approvalId, tool, timestamp: now }; items.push(record); }
      Object.assign(record, { decision: ev.decision, status: ['approved', 'allow', 'allow_once', 'allow_session'].includes(ev.decision) ? 'approved' : 'rejected' });
    }
    if (type === 'verify-result') items.push({ kind: 'verify', runId: ev.runId, passed: Boolean(ev.passed ?? ev.ok), checks: ev.checks || (ev.command ? [ev.command] : []), failureCount: ev.failureCount || 0, summary: ev.summary || '', timestamp: now });
    if (type === 'subagent-start') items.push({ kind: 'subagent', subagentId: ev.subagentId, kindName: ev.kind || ev.kindName, goal: ev.goal || '', status: 'running', timestamp: now });
    if (type === 'subagent-end') {
      record = items.find((x) => x.kind === 'subagent' && x.subagentId === ev.subagentId && x.status === 'running');
      if (!record) { record = { kind: 'subagent', subagentId: ev.subagentId, timestamp: now }; items.push(record); }
      Object.assign(record, { status: ev.ok === false ? 'error' : 'success', durationMs: Math.max(0, now - record.timestamp) });
    }
    if (type === 'file-change') items.push({ kind: 'file_change', path: ev.path, op: ev.op, timestamp: now });
    run.trajectory = schema.projectToStorageJson({ role: 'assistant', parts: [], trajectory: items }).trajectory;
    return run.trajectory;
  }
  return { restore, collect };
});
