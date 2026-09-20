'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const State = require('../src/renderer/ci-watch-state');
const { create } = require('../src/renderer/ci-watch-ui');

const KEY = 'a'.repeat(32);
const KEY2 = 'b'.repeat(32);
const HEAD = 'c'.repeat(40);
const NOW = 1_800_000_000_000;
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function watch(extra = {}) {
  return { watchRef: 'ciw_' + '1'.repeat(24), projectKey: KEY, prNumber: 7, headSha: HEAD, status: 'watching', outcome: null,
    revision: 2, counts: { total: 1, completed: 0, pending: 1, passed: 0, failed: 0, skipped: 0, attention: 0 },
    createdAt: NOW, deadlineAt: NOW + 1_800_000, lastCheckedAt: NOW, nextPollAt: NOW + 15_000, finishedAt: null,
    unread: false, waitingForAttempt: false, reasonCode: '',
    runs: [{ id: '90071992547409931', name: 'CI <script>unsafe()</script>', runAttempt: 2, status: 'in_progress', conclusion: '' }], ...extra };
}

// A small event-capable DOM harness. Assertions exercise controller actions and
// rendered controls; the separate Electron smoke also uses actual DOM nodes.
class Element {
  constructor(doc, attributes = {}) {
    this.doc = doc; this.attributes = attributes; this.dataset = {}; this.listeners = new Map(); this.children = [];
    this.isConnected = true; this.scrollTop = 0; this.value = ''; this.textContent = ''; this.writes = 0;
    const classes = new Set();
    this.classList = { toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); }, contains: (name) => classes.has(name) };
    for (const [name, value] of Object.entries(attributes)) if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_m, char) => char.toUpperCase())] = value;
  }
  set innerHTML(value) {
    this.html = value; this.writes++; this.children = [];
    for (const match of value.matchAll(/<(button|select|span)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
      const attributes = {};
      for (const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attributes[attr[1]] = attr[2] || '';
      const child = new Element(this.doc, attributes);
      child.textContent = match[3];
      child.value = match[3].match(/value="(\d+)" selected/)?.[1] || '';
      this.children.push(child);
    }
  }
  get innerHTML() { return this.html || ''; }
  querySelectorAll(selector) {
    const match = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    return match ? this.children.filter((node) => Object.hasOwn(node.attributes, match[1]) && (match[2] === undefined || node.attributes[match[1]] === match[2])) : [];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  removeEventListener(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name); }
  dispatch(name, event = {}) { return this.listeners.get(name)?.({ target: this, ...event }); }
  click() { return this.dispatch('click'); }
  focus() { this.doc.activeElement = this; }
  contains(node) { return node === this || this.children.some((c) => c === node || c.contains?.(node)); }
}
function documentStub() {
  const doc = { nodes: new Map(), listeners: new Map(), activeElement: null,
    getElementById(id) { return this.nodes.get(id); },
    querySelectorAll(selector) { return [...this.nodes.values()].flatMap((node) => node.querySelectorAll(selector)); },
    addEventListener(name, fn) { this.listeners.set(name, fn); }, removeEventListener(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name); },
    dispatch(name, event = {}) { return this.listeners.get(name)?.({ target: this, ...event }); },
  };
  for (const id of ['btn-ci-watch', 'ci-watch-inbox', 'pr', 'center', 'pr-title', 'pr-body', 'pr-comment']) doc.nodes.set(id, new Element(doc));
  return doc;
}
function fixture(t, initial = []) {
  const doc = documentStub(); const server = new Map(initial.map((item) => [item.watchRef, item]));
  const projects = new Map([['a', { id: 'a', path: '/a', name: '项目 A' }], ['b', { id: 'b', path: '/b', name: '项目 B' }]]);
  const tokens = new Map([['a', 'pb_a'], ['b', 'pb_b']]);
  const calls = []; const toasts = []; const navigations = []; const data = { view: 'prs', project: 'a', now: NOW };
  let listener; let navigationListener;
  const keyOf = (token) => token === 'pb_a' ? KEY : KEY2;
  const api = {
    listCiWatches: async ({ projectBindingId }) => { calls.push(['list', projectBindingId]); return { ok: true, projectKey: keyOf(projectBindingId), watches: [...server.values()].filter((item) => item.projectKey === keyOf(projectBindingId)).map((item) => structuredClone(item)) }; },
    startCiWatch: async (payload) => { calls.push(['start', payload]); const item = watch({ revision: 1, status: 'starting', projectKey: keyOf(payload.projectBindingId), prNumber: payload.prNumber }); server.set(item.watchRef, item); return { ok: true, watch: structuredClone(item) }; },
    getCiWatch: async ({ watchRef }) => { calls.push(['get', watchRef]); return { ok: server.has(watchRef), watch: structuredClone(server.get(watchRef)) }; },
    stopCiWatch: async ({ watchRef }) => { calls.push(['stop', watchRef]); const item = { ...server.get(watchRef), status: 'stopped', unread: false, revision: server.get(watchRef).revision + 1 }; server.set(watchRef, item); return { ok: true, watch: item }; },
    ackCiWatch: async ({ watchRef }) => { calls.push(['ack', watchRef]); const item = { ...server.get(watchRef), unread: false, revision: server.get(watchRef).revision + 1 }; server.set(watchRef, item); return { ok: true, watch: item }; },
    onCiWatchEvent: (fn) => { listener = fn; return () => { listener = null; }; },
    onCiWatchNavigate: (fn) => { navigationListener = fn; return () => { navigationListener = null; }; },
  };
  const options = { api, document: doc, getProject: (id) => projects.get(id), getToken: (id) => tokens.get(id),
    navigateToPr: async (target) => { navigations.push(target); return true; }, toast: (message) => toasts.push(message), now: () => data.now,
    isVisible: (view, projectId) => data.view === view && data.project === projectId };
  const ui = create(options);
  t.after(() => ui.close());
  const emit = (raw) => {
    const previous = server.get(raw.watchRef);
    server.set(raw.watchRef, { ...previous, ...raw, runs: raw.runs || previous?.runs || [] });
    listener?.(raw);
  };
  return { ui, api, doc, data, projects, tokens, server, calls, toasts, navigations, emit, options,
    notify: (target) => navigationListener?.(target),
    bind: (id = 'a') => ui.bindProject(projects.get(id), tokens.get(id)),
    mount: () => ui.mountPr(doc.getElementById('pr'), { projectId: 'a', prNumber: 7, state: 'OPEN' }),
  };
}

