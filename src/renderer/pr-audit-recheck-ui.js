'use strict';
(function expose(factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else Object.defineProperty(window, 'PrAuditRecheckUi', { value: Object.freeze(factory()) });
}(function () {
  const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const REF = /^pac_[a-f0-9]{24}$/; const ACTIVE = new Set(['preparing', 'running']);
  const labels = { resolved: 'AI 判断已解决', still_present: 'AI 判断仍存在', unknown: '无法判断' };
  const statuses = { preparing: '准备复审快照', running: '复审中', completed: '复审完成', failed: '复审未完成', cancelled: '已取消', interrupted: '已中断' };
  const fresh = { current: '与当前 PR 一致', stale: '结论已过期，PR 已变化', unknown: '当前状态未核实' };
  function reason(code) {
    return ({ PR_AUDIT_RECHECK_SOURCE: '原报告或修复来源不可用，无法复审。', PR_AUDIT_RECHECK_DELIVERY: '该修复的 PR 更新尚未确认成功，请先核对更新状态。',
      PR_AUDIT_RECHECK_ANCESTRY: '当前 PR 未包含该修复提交，或提交历史无法验证。', PR_AUDIT_RECHECK_STORE_CORRUPT: '复审历史无法解密，原文件已保留；当前结果仅保留在内存。' })[code]
      || (typeof window !== 'undefined' && window.PrAuditUi?.reason(code)) || '操作未完成，请刷新后重试。';
  }
  function create(options) {
    const { api, getProject, getToken, document: doc } = options;
    const records = new Map(); let view; let closed = false;
    const current = (r) => !closed && view?.record === r && view.element?.isConnected !== false
      && getProject(r.projectId)?.path === r.path && getToken(r.projectId) === r.token && options.isVisible?.(r.projectId, r.prNumber) !== false;
    const call = async (method, payload) => { try { return await api[method](payload); } catch { return { ok: false, code: 'PR_AUDIT_UNAVAILABLE' }; } };
    function draft(r) {
      if (!r?.selected) return null;
      if (!r.drafts.has(r.selected)) r.drafts.set(r.selected, { selected: new Set(), note: '', profileId: '', preview: '', repairRef: '' });
      while (r.drafts.size > 50) r.drafts.delete(r.drafts.keys().next().value);
      return r.drafts.get(r.selected);
    }
    const canRepair = (r) => r?.detail?.status === 'completed' && r.detail.freshness === 'current'
      && r.sourceAvailable !== false && /^[a-f0-9]{64}$/.test(r.repairRevision || '') && typeof api.snapshotPrAuditRecheckRepair === 'function';
    const selectedFindings = (r) => (r.detail?.report?.findings || []).filter((f) => draft(r)?.selected.has(f.findingId));
    const previewKey = (r) => JSON.stringify([r.selected, r.repairRevision, selectedFindings(r).map((f) => f.findingId), draft(r)?.note, draft(r)?.profileId]);
    function selectRepair(id, checked, r = view?.record) {
      if (!r || !current(r) || r.busy || r.loading || !canRepair(r)) return false;
      const f = r.detail.report.findings.find((f) => f.findingId === id);
      if (!f || !['still_present', 'unknown'].includes(f.status)) return false;
      const saved = draft(r);
      if (checked && saved.selected.size >= 5 && !saved.selected.has(id)) return false;
      if (checked) saved.selected.add(id); else saved.selected.delete(id);
      saved.preview = ''; render(r); return true;
    }
    function editRepair(field, value, r = view?.record) {
      if (!r || !current(r) || r.busy || r.loading || !canRepair(r) || !['note', 'profileId'].includes(field)) return false;
      const saved = draft(r); saved[field] = String(value || ''); saved.preview = ''; render(r); return true;
    }
    async function repair(action, r = view?.record) {
      if (!r || !current(r) || r.busy || r.loading || !canRepair(r)) return false;
      const saved = draft(r); const findings = selectedFindings(r);
      if (!findings.length || findings.length > 5 || saved.note.length > 2000
        || findings.some((f) => !['still_present', 'unknown'].includes(f.status))
        || (saved.profileId && !r.profiles.some((p) => p.id === saved.profileId))) {
        r.error = '请选择 1–5 项仍存在或无法判断的问题，并检查说明及复验档案。'; render(r); return false;
      }
      if (action === 'previewRepair') { saved.preview = previewKey(r); r.error = ''; render(r); return true; }
      if (action !== 'repair' || saved.preview !== previewKey(r)) return false;
      const seq = ++r.seq; const frozen = previewKey(r); const ref = r.selected;
      const valid = () => current(r) && r.seq === seq && r.selected === ref && canRepair(r) && previewKey(r) === frozen;
      const note = saved.note; const profileId = saved.profileId;
      r.busy = 'repair'; r.error = ''; render(r);
      try {
        const source = await call('snapshotPrAuditRecheckRepair', { projectBindingId: r.token, recheckRef: ref,
          repairRevision: r.repairRevision, findingIds: findings.map((f) => f.findingId) });
        if (!valid()) return false;
        if (!source?.ok || !/^pcr_[a-f0-9]{24}$/.test(source.recheckRepairRef)) { r.error = reason(source?.code); return false; }
        const result = await call('startEngineeringRepair', { projectBindingId: r.token,
          source: { kind: 'pr_audit_recheck', recheckRepairRef: source.recheckRepairRef }, note,
          ...(profileId ? { validationProfileId: profileId } : {}) });
        if (!valid()) return false;
        if (!result?.ok) { r.error = reason(result?.code); return false; }
        saved.preview = ''; saved.repairRef = result.repairRef || result.repair?.repairRef || '';
        r.notice = '隔离修复已开始，可在工程中心查看。' + (source.persistence?.durable === false ? '来源仅保留在本次运行中。' : '');
        if (saved.repairRef) options.openRepair?.({ projectId: r.projectId, repairRef: saved.repairRef });
        return true;
      } finally { r.busy = ''; if (current(r)) render(r); }
    }
    function unmount() { if (view) { view.record.seq++; clearTimeout(view.record.timer); } view = null; }
    function forgetProject(id) { if (view?.record.projectId === id) unmount(); for (const [key, r] of records) if (r.projectId === id) records.delete(key); }
    function render(r = view?.record) {
      if (!r || !current(r)) return;
      const el = view.element; const scroll = el.scrollTop;
      const findingScroll = el.querySelector('.pr-audit-recheck-findings')?.scrollTop || 0;
      const focused = el.contains?.(doc?.activeElement) ? doc.activeElement?.getAttribute?.('data-recheck-key') : null;
      const selection = focused ? [doc.activeElement.selectionStart, doc.activeElement.selectionEnd] : null;
      const open = new Set([...el.querySelectorAll('[data-recheck-open]')].filter((n) => n.open).map((n) => n.dataset.recheckOpen));
      const button = (action, key, label, enabled = true) => `<button type="button" class="ghost-btn" data-recheck-action="${action}" data-recheck-key="${escape(key)}" ${r.busy || !enabled ? 'disabled' : ''}>${escape(label)}</button>`;
      const active = r.rows.some((row) => ACTIVE.has(row.status)); const row = r.detail;
      const saved = draft(r); const repairUi = !!r.repairRevision && typeof api.snapshotPrAuditRecheckRepair === 'function';
      const locked = r.busy || r.loading || !canRepair(r);
      let detail = '';
      if (row) {
        const source = row.source;
        detail = `<div class="pr-audit-source">原审查提交 <code>${escape(source.originalHead)}</code><br>修复提交 <code>${escape(source.repairCommit)}</code>${row.target ? `<br>复审目标 <code>${escape(row.target.headSha)}</code>${row.target.headSha !== source.repairCommit ? ' · 包含后续改动' : ''}` : ''}</div>
          <div class="pr-audit-notice">${escape(statuses[row.status])} · ${Number(row.turns) || 0}/8 轮${row.status === 'completed' ? ` · ${escape(fresh[row.freshness] || fresh.unknown)}` : ''}</div>
          ${row.errorCode ? `<div class="pr-audit-error">${escape(reason(row.errorCode))}</div>` : ''}
          ${r.sourceAvailable === false ? '<div class="pr-audit-error">原报告或修复来源不可用，历史结论仍可查看。</div>' : ''}
          <div class="pr-audit-actions">${button('original', source.auditRepairRef, '返回原发现', r.sourceAvailable !== false)}${button('audit', source.auditRepairRef, '完整 AI 审查', r.sourceAvailable !== false)}${button('start', source.resultId, '再次复审', !active && r.sourceAvailable !== false)}${ACTIVE.has(row.status) ? button('cancel', row.recheckRef, '取消复审') : ''}</div>`;
        if (source.parentRecheckRef) detail += `<div class="pr-audit-source">本轮修复前提交 <code>${escape(source.repairBaseHead)}</code></div><div class="pr-audit-actions">${button('parent', source.parentRecheckRef, '查看上一份复审')}</div>`;
        if (row.report) detail += `<p>${escape(row.report.summary)}</p><div class="pr-audit-recheck-findings">${row.report.findings.map((f) => {
          const original = r.originals.find((o) => o.findingId === f.findingId);
          return `<article class="pr-audit-finding"><strong>${escape(labels[f.status])} · ${escape(original?.title || '原问题')}</strong>
            ${repairUi && ['still_present', 'unknown'].includes(f.status) ? `<label class="pr-audit-check"><input type="checkbox" data-recheck-repair-id="${escape(f.findingId)}" data-recheck-key="fix-${escape(f.findingId)}" ${saved.selected.has(f.findingId) ? 'checked' : ''} ${locked ? 'disabled' : ''}>继续修复此项${f.status === 'unknown' ? '（无法判断，尝试修复）' : ''}</label>` : ''}
            ${original ? `<div class="pr-audit-source">${escape(original.path)} · ${escape(original.side)} ${original.startLine}–${original.line}</div><details data-recheck-open="original-${escape(f.findingId)}"><summary>原问题</summary><pre>${escape(original.body)}</pre></details>` : ''}
            <p>${escape(f.reason)}</p><div class="pr-audit-actions">${f.evidence.map((id) => { const e = row.evidence.find((e) => e.evidenceId === id);
              return e ? button('context', id, `${e.stage === 'target' ? '目标' : '历史'}依据：${e.path}${e.kind === 'absence' ? '（路径缺失）' : `:${e.startLine}–${e.line}`}`) : ''; }).join('')}</div></article>`;
        }).join('')}</div>`;
        if (repairUi && saved) {
          const selected = selectedFindings(r); const profiles = r.profiles || [];
          const preview = saved.preview === previewKey(r);
          detail += `<div class="pr-audit-repair-form">
            <label class="pr-audit-field">补充说明（可选，最多 2000 字）<textarea maxlength="2000" rows="2" data-recheck-repair-field="note" data-recheck-key="repair-note" ${locked ? 'disabled' : ''}>${escape(saved.note)}</textarea></label>
            <label class="pr-audit-field">本地复验档案（可选）<select data-recheck-repair-field="profileId" data-recheck-key="repair-profile" ${locked ? 'disabled' : ''}><option value="">不选择</option>${saved.profileId && !profiles.some((p) => p.id === saved.profileId) ? `<option value="${escape(saved.profileId)}" selected>原档案不可用，请重新选择</option>` : ''}${profiles.map((p) => `<option value="${escape(p.id)}" ${p.id === saved.profileId ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}</select></label>
            <div class="pr-audit-actions"><span>已选择 ${selected.length}/5 项</span>${button('previewRepair', 'preview-repair', '预览继续修复', !locked && selected.length > 0)}${saved.repairRef ? button('repairProgress', saved.repairRef, '查看修复进度') : ''}</div>
            ${preview ? `<div class="pr-audit-preview"><strong>继续修复预览</strong><div class="pr-audit-source">基于复审提交 <code>${escape(row.target.headSha)}</code></div>${selected.map((f) => `<p><strong>${escape(r.originals.find((o) => o.findingId === f.findingId)?.title || '原问题')} · ${escape(labels[f.status])}</strong><br>${escape(f.reason)}</p>`).join('')}<p>无法判断的项目将先检查当前代码，可能不产生改动。生成后可查看 diff、手动复验，并单独确认更新此 PR。</p>${button('repair', 'generate-repair', '生成隔离修复', !locked)}</div>` : ''}
          </div>`;
        }
      }
      el.innerHTML = `<section class="pr-audit-recheck"><strong>修复后复审</strong><p class="work-card-meta">逐项检查本次修复的原问题。AI 静态判断不能代替测试结果或合并条件。</p>
        ${button('refresh', 'refresh', '刷新复审历史')}${r.loading ? '<span> 读取中…</span>' : ''}
        ${r.persistence?.persistence === 'memory' ? `<div class="pr-audit-notice">${r.persistence.corrupt ? '原加密文件已保留。' : ''}复审历史仅保留在本次运行中。</div>` : ''}
        ${r.error ? `<div class="pr-audit-error">${escape(r.error)}</div>` : ''}
        ${r.notice ? `<div class="pr-audit-notice">${escape(r.notice)}</div>` : ''}
        <div class="pr-audit-recheck-deliveries">${r.deliveries.map((d) => `<div class="pr-audit-actions"><span>PR #${d.prNumber} · 修复 ${escape(d.repairCommit?.slice(0, 12))} · ${d.findingCount} 项</span>${button('start', d.resultId, '复审本次修复', d.available && !active)}${!d.available ? '<span>原报告或修复来源不可用</span>' : ''}</div>`).join('') || '<div class="work-card-meta">暂无已确认更新的 AI 审查修复。</div>'}</div>
        <div class="pr-audit-recheck-history">${r.rows.map((h) => button('select', h.recheckRef, `PR #${h.prNumber} · ${statuses[h.status] || '未知'} · ${h.createdAt}${h.recheckRef === r.selected ? ' · 当前查看' : ''}`)).join('')}</div>
        <div data-recheck-detail>${detail}</div>${r.snippet ? `<pre class="pr-audit-recheck-snippet">${escape(r.snippet)}</pre>` : ''}</section>`;
      el.querySelectorAll('[data-recheck-action]').forEach((n) => n.addEventListener('click', () => {
        if (current(r)) return operate(n.dataset.recheckAction, n.dataset.recheckKey, r);
      }));
      el.querySelectorAll('[data-recheck-repair-id]').forEach((n) => n.addEventListener('change', () => selectRepair(n.dataset.recheckRepairId, n.checked, r)));
      el.querySelectorAll('[data-recheck-repair-field]').forEach((n) => n.addEventListener(n.dataset.recheckRepairField === 'note' ? 'input' : 'change', () => editRepair(n.dataset.recheckRepairField, n.value, r)));
      el.querySelectorAll('[data-recheck-open]').forEach((n) => { if (open.has(n.dataset.recheckOpen)) n.open = true; });
      el.scrollTop = scroll;
      const findingList = el.querySelector('.pr-audit-recheck-findings'); if (findingList) findingList.scrollTop = findingScroll;
      if (focused) {
        const node = el.querySelector(`[data-recheck-key="${focused.replace(/["\\]/g, '')}"]`); node?.focus();
        if (selection && Number.isInteger(selection[0])) node?.setSelectionRange?.(...selection);
      }
    }
    async function select(ref, r = view?.record) {
      if (!r || !current(r) || !REF.test(ref)) return false;
      const seq = ++r.seq; if (r.selected !== ref) { r.detail = null; r.snippet = ''; }
      if (r.detail?.status === 'completed') r.detail.freshness = 'unknown';
      r.selected = ref; r.loading = true; render(r);
      const out = await call('getPrAuditRecheck', { projectBindingId: r.token, recheckRef: ref });
      if (!current(r) || r.seq !== seq) return false; r.loading = false;
      if (!out?.ok || out.recheck?.recheckRef !== ref || out.recheck.projectKey !== r.projectKey || (r.prNumber && out.recheck.prNumber !== r.prNumber)) r.error = reason(out?.code);
      else {
        if (r.repairRevision !== out.repairRevision && draft(r)) draft(r).preview = '';
        r.detail = out.recheck; r.repairRevision = out.repairRevision; r.originals = out.originalFindings || [];
        r.sourceAvailable = out.sourceAvailable; r.persistence = out.persistence; r.error = '';
      }
      render(r); return !!out?.ok;
    }
    async function refresh(r = view?.record) {
      if (!r || !current(r) || r.busy) return false;
      if (r.detail?.status === 'completed') r.detail.freshness = 'unknown';
      const seq = ++r.seq; r.loading = true; render(r);
      const [out, profiles] = await Promise.all([
        call('listPrAuditRechecks', { projectBindingId: r.token, ...(r.prNumber ? { prNumber: r.prNumber } : {}) }),
        typeof api.listVerificationProfiles === 'function' ? call('listVerificationProfiles', { projectBindingId: r.token }) : null,
      ]);
      if (!current(r) || r.seq !== seq) return false; r.loading = false;
      if (!out?.ok || !/^[a-f0-9]{32}$/.test(out.projectKey) || !Array.isArray(out.deliveries) || out.deliveries.length > 200
        || out.deliveries.some((d) => !/^wt_[A-Za-z0-9]{6,80}$/.test(d.resultId) || (r.prNumber && d.prNumber !== r.prNumber))
        || !Array.isArray(out.rechecks) || out.rechecks.length > 50 || out.rechecks.some((v) => !REF.test(v.recheckRef) || (r.prNumber && v.prNumber !== r.prNumber))) {
        r.error = reason(out?.code); render(r); return false;
      }
      r.rows = out.rechecks; r.deliveries = out.deliveries || []; r.projectKey = out.projectKey; r.persistence = out.persistence;
      r.profiles = (profiles?.profiles || []).filter((p) => p?.enabled !== false && /^vfy_[a-f0-9]{8,64}$/.test(p?.id || '')).slice(0, 100);
      r.error = out.deliveriesUnavailable ? '交付记录暂时无法读取，已保存的复审历史仍可查看。' : '';
      const chosen = r.rows.find((h) => h.recheckRef === r.selected) || r.rows.find((h) => h.status === 'completed') || r.rows[0];
      if (chosen) return select(chosen.recheckRef, r);
      r.detail = null; render(r); return true;
    }
    async function operate(action, key, r = view?.record) {
      if (!r || !current(r) || r.busy) return false;
      if (action === 'refresh') return refresh(r);
      if (action === 'select') return select(key, r);
      if (action === 'parent') return select(key, r);
      if (action === 'previewRepair' || action === 'repair') return repair(action, r);
      if (action === 'repairProgress') return options.openRepair?.({ projectId: r.projectId, repairRef: key });
      if (action === 'original' || action === 'audit') return options.openSource?.(r.projectId, key, { reaudit: action === 'audit' });
      if (action === 'start' && !r.deliveries.some((d) => d.resultId === key && d.available)) { r.error = '该修复来源暂不可用，请刷新交付记录。'; render(r); return false; }
      const method = { start: 'startPrAuditRecheck', cancel: 'cancelPrAuditRecheck', context: 'getPrAuditRecheckContext' }[action];
      if (!method) return false;
      const seq = ++r.seq; r.busy = action; r.error = ''; render(r);
      const out = await call(method, { projectBindingId: r.token, ...(action === 'start' ? { resultId: key }
        : action === 'cancel' ? { recheckRef: key } : { recheckRef: r.selected, evidenceId: key }) });
      r.busy = '';
      if (!current(r) || r.seq !== seq) return false;
      if (!out?.ok) { r.error = reason(out?.code); render(r); return false; }
      if (action === 'context') { const s = out.snippet; r.snippet = `${s.sha}\n${s.path}\n${s.absent ? '已核实：此提交中不存在该路径。路径缺失本身不能证明原问题解决。' : s.content}`; render(r); return true; }
      if (action === 'start') { r.selected = out.recheckRef; r.snippet = ''; }
      return refresh(r);
    }
    async function mount(element, { projectId, prNumber } = {}) {
      const project = getProject(projectId); const token = getToken(projectId);
      if (!element || !project?.path || !token) { unmount(); return false; }
      const key = `${projectId}:${prNumber || 'all'}`; let r = records.get(key);
      if (!r || r.token !== token || r.path !== project.path) {
        r = { projectId, path: project.path, token, prNumber, seq: 0, rows: [], deliveries: [], originals: [], profiles: [], drafts: new Map(), busy: '', selected: '', error: '' };
        records.set(key, r);
        while (records.size > 50) records.delete(records.keys().next().value);
      }
      if (view?.record !== r || view.element !== element) unmount();
      view = { element, record: r }; render(r); return refresh(r);
    }
    function onEvent(e) {
      const r = view?.record;
      if (!r || !current(r) || e.projectKey !== r.projectKey || (r.prNumber && e.prNumber !== r.prNumber)) return;
      clearTimeout(r.timer); r.timer = setTimeout(() => refresh(r), 75);
    }
    const off = api.onPrAuditRecheckEvent?.(onEvent);
    return { mount, refresh, select, operate, start: (id) => operate('start', id), unmount, forgetProject,
      selectRepair, editRepair, previewRepair: () => repair('previewRepair'), repair: () => repair('repair'),
      close: () => { unmount(); closed = true; off?.(); records.clear(); }, onEvent };
  }
  return { create, labels, reason };
}));
