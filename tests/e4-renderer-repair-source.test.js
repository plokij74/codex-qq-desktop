'use strict';
// Runs the production engineering repair render functions with a synthetic DOM.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const chatState = require('../src/renderer/e4-chat-state');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const pick = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const functions = [
  pick('function modelSourceLabel(', 'function getProject('),
  pick('let engineeringRepairSeq =', 'function engineeringIndexStateText('),
].join('\n');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function fixture(repair) {
  const list = { innerHTML: '', querySelectorAll: () => [] };
  const detail = { innerHTML: '', dataset: {}, classList: { add() {}, remove() {} } };
  const elements = { 'engineering-repairs': list, 'engineering-repair-detail': detail,
    'engineering-repair-close-detail': { addEventListener() {} } };
  const context = vm.createContext({
    escapeHtml, currentView: 'scheduled',
    engineeringBindingToken: () => 'synthetic-binding', sessionProject: () => null,
    engineeringRepairStatusText: value => value, engineeringValidationStatusText: value => value || 'not_run',
    engineeringRepairSourceText: () => 'synthetic CI',
    document: { getElementById: id => elements[id] || null },
    window: { E4ChatState: chatState, codex: { listEngineeringRepairs: async () => ({ ok: true, repairs: [repair] }),
      getEngineeringRepairResult: async () => ({ ok: true, repair }) } },
  });
  vm.runInContext(functions, context);
  return { list, detail, listRepairs: () => vm.runInContext('loadEngineeringRepairs("synthetic-binding")', context),
    showRepair: () => vm.runInContext('showEngineeringRepair("synthetic-binding", "synthetic-repair")', context) };
}
const modelSource = Object.freeze({ kind: 'api', providerId: 'fixed-provider', model: 'fixed-model <unsafe>',
  protocol: 'openai-responses', assistantName: 'Accepted assistant', runId: 'accepted-repair-run' });
for (const view of ['list', 'detail']) test(`E4 engineering repair ${view} displays the fixed accepted model, not current settings`, async () => {
  const f = fixture({ repairRef: 'synthetic-repair', status: 'no_changes', source: { kind: 'remote_ci' }, modelSource });
  if (view === 'list') await f.listRepairs(); else await f.showRepair();
  const html = f[view].innerHTML;
  assert.match(html, /fixed-provider/); assert.match(html, /fixed-model &lt;unsafe&gt;/);
  assert.match(html, /openai-responses/); assert.doesNotMatch(html, /fixed-model <unsafe>/);
});
for (const view of ['list', 'detail']) test(`E4 engineering repair ${view} leaves unrecorded historical model provenance unchanged`, async () => {
  const f = fixture({ repairRef: 'synthetic-repair', status: 'failed', source: { kind: 'remote_ci' } });
  if (view === 'list') await f.listRepairs(); else await f.showRepair();
  assert.doesNotMatch(f[view].innerHTML, /fixed-provider|fixed-model|固定模型/);
});
