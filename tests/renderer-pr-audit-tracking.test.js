'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/renderer/pr-audit-tracking-ui');
const { deferred } = require('./helpers/pr-review-fixture');
const REF = 'pra_' + 'a'.repeat(24); const CHECK = 'pac_' + 'b'.repeat(24); const FINDING = 'paf_' + 'c'.repeat(24); const KEY = 'd'.repeat(32);
class Element {
  constructor(attrs = {}) { this.attrs = attrs; this.dataset = {}; this.isConnected = true; this.scrollTop = 0; this.children = [];
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  set innerHTML(value) { this.html = value; this.children = [...value.matchAll(/<(button|details|div)\b([^>]*)>/g)].map((m) => {
    const attrs = {}; for (const a of m[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] || ''; return new Element(attrs);
  }); }
  get innerHTML() { return this.html || ''; }
  querySelectorAll(selector) { const key = selector.slice(1, -1); return this.children.filter((c) => Object.hasOwn(c.attrs, key)); }
  addEventListener() {} contains() { return false; } focus() {} scrollIntoView() {}
}
function setup() {
  let token = 'pb_token'; const el = new Element(); const calls = [];
  const detail = { auditRef: REF, prNumber: 7, sourceAvailable: true, checkedAt: '2026-10-12', warnings: [], orphanRecheckRefs: [],
    findings: [{ findingId: FINDING, title: '<script>alert(1)</script>', path: 'src/a.js', side: 'RIGHT', line: 2, startLine: 2, priority: 'P1',
      latest: { recheckRef: CHECK, headSha: '1'.repeat(40), status: 'resolved', freshness: 'current', reason: '<b>fixed</b>' }, roundIds: [], recheckRefs: [CHECK] }],
    rounds: [], rechecks: [{ recheckRef: CHECK, status: 'completed', freshness: 'current', findings: [] }] };
  const api = { listPrAuditTracking: async () => ({ ok: true, projectKey: KEY, reports: [{ auditRef: REF, prNumber: 7, createdAt: '2026-10-12', findingCount: 1, status: 'completed' }] }),
    getPrAuditTracking: async () => ({ ok: true, projectKey: KEY, detail: structuredClone(detail) }) };
  const ui = create({ api, document: {}, getProject: () => ({ path: '/project' }), getToken: () => token,
    openOriginal: (p) => calls.push(['original', p]), openRecheck: (p) => calls.push(['recheck', p]), navigateToPr: (p) => calls.push(['navigate', p]) });
  return { ui, api, el, detail, calls, token: (v) => { token = v; } };
}
it('D21 UI escapes text, separates freshness and only navigates on explicit clicks', async () => {
  const f = setup(); await f.ui.mount(f.el, { projectId: 'p', prNumber: 7 });
  assert.match(f.el.innerHTML, /已解决 1/); assert.match(f.el.innerHTML, /&lt;script&gt;/); assert.doesNotMatch(f.el.innerHTML, /<script>|<textarea|<input/);
  assert.equal(f.calls.length, 0);
  await f.ui.operate('original', FINDING); await f.ui.operate('recheck', CHECK); assert.deepEqual(f.calls.map((c) => c[0]), ['original', 'recheck']);
  f.detail.findings[0].latest.freshness = 'stale'; await f.ui.refresh();
  assert.match(f.el.innerHTML, /已解决 0/); assert.match(f.el.innerHTML, /AI 判断已解决 · 已过期 · 待复审/);
  assert.equal(await f.ui.operate('recheck', 'other'), false); f.ui.close();
});
it('D21 refresh invalidates current counts immediately, preserves expansion, and keeps history on failure', async () => {
  const f = setup(); await f.ui.mount(f.el, { projectId: 'p', prNumber: 7 });
  f.el.querySelectorAll('[data-tracking-open]')[0].open = true; f.el.scrollTop = 60;
  const pending = deferred(); f.api.listPrAuditTracking = () => pending.promise; const refresh = f.ui.refresh();
  assert.match(f.el.innerHTML, /已解决 0/); assert.match(f.el.innerHTML, /当前性未核实/);
  pending.resolve({ ok: false }); await refresh;
  assert.match(f.el.innerHTML, /&lt;script&gt;/); assert.equal(f.el.querySelectorAll('[data-tracking-open]')[0].open, true); assert.equal(f.el.scrollTop, 60);
  f.ui.close();
});
it('D21 rejects stale binding and cross-PR responses, unsubscribes on close', async () => {
  const f = setup(); const pending = deferred(); f.api.getPrAuditTracking = () => pending.promise;
  const mount = f.ui.mount(f.el, { projectId: 'p', prNumber: 7 }); await new Promise((r) => setImmediate(r));
  f.token('new'); pending.resolve({ ok: true, projectKey: KEY, detail: f.detail }); await mount;
  assert.doesNotMatch(f.el.innerHTML, /已解决 1/); assert.equal(await f.ui.operate('original', FINDING), false);
  f.token('pb_token'); f.api.getPrAuditTracking = async () => ({ ok: true, projectKey: KEY, detail: { ...f.detail, prNumber: 99 } });
  await f.ui.mount(f.el, { projectId: 'p', prNumber: 7 }); assert.match(f.el.innerHTML, /追踪详情暂不可用/); f.ui.close();
});
it('D21 engineering center loads only local summaries and navigates to selected report', async () => {
  const f = setup(); f.api.getPrAuditTracking = async () => { throw Error('must not read remote details in center'); };
  await f.ui.mount(f.el, { projectId: 'p' }); assert.match(f.el.innerHTML, /data-tracking-action="navigate"/);
  await f.ui.operate('navigate', REF); assert.equal(f.calls[0][0], 'navigate'); f.ui.unmount();
  assert.equal(await f.ui.operate('navigate', REF), false); f.ui.close();
});

it('D21 events fence in-flight snapshots immediately and release subscriptions on close', async () => {
  const f = setup(); let off = 0;
  const api = f.api; api.onPrAuditEvent = api.onPrAuditRecheckEvent = api.onEngineeringRepairEvent = () => () => { off++; };
  const ui = create({ api, getProject: () => ({ path: '/project' }), getToken: () => 'token', document: {} });
  await ui.mount(f.el, { projectId: 'p', prNumber: 7 });
  const pending = deferred(); api.getPrAuditTracking = () => pending.promise;
  const selection = ui.select(REF); ui.onEvent({ projectKey: KEY, prNumber: 7 });
  pending.resolve({ ok: true, projectKey: KEY, detail: f.detail });
  assert.equal(await selection, false); assert.match(f.el.innerHTML, /已解决 0/);
  ui.close(); assert.equal(off, 3); f.ui.close();
});
