'use strict';
(function expose(factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else Object.defineProperty(window, 'PrAuditTrackingUi', { value: Object.freeze(factory()) });
}(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ref = /^pra_[a-f0-9]{24}$/;
  const verdicts = { resolved: 'AI 判断已解决', still_present: 'AI 判断仍存在', unknown: '无法判断' };
  const freshness = { current: '与当前 PR 一致', stale: '已过期 · 待复审', unknown: '当前性未核实' };
  const statuses = { queued: '排队中', preparing: '准备中', generating: '生成中', collecting: '收集中', ready: '已生成',
    no_changes: '无改动', failed: '失败', cancelled: '已取消', interrupted: '已中断', completed: '已完成', running: '运行中',
    not_run: '未复验', passed: '通过', timed_out: '超时', stale: '已过期', error: '异常', unavailable: '不可用',
    pr_updated: 'PR 已更新', pr_update_cleanup_pending: 'PR 已更新，待清理', pr_update_uncertain: '更新待核对',
    pr_update_preparing: '准备更新 PR', pr_update_pushing: '推送中', pr_update_failed: '更新 PR 失败',
    creating: '创建隔离目录', collect_failed: '收集失败', oversize: '改动超出限制', conflict: '存在冲突',
    applying: '应用中', apply_uncertain: '应用待核对', applied_cleanup_pending: '已应用，待清理',
    discarded_cleanup_pending: '已丢弃，待清理', pr_preparing: '准备 PR', pr_committing: '提交中', pr_pushing: '推送中',
    pr_creating: '创建 PR', pr_failed: '创建 PR 失败', pr_cleanup_pending: 'PR 已创建，待清理', pr_created: 'PR 已创建' };
  const label = (s) => statuses[s] || s || '未知';
  const button = (action, id, text, enabled = true) => `<button type="button" class="ghost-btn" data-tracking-action="${action}" data-tracking-id="${esc(id)}" ${enabled ? '' : 'disabled'}>${esc(text)}</button>`;
  function create(options) {
    const { api, getProject, getToken, document: doc } = options;
    const records = new Map(); let view; let closed = false;
    const current = (r) => !closed && view?.record === r && view.element?.isConnected !== false
      && getProject(r.projectId)?.path === r.path && getToken(r.projectId) === r.token && options.isVisible?.(r.projectId, r.prNumber) !== false;
    const call = async (method, payload) => { try { return await api[method](payload); } catch { return { ok: false }; } };
    function unverified(r) {
      if (!r.detail) return;
      for (const f of r.detail.findings) if (f.latest) f.latest.freshness = 'unknown';
      for (const c of r.detail.rechecks) c.freshness = 'unknown';
      r.detail.checkedAt = null;
    }
    function render(r) {
      if (!current(r)) return;
      const el = view.element; const scroll = el.scrollTop;
      for (const node of el.querySelectorAll('[data-tracking-open]')) r.open.set(node.dataset.trackingOpen, node.open);
      const active = doc?.activeElement;
      const focused = active && el.contains?.(active) ? [active.dataset.trackingAction, active.dataset.trackingId] : null;
      const d = r.detail;
      const check = (c) => `<div class="tracking-check"><span>${esc(label(c.status))} · ${esc(c.createdAt)} · 提交 <code>${esc(c.headSha || '尚未捕获')}</code> · ${esc(freshness[c.freshness])}</span>${button('recheck', c.recheckRef, '查看复审')}${c.findings.map((f) => `<p>${esc(d.findings.find((v) => v.findingId === f.findingId)?.title || '原问题缺失')}：${esc(verdicts[f.status])} · ${esc(f.reason)}</p>`).join('')}</div>`;
      const round = (v) => `<details data-tracking-open="round-${esc(v.id)}"><summary>第 ${v.number} 轮 · ${esc(label(v.status))} · ${esc(label(v.deliveryStatus))}</summary>
        <p>${esc(v.createdAt)}${v.parentRoundId ? ` · 续自第 ${d.rounds.find((x) => x.id === v.parentRoundId)?.number} 轮` : ''} · 复验：${esc(label(v.validationStatus))}</p>
        <p>基线 <code>${esc(v.baseHead || '不可用')}</code> → 修复 <code>${esc(v.repairCommit || '尚未确认交付')}</code></p>
        ${v.issues.map((s) => `<p class="pr-audit-notice">${esc(s)}</p>`).join('')}
        ${button('repair', v.repairRef, '查看修复详情')}${button('result', v.id, '查看结果 / diff', v.resultAvailable)}
        ${v.parentRecheckRef ? button('recheck', v.parentRecheckRef, '查看父复审', !v.issues.includes('父复审缺失或关联冲突')) : ''}
        ${d.rechecks.filter((c) => v.recheckRefs.includes(c.recheckRef)).map(check).join('') || '<p>尚无复审。</p>'}</details>`;
      const counts = d ? d.findings.reduce((c, f) => { if (f.latest?.freshness === 'current') c[f.latest.status]++; else c.pending++; return c; }, { resolved: 0, still_present: 0, unknown: 0, pending: 0 }) : null;
      el.innerHTML = `<section class="pr-audit-tracking"><strong>多轮修复追踪</strong>
        <p class="work-card-meta">按原始报告追踪问题。AI 结论对应特定提交，不能代替测试或合并门禁。</p>
        ${button('refresh', 'refresh', '刷新追踪')}${r.loading ? '<span role="status"> 读取中…</span>' : ''}
        ${r.error ? `<p class="pr-audit-error">${esc(r.error)}</p>` : ''}
        ${Object.values(r.persistence || {}).some((p) => p.persistence === 'memory') ? '<p class="pr-audit-notice">部分历史仅保留在本次运行中。</p>' : ''}
        ${(r.warnings || []).map((s) => `<p class="pr-audit-notice">${esc(s)}</p>`).join('')}
        <div class="tracking-reports">${r.reports.map((a) => button(r.prNumber ? 'select' : 'navigate', a.auditRef,
          `PR #${a.prNumber} · ${a.createdAt} · ${label(a.status)} · ${a.findingCount} 项${r.selected === a.auditRef ? ' · 当前查看' : ''}`)).join('') || '<p>暂无可追踪的审查报告。</p>'}</div>
        ${d ? `<div class="tracking-detail"><p>当前有效：已解决 ${counts.resolved} · 仍存在 ${counts.still_present} · 无法判断 ${counts.unknown} · 待复审 / 未核实 ${counts.pending}</p>
          <p class="work-card-meta">${d.checkedAt ? `核对时间：${esc(d.checkedAt)}` : '当前 PR 状态未核实'}</p>
          ${d.warnings.map((s) => `<p class="pr-audit-notice">历史不完整 / 提示：${esc(s)}</p>`).join('')}
          ${d.findings.map((f) => `<details data-tracking-open="finding-${esc(f.findingId)}"><summary>${esc(f.priority)} · ${esc(f.title)} · ${f.latest ? `${esc(verdicts[f.latest.status])} · ${esc(freshness[f.latest.freshness])}` : '尚未复审'}</summary>
            <p><code>${esc(f.path)}:${f.startLine}–${f.line}</code> · ${esc(f.side)}</p>
            ${f.latest ? `<p>${esc(f.latest.reason)}</p><p>最近复审提交 <code>${esc(f.latest.headSha)}</code></p>${button('recheck', f.latest.recheckRef, '查看最近复审')}` : ''}
            ${button('original', f.findingId, '查看原发现', d.sourceAvailable)}
            ${f.roundIds.map((id) => { const v = d.rounds.find((v) => v.id === id); return button('round', id, `第 ${v.number} 轮 · ${label(v.status)}`); }).join('')}
            ${d.rechecks.filter((c) => d.orphanRecheckRefs.includes(c.recheckRef) && f.recheckRefs.includes(c.recheckRef)).map(check).join('')}</details>`).join('') || '<p>原问题列表为空或不可用。</p>'}
          <details data-tracking-open="history"><summary>完整轮次历史（${d.rounds.length}）</summary>${d.rounds.map(round).join('') || '<p>尚无修复任务。</p>'}</details>
          ${d.orphanRecheckRefs.length ? `<details data-tracking-open="orphans"><summary>修复任务缺失的复审记录</summary>${d.rechecks.filter((c) => d.orphanRecheckRefs.includes(c.recheckRef)).map(check).join('')}</details>` : ''}</div>` : ''}</section>`;
      for (const node of el.querySelectorAll('[data-tracking-open]')) {
        node.open = r.open.get(node.dataset.trackingOpen) || false;
        node.addEventListener('toggle', () => { if (current(r)) r.open.set(node.dataset.trackingOpen, node.open); });
      }
      for (const node of el.querySelectorAll('[data-tracking-action]')) node.addEventListener('click', () => operate(node.dataset.trackingAction, node.dataset.trackingId, r));
      el.scrollTop = scroll;
      if (focused) [...el.querySelectorAll('[data-tracking-action]')].find((n) => n.dataset.trackingAction === focused[0] && n.dataset.trackingId === focused[1])?.focus?.({ preventScroll: true });
    }
    async function select(id, r = view?.record) {
      if (!r || !current(r) || !r.prNumber || !r.reports.some((a) => a.auditRef === id) || !ref.test(id)) return false;
      const seq = ++r.seq;
      if (r.selected !== id) { r.detail = null; r.open.clear(); }
      r.selected = id; unverified(r); r.loading = true; render(r);
      const out = await call('getPrAuditTracking', { projectBindingId: r.token, auditRef: id });
      if (!current(r) || seq !== r.seq) return false;
      r.loading = false;
      if (!out?.ok || out.projectKey !== r.projectKey || out.detail?.auditRef !== id || out.detail.prNumber !== r.prNumber) {
        r.error = '追踪详情暂不可用，已保留可读历史。'; render(r); return false;
      }
      r.detail = out.detail; r.persistence = out.persistence; r.error = ''; render(r); return true;
    }
    async function refresh(r = view?.record) {
      if (!r || !current(r)) return false;
      const seq = ++r.seq; unverified(r); r.loading = true; render(r);
      const out = await call('listPrAuditTracking', { projectBindingId: r.token, ...(r.prNumber ? { prNumber: r.prNumber } : {}) });
      if (!current(r) || r.seq !== seq) return false;
      r.loading = false;
      if (!out?.ok || !/^[a-f0-9]{32}$/.test(out.projectKey) || !Array.isArray(out.reports)
        || out.reports.some((a) => !ref.test(a.auditRef) || (r.prNumber && a.prNumber !== r.prNumber))) {
        r.error = '追踪历史暂不可用，请重试。'; render(r); return false;
      }
      r.reports = out.reports; r.projectKey = out.projectKey; r.persistence = out.persistence; r.warnings = out.warnings; r.error = '';
      const chosen = r.reports.find((a) => a.auditRef === r.selected) || r.reports.find((a) => a.status === 'completed') || r.reports[0];
      if (r.prNumber && chosen) return select(chosen.auditRef, r);
      r.detail = null; render(r); return true;
    }
    async function operate(action, id, r = view?.record) {
      if (!r || !current(r)) return false;
      if (action === 'refresh') return refresh(r);
      if (action === 'select') return select(id, r);
      if (action === 'navigate') { const a = r.reports.find((a) => a.auditRef === id); return a && options.navigateToPr?.({ projectId: r.projectId, ...a }); }
      const d = r.detail; if (!d) return false;
      if (action === 'round') {
        if (!d.rounds.some((v) => v.id === id)) return false;
        for (const node of view.element.querySelectorAll('[data-tracking-open]')) {
          if (['history', `round-${id}`].includes(node.dataset.trackingOpen)) { node.open = true; r.open.set(node.dataset.trackingOpen, true); }
          if (node.dataset.trackingOpen === `round-${id}`) node.scrollIntoView?.({ block: 'nearest' });
        }
        return true;
      }
      if (action === 'original' && d.sourceAvailable && d.findings.some((f) => f.findingId === id))
        return options.openOriginal?.({ projectId: r.projectId, auditRef: d.auditRef, findingId: id });
      if (action === 'recheck' && d.rechecks.some((c) => c.recheckRef === id)) return options.openRecheck?.({ projectId: r.projectId, recheckRef: id });
      const round = d.rounds.find((v) => v.id === id);
      if (action === 'repair' && round) return options.openRepair?.({ projectId: r.projectId, repairRef: round.repairRef });
      if (action === 'result' && round?.resultAvailable) return options.openResult?.({ projectId: r.projectId, resultId: round.resultId });
      return false;
    }
    function unmount() { if (view) { view.record.seq++; clearTimeout(view.record.timer); } view = null; }
    function forgetProject(id) { if (view?.record.projectId === id) unmount(); for (const [key, r] of records) if (r.projectId === id) records.delete(key); }
    async function mount(element, { projectId, prNumber } = {}) {
      const project = getProject(projectId); const token = getToken(projectId);
      if (!element || !project?.path || !token) { unmount(); return false; }
      const key = `${projectId}:${prNumber || 'all'}`; let r = records.get(key);
      if (!r || r.path !== project.path || r.token !== token) {
        r = { projectId, prNumber, path: project.path, token, seq: 0, reports: [], open: new Map(), selected: '', detail: null };
        records.set(key, r); while (records.size > 50) records.delete(records.keys().next().value);
      }
      unmount(); view = { element, record: r }; return refresh(r);
    }
    function onEvent(e) {
      const r = view?.record;
      if (!r || !current(r) || e.projectKey !== r.projectKey || (r.prNumber && e.prNumber && e.prNumber !== r.prNumber)) return;
      r.seq++; unverified(r); render(r); clearTimeout(r.timer); r.timer = setTimeout(() => refresh(r), 100);
    }
    const offs = ['onPrAuditEvent', 'onPrAuditRecheckEvent', 'onEngineeringRepairEvent'].map((method) => api[method]?.(onEvent));
    return { mount, unmount, forgetProject, refresh, select, operate, onEvent,
      close: () => { unmount(); closed = true; offs.forEach((off) => off?.()); records.clear(); } };
  }
  return { create };
}));
