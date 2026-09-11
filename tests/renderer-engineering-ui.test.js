'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

describe('D11 renderer engineering center contract', () => {
  it('renames the scheduled entry to the engineering center in nav and title', () => {
    assert.match(html, /data-view="scheduled">工程中心</);
    assert.match(html, /class="nav-item" data-view="scheduled">工程中心</);
    assert.match(app, /scheduled:\s*'工程中心'/);
  });

  it('keeps index state and job status labels in separate maps', () => {
    // 'stale' means "needs refresh" for an index but "result outdated" for a
    // job. A single object literal silently drops the first definition.
    assert.match(app, /const INDEX_STATE_LABELS\s*=/);
    assert.match(app, /const JOB_STATUS_LABELS\s*=/);
    const indexMap = app.slice(app.indexOf('const INDEX_STATE_LABELS'), app.indexOf('const JOB_STATUS_LABELS'));
    assert.match(indexMap, /stale:\s*'需要刷新'/);
    assert.doesNotMatch(indexMap, /queued:/);
    const jobMap = app.slice(app.indexOf('const JOB_STATUS_LABELS'));
    assert.match(jobMap.slice(0, 400), /stale:\s*'结果过期'/);
  });

  it('renders the index state through the localized label helper', () => {
    assert.match(app, /function engineeringIndexStateText\(/);
    assert.match(app, /engineeringIndexStateText\(status\??\.state\)/);
  });

  it('shows the lexical approximation notice inside the engineering center', () => {
    assert.match(app, /近似定位/);
  });

  it('warns when the terminal switch is off instead of failing silently on run', () => {
    const start = app.indexOf('async function renderEngineeringCenter');
    const section = app.slice(start, app.indexOf('async function loadEngineeringJobs', start));
    assert.ok(start >= 0);
    assert.match(section, /getSettings\(\)/);
    assert.match(section, /terminalEnabled/);
    assert.match(section, /允许终端命令/);
  });

  it('keeps verification approval in an ephemeral engineering panel', () => {
    assert.match(app, /ev\.source === 'verification'/);
    assert.match(app, /function renderEngineeringApprovalCard\(/);
    assert.match(app, /id="engineering-approval"/);
    assert.doesNotMatch(app.slice(app.indexOf('function handleTerminalPanelEvent'), app.indexOf('function runManualTerminal')), /renderApprovalCard\(ev\).*verification/);
  });

  it('routes Agent verification approvals to the engineering source', () => {
    const start = main.indexOf('async function startChatRun');
    const section = main.slice(start, main.indexOf('// --- Manual terminal panel IPC', start));
    assert.match(section, /if \(approvalPayload\.source\) approvalEvent\.source = approvalPayload\.source/);
    assert.match(section, /else if \(approvalPayload\.tool === 'verification_start'\) approvalEvent\.source = 'verification'/);
    assert.match(section, /ordinary chat approvals source-less/);
    assert.doesNotMatch(section, /source:\s*approvalPayload\.tool === 'verification_start'[\s\S]{0,120}\? 'verification'[\s\S]{0,120}: \(approvalPayload\.source \|\| 'user'\)/);
  });

  it('binds a newly created project before exposing engineering tools', () => {
    const start = app.indexOf('async function createProjectFromModal');
    const section = app.slice(start, app.indexOf('function openProjectChat', start));
    assert.ok(start >= 0);
    assert.match(section, /bindWorktreeProject/);
    assert.match(section, /worktreeBindings\.set/);
  });

  it('carries the sender-owned binding into approved plan execution', () => {
    const start = app.indexOf('async function approvePlanFromCard');
    const section = app.slice(start, app.indexOf('async function renderVerifyStrip', start));
    assert.match(section, /projectBindingId/);
    assert.match(section, /approvePlan\(\{[\s\S]*projectBindingId/);
  });

  it('exposes a grant revoke action wired to the narrow revoke IPC', () => {
    assert.match(app, /data-vfy-revoke/);
    assert.match(app, /window\.codex\.revokeVerificationGrant\(\{\s*projectBindingId:\s*token,\s*profileId:/);
  });

  it('refreshes index status as well as jobs on background engineering events', () => {
    const start = app.indexOf('onEngineeringEvent');
    const handler = app.slice(start, start + 1200);
    assert.ok(start >= 0);
    assert.match(handler, /loadEngineeringJobs/);
    assert.match(handler, /refreshEngineeringIndexStatus/);
  });

  it('shows failed verification and workflow repair entry points with advisory validation controls', () => {
    assert.match(app, /j\.status === 'failed'[\s\S]{0,180}data-vfy-repair/);
    assert.match(app, /node\.status === 'failed'[\s\S]{0,180}data-workflow-repair-node/);
    assert.match(app, /仅供参考，不影响应用或 Draft PR/);
    assert.match(app, /data-repair-validate-cancel/);
    assert.match(app, /cancelEngineeringRepairValidation/);
  });

  it('refreshes repair history on engineering events without persisting notes or validation output', () => {
    const start = app.indexOf('onEngineeringEvent');
    const handler = app.slice(start, start + 1200);
    assert.match(handler, /loadEngineeringRepairs/);
    const saveStart = app.indexOf('function saveState()');
    const saveBody = app.slice(saveStart, app.indexOf('function activeSession()', saveStart));
    assert.doesNotMatch(saveBody, /repair|note|stdout|stderr|diagnostic/i);
  });

  it('routes repair approvals and subscribes to the dedicated repair event channel', () => {
    assert.match(app, /function renderEngineeringRepairApprovalCard\(/);
    assert.match(app, /ev\.source === 'repair'[\s\S]{0,180}renderEngineeringRepairApprovalCard\(ev\)/);
    assert.match(app, /onEngineeringRepairEvent/);
    assert.match(app, /engineering-repair-open-result/);
    assert.match(app, /查看 D5 结果卡/);
  });

  it('provides a structured D12 DAG editor and drill-down workflow results', () => {
    const start = app.indexOf('async function editEngineeringWorkflow');
    const editor = app.slice(start, app.indexOf('function openProjectChat', start));
    assert.ok(start >= 0);
    assert.match(editor, /data-workflow-node-profile/);
    assert.match(editor, /data-workflow-dependency/);
    assert.match(editor, /data-workflow-node-continue/);
    assert.match(editor, /data-workflow-fail-fast/);
    assert.match(editor, /data-workflow-parallel/);
    assert.match(editor, /data-workflow-timeout/);
    assert.match(app, /data-workflow-copy/);
    assert.match(app, /workflow\.runnable/);
    assert.match(app, /仅当前进程/);
    assert.match(app, /showEngineeringJobResult\(token, button\.dataset\.workflowJob, 'engineering-workflow-detail'\)/);
  });

  it('drops the phantom verification profile textarea wiring from settings', () => {
    // No such element exists in index.html; reading it made every settings
    // save submit an empty profile list, and main only ever returns redacted
    // profile summaries without command or cwd.
    assert.doesNotMatch(app, /set-verification-profiles/);
    assert.doesNotMatch(html, /set-verification-profiles/);
    assert.match(app, /codeIndexEnabled:\s*document\.getElementById\('set-code-index-enabled'\)/);
  });

  it('never persists engineering index, job, command or diagnostic bodies', () => {
    const start = app.indexOf('function saveState()');
    const body = app.slice(start, app.indexOf('function activeSession()', start));
    assert.ok(start >= 0);
    assert.match(body, /JSON\.stringify\(\{ sessions, projects, activeSessionId, pluginState \}\)/);
    assert.doesNotMatch(body, /engineering|verification|diagnostic/i);
    assert.doesNotMatch(app, /localStorage\.setItem\([^)]*engineering/i);
  });
});
