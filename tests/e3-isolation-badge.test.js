'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const begin = source.indexOf('async function updateIsolationBadge() {');
const end = source.indexOf('\nfunction promptElevation', begin);
assert.ok(begin >= 0 && end > begin, 'Load the actual renderer isolation badge implementation');
const implementation = source.slice(begin, end);
test('initial HTML badge does not claim isolation before IPC capability verification', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const badge = html.match(/<span[^>]*id="isolation-badge"[^>]*>[\s\S]*?<\/span>/)?.[0];
  assert.ok(badge);
  assert.match(badge, /isolation-badge unconfined/);
  assert.match(badge, /隔离状态待核验/);
  assert.doesNotMatch(badge, /🛡️|严格沙箱隔离|>[^<]*已隔离/);
});
async function render(status, fail = false) {
  const badge = { textContent: 'old green', className: 'isolation-badge', title: 'old isolation proof' };
  const warnings = [];
  const context = vm.createContext({
    document: { getElementById: (id) => id === 'isolation-badge' ? badge : null },
    window: { codex: { getIsolationStatus: async () => { if (fail) throw new Error('fixture status unavailable'); return status; } } },
    console: { warn: (...args) => warnings.push(args) },
  });
  vm.runInContext(implementation, context);
  await vm.runInContext('updateIsolationBadge()', context);
  return { badge, warnings };
}
for (const executionPolicy of ['strict-isolated', 'workspace-write']) {
  test(`actual isolation badge shows backend availability, not proof of an execution: ${executionPolicy}`, async () => {
    const { badge } = await render({ executionPolicy, capabilities: { osIsolationAvailable: true } });
    assert.match(badge.textContent, /隔离可用/);
    assert.doesNotMatch(badge.textContent, /已隔离/);
    assert.equal(badge.className, 'isolation-badge');
    assert.match(badge.title, /失败不自动退回宿主/);
  });
}
test('actual isolation badge never claims isolation for explicitly selected host mode', async () => {
  const { badge } = await render({ executionPolicy: 'HOST_UNCONFINED', capabilities: { osIsolationAvailable: true } });
  assert.match(badge.textContent, /宿主执行模式（未隔离）/);
  assert.equal(badge.className, 'isolation-badge unconfined');
  assert.doesNotMatch(badge.textContent, /隔离可用/);
});
test('actual isolation badge warns when a requested isolated backend is unavailable', async () => {
  const { badge } = await render({ executionPolicy: 'strict-isolated', capabilities: { osIsolationAvailable: false } });
  assert.match(badge.textContent, /OS 隔离不可用/);
  assert.equal(badge.className, 'isolation-badge unconfined');
});
test('actual isolation badge removes stale green state when status IPC rejects', async () => {
  const { badge, warnings } = await render(null, true);
  assert.match(badge.textContent, /隔离状态未知/);
  assert.equal(badge.className, 'isolation-badge unconfined');
  assert.match(badge.title, /不将旧状态视为/);
  assert.equal(warnings.length, 1);
});
test('actual isolation badge does not infer capability from an empty IPC response', async () => {
  const { badge } = await render(undefined);
  assert.match(badge.textContent, /OS 隔离不可用/);
  assert.equal(badge.className, 'isolation-badge unconfined');
});