describe('D15 renderer watch state', () => {
  it('allowlists bounded public metadata and preserves literal workflow IDs', () => {
    const normalized = State.normalize(watch({ projectPath: 'secret', token: 'secret', command: 'secret', counts: { total: 900 } }));
    assert.equal(normalized.counts.total, 200);
    assert.equal(normalized.runs[0].id, '90071992547409931');
    assert.doesNotMatch(JSON.stringify(normalized), /secret|projectPath|command|token/);
    assert.equal(State.normalize(watch({ projectKey: 'forged' })), null);
    assert.equal(State.normalize(watch({ watchRef: '../forged' })), null);
  });
  it('rejects stale revisions and never treats stale run details as fresh', () => {
    const before = State.normalize(watch());
    const event = watch({ revision: 3, runs: undefined, unread: true, status: 'completed', outcome: 'failed' });
    const after = State.merge(before, event);
    assert.equal(after.detailRevision, 2);
    assert.equal(after.revision, 3);
    assert.equal(State.merge(after, watch()), after);
    assert.equal(State.merge(after, watch({ revision: 4, projectKey: KEY2 })), after);
    assert.equal(State.merge(after, { ...event, runs: [] }).detailRevision, 3);
  });
  it('labels advisory conclusions and clamps the countdown', () => {
    assert.equal(State.label(watch({ status: 'completed', outcome: 'passed' })), '已发现的 Actions 通过');
    assert.equal(State.label(watch({ waitingForAttempt: true })), '等待新的重跑 attempt');
    assert.equal(State.remaining(watch(), NOW), '剩余 30:00');
    assert.equal(State.remaining(watch(), NOW + 2_000_000), '剩余 0:00');
    assert.equal(State.remaining(watch({ status: 'expired' }), NOW), '');
    assert.equal(State.runLabel({ status: 'completed', conclusion: 'unexpected' }), '未知状态');
  });
});

