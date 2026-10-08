'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/renderer/pr-audit-ui');

const AUDIT_REF = 'pra_' + 'a'.repeat(24);
const FINDING_ID = 'paf_' + 'b'.repeat(24);
const REVISION = 'c'.repeat(64);
const DRAFT_REF = 'pad_' + 'd'.repeat(24);
const AUDIT_REPAIR_REF = 'par_' + 'e'.repeat(24);
const REPAIR_REF = 'rpr_' + 'f'.repeat(24);

const decode = (value) => value.replace(/&(amp|lt|gt|quot|#39);/g, (_s, code) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[code]);

class MockElement {
  constructor(doc, attributes = {}, tag = 'div') {
    this.doc = doc;
    this.attributes = attributes;
    this.tagName = tag.toUpperCase();
    this.dataset = {};
    this.listeners = new Map();
    this.children = [];
    this.isConnected = true;
    this.scrollTop = 0;
    this.value = '';
    this.checked = Object.hasOwn(attributes, 'checked');
    this.disabled = Object.hasOwn(attributes, 'disabled');
    for (const [key, value] of Object.entries(attributes)) {
      if (key.startsWith('data-')) {
        this.dataset[key.slice(5).replace(/-([a-z])/g, (_m, char) => char.toUpperCase())] = value;
      }
    }
  }

  set innerHTML(value) {
    this.html = value;
    this.children = [];
    for (const match of value.matchAll(/<(button|input|textarea|select|option|article|section|div|pre|strong)\b([^>]*)>/g)) {
      const attrs = {};
      for (const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
        attrs[attr[1]] = decode(attr[2] || '');
      }
      const node = new MockElement(this.doc, attrs, match[1]);
      const content = value.slice(match.index + match[0].length).split(`</${match[1]}>`)[0];
      node.textContent = content;
      if (match[1] === 'textarea' || match[1] === 'input') {
        node.value = decode(attrs.value ?? (match[1] === 'textarea' ? content : ''));
      }
      if (match[1] === 'select') node.value = decode(content.match(/<option value="([^"]*)" selected/)?.[1] || '');
      this.children.push(node);
    }
  }

  get innerHTML() { return this.html || ''; }

  querySelectorAll(selector) {
    const match = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (!match) return this.children.filter((c) => c.tagName.toLowerCase() === selector.toLowerCase());
    return this.children.filter((node) => Object.hasOwn(node.attributes, match[1]) && (match[2] === undefined || node.attributes[match[1]] === match[2]));
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  dispatch(name, extra = {}) { return this.listeners.get(name)?.({ target: this, ...extra }); }
  click() { if (!this.disabled) return this.dispatch('click'); }
  focus() { this.doc.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  scrollIntoView() { this.scrolled = true; }
  contains(node) { return node === this || this.children.includes(node); }
}

function sampleAuditDetail() {
  return {
    auditRef: AUDIT_REF,
    prNumber: 7,
    revision: REVISION,
    repairRevision: '9'.repeat(64),
    status: 'completed',
    createdAt: '2026-09-29T10:00:00.000Z',
    source: {
      headSha: '1111222233334444555566667777888899990000',
      baseSha: '0000999988887777666655554444333322221111',
      mergeBaseSha: '0000999988887777666655554444333322221111',
      headRefName: 'feature',
      baseRefName: 'main',
    },
    coverage: {
      total: 1,
      scoped: 1,
      outside: 0,
      reviewed: 1,
      skipped: [],
    },
    report: {
      summary: '代码审查完成',
      findings: [{
        findingId: FINDING_ID,
        priority: 'P1',
        title: '缺少边界检查',
        body: '<img src=x onerror="bad()">输入为空时可能崩溃。',
        path: 'src/app.js',
        side: 'RIGHT',
        line: 10,
        startLine: 10,
      }],
    },
    publication: null,
  };
}

function fixture(t, { findingCount = 1 } = {}) {
  const doc = { activeElement: null };
  const panel = new MockElement(doc);
  const center = new MockElement(doc);
  const calls = [];
  let publishedPr = null;
  let navTarget = null;
  let repairTarget = null;
  let token = 'token-1';
  let visible = true;

  const detail = sampleAuditDetail();
  for (let i = 1; i < findingCount; i++) detail.report.findings.push({ ...detail.report.findings[0], findingId: 'paf_' + String(i).padStart(24, '0'), title: `发现 ${i + 1}` });

  const api = {
    listPrAudits: async (payload) => {
      calls.push(['list', payload]);
      return {
        ok: true,
        projectKey: 'a'.repeat(32),
        audits: [{
          auditRef: AUDIT_REF,
          prNumber: payload.prNumber || 7,
          status: 'completed',
          createdAt: detail.createdAt,
          findingCount: 1,
          headSha: detail.source.headSha,
        }],
      };
    },
    getPrAudit: async (payload) => {
      calls.push(['get', payload]);
      return { ok: true, audit: structuredClone(detail) };
    },
    startPrAudit: async (payload) => {
      calls.push(['start', payload]);
      return { ok: true, auditRef: AUDIT_REF };
    },
    getPrAuditContext: async (payload) => {
      calls.push(['context', payload]);
      return { ok: true, snippet: { path: 'src/app.js', content: '10: const x = foo();', sha: detail.source.headSha } };
    },
    preparePrAudit: async (payload) => {
      calls.push(['prepare', payload]);
      return { ok: true, draftRef: DRAFT_REF, commentCount: 1, preview: 'AI Review Preview' };
    },
    publishPrAudit: async (payload) => {
      calls.push(['publish', payload]);
      return { ok: true, published: true };
    },
    reconcilePrAudit: async (payload) => {
      calls.push(['reconcile', payload]);
      return { ok: true, published: true };
    },
    cancelPrAudit: async (payload) => {
      calls.push(['cancel', payload]);
      return { ok: true };
    },
    snapshotPrAuditRepair: async (payload) => { calls.push(['snapshotRepair', payload]); return { ok: true, auditRepairRef: AUDIT_REPAIR_REF }; },
    startEngineeringRepair: async (payload) => { calls.push(['repair', payload]); return { ok: true, repair: { repairRef: REPAIR_REF } }; },
  };

  const project = { id: 'proj-1', path: '/repo' };
  const ui = create({
    api,
    document: doc,
    getProject: () => project,
    getToken: () => token,
    getSessionId: () => 'session-1',
    isVisible: () => visible,
    onPublished: (p) => { publishedPr = p; },
    navigateToPr: (p) => { navTarget = p; },
    openRepair: (p) => { repairTarget = p; },
  });

  t.after(() => ui.close());

  const data = {
    projectId: 'proj-1',
    prNumber: 7,
    state: 'OPEN',
    headSha: detail.source.headSha,
    profiles: [{ id: 'local-test', name: '本地测试' }],
  };

  return { ui, api, doc, panel, center, calls, detail, data, getPublished: () => publishedPr, getNav: () => navTarget,
    getRepair: () => repairTarget, setToken: (value) => { token = value; }, setVisible: (value) => { visible = value; } };
}

describe('D17 renderer PR audit UI', () => {
  it('mounts panel, loads audit history, and escapes HTML', async (t) => {
    const f = fixture(t);
    await f.ui.mountPr(f.panel, f.data);

    assert.equal(f.calls.some(([name]) => name === 'list'), true);
    assert.equal(f.calls.some(([name]) => name === 'get'), true);

    // Verifies HTML escaping
    assert.match(f.panel.innerHTML, /&lt;img/);
    assert.doesNotMatch(f.panel.innerHTML, /<img/);
    assert.match(f.panel.innerHTML, /缺少边界检查/);
    assert.match(f.panel.innerHTML, /代码审查完成/);
  });

  it('preserves finding edits across redraws', async (t) => {
    const f = fixture(t);
    await f.ui.mountPr(f.panel, f.data);

    const titleInput = f.panel.querySelector(`[data-audit-title="${FINDING_ID}"]`);
    assert.ok(titleInput);
    titleInput.value = '自定义修改标题';
    titleInput.dispatch('input');

    // Re-render
    await f.ui.mountPr(f.panel, f.data);
    const recheckedInput = f.panel.querySelector(`[data-audit-title="${FINDING_ID}"]`);
    assert.equal(recheckedInput.value, '自定义修改标题');
  });

  it('keeps the current report and draft visible while refreshing the same report', async (t) => {
    const f = fixture(t);
    await f.ui.mountPr(f.panel, f.data);
    const title = f.panel.querySelector(`[data-audit-title="${FINDING_ID}"]`);
    title.value = '保留正在编辑的草稿'; title.dispatch('input');
    let finish;
    f.api.getPrAudit = () => new Promise((resolve) => { finish = resolve; });
    const pending = f.ui.select(AUDIT_REF);
    assert.match(f.panel.innerHTML, /正在读取报告/);
    assert.equal(f.panel.querySelector(`[data-audit-title="${FINDING_ID}"]`).value, '保留正在编辑的草稿');
    assert.equal(f.panel.querySelector('[data-audit-action="prepare"]').disabled, true);
    finish({ ok: true, audit: structuredClone(f.detail) });
    await pending;
    assert.equal(f.panel.querySelector(`[data-audit-title="${FINDING_ID}"]`).value, '保留正在编辑的草稿');
    assert.doesNotMatch(f.panel.innerHTML, /正在读取报告/);
  });

  it('prepares and publishes review, firing onPublished callback', async (t) => {
    const f = fixture(t);
    await f.ui.mountPr(f.panel, f.data);

    // Check the finding
    const check = f.panel.querySelector(`[data-audit-check="${FINDING_ID}"]`);
    check.checked = true;
    check.dispatch('change');

    // Click prepare
    await f.ui.operate('prepare');
    assert.equal(f.calls.some(([name]) => name === 'prepare'), true);
    assert.match(f.panel.innerHTML, /AI Review Preview/);

    // Click publish
    await f.ui.operate('publish');
    assert.equal(f.calls.some(([name]) => name === 'publish'), true);
    assert.deepEqual(f.getPublished(), { projectId: 'proj-1', prNumber: 7 });
  });

  it('loads code context on request', async (t) => {
    const f = fixture(t);
    await f.ui.mountPr(f.panel, f.data);

    await f.ui.context(FINDING_ID);
    assert.equal(f.calls.some(([name]) => name === 'context'), true);
    assert.match(f.panel.innerHTML, /10: const x = foo\(\);/);
  });

  it('mounts center and navigates to PR on click', async (t) => {
    const f = fixture(t);
    await f.ui.mountCenter(f.center, 'proj-1');

    assert.match(f.center.innerHTML, /PR #7/);
    const rowBtn = f.center.querySelector(`[data-audit-open="${AUDIT_REF}"]`);
    assert.ok(rowBtn);
    rowBtn.click();

    assert.deepEqual(f.getNav(), { projectId: 'proj-1', prNumber: 7, auditRef: AUDIT_REF });
  });
});

describe('D18 renderer original-finding repair', () => {
  function check(f, id = FINDING_ID) {
    const input = f.panel.querySelector(`[data-audit-repair-check="${id}"]`); input.checked = true; input.dispatch('change');
  }

  it('keeps repair selection and original preview independent from publication drafts', async (t) => {
    const f = fixture(t); await f.ui.mountPr(f.panel, f.data);
    assert.equal(f.panel.querySelector(`[data-audit-repair-check="${FINDING_ID}"]`).checked, false);
    check(f);
    assert.equal(f.panel.querySelector(`[data-audit-check="${FINDING_ID}"]`).checked, false);
    for (const field of ['title', 'body']) {
      const input = f.panel.querySelector(`[data-audit-${field}="${FINDING_ID}"]`);
      input.value = `edited publication ${field}`; input.dispatch('input');
    }
    const note = f.panel.querySelector('[data-audit-repair-field="note"]'); note.value = '说明\n保留换行'; note.dispatch('input');
    const profile = f.panel.querySelector('[data-audit-repair-field="profileId"]'); profile.value = 'local-test'; profile.dispatch('change');
    await f.ui.operate('prepare');
    assert.equal(await f.ui.operate('previewRepair'), true);
    const preview = f.panel.innerHTML.split('data-audit-repair-preview>')[1];
    assert.match(preview, /缺少边界检查/); assert.match(preview, /&lt;img/); assert.doesNotMatch(preview, /edited publication/);
    assert.match(f.panel.innerHTML, /AI Review Preview/);
    // Editing publication text must not invalidate the already reviewed repair preview.
    const body = f.panel.querySelector(`[data-audit-body="${FINDING_ID}"]`); body.value = 'new publication'; body.dispatch('input');
    assert.equal(await f.ui.operate('repair'), true);
    assert.deepEqual(f.calls.find(([name]) => name === 'snapshotRepair')[1], {
      projectBindingId: 'token-1', auditRef: AUDIT_REF, repairRevision: f.detail.repairRevision, findingIds: [FINDING_ID],
    });
    assert.deepEqual(f.calls.find(([name]) => name === 'repair')[1], {
      projectBindingId: 'token-1', source: { kind: 'pr_audit', auditRepairRef: AUDIT_REPAIR_REF }, note: '说明\n保留换行', validationProfileId: 'local-test', sessionId: 'session-1',
    });
    assert.deepEqual(f.getRepair(), { projectId: 'proj-1', repairRef: REPAIR_REF });
    assert.equal(f.calls.some(([name]) => name === 'publish'), false);
  });

  it('limits selection to five and requires a new preview after a repair edit', async (t) => {
    const f = fixture(t, { findingCount: 6 }); await f.ui.mountPr(f.panel, f.data);
    assert.equal(await f.ui.operate('previewRepair'), false);
    for (const finding of f.detail.report.findings.slice(0, 5)) check(f, finding.findingId);
    assert.equal(f.panel.querySelector(`[data-audit-repair-check="${f.detail.report.findings[5].findingId}"]`).disabled, true);
    assert.equal(await f.ui.operate('previewRepair'), true);
    const note = f.panel.querySelector('[data-audit-repair-field="note"]'); note.value = '更改说明'; note.dispatch('input');
    assert.equal(await f.ui.operate('repair'), false);
    assert.equal(f.calls.some(([name]) => name === 'snapshotRepair'), false);
    await f.ui.operate('previewRepair'); await f.ui.operate('repair');
    assert.equal(f.calls.find(([name]) => name === 'snapshotRepair')[1].findingIds.length, 5);
    assert.equal(Object.hasOwn(f.calls.find(([name]) => name === 'repair')[1], 'validationProfileId'), false);
  });

  it('allows every Review publication state without changing a repair preview', async (t) => {
    const f = fixture(t); await f.ui.mountPr(f.panel, f.data); check(f); await f.ui.operate('previewRepair');
    for (const status of ['publishing', 'published', 'uncertain', 'failed']) {
      f.detail.publication = { status, reviewId: 12 };
      // Publication revisions are hashes; their contents are irrelevant to the repair revision.
      f.detail.revision = status.length.toString(16).repeat(64);
      await f.ui.refresh();
      assert.equal(f.panel.querySelector(`[data-audit-repair-check="${FINDING_ID}"]`).disabled, false);
      assert.equal(f.panel.querySelector('[data-audit-action="repair"]').disabled, false);
    }
    f.detail.stale = true; await f.ui.refresh();
    assert.equal(f.panel.querySelector(`[data-audit-repair-check="${FINDING_ID}"]`).disabled, true);
    assert.equal(await f.ui.operate('repair'), false);
  });

  it('preserves both drafts, selection, focus, and finding scroll across refresh and remount', async (t) => {
    const f = fixture(t); await f.ui.mountPr(f.panel, f.data); check(f);
    const title = f.panel.querySelector(`[data-audit-title="${FINDING_ID}"]`); title.value = '发布草稿'; title.dispatch('input');
    const note = f.panel.querySelector('[data-audit-repair-field="note"]'); note.value = '修复草稿'; note.focus(); note.setSelectionRange(1, 3); note.dispatch('input');
    f.panel.querySelector('[data-audit-findings]').scrollTop = 120;
    await f.ui.refresh(); f.ui.unmount(); await f.ui.mountPr(f.panel, f.data);
    assert.equal(f.panel.querySelector(`[data-audit-title="${FINDING_ID}"]`).value, '发布草稿');
    assert.equal(f.panel.querySelector(`[data-audit-repair-check="${FINDING_ID}"]`).checked, true);
    assert.equal(f.doc.activeElement.value, '修复草稿'); assert.equal(f.doc.activeElement.selectionStart, 1);
    assert.equal(f.panel.querySelector('[data-audit-findings]').scrollTop, 120);
    f.ui.focusFindings([FINDING_ID]);
    assert.equal(f.panel.querySelector(`[data-audit-finding="${FINDING_ID}"]`).scrolled, true);
    assert.match(f.panel.innerHTML, /is-highlighted/);
  });

  it('highlights source findings without selecting them for another repair', async (t) => {
    const f = fixture(t); await f.ui.mountPr(f.panel, f.data);
    assert.equal(f.ui.focusFindings([FINDING_ID]), true);
    assert.equal(f.panel.querySelector(`[data-audit-repair-check="${FINDING_ID}"]`).checked, false);
  });

  it('discards late snapshots after unmount, a binding change, PR switch, or head change', async (t) => {
    for (const change of ['unmount', 'binding', 'pr', 'head']) {
      const f = fixture(t); await f.ui.mountPr(f.panel, f.data); check(f); await f.ui.operate('previewRepair');
      let finish; f.api.snapshotPrAuditRepair = () => new Promise((resolve) => { finish = resolve; });
      const pending = f.ui.operate('repair');
      if (change === 'unmount') f.ui.unmount();
      if (change === 'binding') f.setToken('replacement');
      if (change === 'pr') await f.ui.mountPr(f.panel, { ...f.data, prNumber: 8 });
      if (change === 'head') await f.ui.mountPr(f.panel, { ...f.data, headSha: '2'.repeat(40) });
      finish({ ok: true, auditRepairRef: AUDIT_REPAIR_REF });
      assert.equal(await pending, false, change);
      assert.equal(f.calls.some(([name]) => name === 'repair'), false, change); assert.equal(f.getRepair(), null, change);
    }
  });
});
