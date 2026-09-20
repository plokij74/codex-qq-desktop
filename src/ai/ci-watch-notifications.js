'use strict';

const { validWatchRef, validPrNumber } = require('./ci-watch-state');

function createCiWatchNotifier({ Notification, getWindows, getOwnerIds, canNavigate, navigate, isEnabled } = {}) {
  const seen = new Set();
  const notifications = new Map();
  let closed = false;
  function publish(event) {
    if (closed || event?.notify !== true || !validWatchRef(event.watchRef) || !validPrNumber(event.prNumber) || seen.has(event.watchRef)) return false;
    seen.add(event.watchRef);
    while (seen.size > 200) seen.delete(seen.values().next().value);
    try {
      const owners = new Set(getOwnerIds(event.projectKey));
      const windows = getWindows().filter((win) => !win.isDestroyed?.() && owners.has(win.webContents.id));
      if (!isEnabled() || !windows.length || windows.some((win) => win.isFocused?.())
        || typeof Notification !== 'function' || !Notification.isSupported?.()) return false;
      const label = ({ passed: '已发现的 Actions 通过', failed: 'Actions 失败', attention: '需要关注' })[event.outcome]
        || ({ head_changed: 'PR 出现新提交', pr_closed: 'PR 已关闭或合并', expired: '跟踪已到期', error: '跟踪遇到错误' })[event.status]
        || '跟踪已结束';
      const notification = new Notification({ title: 'CI 跟踪结果', body: `PR #${event.prNumber} · ${label}`, silent: true });
      notifications.set(event.watchRef, notification);
      notification.on('click', () => {
        if (closed || notifications.get(event.watchRef) !== notification) return;
        try {
          const liveOwners = new Set(getOwnerIds(event.projectKey));
          const liveWindows = getWindows().filter((win) => !win.isDestroyed?.());
          const target = liveWindows.find((win) => liveOwners.has(win.webContents.id)) || liveWindows[0];
          if (!target) return;
          if (target.isMinimized?.()) target.restore();
          target.show(); target.focus();
          if (liveOwners.has(target.webContents.id) && canNavigate(target.webContents.id, event.projectKey, event.watchRef)) {
            navigate(target, { projectKey: event.projectKey, watchRef: event.watchRef, prNumber: event.prNumber });
          }
        } catch { /* Native notification/window failures must not affect watches. */ }
      });
      notification.on('failed', () => notifications.delete(event.watchRef));
      notification.on('close', () => notifications.delete(event.watchRef));
      notification.show();
      while (notifications.size > 50) {
        const [ref, old] = notifications.entries().next().value;
        notifications.delete(ref); old.close?.();
      }
      return true;
    } catch {
      const notification = notifications.get(event.watchRef);
      notifications.delete(event.watchRef);
      try { notification?.close?.(); } catch {}
      return false;
    }
  }
  return {
    publish,
    close: () => {
      closed = true;
      for (const notification of notifications.values()) { try { notification.close?.(); } catch {} }
      notifications.clear(); seen.clear();
    },
  };
}

module.exports = { createCiWatchNotifier };
