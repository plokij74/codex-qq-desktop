'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/renderer/pr-audit-ui');

const AUDIT_REF = 'pra_' + 'a'.repeat(24);
const FINDING_ID = 'paf_' + 'b'.repeat(24);
const REVISION = 'c'.repeat(64);
const DRAFT_REF = 'pad_' + 'd'.repeat(24);

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
    for (const match of value.matchAll(/<(button|input|textarea|article|section|div|pre|strong)\b([^>]*)>/g)) {
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
  contains(node) { return node === this || this.children.includes(node); }
}

function sampleAuditDetail() {
  return {
    auditRef: AUDIT_REF,
    prNumber: 7,
    revision: REVISION,
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

function fixture(t) {
  const doc = { activeElement: null };
  const panel = new MockElement(doc);
  const center = new MockElement(doc);
  const calls = [];
  let publishedPr = null;
  let navTarget = null;

  const detail = sampleAuditDetail();

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
      return { ok: true, audit: detail };
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
  };

  const project = { id: 'proj-1', path: '/repo' };
  const ui = create({
    api,
    document: doc,
    getProject: () => project,
    getToken: () => 'token-1',
    isVisible: () => true,
    onPublished: (p) => { publishedPr = p; },
    navigateToPr: (p) => { navTarget = p; },
  });

  t.after(() => ui.close());

  const data = {
    projectId: 'proj-1',
    prNumber: 7,
    state: 'OPEN',
    headSha: detail.source.headSha,
  };

  return { ui, api, doc, panel, center, calls, detail, data, getPublished: () => publishedPr, getNav: () => navTarget };
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
