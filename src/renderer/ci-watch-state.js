'use strict';

(function expose(factory) {
  const api = Object.freeze(factory());
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.defineProperty(window, 'CiWatchState', { value: api });
}(function createState() {
  const active = new Set(['starting', 'watching']);
  const statuses = new Set([...active, 'completed', 'head_changed', 'pr_closed', 'expired', 'stopped', 'error']);
  const reasons = {
    CI_WATCH_INVALID: '跟踪参数无效', CI_WATCH_PROJECT_BINDING_INVALID: '项目绑定已失效',
    CI_WATCH_NOT_FOUND: '跟踪记录已失效', CI_WATCH_ALREADY_RUNNING: '本项目已有跟踪，请先停止它',
    CI_WATCH_LIMIT: '应用最多同时跟踪 3 个项目', CI_WATCH_UNAVAILABLE: '暂时无法读取 CI 状态',
    CI_WATCH_REPOSITORY_INVALID: '无法确认项目 origin 仓库', CI_WATCH_REPOSITORY_CHANGED: '项目 origin 已变化',
    CI_WATCH_PR_INVALID: '无法确认 PR 状态', CI_WATCH_FORK_UNSUPPORTED: '暂不支持 fork PR',
    CI_WATCH_INCOMPLETE: '工作流元数据不完整，无法给出结论', CI_WATCH_NETWORK: '网络连接异常',
    CI_WATCH_QUERY_TIMEOUT: '本次查询超时', CI_WATCH_RATE_LIMITED: 'GitHub 限流，等待重试',
    CI_WATCH_AUTH_REQUIRED: '请先通过 gh 登录 GitHub', CI_WATCH_FORBIDDEN: '没有读取 Actions 的权限',
    CI_WATCH_TARGET_NOT_FOUND: '仓库或 PR 不可用', CI_WATCH_GH_UNAVAILABLE: '未找到 GitHub CLI（gh）',
    CI_WATCH_NO_RUNS: '到期仍未发现 Actions', CI_WATCH_AWAITING_ATTEMPT: '到期仍未观察到新的重跑 attempt',
    CI_WATCH_SUSPENDED: '系统休眠，查询已暂停', CI_WATCH_PROJECT_REMOVED: '项目已解除绑定',
    CI_WATCH_APP_CLOSED: '应用已退出',
  };
  function validRef(ref) { return typeof ref === 'string' && /^ciw_[a-f0-9]{24}$/.test(ref); }
  function validKey(key) { return typeof key === 'string' && /^[a-f0-9]{32}$/.test(key); }
  function isActive(watch) { return active.has(watch?.status); }
  function time(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
  function normalize(raw) {
    if (!raw || !validRef(raw.watchRef) || !validKey(raw.projectKey) || !statuses.has(raw.status)
      || !Number.isSafeInteger(raw.revision) || raw.revision < 0
      || !Number.isInteger(raw.prNumber) || raw.prNumber < 1 || raw.prNumber > 0x7fffffff) return null;
    const counts = {};
    for (const key of ['total', 'completed', 'pending', 'passed', 'failed', 'skipped', 'attention']) {
      counts[key] = Number.isInteger(raw.counts?.[key]) ? Math.min(200, Math.max(0, raw.counts[key])) : 0;
    }
    const runs = Array.isArray(raw.runs) ? raw.runs.slice(0, 200).map((run) => ({
      id: /^[1-9]\d{0,29}$/.test(String(run?.id)) ? String(run.id) : '',
      name: String(run?.name || 'GitHub Actions').slice(0, 200),
      runAttempt: Number.isSafeInteger(run?.runAttempt) && run.runAttempt > 0 ? run.runAttempt : 0,
      status: String(run?.status || '').slice(0, 32), conclusion: String(run?.conclusion || '').slice(0, 32),
    })).filter((run) => run.id && run.runAttempt) : null;
    return {
      watchRef: raw.watchRef, projectKey: raw.projectKey, prNumber: raw.prNumber, revision: raw.revision,
      headSha: /^[a-f0-9]{40}$/.test(raw.headSha) ? raw.headSha : '', status: raw.status,
      outcome: ['passed', 'failed', 'attention'].includes(raw.outcome) ? raw.outcome : null,
      counts, createdAt: time(raw.createdAt), deadlineAt: time(raw.deadlineAt),
      lastCheckedAt: time(raw.lastCheckedAt), nextPollAt: time(raw.nextPollAt), finishedAt: time(raw.finishedAt),
      unread: raw.unread === true, waitingForAttempt: raw.waitingForAttempt === true,
      reasonCode: Object.hasOwn(reasons, raw.reasonCode) ? raw.reasonCode : '', runs,
      detailRevision: runs ? raw.revision : -1,
    };
  }
  function merge(previous, raw) {
    const next = normalize(raw);
    if (!next) return previous || null;
    if (previous && (previous.watchRef !== next.watchRef || previous.projectKey !== next.projectKey
      || previous.prNumber !== next.prNumber || next.revision < previous.revision)) return previous;
    if (previous && next.runs === null) {
      next.runs = previous.runs;
      next.detailRevision = previous.detailRevision;
    }
    return next;
  }
  function label(watch) {
    if (watch?.status === 'completed') return ({ passed: '已发现的 Actions 通过', failed: 'Actions 失败', attention: '需要关注' })[watch.outcome] || '需要关注';
    if (watch?.status === 'watching') {
      if (watch.waitingForAttempt) return '等待新的重跑 attempt';
      if (!watch.counts.total) return '等待 Actions 出现';
      if (!watch.counts.pending && !watch.reasonCode) return '等待结果稳定（30 秒）';
    }
    return ({ starting: '正在确认 PR', watching: '正在跟踪', head_changed: '新提交，跟踪已结束',
      pr_closed: 'PR 已关闭或合并', expired: '跟踪已到期', stopped: '已停止跟踪', error: '跟踪出错' })[watch?.status] || '未知状态';
  }
  function reason(value) { return reasons[value] || reasons.CI_WATCH_UNAVAILABLE; }
  function remaining(watch, now = Date.now()) {
    if (!isActive(watch) || watch.deadlineAt == null) return '';
    const seconds = Math.max(0, Math.ceil((watch.deadlineAt - now) / 1000));
    return `剩余 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function runLabel(run) {
    const labels = { queued: '排队', in_progress: '运行中', waiting: '等待', requested: '已请求', pending: '等待',
      success: '通过', neutral: '中性', skipped: '跳过', failure: '失败', timed_out: '超时', startup_failure: '启动失败',
      cancelled: '已取消', action_required: '需要操作', stale: '已过期', unknown: '未知结论' };
    return labels[run.status === 'completed' ? run.conclusion : run.status] || '未知状态';
  }
  return { validRef, validKey, normalize, merge, isActive, label, reason, remaining, runLabel };
}));
