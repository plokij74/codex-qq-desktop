'use strict';
const assert = require('node:assert/strict');
module.exports = async function followupFlow({ js, until, capture, win, engineering, state, git, localHead, beforeRefs, validationProfile }) {
  for (const round of [1, 2]) {
    await until("document.querySelectorAll('[data-recheck-repair-id]').length === 2 && !document.querySelector('[data-recheck-repair-id]').disabled", 60000);
    assert.equal(await js("[...document.querySelectorAll('[data-recheck-repair-id]')].some(n=>n.checked)"), false);
    const parent = engineering.prAuditRecheckManager.store.list().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const parentSelected = `document.querySelector('[data-recheck-action=select][data-recheck-key="${parent.recheckRef}"]')?.textContent.includes('当前查看')`;
    await js(`(() => {
      const ids = [...document.querySelectorAll('[data-recheck-repair-id]')].filter(n=>${round === 1 ? 'true' : "n.parentElement.textContent.includes('无法判断')"}).map(n=>n.dataset.recheckRepairId);
      for (const id of ids) { const node=document.querySelector('[data-recheck-repair-id="'+id+'"]'); node.checked=true; node.dispatchEvent(new Event('change')); }
      const note=document.querySelector('[data-recheck-repair-field=note]'); note.value='SMOKE_PRIVATE_D20_NOTE_${round}'; note.focus(); note.setSelectionRange(2, 5); note.dispatchEvent(new Event('input'));
    })()`);
    assert.deepEqual(await js("[document.activeElement.selectionStart, document.activeElement.selectionEnd]"), [2, 5]);
    await js(`(() => {const n=document.querySelector('[data-recheck-repair-field=profileId]'); n.value='${round === 1 ? validationProfile.id : ''}'; n.dispatchEvent(new Event('change'));})()`);
    await js('prAuditRecheckUi.refresh()');
    assert.equal(await js("document.querySelector('[data-recheck-repair-field=note]').value"), 'SMOKE_PRIVATE_D20_NOTE_' + round);
    assert.equal(await js("[...document.querySelectorAll('[data-recheck-repair-id]')].filter(n=>n.checked).length"), round === 1 ? 2 : 1);
    await js("document.querySelector('[data-recheck-action=previewRepair]').click()");
    await until("Boolean(document.querySelector('[data-recheck-action=repair]'))");
    assert.match(await js("document.querySelector('.pr-audit-recheck .pr-audit-preview').textContent"), /无法判断/);
    if (round === 1) for (const [width, height] of [[1100, 720], [900, 580]]) {
      win.setContentSize(width, height);
      await js('new Promise(resolve => setTimeout(resolve, 150))');
      await js("document.querySelector('.pr-audit-recheck .pr-audit-preview').scrollIntoView({block:'center'})");
      await capture(`continue-preview-${width}x${height}`);
      const sizes = await js("['.pr-audit-recheck','.pr-audit-repair-form','.pr-detail'].map(s=>{const n=document.querySelector(s);return {selector:s,width:n.clientWidth,scroll:n.scrollWidth};})");
      for (const size of sizes) assert.ok(size.scroll <= size.width + 1, JSON.stringify(size));
    }
    const validations = state.validations;
    await js("document.querySelector('[data-recheck-action=repair]').click()");
    await until(`currentView === 'scheduled' && document.querySelectorAll('#engineering-repairs [data-repair-view]').length === ${round + 1}`, 120000);
    assert.equal(state.generations, round + 1); assert.equal(state.pushes, round); assert.equal(state.rechecks, round); assert.equal(state.validations, validations);
    const repair = engineering.repairManager.store.list().find((r) => r.source.kind === 'pr_audit_recheck');
    const source = engineering.prAuditRecheckRepairManager.store.get(repair.source.recheckRepairRef, repair.projectKey);
    assert.equal(source.recheckRef, parent.recheckRef); assert.equal(source.headSha, parent.target.headSha);
    assert.equal(source.findingIds.length, round === 1 ? 2 : 1);
    const view = `document.querySelector('[data-repair-view="${repair.repairRef}"]').click()`;
    await js(view); await until("Boolean(document.getElementById('engineering-repair-open-recheck'))");
    await js("document.getElementById('engineering-repair-open-recheck').click()");
    await until(`${parentSelected} && document.querySelector('[data-recheck-repair-field=note]')?.value === 'SMOKE_PRIVATE_D20_NOTE_${round}'`);
    await js("document.querySelector('[data-recheck-action=repairProgress]').click()");
    await until(`currentView === 'scheduled' && Boolean(document.querySelector('[data-repair-view="${repair.repairRef}"]'))`);
    if (round === 1) {
      await js(`document.querySelector('[data-repair-validate="${repair.repairRef}"]').click()`);
      await until("!document.getElementById('engineering-approval').classList.contains('hidden')");
      await js("document.querySelector('#engineering-approval [data-engineering-decision=allow]').click()");
      await until(`document.querySelector('[data-repair-view="${repair.repairRef}"]')?.closest('.engineering-job').textContent.includes('验证 通过')`, 60000);
      assert.equal(state.validations, validations + 1);
    }
    await js(view); await until("Boolean(document.getElementById('engineering-repair-open-result'))");
    await js("document.getElementById('engineering-repair-open-result').click()");
    const card = '.worktree-result-card[data-result-id="' + repair.resultId + '"]';
    await until(`currentView === 'chat' && Boolean(document.querySelector('${card}'))`);
    const click = (label) => js(`[...document.querySelectorAll('${card} button')].find(n=>n.textContent==='${label}').click()`);
    await click('查看 diff'); await until(`Boolean(document.querySelector('${card} .worktree-result-preview'))`);
    await capture('continue-diff-round-' + round);
    await click('更新此 PR');
    await until("!document.getElementById('app-dialog-input-wrap').classList.contains('hidden')");
    await js(`document.getElementById('app-dialog-input').value='Continue repair round ${round}'; document.getElementById('app-dialog-ok').click()`);
    await until("!document.getElementById('app-dialog').classList.contains('hidden') && document.getElementById('app-dialog-input-wrap').classList.contains('hidden')");
    assert.equal(state.pushes, round); await capture('continue-update-approval-' + round);
    await js("document.getElementById('app-dialog-ok').click()");
    await until(`activeSession()?.pendingWorktreeResults?.some(r=>r.id==='${repair.resultId}' && r.state==='pr_updated')`, 120000);
    assert.equal(state.pushes, round + 1); assert.equal(state.rechecks, round);
    await click('查看来源复审');
    await until(`${parentSelected} && document.querySelector('[data-recheck-detail]')?.textContent.includes('结论已过期') && document.querySelector('[data-recheck-repair-id]')?.disabled === true`);
    await js("setView('chat')");
    await click('复审本次修复');
    await until(`document.querySelector('.pr-audit-recheck-findings')?.textContent.includes('${round === 1 ? '无法判断' : 'AI 判断已解决'}') && Boolean(document.querySelector('[data-recheck-action=parent]'))`, 120000);
    assert.equal(state.rechecks, round + 1);
    const final = engineering.prAuditRecheckManager.store.list().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    assert.deepEqual(final.source.findingIds, source.findingIds);
    assert.equal(final.source.repairBaseHead, parent.target.headSha);
    assert.equal(final.source.originalHead, parent.source.originalHead);
    await js("document.querySelector('[data-recheck-action=parent]').click()");
    await until(`${parentSelected} && document.querySelector('[data-recheck-detail]')?.textContent.includes('结论已过期') && document.querySelector('[data-recheck-repair-id]')?.disabled === true`);
    await js(`prAuditRecheckUi.select('${final.recheckRef}')`);
    await capture('continue-recheck-round-' + round);
    assert.equal(git(['rev-parse', 'HEAD']), localHead); assert.equal(git(['show-ref']), beforeRefs); assert.equal(git(['status', '--porcelain']), '');
    console.log('D20 smoke: round ' + round + ' delivered and manually rechecked');
  }
};
