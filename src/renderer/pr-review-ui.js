'use strict';

(function expose(factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else Object.defineProperty(window, 'PrReviewUi', { value: Object.freeze(factory()) });
}(function createModule() {
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const THREAD = /^prt_[a-f0-9]{24}$/;
  const REVISION = /^[a-f0-9]{64}$/;
  const reasons = {
    PR_REVIEW_INVALID: '参数无效，请检查回复长度后重新操作。',
    PR_REVIEW_PROJECT_BINDING_INVALID: '项目绑定已变化，请重新打开 PR。',
    PR_REVIEW_UNAVAILABLE: '暂时无法读取审查，请检查 gh 登录状态后刷新。',
    PR_REVIEW_UNSUPPORTED: '此 GitHub 服务未返回完整的审查接口数据。',
    PR_REVIEW_NOT_FOUND: '线程或修复来源不可用，请刷新审查列表。',
    PR_REVIEW_PR_NOT_OPEN: '仅支持仍然打开的 PR（包括 Draft）。',
    PR_REVIEW_FORK_UNSUPPORTED: '当前仅支持分支位于同一仓库的 PR。',
    PR_REVIEW_CHANGED: '讨论、位置或 PR 提交已变化，请刷新后重新选择。',
    PR_REVIEW_INCOMPLETE: '讨论不完整或超过 50 条，当前仅供查看。',
    PR_REVIEW_LOCATION_UNAVAILABLE: '无法定位到当前项目的现有文件或右侧行，仍可回复或解决线程。',
    PR_REVIEW_NOT_REPAIRABLE: '已解决或过期的线程不能生成修复，仍可按权限处理讨论。',
    PR_REVIEW_CONTEXT_TOO_LARGE: '完整讨论与补充说明超过 32 KiB，无法生成修复。',
    PR_REVIEW_CONFIRM_REQUIRED: '操作未获确认，未发送远程更改。',
    PR_REVIEW_PERMISSION_DENIED: '当前账号无权执行此操作，请刷新查看最新状态。',
    PR_REVIEW_ACTION_FAILED: '操作失败，请刷新确认线程状态。',
    PR_REVIEW_ACTION_UNCERTAIN: '操作可能已生效。请手动刷新核对讨论；不会自动重发，相同回复在本次运行中不会再次发送。',
    PR_REVIEW_BUSY: '此线程已有操作进行中。',
    PR_REVIEW_LIMIT: '修复来源已达上限，请先处理现有隔离结果。',
    PR_REVIEW_STORE_CORRUPT: '审查来源存储已损坏，原文件已保留。',
    PR_REVIEW_STORE_UNAVAILABLE: '审查来源当前仅保留在内存中。',
    REPAIR_ALREADY_RUNNING: '此项目已有修复或验证进行中，请先完成或取消。',
    REPAIR_READ_ONLY: '只读模式不能生成修复。',
    REPAIR_APPROVAL_CANCELLED: '修复已取消。',
    REPAIR_APPROVAL_REQUIRED: '修复需要写入授权。',
    REPAIR_PROJECT_BINDING_INVALID: '项目绑定已变化，请重新打开 PR。',
    REMOTE_CI_VALIDATION_PROFILE_NOT_FOUND: '选定的本地验证档案已不可用，请重新选择。',
    PR_UPDATE_UNCERTAIN: '推送结果尚未确认。可点击「核对更新状态」只读核对远端；不会再次推送。',
    PR_UPDATE_HEAD_CHANGED: 'PR 分支已有变化，请重新选择当前线程生成修复。',
    PR_UPDATE_UNAVAILABLE: '当前隔离结果无法更新此 PR，请检查结果和审查来源。',
    PR_UPDATE_CONFIRM_REQUIRED: '更新 PR 未获确认。',
    PR_UPDATE_TREE_MISMATCH: '隔离提交与审阅结果不一致，已阻止推送。',
    PR_UPDATE_PUSH_FAILED: '推送失败，请检查远端分支权限后再操作。',
    PR_UPDATE_IDENTITY_MISSING: '请先配置本地 Git 的 user.name 和 user.email。',
    PR_UPDATE_CLEANUP_FAILED: 'PR 已更新，本地隔离目录清理未完成，可再次核对状态。',
  };
  const reason = (code) => reasons[code] || '操作未完成，请刷新后查看当前状态。';
  const location = (thread) => `${thread.path || '未知文件'}${thread.subjectType === 'FILE' ? ' · 文件' : thread.line ? `:${thread.line}` : ' · 原位置'}`;

  function create(options) {
    const { api, document: doc, getProject, getToken } = options;
    // These records and drafts never enter session persistence, exports or chat.
    const records = new Map();
    let mount = null;
    let closed = false;
    function current(record) {
      return !closed && record && records.get(record.key) === record
        && getProject(record.projectId)?.path === record.path && getToken(record.projectId) === record.token;
    }
    function active(record) {
      return current(record) && mount?.record === record && mount.element?.isConnected !== false
        && options.isVisible?.(record.projectId, record.prNumber) !== false;
    }
    function draft(record, ref = record.selected) {
      if (!record.drafts.has(ref)) record.drafts.set(ref, { reply: '', note: '', profileId: '' });
      return record.drafts.get(ref);
    }
    function capture() {
      if (!mount?.renderedRef) return;
      const saved = draft(mount.record, mount.renderedRef);
      for (const name of ['reply', 'note', 'profileId']) {
        const input = mount.element.querySelector(`[data-review-field="${name}"]`);
        if (input) saved[name] = input.value;
      }
    }
    function invalidate(record) {
      if (!record) return;
      record.epoch++; record.listSeq++; record.detailSeq++;
      record.loading = false; record.reading = false;
    }
    function unmount() { capture(); if (mount) mount.record.attempted = false; invalidate(mount?.record); mount = null; }
    function forgetProject(id) {
      if (mount?.record.projectId === id) unmount();
      for (const [key, record] of records) if (record.projectId === id) records.delete(key);
    }
    async function invoke(method, payload) {
      try { return await api[method](payload); }
      catch { return { ok: false, code: ['replyPrReview', 'resolvePrReview'].includes(method) ? 'PR_REVIEW_ACTION_UNCERTAIN' : 'PR_REVIEW_UNAVAILABLE' }; }
    }
    function validDetail(value, record, ref) {
      return value?.threadRef === ref && value.prNumber === record.prNumber && REVISION.test(value.revision)
        && Array.isArray(value.comments) && value.comments.length <= 50;
    }
    async function select(ref, record = mount?.record) {
      if (!active(record) || !THREAD.test(ref) || record.busy) return false;
      capture();
      record.selected = ref; record.detail = null; record.reading = true; record.error = '';
      const seq = ++record.detailSeq; const epoch = record.epoch;
      render();
      const result = await invoke('getPrReviewThread', { projectBindingId: record.token, threadRef: ref });
      if (!active(record) || seq !== record.detailSeq || epoch !== record.epoch) return false;
      record.reading = false;
      if (!result?.ok || !validDetail(result.thread, record, ref)) record.error = reason(result?.code);
      else {
        record.detail = result.thread;
        const row = record.threads.find((item) => item.threadRef === ref);
        if (row) Object.assign(row, { isResolved: result.thread.isResolved, isOutdated: result.thread.isOutdated, path: result.thread.path, line: result.thread.line });
      }
      render(); return Boolean(record.detail);
    }
    async function refresh(record = mount?.record) {
      if (!active(record) || record.busy) return false;
      capture();
      const seq = ++record.listSeq; const epoch = record.epoch;
      record.detailSeq++; record.reading = false; record.detail = null;
      record.loading = true; record.attempted = true; record.error = '';
      render();
      const result = await invoke('getPrReviewThreads', { projectBindingId: record.token, prNumber: record.prNumber });
      if (!active(record) || seq !== record.listSeq || epoch !== record.epoch) return false;
      record.loading = false;
      if (!result?.ok || result.prNumber !== record.prNumber || !Array.isArray(result.threads)
        || result.threads.length > 200 || result.threads.some((item) => !THREAD.test(item.threadRef))) {
        record.error = reason(result?.code); render(); return false;
      }
      record.threads = result.threads; record.truncated = result.truncated; record.total = result.total;
      render();
      if (record.selected) await select(record.selected, record);
      return true;
    }
    async function operate(action, record = mount?.record) {
      if (!['repair', 'reply', 'resolve'].includes(action)) return false;
      if (!active(record) || record.busy || record.loading || record.reading || !record.detail) return false;
      capture();
      const detail = record.detail;
      if (!detail.complete || !(action === 'repair' ? detail.canRepair : action === 'reply' ? detail.canReply : detail.canResolve)) return false;
      const saved = { ...draft(record) }; const epoch = record.epoch; const ref = detail.threadRef;
      if (action === 'reply' && (!saved.reply.trim() || saved.reply.length > 5000)) { record.error = reason('PR_REVIEW_INVALID'); render(); return false; }
      if (action === 'repair' && saved.note.length > 2000) { record.error = '补充说明最多 2000 字。'; render(); return false; }
      const sessionId = options.getSessionId?.();
      record.busy = action; record.error = ''; record.notice = ''; render();
      const valid = () => active(record) && record.epoch === epoch && record.selected === ref;
      try {
        let result;
        const base = { projectBindingId: record.token, threadRef: ref, revision: detail.revision };
        if (action === 'repair') {
          const source = await invoke('snapshotPrReview', base);
          if (!valid()) return false;
          if (!source?.ok || !/^prv_[a-f0-9]{24}$/.test(source.reviewRef)) { record.error = reason(source?.code); return false; }
          result = await invoke('startEngineeringRepair', { projectBindingId: record.token,
            source: { kind: 'pr_review', reviewRef: source.reviewRef }, note: saved.note,
            ...(saved.profileId ? { validationProfileId: saved.profileId } : {}), ...(sessionId ? { sessionId } : {}) });
          if (valid() && result?.ok) {
            record.repairRef = result.repair?.repairRef || result.repairRef || '';
            record.notice = `修复已排队，可到工程中心查看进度与隔离结果。${source.persistence?.persistence === 'memory' ? '审查来源仅保留在本次运行中。' : ''}`;
          }
        } else result = await invoke(action === 'reply' ? 'replyPrReview' : 'resolvePrReview', { ...base, ...(action === 'reply' ? { body: saved.reply } : {}) });
        if (!valid()) return false;
        if (!result?.ok) {
          record.error = reason(result?.code);
          if (['PR_REVIEW_CHANGED', 'PR_REVIEW_ACTION_UNCERTAIN', 'PR_REVIEW_INCOMPLETE', 'PR_REVIEW_PERMISSION_DENIED'].includes(result?.code)) record.detail = null;
          return false;
        }
        if (action !== 'repair') {
          if (action === 'reply' && draft(record, ref).reply === saved.reply) {
            draft(record, ref).reply = '';
            const input = mount?.element.querySelector('[data-review-field="reply"]');
            if (input) input.value = '';
          }
          record.notice = action === 'reply' ? '回复已发布。' : '线程已解决。';
          record.busy = ''; await refresh(record);
        }
        return true;
      } finally {
        record.busy = '';
        if (valid()) render();
      }
    }
    function render() {
      if (!active(mount?.record)) return;
      capture();
      const { element, record } = mount;
      const focused = element.contains(doc.activeElement) ? doc.activeElement?.dataset?.reviewField : '';
      const start = doc.activeElement?.selectionStart; const end = doc.activeElement?.selectionEnd;
      const scroll = element.querySelector('[data-review-discussion]')?.scrollTop || 0;
      const disabled = record.busy || record.loading || record.reading || record.state !== 'OPEN';
      const button = (action, label, enabled = true, primary = false) => `<button type="button" class="${primary ? 'btn-primary' : 'btn-secondary'}" data-review-action="${action}" ${disabled || !enabled ? 'disabled' : ''}>${label}</button>`;
      const rows = record.threads.filter((item) => record.filter === 'all' || (record.filter === 'resolved' ? item.isResolved : record.filter === 'outdated' ? item.isOutdated : !item.isResolved));
      const list = rows.map((thread) => `<button type="button" class="pr-review-row${record.selected === thread.threadRef ? ' is-selected' : ''}" data-review-thread="${thread.threadRef}" ${record.busy ? 'disabled' : ''} aria-pressed="${record.selected === thread.threadRef}"><span>${escape(location(thread))}</span><small>${thread.isResolved ? '已解决' : '未解决'}${thread.isOutdated ? ' · 已过期' : ''} · ${Number(thread.commentCount) || 0} 条</small></button>`).join('');
      let detailHtml = `<div class="muted">${record.reading ? '正在读取完整讨论…' : '选择一个审查线程'}</div>`;
      const detail = record.detail;
      if (detail) {
        const saved = draft(record);
        const unavailableProfile = saved.profileId && !record.profiles.some((p) => p.id === saved.profileId)
          ? `<option value="${escape(saved.profileId)}" selected>已选档案暂不可用</option>` : '';
        const profiles = unavailableProfile + record.profiles.map((p) => `<option value="${escape(p.id)}"${saved.profileId === p.id ? ' selected' : ''}>${escape(p.name)}</option>`).join('');
        detailHtml = `<div class="pr-review-location">${escape(location(detail))} · ${detail.isResolved ? '已解决' : '未解决'}${detail.isOutdated ? ' · 已过期' : ''}</div>
          ${!detail.complete || detail.reasonCode ? `<div class="pr-review-notice">${escape(reason(detail.complete ? detail.reasonCode : 'PR_REVIEW_INCOMPLETE'))}</div>` : ''}
          <div class="pr-review-discussion" data-review-discussion>${detail.comments.map((c) => `<article class="pr-review-comment"><div class="pr-comment-meta">${escape(c.author)} · ${escape(c.updatedAt)}</div><div class="pr-comment-body">${escape(c.body)}</div></article>`).join('') || '<div class="muted">暂无已发布的讨论</div>'}</div>
          <label class="pr-review-field">回复（最多 5000 字）<textarea data-review-field="reply" rows="3" maxlength="5000" placeholder="填写要发布到此线程的回复" ${record.busy ? 'disabled' : ''}>${escape(saved.reply)}</textarea></label>
          <div class="pr-review-actions">${button('reply', record.busy === 'reply' ? '等待回复确认…' : '发布回复', detail.canReply && detail.complete && Boolean(saved.reply.trim()))}${button('resolve', record.busy === 'resolve' ? '等待解决确认…' : '解决线程', detail.canResolve && detail.complete)}</div>
          <details class="pr-review-repair"${record.repairOpen ? ' open' : ''} data-review-repair><summary>生成隔离修复建议</summary>
            <label class="pr-review-field">补充说明（可选，最多 2000 字）<textarea data-review-field="note" rows="2" maxlength="2000" ${record.busy ? 'disabled' : ''}>${escape(saved.note)}</textarea></label>
            <label class="pr-review-field">本地复验档案（可选）<select data-review-field="profileId" ${record.busy ? 'disabled' : ''}><option value="">不选择</option>${profiles}</select></label>
            <div class="pr-review-actions">${button('repair', record.busy === 'repair' ? '准备修复…' : '生成此线程的修复', detail.canRepair && detail.complete, true)}</div>
            <div class="muted">每次只处理一个线程。先审阅 diff，再单独确认更新 PR；本地复验结果仅供参考。</div>
          </details>`;
      }
      element.innerHTML = `<section class="pr-detail-section pr-review-panel" aria-label="代码审查"><div class="pr-review-toolbar"><h2>代码审查</h2>
        <label>筛选 <select data-review-filter ${record.busy ? 'disabled' : ''}>${[['unresolved', '未解决'], ['all', '全部'], ['resolved', '已解决'], ['outdated', '已过期']].map(([key, label]) => `<option value="${key}"${record.filter === key ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
        ${button('refresh', record.loading ? '刷新中…' : '刷新审查')}</div>
        ${record.state !== 'OPEN' ? '<div class="pr-review-notice">仅支持仍然打开的 PR（包括 Draft）。</div>' : ''}
        ${record.truncated ? `<div class="pr-review-notice">仅显示前 200 个线程（共 ${Number(record.total) || 200} 个）。</div>` : ''}
        ${record.error ? `<div class="pr-review-error" role="alert">${escape(record.error)}</div>` : ''}
        ${record.notice ? `<div class="pr-review-notice" role="status">${escape(record.notice)}</div>` : ''}
        ${record.repairRef ? '<button type="button" class="ghost-btn" data-review-action="repairProgress">查看修复进度</button>' : ''}
        <div class="pr-review-list">${list || `<div class="muted">${record.loading ? '正在读取线程…' : '没有匹配的审查线程'}</div>`}</div>
        <div class="pr-review-detail">${detailHtml}</div></section>`;
      mount.renderedRef = detail ? record.selected : '';
      element.querySelectorAll('[data-review-thread]').forEach((node) => node.addEventListener('click', () => select(node.dataset.reviewThread)));
      element.querySelectorAll('[data-review-action]').forEach((node) => node.addEventListener('click', () => {
        const action = node.dataset.reviewAction;
        if (action === 'refresh') return refresh();
        if (action === 'repairProgress') return options.openRepair?.({ projectId: record.projectId, repairRef: record.repairRef });
        return operate(action);
      }));
      element.querySelector('[data-review-filter]')?.addEventListener('change', (event) => { record.filter = event.target.value; render(); });
      element.querySelector('[data-review-repair]')?.addEventListener('toggle', (event) => { record.repairOpen = event.target.open; });
      element.querySelectorAll('[data-review-field]').forEach((node) => node.addEventListener(node.dataset.reviewField === 'profileId' ? 'change' : 'input', () => {
        draft(record)[node.dataset.reviewField] = node.value;
        const reply = element.querySelector('[data-review-action="reply"]');
        if (reply && detail) reply.disabled = Boolean(disabled || !detail.canReply || !detail.complete || !draft(record).reply.trim() || draft(record).reply.length > 5000);
      }));
      const discussion = element.querySelector('[data-review-discussion]'); if (discussion) discussion.scrollTop = scroll;
      if (focused) {
        const input = element.querySelector(`[data-review-field="${focused}"]`);
        input?.focus(); if (typeof start === 'number' && typeof input?.setSelectionRange === 'function') input.setSelectionRange(start, end);
      }
    }
    function mountPr(element, data = {}) {
      capture();
      const project = getProject(data.projectId); const token = getToken(data.projectId);
      if (!element || !project?.path || !token || !Number.isSafeInteger(data.prNumber)) { unmount(); return Promise.resolve(false); }
      for (const record of [...records.values()]) if (record.projectId === project.id && !current(record)) forgetProject(project.id);
      const key = `${project.id}:${data.prNumber}`;
      let record = records.get(key);
      if (!record) {
        record = { key, projectId: project.id, path: project.path, token, prNumber: data.prNumber,
          threads: [], selected: '', detail: null, drafts: new Map(), filter: 'unresolved', epoch: 0, listSeq: 0, detailSeq: 0,
          loading: false, reading: false, busy: '', error: '', notice: '', attempted: false };
        records.set(key, record);
        while (records.size > 50) { const oldest = [...records.values()].find((r) => r !== record && !r.busy); if (!oldest) break; records.delete(oldest.key); }
      }
      if (mount?.record !== record) invalidate(mount?.record);
      if (record.headSha && record.headSha !== data.headSha) { invalidate(record); record.detail = null; record.attempted = false; }
      Object.assign(record, { state: data.state, headSha: data.headSha, profiles: data.profiles || [] });
      mount = { element, record }; render();
      return data.state === 'OPEN' && !record.attempted ? refresh(record) : Promise.resolve(true);
    }
    function close() { unmount(); closed = true; records.clear(); }
    return { mountPr, unmount, forgetProject, select, refresh, operate, close };
  }
  return { create, reason };
}));