describe('D15 renderer watch interactions', () => {
  it('hydrates on binding without starting or polling remote CI', async (t) => {
    const f = fixture(t, [watch()]); await f.bind(); f.mount();
    assert.equal(f.ui.snapshot().length, 1);
    assert.deepEqual(f.calls.map((call) => call[0]), ['list']);
    for (let i = 0; i < 60; i++) { f.data.now += 1000; f.ui.tick(); }
    assert.deepEqual(f.calls.map((call) => call[0]), ['list']);
    assert.match(f.doc.getElementById('pr').innerHTML, /不代表满足合并条件/);
  });
  it('starts only on a button click with the selected duration and stops locally', async (t) => {
    const f = fixture(t); await f.bind(); f.mount();
    const panel = f.doc.getElementById('pr');
    const select = panel.querySelector('[data-ci-duration]');
    assert.equal(select.value, '30'); select.value = '60'; select.dispatch('change');
    panel.querySelector('[data-ci-action="start"]').click(); await flush();
    assert.deepEqual(f.calls.find((call) => call[0] === 'start')[1], { projectBindingId: 'pb_a', prNumber: 7, durationMinutes: 60 });
    assert.match(panel.innerHTML, /停止跟踪/);
    panel.querySelector('[data-ci-action="stop"]').click(); await flush();
    assert.equal(f.ui.snapshot()[0].status, 'stopped');
    assert.equal(panel.querySelector('[data-ci-duration]').value, '60');
    assert.equal(f.calls.filter((call) => call[0] === 'stop').length, 1);
  });
  it('preserves PR edits during background events and escapes workflow names', async (t) => {
    const f = fixture(t, [watch()]); await f.bind(); f.mount();
    for (const id of ['pr-title', 'pr-body', 'pr-comment']) f.doc.getElementById(id).value = `unsaved ${id}`;
    f.doc.getElementById('pr').querySelector('[data-ci-action="details"]').click();
    assert.doesNotMatch(f.doc.getElementById('pr').innerHTML, /<script>/);
    assert.match(f.doc.getElementById('pr').innerHTML, /&lt;script&gt;/);
    f.emit(watch({ revision: 3, runs: undefined })); await flush();
    for (const id of ['pr-title', 'pr-body', 'pr-comment']) assert.equal(f.doc.getElementById(id).value, `unsaved ${id}`);
    assert.equal(f.calls.filter((call) => call[0] === 'start').length, 0);
  });
  it('replays events received before hydration and never rolls back a newer revision', async (t) => {
    const f = fixture(t); const late = deferred(); f.api.listCiWatches = () => late.promise;
    const pending = f.bind();
    f.emit(watch({ status: 'completed', revision: 4, outcome: 'failed', unread: true, notify: true, runs: undefined }));
    late.resolve({ ok: true, projectKey: KEY, watches: [watch()] }); await pending;
    assert.equal(f.ui.snapshot()[0].revision, 4);
    assert.equal(f.toasts.length, 1);
    f.emit(watch({ revision: 3, notify: true }));
    assert.equal(f.ui.snapshot()[0].revision, 4);
    assert.equal(f.toasts.length, 1);
  });
  it('bounds failed or malformed detail reads to one per revision', async (t) => {
    const f = fixture(t, [watch()]); await f.bind(); f.mount();
    let gets = 0;
    f.api.getCiWatch = async () => { gets++; return { ok: true, watch: watch({ revision: 3, runs: undefined }) }; };
    f.emit(watch({ revision: 3, runs: undefined }));
    f.doc.getElementById('pr').querySelector('[data-ci-action="details"]').click(); await flush();
    assert.equal(gets, 1);
    assert.match(f.doc.getElementById('pr').innerHTML, /摘要暂不可用/);
    f.ui.tick(); await flush(); assert.equal(gets, 1);
  });
  it('accepts a start response arriving after a newer event without showing a false error', async (t) => {
    const f = fixture(t); await f.bind(); const late = deferred(); f.api.startCiWatch = () => late.promise;
    const pending = f.ui.start('a', 7, 30);
    f.emit(watch({ revision: 3 }));
    late.resolve({ ok: true, watch: watch({ revision: 1, status: 'starting' }) });
    assert.equal(await pending, true);
    assert.equal(f.ui.snapshot()[0].revision, 3);
    assert.match(f.toasts.at(-1), /已开始跟踪/);
  });
  it('rejects stale list and action responses after a project changes directory', async (t) => {
    const f = fixture(t); const late = deferred(); f.api.listCiWatches = () => late.promise;
    const pending = f.bind(); f.projects.get('a').path = '/different'; f.tokens.set('a', 'new_token'); f.ui.forgetProject('a');
    late.resolve({ ok: true, projectKey: KEY, watches: [watch()] }); await pending;
    assert.equal(f.ui.snapshot().length, 0);
    assert.equal(f.toasts.length, 0);
  });
  it('keeps cross-project unread results accessible and acknowledges only after verified navigation', async (t) => {
    const other = watch({ watchRef: 'ciw_' + '2'.repeat(24), projectKey: KEY2, prNumber: 9 });
    const f = fixture(t, [watch(), other]); await f.bind(); await f.bind('b'); f.mount();
    f.emit({ ...other, revision: 3, status: 'completed', outcome: 'failed', unread: true, notify: true });
    assert.match(f.doc.getElementById('btn-ci-watch').textContent, /1 未读/);
    assert.match(f.toasts.at(-1), /项目 B/);
    f.doc.getElementById('btn-ci-watch').click();
    assert.match(f.doc.getElementById('ci-watch-inbox').innerHTML, /项目 B/);
    assert.equal(await f.ui.navigate(other.watchRef, true), true);
    assert.deepEqual(f.navigations, [{ projectId: 'b', prNumber: 9, headSha: HEAD, showFailures: true }]);
    assert.deepEqual(f.calls.slice(-2).map((call) => call[0]), ['get', 'ack']);
    assert.equal(f.ui.snapshot().find((item) => item.projectKey === KEY2).unread, false);
  });
  it('toggles inbox on toolbar button and closes on escape or clicking outside', async (t) => {
    const f = fixture(t, [watch()]); await f.bind(); f.mount();
    const btn = f.doc.getElementById('btn-ci-watch');
    const inbox = f.doc.getElementById('ci-watch-inbox');
    assert.equal(inbox.classList.contains('hidden'), true);
    btn.click();
    assert.equal(inbox.classList.contains('hidden'), false);
    f.doc.dispatch('keydown', { key: 'Escape' });
    assert.equal(inbox.classList.contains('hidden'), true);
    btn.click();
    assert.equal(inbox.classList.contains('hidden'), false);
    f.doc.dispatch('click', { target: f.doc.getElementById('pr') });
    assert.equal(inbox.classList.contains('hidden'), true);
  });
  it('ignores notification navigation after unbind and never trusts its PR number', async (t) => {
    const f = fixture(t, [watch({ unread: true, status: 'completed', outcome: 'passed' })]); await f.bind();
    f.notify({ projectKey: KEY, watchRef: watch().watchRef, prNumber: 999 }); await flush();
    assert.equal(f.navigations[0].prNumber, 7);
    f.ui.forgetProject('a');
    f.notify({ projectKey: KEY, watchRef: watch().watchRef }); await flush();
    assert.equal(f.navigations.length, 1);
  });
  it('does not acknowledge if the binding changes while navigation is pending', async (t) => {
    const f = fixture(t, [watch()]); await f.bind(); const late = deferred();
    f.api.getCiWatch = () => late.promise;
    const pending = f.ui.navigate(watch().watchRef);
    f.tokens.set('a', 'different');
    late.resolve({ ok: true, watch: watch() });
    assert.equal(await pending, false);
    assert.equal(f.navigations.length, 0);
    assert.equal(f.calls.some((call) => call[0] === 'ack'), false);
  });
  it('offers post-rerun tracking without starting it and clears listeners on unload', async (t) => {
    const f = fixture(t); await f.bind(); f.mount();
    f.ui.offer('a', 7, '等待新的 attempt');
    assert.match(f.doc.getElementById('pr').innerHTML, /等待新的 attempt/);
    assert.equal(f.calls.some((call) => call[0] === 'start'), false);
    f.ui.close();
    f.emit(watch({ unread: true, notify: true }));
    assert.equal(f.ui.snapshot().length, 0);
    assert.equal(f.toasts.length, 0);
    assert.equal(f.doc.getElementById('btn-ci-watch').listeners.size, 0);
  });
  it('caps memory history and keeps tracking out of saved session state', async (t) => {
    const records = Array.from({ length: 55 }, (_, n) => watch({ watchRef: `ciw_${n.toString(16).padStart(24, '0')}`, status: 'completed', outcome: 'passed', createdAt: NOW + n, finishedAt: NOW + n }));
    records.push(watch({ watchRef: 'ciw_' + 'f'.repeat(24) }));
    const f = fixture(t, records); await f.bind();
    assert.equal(f.ui.snapshot().length, 51);
    assert.equal(f.ui.snapshot().filter(State.isActive).length, 1);
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
    const save = app.slice(app.indexOf('function saveState('), app.indexOf('\nfunction ', app.indexOf('function saveState(') + 1));
    assert.doesNotMatch(save, /ciWatch|watchRef|CI 跟踪/);
  });
});
