'use strict';

(function expose(factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ci-watch-state'));
  else Object.defineProperty(window, 'CiWatchUi', { value: Object.freeze(factory(window.CiWatchState)) });
}(function createModule(State) {
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  function create(options) {
    const { api, document: doc, getProject, getToken, navigateToPr } = options;
    const now = options.now || Date.now;
    const toast = options.toast || (() => {});
    // Never serialized into sessions, exports, memory, or usage records.
    const records = new Map();
    const bindings = new Map();
    const earlyEvents = new Map();
    const expanded = new Set();
    const detailRequests = new Map();
    const detailAttempts = new Map();
    const operations = new Set();
    const durations = new Map();
    const offers = new Map();
    const notified = new Set();
    let prMount = null;
    let centerMount = null;
    let inboxOpen = false;
    let closed = false;
    let navigationSequence = 0;

    function current(binding) {
      return !closed && binding && bindings.get(binding.id) === binding
        && getProject(binding.id)?.path === binding.path && getToken(binding.id) === binding.token;
    }
    function bindingForKey(key) { return [...bindings.values()].find((binding) => binding.key === key && current(binding)); }
    function visibleRecords() { return [...records.values()].filter((watch) => bindingForKey(watch.projectKey)).sort((a, b) => b.createdAt - a.createdAt); }
    function prune() {
      const terminal = [...records.values()].filter((watch) => !State.isActive(watch)).sort((a, b) => b.finishedAt - a.finishedAt);
      for (const watch of terminal.slice(50)) { records.delete(watch.watchRef); expanded.delete(watch.watchRef); detailAttempts.delete(watch.watchRef); }
      while (notified.size > 200) notified.delete(notified.values().next().value);
    }
    function ingest(raw, key) {
      if (!State.validRef(raw?.watchRef) || raw.projectKey !== key) return null;
      const previous = records.get(raw.watchRef);
      const watch = State.merge(previous, raw);
      if (!watch || watch === previous) return null;
      records.set(watch.watchRef, watch);
      prune();
      return watch;
    }
    function onEvent(raw) {
      const value = State.normalize(raw);
      if (closed || !value) return;
      const binding = bindingForKey(value.projectKey);
      if (!binding) {
        if ([...bindings.values()].some((item) => current(item) && !item.key)) {
          if ((earlyEvents.get(value.watchRef)?.revision ?? -1) <= value.revision) earlyEvents.set(value.watchRef, raw);
          while (earlyEvents.size > 53) earlyEvents.delete(earlyEvents.keys().next().value);
        }
        return;
      }
      const watch = ingest(raw, binding.key);
      if (!watch) return;
      if (raw.notify === true && watch.unread && !State.isActive(watch) && !notified.has(watch.watchRef)) {
        notified.add(watch.watchRef);
        toast(`${getProject(binding.id)?.name || '项目'} · PR #${watch.prNumber}：${State.label(watch)}。可在「CI 结果」查看。`, 5000);
      }
      render();
    }

    async function hydrate(binding) {
      if (!current(binding) || typeof api.listCiWatches !== 'function') return false;
      if (binding.loading) return binding.loading;
      const snapshot = new Map([...records].map(([ref, watch]) => [ref, watch.revision]));
      binding.loading = (async () => {
        const response = await api.listCiWatches({ projectBindingId: binding.token }).catch(() => null);
        if (!current(binding)) return false;
        if (!response?.ok || !State.validKey(response.projectKey) || !Array.isArray(response.watches)) {
          binding.error = State.reason(response?.code);
          return false;
        }
        if (binding.key && binding.key !== response.projectKey) return false;
        binding.key = response.projectKey;
        binding.error = '';
        const retained = new Set();
        for (const raw of response.watches) {
          const watch = State.normalize(raw);
          if (!watch || watch.projectKey !== binding.key) continue;
          retained.add(watch.watchRef); ingest(raw, binding.key);
        }
        // A late list cannot delete records created/updated by a newer event.
        for (const [ref, watch] of records) {
          if (watch.projectKey === binding.key && !retained.has(ref) && snapshot.has(ref) && watch.revision <= snapshot.get(ref)) records.delete(ref);
        }
        for (const [ref, event] of earlyEvents) {
          if (event.projectKey === binding.key) { earlyEvents.delete(ref); onEvent(event); }
        }
        return true;
      })();
      try { return await binding.loading; }
      finally { binding.loading = null; if (current(binding)) render(); }
    }
    function bindProject(project, token) {
      if (closed || !project?.id || !project.path || !token) return Promise.resolve(false);
      let binding = bindings.get(project.id);
      if (binding?.path === project.path && binding.token === token) return binding.loading || Promise.resolve(Boolean(binding.key));
      forgetProject(project.id);
      binding = { id: project.id, path: project.path, token, key: '', error: '', loading: null };
      bindings.set(project.id, binding);
      return hydrate(binding);
    }
    function forgetProject(id) {
      const old = bindings.get(id);
      bindings.delete(id);
      if (old?.key && !bindingForKey(old.key)) {
        for (const [ref, watch] of records) if (watch.projectKey === old.key) { records.delete(ref); expanded.delete(ref); detailAttempts.delete(ref); }
        for (const [ref, event] of earlyEvents) if (event.projectKey === old.key) earlyEvents.delete(ref);
      }
      for (const key of offers.keys()) if (key.startsWith(`${id}:`)) offers.delete(key);
      for (const key of durations.keys()) if (key.startsWith(`${id}:`)) durations.delete(key);
      render();
    }
    async function refreshProject(id) { return hydrate(bindings.get(id)); }

    async function start(projectId, prNumber, minutes = 30) {
      const binding = bindings.get(projectId);
      if (!current(binding)) return false;
      if (!binding.key && !(await hydrate(binding))) { toast(binding.error || '项目绑定已失效'); return false; }
      if (!current(binding) || ![15, 30, 60].includes(minutes)) return false;
      const busyKey = `start:${binding.key}`;
      if (operations.has(busyKey)) return false;
      operations.add(busyKey); render();
      try {
        const result = await api.startCiWatch({ projectBindingId: binding.token, prNumber, durationMinutes: minutes }).catch(() => null);
        if (!current(binding)) return false;
        if (!result?.ok || !State.normalize(result.watch) || result.watch.projectKey !== binding.key) { toast(State.reason(result?.code)); return false; }
        ingest(result.watch, binding.key);
        offers.delete(`${projectId}:${prNumber}`);
        toast(result.existing ? '该 PR 已在跟踪中' : `已开始跟踪 PR #${prNumber}，最长 ${minutes} 分钟`);
        return true;
      } finally { operations.delete(busyKey); render(); }
    }
    async function update(ref, method) {
      const watch = records.get(ref);
      const binding = watch && bindingForKey(watch.projectKey);
      if (!current(binding) || operations.has(ref)) return false;
      operations.add(ref); render();
      try {
        const result = await api[method]({ projectBindingId: binding.token, watchRef: ref }).catch(() => null);
        if (!current(binding)) return false;
        if (!result?.ok) { toast(State.reason(result?.code)); return false; }
        ingest(result.watch, binding.key);
        return true;
      } finally { operations.delete(ref); render(); }
    }
    async function loadDetails(ref) {
      const watch = records.get(ref);
      const binding = watch && bindingForKey(watch.projectKey);
      if (!current(binding) || detailRequests.has(ref) || watch.detailRevision >= watch.revision || detailAttempts.get(ref) === watch.revision) return;
      const request = { binding, revision: watch.revision };
      detailRequests.set(ref, request);
      detailAttempts.set(ref, watch.revision);
      try {
        const result = await api.getCiWatch({ projectBindingId: binding.token, watchRef: ref }).catch(() => null);
        if (current(binding) && result?.ok && result.watch?.watchRef === ref && Array.isArray(result.watch.runs)) ingest(result.watch, binding.key);
      } finally {
        if (detailRequests.get(ref) === request) detailRequests.delete(ref);
        // At most one automatic detail read per revision, including malformed
        // or stale responses. Collapsing/reopening allows an explicit retry.
        if (current(binding)) render();
      }
    }
    async function navigate(ref, failures = false, expectedKey = '') {
      const sequence = ++navigationSequence;
      if (!State.validRef(ref)) return false;
      let watch = records.get(ref);
      if (!watch && expectedKey) {
        await Promise.all([...bindings.values()].filter(current).map(hydrate));
        watch = records.get(ref);
      }
      const binding = watch && bindingForKey(watch.projectKey);
      if (!current(binding) || (expectedKey && watch.projectKey !== expectedKey)) { toast('跟踪记录已失效，请重新打开对应项目'); return false; }
      const result = await api.getCiWatch({ projectBindingId: binding.token, watchRef: ref }).catch(() => null);
      if (sequence !== navigationSequence || !current(binding)) return false;
      if (!result?.ok || !State.normalize(result.watch) || result.watch.watchRef !== ref || result.watch.projectKey !== binding.key) { toast('跟踪记录已失效'); return false; }
      ingest(result.watch, binding.key);
      watch = records.get(ref);
      const navigated = await navigateToPr({ projectId: binding.id, prNumber: watch.prNumber, headSha: watch.headSha, showFailures: failures });
      if (!navigated || sequence !== navigationSequence || !current(binding)) return false;
      setInbox(false);
      await update(ref, 'ackCiWatch');
      return true;
    }
    function offer(projectId, number, message) {
      if (!current(bindings.get(projectId))) return;
      offers.set(`${projectId}:${number}`, String(message || '可点击「跟踪 CI」观察结果。'));
      render();
    }

    const timeLabel = (value) => value == null ? '尚未查询' : new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
    function button(action, label, ref = '', disabled = false) {
      return `<button type="button" class="ghost-btn" data-ci-action="${action}" data-ci-ref="${ref}"${disabled ? ' disabled' : ''}>${label}</button>`;
    }
    function card(watch, { details = false, projectName = '' } = {}) {
      const ref = watch.watchRef;
      const isActive = State.isActive(watch);
      const busy = operations.has(ref);
      let runsHtml = '';
      if (details && expanded.has(ref)) {
        if (watch.detailRevision < watch.revision) {
          runsHtml = `<div class="work-card-meta">${detailAttempts.get(ref) === watch.revision && !detailRequests.has(ref) ? '摘要暂不可用，可收起后重新展开' : '正在读取工作流摘要…'}</div>`;
          void loadDetails(ref);
        } else runsHtml = `<ul class="ci-watch-runs">${(watch.runs || []).map((run) => `<li><span>${escape(run.name)}</span><span>attempt ${run.runAttempt} · ${escape(State.runLabel(run))}</span></li>`).join('') || '<li>尚未发现 Actions</li>'}</ul>`;
      }
      return `<article class="ci-watch-record${watch.unread ? ' is-unread' : ''}">
        <div class="ci-watch-record-head"><strong>${projectName ? `${escape(projectName)} · ` : ''}PR #${watch.prNumber}</strong><span class="ci-watch-status ${watch.outcome || (watch.status === 'error' ? 'failed' : '')}">${escape(State.label(watch))}</span></div>
        <div class="work-card-meta">${watch.headSha ? `<code>${watch.headSha.slice(0, 8)}</code> · ` : ''}已发现 ${watch.counts.total} · 通过 ${watch.counts.passed} · 等待 ${watch.counts.pending} · 失败 ${watch.counts.failed} · 中性/跳过 ${watch.counts.skipped} · 关注 ${watch.counts.attention}</div>
        <div class="work-card-meta">上次查询 ${escape(timeLabel(watch.lastCheckedAt))}${isActive ? ` · <span data-ci-countdown="${ref}">${State.remaining(watch, now())}</span>${watch.nextPollAt ? ` · 下次 ${escape(timeLabel(watch.nextPollAt))}` : ''}` : ''}</div>
        ${watch.reasonCode ? `<div class="work-card-notice">${escape(State.reason(watch.reasonCode))}</div>` : ''}
        <div class="work-card-actions">${isActive ? button('stop', '停止跟踪', ref, busy) : ''}${button('navigate', '查看 PR', ref, busy)}${watch.outcome === 'failed' ? button('failures', '查看失败', ref, busy) : ''}${details ? button('details', expanded.has(ref) ? '收起工作流' : '展开工作流', ref) : ''}${watch.unread ? button('ack', '标为已读', ref, busy) : ''}</div>${runsHtml}
      </article>`;
    }
    function wire(host, context = {}) {
      host.querySelectorAll('[data-ci-action]').forEach((element) => element.addEventListener('click', () => {
        const { ciAction: action, ciRef: ref } = element.dataset;
        const fail = () => toast('CI 跟踪操作未完成，请重试');
        if (action === 'start') void start(context.projectId, context.prNumber, durations.get(`${context.projectId}:${context.prNumber}`) || 30).catch(fail);
        if (action === 'stop') void update(ref, 'stopCiWatch').catch(fail);
        if (action === 'ack') void update(ref, 'ackCiWatch').catch(fail);
        if (action === 'navigate' || action === 'failures') void navigate(ref, action === 'failures').catch(fail);
        if (action === 'details') { if (expanded.has(ref)) expanded.delete(ref); else { expanded.add(ref); detailAttempts.delete(ref); } render(); }
        if (action === 'refresh') void refreshProject(context.projectId).catch(fail);
        if (action === 'close') setInbox(false);
      }));
      host.querySelector('[data-ci-duration]')?.addEventListener('change', (event) => {
        const minutes = Number(event.target.value);
        if ([15, 30, 60].includes(minutes)) durations.set(`${context.projectId}:${context.prNumber}`, minutes);
      });
    }
    function mountCurrent(mount, kind) {
      return mount?.host?.isConnected !== false && mount?.host && current(bindings.get(mount.projectId))
        && (!options.isVisible || options.isVisible(kind, mount.projectId));
    }
    function renderPr() {
      if (!mountCurrent(prMount, 'prs')) return;
      const { host, projectId, prNumber, state } = prMount;
      const binding = bindings.get(projectId);
      const watches = visibleRecords().filter((watch) => watch.projectKey === binding.key);
      const activeWatch = watches.find(State.isActive);
      const latest = watches.find((watch) => watch.prNumber === prNumber);
      const minutes = durations.get(`${projectId}:${prNumber}`) || 30;
      const busy = !binding.key || operations.has(`start:${binding.key}`);
      const durationHtml = `<label>最长 <select data-ci-duration aria-label="CI 跟踪时长">${[15, 30, 60].map((n) => `<option value="${n}"${n === minutes ? ' selected' : ''}>${n} 分钟</option>`).join('')}</select></label>`;
      host.innerHTML = `<div class="ci-watch-panel"><h3>跟踪 CI</h3><p class="work-card-meta">每 15 秒查询当前提交的所有 Actions；全部结束并稳定 30 秒后提醒。新提交会结束本次跟踪。结果不代表满足合并条件。</p>
        ${binding.error ? `<div class="work-card-error">${escape(binding.error)} ${button('refresh', '重试')}</div>` : ''}
        ${offers.has(`${projectId}:${prNumber}`) ? `<div class="work-card-notice">${escape(offers.get(`${projectId}:${prNumber}`))}</div>` : ''}
        ${latest ? card(latest, { details: true }) : ''}
        ${activeWatch && activeWatch.prNumber !== prNumber ? `<div class="work-card-notice">本项目正在跟踪另一个 PR；停止后才可开始新的跟踪。</div>${card(activeWatch)}` : ''}
        ${!activeWatch && state === 'OPEN' ? `<div class="ci-watch-controls">${durationHtml}${button('start', binding.key ? '跟踪 CI' : '读取跟踪记录…', '', busy)}</div>` : ''}
        <div class="work-card-meta">仅本次应用运行有效；每项目 1 条、全应用最多 3 条。停止跟踪不会取消远端 Actions。</div></div>`;
      wire(host, prMount);
    }
    function renderCenter() {
      if (!mountCurrent(centerMount, 'scheduled')) return;
      const { host, projectId } = centerMount;
      const binding = bindings.get(projectId);
      const watches = visibleRecords().filter((watch) => watch.projectKey === binding.key);
      host.innerHTML = `<div class="work-card-meta">在 PR 页面手动开始跟踪；切换页面或最小化不会停止。历史仅保留本次运行最近 50 条。</div>${binding.error ? `<div class="work-card-error">${escape(binding.error)} ${button('refresh', '重试')}</div>` : ''}${watches.map((watch) => card(watch)).join('') || '<div class="work-empty">本项目暂无 CI 跟踪</div>'}`;
      wire(host, centerMount);
    }
    function renderInbox() {
      const watches = visibleRecords();
      const unread = watches.filter((watch) => watch.unread).length;
      const activeCount = watches.filter(State.isActive).length;
      const toolbar = doc?.getElementById('btn-ci-watch');
      if (toolbar) {
        toolbar.textContent = `CI 结果${unread ? ` · ${unread} 未读` : activeCount ? ` · ${activeCount} 跟踪` : ''}`;
        toolbar.classList.toggle('has-unread', unread > 0);
        toolbar.setAttribute('aria-expanded', String(inboxOpen));
      }
      const host = doc?.getElementById('ci-watch-inbox');
      if (!host) return;
      host.classList.toggle('hidden', !inboxOpen);
      if (!inboxOpen) return;
      const scrollTop = host.scrollTop;
      host.innerHTML = `<div class="ci-watch-inbox-head"><strong>CI 跟踪 · ${unread} 条未读</strong>${button('close', '关闭')}</div><div class="work-card-meta">应用内提醒始终保留；系统通知可在设置中开启。</div>${watches.sort((a, b) => Number(b.unread) - Number(a.unread) || b.createdAt - a.createdAt).map((watch) => card(watch, { projectName: getProject(bindingForKey(watch.projectKey)?.id)?.name || '项目' })).join('') || '<div class="work-empty">暂无跟踪记录，请在 PR 页面点击「跟踪 CI」。</div>'}`;
      host.scrollTop = scrollTop;
      wire(host);
    }
    function render() { if (!closed) { renderPr(); renderCenter(); renderInbox(); } }
    function tick() {
      if (closed) return;
      doc?.querySelectorAll('[data-ci-countdown]').forEach((node) => { node.textContent = State.remaining(records.get(node.dataset.ciCountdown), now()); });
    }
    function setInbox(open) {
      inboxOpen = open; renderInbox();
      if (open) doc?.getElementById('ci-watch-inbox')?.querySelector('[data-ci-action="close"]')?.focus();
      else doc?.getElementById('btn-ci-watch')?.focus();
    }
    const toggleInbox = () => setInbox(!inboxOpen);
    const onKey = (event) => { if (event.key === 'Escape' && inboxOpen) setInbox(false); };
    const onClickDoc = (event) => {
      if (!inboxOpen) return;
      const target = event?.target;
      if (!target) return;
      const host = doc?.getElementById('ci-watch-inbox');
      const btn = doc?.getElementById('btn-ci-watch');
      if (host && btn) {
        if (typeof host.contains === 'function' && typeof btn.contains === 'function') {
          if (!host.contains(target) && !btn.contains(target)) setInbox(false);
        } else if (target !== host && target !== btn) {
          if (!Array.isArray(host.children) || !host.children.includes(target)) setInbox(false);
        }
      }
    };
    doc?.getElementById('btn-ci-watch')?.addEventListener('click', toggleInbox);
    doc?.addEventListener('keydown', onKey);
    doc?.addEventListener('click', onClickDoc);
    const offEvent = api.onCiWatchEvent?.(onEvent);
    const offNavigate = api.onCiWatchNavigate?.((target) => {
      if (State.validKey(target?.projectKey)) void navigate(target.watchRef, false, target.projectKey).catch(() => toast('暂时无法打开跟踪结果'));
    });
    renderInbox();
    return {
      bindProject, forgetProject, refreshProject, start, navigate, offer, tick,
      stop: (ref) => update(ref, 'stopCiWatch'), ack: (ref) => update(ref, 'ackCiWatch'),
      mountPr: (host, context) => { prMount = host ? { host, ...context } : null; renderPr(); },
      mountCenter: (host, projectId) => { centerMount = host ? { host, projectId } : null; renderCenter(); },
      // Copies for diagnostics/tests, not a persistence hook.
      snapshot: () => visibleRecords().map((watch) => ({ ...watch, counts: { ...watch.counts }, runs: watch.runs?.map((run) => ({ ...run })) || null })),
      close: () => {
        closed = true; navigationSequence++; offEvent?.(); offNavigate?.();
        doc?.getElementById('btn-ci-watch')?.removeEventListener('click', toggleInbox);
        doc?.removeEventListener('keydown', onKey);
        doc?.removeEventListener('click', onClickDoc);
        records.clear(); bindings.clear(); earlyEvents.clear(); offers.clear(); detailAttempts.clear(); detailRequests.clear(); expanded.clear(); durations.clear(); notified.clear();
      },
    };
  }
  return { create };
}));
