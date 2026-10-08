'use strict';
const { it } = require('node:test'); const assert = require('node:assert/strict');
const { create } = require('../src/renderer/pr-audit-recheck-ui');
const { deferred } = require('./helpers/pr-review-fixture');
const REF = 'pac_' + 'a'.repeat(24); const KEY = 'b'.repeat(32); const RESULT = 'wt_d19result';
class Element {
  constructor(attrs = {}) { this.attrs = attrs; this.dataset = {}; this.isConnected = true; this.scrollTop = 0; this.children = [];
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  set innerHTML(v) { this.html = v; this.children = [...v.matchAll(/<(button|details|div|pre)\b([^>]*)>/g)].map((m) => {
    const attrs = {}; for (const a of m[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] || '';
    return new Element(attrs);
  }); }
  get innerHTML() { return this.html || ''; }
  querySelectorAll(s) { const m = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/); return this.children.filter((c) => m ? Object.hasOwn(c.attrs, m[1]) && (!m[2] || c.attrs[m[1]] === m[2]) : s.startsWith('.') && (c.attrs.class || '').split(' ').includes(s.slice(1))); }
  querySelector(s) { return this.querySelectorAll(s)[0]; }
  addEventListener() {} contains() { return false; } focus() {}
}
function setup() {
  let token = 'token'; const element = new Element(); const calls = [];
  const source = { originalHead: '1'.repeat(40), repairCommit: '2'.repeat(40), resultId: RESULT, auditRepairRef: 'par_' + 'c'.repeat(24) };
  const detail = { recheckRef: REF, projectKey: KEY, prNumber: 7, source, target: { headSha: '3'.repeat(40) }, status: 'completed', freshness: 'stale',
    report: { summary: '<script>bad()</script>', findings: [{ findingId: 'paf_' + 'd'.repeat(24), status: 'unknown', reason: '需更多依据', evidence: [] }] }, evidence: [] };
  const api = {
    listPrAuditRechecks: async () => ({ ok: true, projectKey: KEY, deliveries: [{ resultId: RESULT, prNumber: 7, repairCommit: source.repairCommit, available: true, findingCount: 1 }],
      rechecks: [{ recheckRef: REF, status: 'completed', prNumber: 7, createdAt: '2026-10-08' }] }),
    getPrAuditRecheck: async () => ({ ok: true, recheck: structuredClone(detail), originalFindings: [], sourceAvailable: true }),
    startPrAuditRecheck: async (p) => { calls.push(p); return { ok: true, recheckRef: REF }; },
  };
  const ui = create({ api, getProject: () => ({ path: 'project' }), getToken: () => token, document: {}, isVisible: () => true });
  return { ui, api, element, detail, calls, token: (v) => { token = v; } };
}
it('D19 UI renders read-only verdicts, escaped text and later-head/stale labels without starting work', async () => {
  const f = setup(); await f.ui.mount(f.element, { projectId: 'p', prNumber: 7 });
  assert.match(f.element.innerHTML, /无法判断/); assert.match(f.element.innerHTML, /包含后续改动/); assert.match(f.element.innerHTML, /结论已过期/);
  assert.match(f.element.innerHTML, /&lt;script&gt;/); assert.doesNotMatch(f.element.innerHTML, /<textarea|<input|<script>/);
  assert.equal(f.calls.length, 0);
  await f.ui.start(RESULT); assert.deepEqual(f.calls, [{ projectBindingId: 'token', resultId: RESULT }]); f.ui.close();
});
it('D19 UI discards old binding responses and cannot start from an unmounted view', async () => {
  const f = setup(); const pending = deferred(); f.api.listPrAuditRechecks = () => pending.promise;
  const mounted = f.ui.mount(f.element, { projectId: 'p', prNumber: 7 }); f.token('new');
  pending.resolve({ ok: true, projectKey: KEY, deliveries: [], rechecks: [] }); await mounted;
  assert.equal(await f.ui.start(RESULT), false); assert.equal(f.calls.length, 0); f.ui.close();
});
it('D19 UI marks cached verdicts unverified during refresh and rejects cross-PR list responses', async () => {
  const f = setup(); f.detail.freshness = 'current'; await f.ui.mount(f.element, { projectId: 'p', prNumber: 7 });
  const wait = deferred(); f.api.listPrAuditRechecks = () => wait.promise; const refresh = f.ui.refresh();
  assert.match(f.element.innerHTML, /当前状态未核实/);
  wait.resolve({ ok: true, projectKey: KEY, deliveries: [], rechecks: [{ recheckRef: REF, prNumber: 99 }] });
  assert.equal(await refresh, false); f.ui.close();
});

it('D19 UI defaults to the latest completed history, retaining older failures separately', async () => {
  const f = setup(); const list = f.api.listPrAuditRechecks;
  f.api.listPrAuditRechecks = async () => { const out = await list(); out.rechecks.unshift({ recheckRef: 'pac_' + 'e'.repeat(24), prNumber: 7, status: 'failed', createdAt: '2026-10-09' }); return out; };
  f.api.getPrAuditRecheck = async (p) => {
    assert.equal(p.recheckRef, REF);
    return { ok: true, recheck: structuredClone(f.detail), originalFindings: [], sourceAvailable: false };
  };
  await f.ui.mount(f.element, { projectId: 'p', prNumber: 7 });
  assert.match(f.element.innerHTML, /复审未完成/); assert.match(f.element.innerHTML, /历史结论仍可查看/);
  assert.ok(Object.hasOwn(f.element.querySelector('[data-recheck-action="original"]').attrs, 'disabled'));
  assert.equal(f.calls.length, 0); f.ui.close();
});
