'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const source = app.slice(app.indexOf('async function bindWorktreeProject('), app.indexOf('\nfunction workflowGateSelectionKey'));
it('coalesces concurrent startup binding requests so source navigation retains a valid token', async () => {
  let finish; let calls = 0; const project = { id: 'p', path: '/repo' }; const bindings = new Map();
  const context = { getProject: () => project, worktreeBindings: bindings, worktreeBindingRequests: new Map(), ciWatchUi: null,
    window: { codex: { bindWorktreeProject: () => { calls++; return new Promise((resolve) => { finish = resolve; }); } } } };
  vm.createContext(context); vm.runInContext(source, context);
  const first = context.bindWorktreeProject(project); const second = context.bindWorktreeProject(project);
  assert.equal(calls, 1); finish({ ok: true, projectBindingId: 'pb_current' });
  assert.deepEqual(await Promise.all([first, second]), ['pb_current', 'pb_current']);
  assert.equal(bindings.get('p'), 'pb_current'); assert.equal(context.worktreeBindingRequests.size, 0);
  const changed = context.bindWorktreeProject(project, true); project.path = '/new';
  finish({ ok: true, projectBindingId: 'pb_old' }); assert.equal(await changed, '');
  assert.equal(bindings.has('p'), false);
});
