'use strict';
const assert = require('node:assert/strict');
module.exports = async ({ js, until, capture, win, state }) => {
  const before = { ...state };
  await js('prAuditTrackingUi.refresh()');
  await until("document.querySelector('.tracking-detail')?.textContent.includes('完整轮次历史（3）')");
  assert.equal(await js("document.querySelectorAll('[data-tracking-open^=finding-]').length"), 2);
  for (const [width, height] of [[1100, 720], [900, 580]]) {
    win.setSize(width, height);
    await js("document.querySelector('[data-tracking-open=history]').open=true; document.querySelector('[data-tracking-open^=round-]').open=true; document.getElementById('pr-audit-tracking-panel').scrollIntoView({block:'start'})");
    await capture(`tracking-${width}x${height}`);
    assert.equal(await js("document.querySelector('.pr-audit-tracking').scrollWidth <= document.querySelector('.pr-audit-tracking').clientWidth + 2"), true);
  }
  await js("document.querySelector('[data-tracking-action=original]').click()");
  await until("document.querySelectorAll('.pr-audit-finding.is-highlighted').length === 1");
  await js("document.querySelector('[data-tracking-action=recheck]').click()");
  await until("Boolean(document.querySelector('.pr-audit-recheck-findings'))");
  await js("document.querySelector('[data-tracking-action=repair]').click()");
  await until("currentView === 'scheduled' && Boolean(document.getElementById('engineering-repair-open-result'))");
  await until("Boolean(document.querySelector('#engineering-pr-tracking [data-tracking-action=navigate]'))");
  await js("document.querySelector('#engineering-pr-tracking [data-tracking-action=navigate]').click()");
  await until("currentView === 'prs' && document.querySelector('.tracking-detail')?.textContent.includes('完整轮次历史（3）')");
  await js('prAuditTrackingUi.refresh()');
  assert.equal(await js("document.querySelectorAll('[data-tracking-open^=round-]').length"), 3);
  for (const key of ['audits', 'generations', 'pushes', 'rechecks', 'validations', 'reviews', 'replies', 'resolves', 'watches']) assert.equal(state[key], before[key], key);
  console.log('D21 smoke: multi-round tracking, responsive layout and read-only navigation passed');
};
