'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
function production(name) {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start, `${name} production function exists`);
  return source.slice(start, end);
}
function node(id) {
  return {
    id, children: [], parentElement: null, innerHTML: '', value: '', listeners: new Map(), label: '',
    get textContent() { return this.label + this.children.map(child => child.textContent).join(''); },
    set textContent(value) {
      this.label = String(value);
      for (const child of this.children) child.parentElement = null;
      this.children = [];
    },
    appendChild(child) {
      if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child);
      this.children.push(child); child.parentElement = this; return child;
    },
    querySelectorAll() { return []; },
    addEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      handlers.push(handler); this.listeners.set(type, handlers);
    },
    click() { for (const handler of this.listeners.get('click') || []) handler({ target: this }); },
  };
}
function harness() {
  const container = node('root'), head = node('friend-list-head'), list = node('friend-list');
  const button = node('btn-general-ai');
  const header = html.match(/<div[^>]+id="friend-list-head"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  assert.ok(header?.includes('id="btn-general-ai"'), 'actual HTML provides the general AI entry');
  if (header.includes('id="friend-list-label"')) head.appendChild(node('friend-list-label'));
  head.appendChild(button); container.appendChild(head); container.appendChild(list);
  const find = (owner, id) => owner.id === id ? owner : owner.children.map(child => find(child, id)).find(Boolean) || null;
  const document = { getElementById: id => find(container, id) };
  const friends = source.match(/const FRIENDS = (\[[\s\S]*?\n\]);/)?.[1];
  assert.ok(friends, 'actual contact identities exist');
  const context = vm.createContext({ document, activeSession: () => ({ peer: 'codex' }), openFriendChat() {} });
  vm.runInContext(`const FRIENDS = ${friends};\n${production('escapeHtml')}\n${production('renderFriends')}`, context);
  return { context, document, head, list, button };
}

test('general AI contact entry survives actual first render and later contact refreshes', () => {
  const h = harness();
  h.context.renderFriends();
  assert.equal(h.document.getElementById('btn-general-ai'), h.button,
    'rendering the contact title must not detach the explicit general AI entry');
  let clicks = 0;
  h.button.addEventListener('click', () => { clicks++; });
  for (let i = 0; i < 3; i++) {
    h.context.renderFriends();
    assert.equal(h.document.getElementById('btn-general-ai'), h.button);
    h.button.click();
  }
  assert.equal(clicks, 3, 'the same entry and handler survive repeated refreshes');
});
test('actual AI and demonstration contacts never advertise unverified online presence', () => {
  const h = harness(); h.context.renderFriends();
  assert.match(h.head.textContent, /AI/);
  assert.match(h.head.textContent, /示例/);
  assert.match(h.list.innerHTML, /AI 助手/);
  assert.match(h.list.innerHTML, /Randy Lu（示例）/);
  assert.match(h.list.innerHTML, /Maya（示例）/);
  assert.doesNotMatch(h.list.innerHTML, />在线<|contact-status online/);
});
test('the static demonstration-contact template also cannot claim a real online contact', () => {
  const contact = html.match(/id="contact-randy"[\s\S]*?<\/div>\s*<\/div>/)?.[0];
  assert.ok(contact, 'the legacy demonstration entry remains accessible');
  assert.match(contact, /示例/);
  assert.match(contact, /模拟/);
  assert.doesNotMatch(contact, /contact-status online|>在线</);
});
