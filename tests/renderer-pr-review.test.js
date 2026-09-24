'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/renderer/pr-review-ui');
const { deferred, flush } = require('./helpers/pr-review-fixture');
const REF = 'prt_' + 'a'.repeat(24); const REF2 = 'prt_' + 'b'.repeat(24); const REVISION = 'c'.repeat(64);
const decode = (value) => value.replace(/&(amp|lt|gt|quot|#39);/g, (_s, code) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[code]);
class Element {
  constructor(doc, attributes = {}, tag = 'div') {
    this.doc = doc; this.attributes = attributes; this.tagName = tag.toUpperCase(); this.dataset = {}; this.listeners = new Map(); this.children = [];
    this.isConnected = true; this.scrollTop = 0; this.value = ''; this.textContent = ''; this.writes = 0;
    this.disabled = Object.hasOwn(attributes, 'disabled'); this.open = Object.hasOwn(attributes, 'open');
    for (const [key, value] of Object.entries(attributes)) if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_m, char) => char.toUpperCase())] = value;
  }
  set innerHTML(value) {
    this.html = value; this.writes++; this.children = [];
    for (const match of value.matchAll(/<(button|select|textarea|details|div)\b([^>]*)>/g)) {
      const attrs = {};
      for (const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[attr[1]] = decode(attr[2] || '');
      const node = new Element(this.doc, attrs, match[1]);
      const content = value.slice(match.index + match[0].length).split(`</${match[1]}>`)[0];
      node.textContent = content;
      if (match[1] === 'textarea') node.value = decode(content);
      if (match[1] === 'select') node.value = decode(content.match(/<option value="([^"]*)" selected/)?.[1] ?? content.match(/<option value="([^"]*)"/)?.[1] ?? '');
      this.children.push(node);
    }
  }
  get innerHTML() { return this.html || ''; }
  querySelectorAll(selector) {
    const match = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    return match ? this.children.filter((node) => Object.hasOwn(node.attributes, match[1]) && (match[2] === undefined || node.attributes[match[1]] === match[2])) : [];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  dispatch(name, extra = {}) { return this.listeners.get(name)?.({ target: this, ...extra }); }
  click() { if (!this.disabled) return this.dispatch('click'); }
  focus() { this.doc.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  contains(node) { return node === this || this.children.includes(node); }
}
function detail(ref = REF, overrides = {}) {
  return { threadRef: ref, revision: REVISION, prNumber: 7, headSha: 'd'.repeat(40), path: 'src/app.js', line: 2, subjectType: 'LINE',
    isResolved: false, isOutdated: false, complete: true, canRepair: true, canReply: true, canResolve: true,
    comments: [{ author: 'reviewer', body: '<img src=x onerror="bad()">\nCheck empty input.', updatedAt: '2026-09-24' }], ...overrides };
}
function fixture(t) {
  const doc = { activeElement: null }; const panel = new Element(doc); const outer = new Element(doc); outer.value = 'unsaved PR title';
  const state = { project: { id: 'a', path: '/project' }, token: 'pb_token', visible: true, detail: detail() }; const calls = [];
  const api = {
    getPrReviewThreads: async (payload) => { calls.push(['list', payload]); return { ok: true, prNumber: payload.prNumber, total: 2, truncated: false,
      threads: [REF, REF2].map((ref) => ({ threadRef: ref, path: 'src/app.js', line: 2, commentCount: 1, isResolved: false, isOutdated: ref === REF2 })) }; },
    getPrReviewThread: async (payload) => { calls.push(['get', payload]); return { ok: true, thread: { ...state.detail, threadRef: payload.threadRef } }; },
    snapshotPrReview: async (payload) => { calls.push(['snapshot', payload]); return { ok: true, reviewRef: 'prv_' + '1'.repeat(24), persistence: { persistence: 'memory' } }; },
    startEngineeringRepair: async (payload) => { calls.push(['repair', payload]); return { ok: true, repairRef: 'rpr_' + '2'.repeat(24) }; },
    replyPrReview: async (payload) => { calls.push(['reply', payload]); return { ok: true }; },
    resolvePrReview: async (payload) => { calls.push(['resolve', payload]); return { ok: true }; },
  };
  const ui = create({ api, document: doc, getProject: () => state.project, getToken: () => state.token,
    getSessionId: () => 'session-a', isVisible: () => state.visible, openRepair: (payload) => calls.push(['progress', payload]) });
  t.after(() => ui.close());
  const data = { projectId: 'a', prNumber: 7, headSha: 'd'.repeat(40), state: 'OPEN', profiles: [{ id: 'vfy_aaaaaaaa', name: 'Tests' }] };
  const field = (name, value) => { const input = panel.querySelector(`[data-review-field="${name}"]`); input.value = value; input.dispatch(name === 'profileId' ? 'change' : 'input'); return input; };
  return { ui, api, doc, panel, outer, state, calls, data, field, mount: () => ui.mountPr(panel, data) };
}
describe('D16 review panel interactions', () => {
  it('loads only on opening/manual refresh, filters threads, and escapes remote discussion', async (t) => {
    const f = fixture(t); await f.mount(); await f.ui.select(REF);
    assert.equal(f.calls.filter(([name]) => name === 'list').length, 1);
    assert.match(f.panel.innerHTML, /&lt;img/); assert.doesNotMatch(f.panel.innerHTML, /<img/);
    await f.mount(); assert.equal(f.calls.filter(([name]) => name === 'list').length, 1);
    const filter = f.panel.querySelector('[data-review-filter]'); filter.value = 'outdated'; filter.dispatch('change');
    assert.equal(f.panel.querySelectorAll('[data-review-thread]').length, 1);
    assert.equal(f.panel.querySelector('[data-review-thread]').dataset.reviewThread, REF2);
    await f.panel.querySelector('[data-review-action="refresh"]').click();
    assert.equal(f.calls.filter(([name]) => name === 'list').length, 2);
  });
  it('preserves separate drafts per thread, focus, profile and PR edits across local and outer redraws', async (t) => {
    const f = fixture(t); await f.mount(); await f.ui.select(REF);
    const reply = f.field('reply', 'draft for first thread'); reply.focus(); reply.setSelectionRange(3, 8);
    f.field('note', 'keep the API'); f.field('profileId', 'vfy_aaaaaaaa');
    await f.mount();
    assert.equal(f.panel.querySelector('[data-review-field="reply"]').value, 'draft for first thread');
    await f.ui.select(REF2); assert.equal(f.panel.querySelector('[data-review-field="reply"]').value, '');
    f.field('reply', 'draft for second thread'); await f.ui.select(REF);
    assert.equal(f.panel.querySelector('[data-review-field="reply"]').value, 'draft for first thread');
    assert.equal(f.panel.querySelector('[data-review-field="note"]').value, 'keep the API');
    await f.ui.mountPr(f.panel, { ...f.data, profiles: [] });
    assert.equal(f.panel.querySelector('[data-review-field="profileId"]').value, 'vfy_aaaaaaaa');
    assert.equal(f.outer.value, 'unsaved PR title'); assert.equal(f.outer.writes, 0);
  });
  it('generates one repair from an opaque snapshot with the chosen note/profile/session', async (t) => {
    const f = fixture(t); await f.mount(); await f.ui.select(REF);
    f.field('note', 'Keep API'); f.field('profileId', 'vfy_aaaaaaaa'); f.field('reply', 'unsent reply');
    assert.equal(await f.ui.operate('repair'), true);
    assert.deepEqual(f.calls.find(([name]) => name === 'snapshot')[1], { projectBindingId: 'pb_token', threadRef: REF, revision: REVISION });
    assert.deepEqual(f.calls.find(([name]) => name === 'repair')[1], { projectBindingId: 'pb_token', source: { kind: 'pr_review', reviewRef: 'prv_' + '1'.repeat(24) }, note: 'Keep API', validationProfileId: 'vfy_aaaaaaaa', sessionId: 'session-a' });
    assert.match(f.panel.innerHTML, /查看修复进度|仅保留在本次运行/);
    assert.equal(f.panel.querySelector('[data-review-field="reply"]').value, 'unsent reply');
    assert.equal(f.calls.some(([name]) => name === 'reply' || name === 'resolve'), false);
  });
  it('keeps drafts on failures and performs independent replies and resolution without a repair', async (t) => {
    const f = fixture(t); await f.mount(); await f.ui.select(REF); f.field('reply', 'reply text');
    f.api.replyPrReview = async (payload) => { f.calls.push(['reply', payload]); return { ok: false, code: 'PR_REVIEW_CONFIRM_REQUIRED' }; };
    assert.equal(await f.ui.operate('reply'), false);
    assert.equal(f.panel.querySelector('[data-review-field="reply"]').value, 'reply text');
    f.api.replyPrReview = async () => ({ ok: true });
    assert.equal(await f.ui.operate('reply'), true);
    assert.equal(f.panel.querySelector('[data-review-field="reply"]').value, '');
    assert.equal(await f.ui.operate('resolve'), true);
    assert.equal(f.calls.some(([name]) => name === 'snapshot' || name === 'repair'), false);
  });
  it('requires manual refresh after uncertain writes and never retries a pending action', async (t) => {
    const f = fixture(t); await f.mount(); await f.ui.select(REF); f.field('reply', 'check once');
    const response = deferred(); let writes = 0;
    f.api.replyPrReview = async () => { writes++; return response.promise; };
    const first = f.ui.operate('reply');
    assert.equal(await f.ui.operate('reply'), false);
    response.resolve({ ok: false, code: 'PR_REVIEW_ACTION_UNCERTAIN' }); assert.equal(await first, false);
    assert.match(f.panel.innerHTML, /手动刷新核对/); assert.equal(await f.ui.operate('reply'), false);
    assert.equal(writes, 1); await f.ui.refresh();
    assert.equal(f.panel.querySelector('[data-review-field="reply"]').value, 'check once');
    assert.equal(writes, 1);
  });
  it('disables repair for unlocatable threads and all mutations for incomplete discussion', async (t) => {
    const f = fixture(t); await f.mount(); f.state.detail = detail(REF, { canRepair: false, reasonCode: 'PR_REVIEW_LOCATION_UNAVAILABLE' });
    await f.ui.select(REF); f.field('reply', 'manual reply');
    assert.equal(f.panel.querySelector('[data-review-action="repair"]').disabled, true);
    assert.equal(f.panel.querySelector('[data-review-action="reply"]').disabled, false);
    f.state.detail = detail(REF, { complete: false, canRepair: false, canReply: false, canResolve: false });
    await f.ui.select(REF);
    for (const name of ['repair', 'reply', 'resolve']) { assert.equal(f.panel.querySelector(`[data-review-action="${name}"]`).disabled, true); assert.equal(await f.ui.operate(name), false); }
    assert.equal(f.calls.some(([name]) => ['repair', 'reply', 'resolve'].includes(name)), false);
  });
  it('rejects late list/detail results after navigating away or changing the binding', async (t) => {
    const f = fixture(t); const list = deferred(); f.api.getPrReviewThreads = () => list.promise;
    const loading = f.mount(); f.ui.unmount(); f.state.visible = false;
    const writes = f.panel.writes; list.resolve({ ok: true, prNumber: 7, threads: [] }); await loading;
    assert.equal(f.panel.writes, writes);
    f.state.visible = true; await f.mount(); const read = deferred(); f.api.getPrReviewThread = () => read.promise;
    const selected = f.ui.select(REF); f.state.token = 'new_token'; f.ui.forgetProject('a');
    read.resolve({ ok: true, thread: detail() }); await selected;
    await f.ui.mountPr(f.panel, f.data);
    assert.doesNotMatch(f.panel.innerHTML, /Check empty input/);
  });
  it('never starts a repair from a late snapshot after PR navigation', async (t) => {
    const f = fixture(t); await f.mount(); await f.ui.select(REF);
    const response = deferred(); f.api.snapshotPrReview = () => response.promise;
    const repairing = f.ui.operate('repair');
    await f.ui.mountPr(f.panel, { ...f.data, prNumber: 8 });
    response.resolve({ ok: true, reviewRef: 'prv_' + '1'.repeat(24) });
    assert.equal(await repairing, false);
    assert.equal(f.calls.some(([name]) => name === 'repair'), false);
  });
  it('preserves model-error drafts and uses current thread revisions after a head change', async (t) => {
    const f = fixture(t); await f.mount(); await f.ui.select(REF); f.field('reply', 'keep me'); f.field('note', 'task note');
    f.api.startEngineeringRepair = async () => ({ ok: false, code: 'REPAIR_AGENT_UNAVAILABLE' });
    assert.equal(await f.ui.operate('repair'), false); assert.equal(f.panel.querySelector('[data-review-field="note"]').value, 'task note');
    f.state.detail = detail(REF, { revision: 'e'.repeat(64), headSha: 'f'.repeat(40) });
    await f.ui.mountPr(f.panel, { ...f.data, headSha: 'f'.repeat(40) });
    assert.equal(await f.ui.operate('reply'), true);
    assert.equal(f.calls.find(([name]) => name === 'reply')[1].revision, 'e'.repeat(64));
    await flush();
  });
});
