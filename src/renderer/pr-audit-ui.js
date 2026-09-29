'use strict';

(function expose(factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else Object.defineProperty(window, 'PrAuditUi', { value: Object.freeze(factory()) });
}(function createModule() {
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const REF = /^pra_[a-f0-9]{24}$/; const FINDING = /^paf_[a-f0-9]{24}$/;
  const ACTIVE = new Set(['preparing', 'running']);
  const statuses = { preparing: '准备提交快照', running: '审查中', completed: '审查完成', failed: '未完成', cancelled: '已取消', interrupted: '已中断' };
  const published = { publishing: '正在发布', published: '已发布', uncertain: '发布结果待核对', failed: '发布未完成' };
  const reasons = {
    INVALID: '参数或文字长度无效，请检查后重新预览。', BINDING: '项目绑定已变化，请重新打开 PR。',
    UNAVAILABLE: '暂时无法完成请求，请检查模型配置和 gh 登录状态。', UNSUPPORTED: '此 GitHub 服务未提供所需接口。',
    NOT_FOUND: '报告或代码位置已不可用，请刷新历史。', NOT_OPEN: '仅支持仍然打开的 PR（包括 Draft）。',
    FORK: '当前仅支持 origin 同仓库的 PR。', CHANGED: 'PR 的提交、描述或仓库已变化，请重新审查。',
    INCOMPLETE: '无法取得完整的文本改动和提交历史，本次审查未完成。', LIMIT: '任务、文件或内容达到上限，本次操作未完成。',
    CONTEXT_LIMIT: '代码或模型上下文超过预算，本次审查未完成。', LOCATION: '固定提交中的代码位置不可用，未读取当前工作区。',
    MODEL_REQUIRED: '请先在设置中启用 Agent 并配置 API 模型和密钥。', REPORT_INVALID: '模型未返回有效且可定位的报告，本次审查未完成。',
    TURNS: '已达到 8 轮审查上限，尚未生成完整报告。', TIMEOUT: '已达到 5 分钟审查时限。', CANCELLED: '审查已停止。',
    BUSY: '已有任务或发布操作进行中，请稍后再试。', CONFIRM_REQUIRED: '发布未获确认，可以重新预览后再发布。',
    PUBLISHED: '此报告已经发布。', UNCERTAIN: '发布可能已生效，请只读核对结果；此报告不会重发。',
    PUBLISH_FAILED: '发布未完成，请刷新状态后重新预览。', STORE_CORRUPT: '加密历史无法读取，原文件已保留；当前报告仅保留在内存。',
    STORE_MEMORY: '历史写入不可用；当前报告仅保留在本次运行中。',
  };
  const reason = (code) => reasons[String(code || '').replace(/^PR_AUDIT_/, '')] || '操作未完成，请刷新查看状态。';
  const status = (row) => [statuses[row.status] || '未知状态', published[row.publicationStatus || row.publication?.status], row.stale ? '来源已变化' : ''].filter(Boolean).join(' · ');
  const location = (f) => `${f.path} · ${f.side === 'LEFT' ? '左侧' : '右侧'} ${f.startLine === f.line ? f.line : `${f.startLine}–${f.line}`} 行`;

  function create(options) {
    const { api, document: doc, getProject, getToken } = options;
    const records = new Map(); let mount = null; let center = null; let closed = false;
    function current(record) {
      return !closed && record && records.get(record.key) === record && getProject(record.projectId)?.path === record.path && getToken(record.projectId) === record.token;
    }
    function active(record) {
      return current(record) && mount?.record === record && mount.element?.isConnected !== false
        && options.isVisible?.('prs', record.projectId, record.prNumber) !== false;
    }
    function centerCurrent(value = center) {
      return !closed && value && center === value && value.element?.isConnected !== false
        && getProject(value.projectId)?.path === value.path && getToken(value.projectId) === value.token
        && options.isVisible?.('scheduled', value.projectId) !== false;
    }
    function draft(record) {
      const audit = record.audit;
      if (!audit?.report) return null;
      if (!record.drafts.has(audit.auditRef)) record.drafts.set(audit.auditRef, { summary: audit.report.summary,
        findings: new Map(audit.report.findings.map((f) => [f.findingId, { title: f.title, body: f.body, selected: false }])) });
      return record.drafts.get(audit.auditRef);
    }
    function capture() {
      if (!mount) return;
      const { record, element, renderedRef } = mount;
      const focus = element.querySelector('[data-audit-field="note"]'); if (focus) record.note = focus.value;
      const saved = record.drafts.get(renderedRef); if (!saved) return;
      const summary = element.querySelector('[data-audit-field="summary"]'); if (summary) saved.summary = summary.value;
      for (const [id, value] of saved.findings) {
        const title = element.querySelector(`[data-audit-title="${id}"]`); const body = element.querySelector(`[data-audit-body="${id}"]`);
        const check = element.querySelector(`[data-audit-check="${id}"]`);
        if (title) value.title = title.value; if (body) value.body = body.value; if (check) value.selected = check.checked;
      }
    }
    function invalidate(record) {
      if (!record) return;
      record.epoch++; record.listSeq++; record.detailSeq++; record.contextSeq++; record.loading = false; record.reading = false;
      clearTimeout(record.timer); record.timer = null;
    }
    function unmount() { capture(); invalidate(mount?.record); mount = null; }
    function forgetProject(id) {
      if (mount?.record.projectId === id) unmount();
      if (center?.projectId === id) { clearTimeout(center.timer); center = null; }
      for (const [key, record] of records) if (record.projectId === id) { invalidate(record); records.delete(key); }
    }
    async function invoke(method, payload) {
      try { return await api[method](payload); }
      catch { return { ok: false, code: method === 'publishPrAudit' ? 'PR_AUDIT_UNCERTAIN' : 'PR_AUDIT_UNAVAILABLE' }; }
    }
    function validList(result) {
      return result?.ok && /^[a-f0-9]{32}$/.test(result.projectKey) && Array.isArray(result.audits) && result.audits.length <= 50
        && result.audits.every((row) => REF.test(row.auditRef) && Number.isSafeInteger(row.prNumber));
    }
    async function select(ref, record = mount?.record) {
      if (!active(record) || record.busy || !REF.test(ref)) return false;
      capture(); record.selected = ref; record.audit = null; record.preview = null; record.snippet = null;
      record.reading = true; record.contextSeq++; const seq = ++record.detailSeq; const epoch = record.epoch; render();
      const result = await invoke('getPrAudit', { projectBindingId: record.token, auditRef: ref });
      if (!active(record) || seq !== record.detailSeq || epoch !== record.epoch) return false;
      record.reading = false;
      const audit = result?.audit;
      if (!result?.ok || audit?.auditRef !== ref || audit.prNumber !== record.prNumber || !/^[a-f0-9]{64}$/.test(audit.revision)
        || (audit.report && (!Array.isArray(audit.report.findings) || audit.report.findings.length > 30 || audit.report.findings.some((f) => !FINDING.test(f.findingId))))) {
        record.error = reason(result?.code); render(); return false;
      }
      record.audit = audit; record.persistence = result.persistence; draft(record); render(); return true;
    }
    async function refresh(record = mount?.record) {
      if (!active(record) || record.busy) return false;
      capture(); const seq = ++record.listSeq; const epoch = record.epoch;
      record.loading = true; render();
      const result = await invoke('listPrAudits', { projectBindingId: record.token, prNumber: record.prNumber });
      if (!active(record) || seq !== record.listSeq || epoch !== record.epoch) return false;
      record.loading = false;
      if (!validList(result) || result.audits.some((row) => row.prNumber !== record.prNumber)) { record.error = reason(result?.code); render(); return false; }
      record.history = result.audits; record.projectKey = result.projectKey; record.persistence = result.persistence;
      const ref = record.history.some((r) => r.auditRef === record.selected) ? record.selected : record.history[0]?.auditRef;
      if (ref) await select(ref, record); else { record.audit = null; record.selected = ''; render(); }
      return true;
    }
    function eligible(record) {
      const audit = record.audit;
      return audit?.status === 'completed' && audit.report && !audit.stale && record.state === 'OPEN'
        && (!record.headSha || record.headSha === audit.source?.headSha)
        && !['publishing', 'published', 'uncertain'].includes(audit.publication?.status) && !record.uncertain.has(audit.auditRef);
    }
    async function context(findingId, record = mount?.record) {
      if (!active(record) || record.busy || !record.audit?.report?.findings.some((f) => f.findingId === findingId)) return false;
      capture(); const seq = ++record.contextSeq; const ref = record.selected; const epoch = record.epoch;
      const result = await invoke('getPrAuditContext', { projectBindingId: record.token, auditRef: ref, findingId });
      if (!active(record) || seq !== record.contextSeq || ref !== record.selected || epoch !== record.epoch) return false;
      if (result?.ok && typeof result.snippet?.content === 'string') record.snippet = { findingId, ...result.snippet };
      else record.error = reason(result?.code);
      render(); return !!result?.ok;
    }
    async function operate(action, record = mount?.record) {
      if (!active(record) || record.busy || record.loading || record.reading) return false;
      capture(); const audit = record.audit; const saved = draft(record); let method; let payload;
      if (action === 'start') {
        if (record.state !== 'OPEN' || record.history.some((r) => ACTIVE.has(r.status)) || record.note.length > 2000) return false;
        method = 'startPrAudit'; payload = { prNumber: record.prNumber, note: record.note };
      } else if (action === 'cancel' && ACTIVE.has(audit?.status)) { method = 'cancelPrAudit'; payload = { auditRef: audit.auditRef }; }
      else if (action === 'prepare' && eligible(record) && saved?.summary.trim()) {
        method = 'preparePrAudit'; payload = { auditRef: audit.auditRef, revision: audit.revision, summary: saved.summary,
          selections: [...saved.findings].filter(([, f]) => f.selected).map(([findingId, f]) => ({ findingId, title: f.title, body: f.body })) };
      } else if (action === 'publish' && eligible(record) && record.preview) {
        method = 'publishPrAudit'; payload = { draftRef: record.preview.draftRef }; record.preview = null;
      } else if (action === 'reconcile' && (audit?.publication?.status === 'uncertain' || record.uncertain.has(audit?.auditRef))) {
        method = 'reconcilePrAudit'; payload = { auditRef: audit.auditRef };
      } else return false;
      const epoch = record.epoch; record.busy = action; record.error = ''; record.notice = ''; render();
      const result = await invoke(method, { projectBindingId: record.token, ...payload });
      record.busy = '';
      if (!active(record) || epoch !== record.epoch) return false;
      if (!result?.ok) {
        record.error = reason(result?.code);
        if (action === 'publish' && result?.code === 'PR_AUDIT_UNCERTAIN') record.uncertain.add(audit.auditRef);
      } else if (action === 'prepare' && /^pad_[a-f0-9]{24}$/.test(result.draftRef)) record.preview = result;
      else if (action === 'start') { record.selected = result.auditRef; record.notice = '审查已在后台开始，可以切换页面。'; }
      else if (result.published) { record.uncertain.delete(audit.auditRef); record.notice = 'COMMENT Review 已发布，可在下方审查线程中继续处理。'; options.onPublished?.({ projectId: record.projectId, prNumber: record.prNumber }); }
      if (action !== 'prepare') await refresh(record);
      if (centerCurrent()) void refreshCenter();
      render(); return !!result?.ok;
    }
    function memoryNotice(value) {
      return value && value.persistence !== 'encrypted' ? `<div class="pr-audit-notice">${escape(reason(value.error || 'PR_AUDIT_STORE_MEMORY'))}</div>` : '';
    }
    function render() {
      const record = mount?.record; if (!active(record)) return;
      capture(); const element = mount.element; const audit = record.audit; const saved = draft(record);
      const disabled = !!(record.busy || record.loading || record.reading);
      const scroll = element.querySelector('[data-audit-findings]')?.scrollTop || 0;
      const focused = element.contains?.(doc?.activeElement) ? doc.activeElement : null;
      const focusAttr = focused && ['data-audit-field', 'data-audit-title', 'data-audit-body'].find((key) => focused.hasAttribute?.(key) || focused.attributes?.[key] !== undefined);
      const focusId = focusAttr ? focused.getAttribute?.(focusAttr) ?? focused.attributes[focusAttr] : null;
      const start = focused?.selectionStart; const end = focused?.selectionEnd;
      const button = (action, label, enabled = true, primary = false) => `<button type="button" class="${primary ? 'btn-secondary' : 'ghost-btn'}" data-audit-action="${action}" ${disabled || !enabled ? 'disabled' : ''}>${label}</button>`;
      const history = record.history.map((r) => `<button type="button" class="pr-audit-history-row${r.auditRef === record.selected ? ' is-selected' : ''}" data-audit-select="${r.auditRef}" ${disabled ? 'disabled' : ''}><strong>${escape(status(r))}</strong><span>${escape(r.createdAt)} · ${(r.headSha || '').slice(0, 8)} · ${Number(r.findingCount) || 0} 项发现</span></button>`).join('');
      let report = '';
      if (audit) {
        const source = audit.source; const coverage = audit.coverage;
        report = `<div class="pr-audit-status" role="status">${escape(status(audit))}${audit.turns ? ` · 第 ${Number(audit.turns)} 轮` : ''}</div>
          ${source ? `<div class="pr-audit-source">${escape(source.baseRefName)} → ${escape(source.headRefName)}<br>审查提交 <code>${escape(source.headSha)}</code><br>比较起点 <code>${escape(source.mergeBaseSha)}</code></div>` : ''}
          ${coverage ? `<div class="pr-audit-coverage">已审查 ${coverage.reviewed}/${coverage.total} 个变更文件 · 范围外 ${coverage.outside} 个 · 跳过 ${coverage.skipped.length} 个${coverage.skipped.length ? `<details><summary>查看跳过原因</summary>${coverage.skipped.map((f) => `<div>${escape(f.path)}：${escape(f.reason)}</div>`).join('')}</details>` : ''}</div>` : ''}
          ${audit.errorCode ? `<div class="pr-audit-error">${escape(reason(audit.errorCode))}</div>` : ''}
          ${ACTIVE.has(audit.status) ? button('cancel', '取消审查') : ''}`;
        if (saved) {
          const locked = disabled || !eligible(record);
          const findings = audit.report.findings.map((f) => {
            const edit = saved.findings.get(f.findingId); const snippet = record.snippet?.findingId === f.findingId ? record.snippet : null;
            return `<article class="pr-audit-finding"><div class="pr-audit-actions"><label><input type="checkbox" data-audit-check="${f.findingId}" ${edit.selected ? 'checked' : ''} ${locked ? 'disabled' : ''}> 发布此项</label><strong class="pr-audit-priority">${escape(f.priority)}</strong></div>
              <label class="pr-audit-field">标题<input type="text" maxlength="200" data-audit-title="${f.findingId}" value="${escape(edit.title)}" ${locked ? 'disabled' : ''}></label>
              <button type="button" class="pr-audit-location" data-audit-context="${f.findingId}" ${disabled ? 'disabled' : ''}>${escape(location(f))} · 查看代码</button>
              ${snippet ? `<div class="pr-audit-source">固定提交 ${escape(snippet.sha?.slice(0, 8))}</div><pre class="pr-audit-code">${escape(snippet.content)}</pre>` : ''}
              <label class="pr-audit-field">问题、触发条件与影响<textarea rows="4" maxlength="5000" data-audit-body="${f.findingId}" ${locked ? 'disabled' : ''}>${escape(edit.body)}</textarea></label></article>`;
          }).join('');
          report += `<label class="pr-audit-field">审查汇总<textarea rows="4" maxlength="5000" data-audit-field="summary" ${locked ? 'disabled' : ''}>${escape(saved.summary)}</textarea></label>
            <div class="pr-audit-findings" data-audit-findings>${findings || '<div class="pr-audit-notice">本次审查未发现可确认的问题。</div>'}</div>
            <div class="muted">按固定提交静态阅读，未运行测试。发布项默认不勾选，也可仅发布汇总。</div>
            ${audit.stale || (record.headSha && source?.headSha !== record.headSha) ? '<div class="pr-audit-notice">PR 已有变化，请重新审查后发布。</div>' : ''}
            ${['uncertain', 'publishing'].includes(audit.publication?.status) || record.uncertain.has(audit.auditRef) ? `<div class="pr-audit-notice">发布结果尚未确认，此报告不会重发。</div>${button('reconcile', '只读核对发布结果', audit.publication?.status !== 'publishing')}` : ''}
            ${eligible(record) ? `<div class="pr-audit-actions">${button('prepare', '预览发布内容', !!saved.summary.trim(), true)}</div>` : ''}
            ${audit.publication?.status === 'published' ? `<div class="pr-audit-notice">已发布 COMMENT Review #${Number(audit.publication.reviewId)}。后续回复与修复请使用下方审查线程。</div>` : ''}
            <div data-audit-preview>${record.preview ? `<div class="pr-audit-preview"><strong>发布预览 · ${Number(record.preview.commentCount)} 条行内意见</strong><pre>${escape(record.preview.preview)}</pre>${button('publish', '确认并发布 COMMENT Review', true, true)}</div>` : ''}</div>`;
        }
      }
      element.innerHTML = `<section class="pr-detail-section pr-audit-panel" aria-label="AI 代码审查"><div class="pr-audit-actions"><h2>AI 代码审查</h2>${button('refresh', record.loading ? '读取中…' : '刷新历史')}</div>
        <p class="muted">分析本次改动和相关代码；审阅意见由你选择并确认发布。</p>
        <label class="pr-audit-field">关注点（可选）<textarea rows="2" maxlength="2000" data-audit-field="note" placeholder="例如：空输入处理、兼容性或权限检查" ${disabled ? 'disabled' : ''}>${escape(record.note)}</textarea></label>
        <div class="pr-audit-actions">${button('start', record.busy === 'start' ? '正在开始…' : '开始 AI 审查', record.state === 'OPEN' && !record.history.some((r) => ACTIVE.has(r.status)), true)}</div>
        ${record.state !== 'OPEN' ? '<div class="pr-audit-notice">仅支持仍然打开的 PR（包括 Draft）。历史报告仍可查看。</div>' : ''}
        ${memoryNotice(record.persistence)}${record.error ? `<div class="pr-audit-error" role="alert">${escape(record.error)}</div>` : ''}${record.notice ? `<div class="pr-audit-notice" role="status">${escape(record.notice)}</div>` : ''}
        <div class="pr-audit-history">${history || '<div class="muted">暂无审查历史</div>'}</div>${record.reading ? '<div class="muted">正在读取报告…</div>' : report}</section>`;
      mount.renderedRef = audit?.auditRef;
      element.querySelectorAll('[data-audit-action]').forEach((node) => node.addEventListener('click', () => node.dataset.auditAction === 'refresh' ? refresh() : operate(node.dataset.auditAction)));
      element.querySelectorAll('[data-audit-select]').forEach((node) => node.addEventListener('click', () => select(node.dataset.auditSelect)));
      element.querySelectorAll('[data-audit-context]').forEach((node) => node.addEventListener('click', () => context(node.dataset.auditContext)));
      const edited = () => {
        capture(); record.preview = null;
        const preview = element.querySelector('[data-audit-preview]'); if (preview) preview.innerHTML = '';
        const prepare = element.querySelector('[data-audit-action="prepare"]'); if (prepare) prepare.disabled = !eligible(record) || !draft(record)?.summary.trim();
      };
      for (const selector of ['[data-audit-field]', '[data-audit-title]', '[data-audit-body]', '[data-audit-check]']) {
        element.querySelectorAll(selector).forEach((node) => node.addEventListener(selector === '[data-audit-check]' ? 'change' : 'input', edited));
      }
      const list = element.querySelector('[data-audit-findings]'); if (list) list.scrollTop = scroll;
      if (focusAttr) { const input = element.querySelector(`[${focusAttr}="${focusId}"]`); input?.focus(); if (typeof start === 'number') input?.setSelectionRange?.(start, end); }
    }
    async function refreshCenter(value = center) {
      if (!centerCurrent(value)) return false;
      const seq = ++value.seq;
      const result = await invoke('listPrAudits', { projectBindingId: value.token });
      if (!centerCurrent(value) || value.seq !== seq) return false;
      if (validList(result)) { value.rows = result.audits; value.projectKey = result.projectKey; value.persistence = result.persistence; value.error = ''; }
      else value.error = reason(result?.code);
      renderCenter(); return !!result?.ok;
    }
    function renderCenter() {
      if (!centerCurrent()) return;
      const value = center;
      value.element.innerHTML = `<div class="pr-audit-center"><div class="work-card-meta">从 PR 详情手动开始审查；切换页面后继续运行。每项目保留最近 50 条报告。</div>
        <button type="button" class="ghost-btn" data-audit-center-refresh>刷新审查历史</button>${memoryNotice(value.persistence)}
        ${value.error ? `<div class="pr-audit-error">${escape(value.error)}</div>` : ''}
        <div class="pr-audit-center-list">${value.rows.map((r) => `<button type="button" class="pr-audit-history-row" data-audit-open="${r.auditRef}"><strong>PR #${r.prNumber} · ${escape(status(r))}</strong><span>${escape(r.createdAt)} · ${Number(r.findingCount) || 0} 项发现 · 查看报告</span></button>`).join('') || '<div class="work-empty">本项目暂无 AI 审查报告</div>'}</div></div>`;
      value.element.querySelector('[data-audit-center-refresh]')?.addEventListener('click', () => refreshCenter(value));
      value.element.querySelectorAll('[data-audit-open]').forEach((node) => node.addEventListener('click', () => {
        const row = value.rows.find((r) => r.auditRef === node.dataset.auditOpen);
        if (row && centerCurrent(value)) return options.navigateToPr?.({ projectId: value.projectId, prNumber: row.prNumber, auditRef: row.auditRef });
      }));
    }
    function onEvent(event) {
      if (closed || !REF.test(event?.auditRef)) return;
      const record = mount?.record;
      if (active(record) && event.projectKey === record.projectKey && event.prNumber === record.prNumber) {
        clearTimeout(record.timer); record.timer = setTimeout(() => { record.timer = null; void refresh(record); }, 75);
      }
      if (centerCurrent() && event.projectKey === center.projectKey) {
        const value = center; clearTimeout(value.timer); value.timer = setTimeout(() => { value.timer = null; void refreshCenter(value); }, 75);
      }
    }
    function mountPr(element, data = {}) {
      capture(); const project = getProject(data.projectId); const token = getToken(data.projectId);
      if (!element || !project?.path || !token || !Number.isSafeInteger(data.prNumber)) { unmount(); return Promise.resolve(false); }
      for (const r of records.values()) if (r.projectId === project.id && !current(r)) { forgetProject(project.id); break; }
      const key = `${project.id}:${data.prNumber}`; let record = records.get(key);
      if (!record) {
        record = { key, projectId: project.id, path: project.path, token, prNumber: data.prNumber, history: [], drafts: new Map(),
          selected: '', audit: null, note: '', epoch: 0, listSeq: 0, detailSeq: 0, contextSeq: 0, busy: '', error: '', notice: '', uncertain: new Set() };
        records.set(key, record);
        while (records.size > 50) { const old = [...records.values()].find((r) => r !== record && !r.busy); if (!old) break; invalidate(old); records.delete(old.key); }
      }
      const changed = mount?.record !== record || !mount?.element?.isConnected;
      if (mount?.record !== record) invalidate(mount?.record);
      Object.assign(record, { state: data.state, headSha: data.headSha }); mount = { element, record }; render();
      return changed || !record.projectKey ? refresh(record) : Promise.resolve(true);
    }
    function mountCenter(element, projectId) {
      const project = getProject(projectId); const token = getToken(projectId); if (center) clearTimeout(center.timer);
      center = element && project?.path && token ? { element, projectId, path: project.path, token, rows: [], seq: 0 } : null;
      renderCenter(); return refreshCenter();
    }
    const offEvent = api.onPrAuditEvent?.(onEvent);
    function close() { unmount(); if (center) clearTimeout(center.timer); closed = true; offEvent?.(); records.clear(); center = null; }
    return { mountPr, mountCenter, capture, unmount, forgetProject, refresh, select, operate, context, onEvent, close };
  }
  return { create, reason, status };
}));
