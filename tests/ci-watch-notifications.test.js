'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createCiWatchNotifier } = require('../src/ai/ci-watch-notifications');

function fixture() {
  const made = []; const clicks = [];
  const data = { enabled: true, supported: true, owners: [7], allowed: true, focused: false, minimized: true, fail: false };
  class Notification extends EventEmitter {
    static isSupported() { return data.supported; }
    constructor(options) { super(); this.options = options; this.closed = false; made.push(this); }
    show() { if (data.fail) throw new Error('OS unavailable'); this.shown = true; }
    close() { this.closed = true; this.emit('close'); }
  }
  const win = { webContents: { id: 7 }, isDestroyed: () => false, isFocused: () => data.focused,
    isMinimized: () => data.minimized, restore: () => clicks.push('restore'), show: () => clicks.push('show'), focus: () => clicks.push('focus') };
  const notifier = createCiWatchNotifier({ Notification, getWindows: () => [win], getOwnerIds: () => data.owners,
    canNavigate: () => data.allowed, navigate: (_win, target) => clicks.push(target), isEnabled: () => data.enabled });
  const event = (n = 1) => ({ watchRef: `ciw_${n.toString(16).padStart(24, '0')}`, projectKey: 'a'.repeat(32), prNumber: 7, status: 'completed', outcome: 'failed', notify: true, name: 'private workflow', log: 'private log', headRefName: 'private branch' });
  return { notifier, made, clicks, data, event, win };
}

describe('D15 optional system notifications', () => {
  it('requires opt-in, live owners, supported OS and no focused owner', () => {
    for (const values of [{ enabled: false }, { supported: false }, { focused: true }, { owners: [] }]) {
      const f = fixture(); Object.assign(f.data, values);
      assert.equal(f.notifier.publish(f.event()), false);
      assert.equal(f.made.length, 0);
      f.notifier.close();
    }
  });
  it('notifies once and exposes only generic metadata; clicks revalidate ownership', () => {
    const f = fixture();
    assert.equal(f.notifier.publish({ ...f.event(), notify: false }), false);
    assert.equal(f.notifier.publish(f.event()), true);
    assert.equal(f.notifier.publish(f.event()), false);
    assert.equal(f.made.length, 1);
    assert.doesNotMatch(JSON.stringify(f.made[0].options), /private|branch|log|workflow/);
    f.made[0].emit('click');
    assert.deepEqual(f.clicks.slice(0, 3), ['restore', 'show', 'focus']);
    assert.equal(f.clicks[3].watchRef, f.event().watchRef);
    f.clicks.length = 0; f.data.allowed = false;
    f.made[0].emit('click');
    assert.equal(f.clicks.length, 3);
    f.notifier.close();
  });
  it('only focuses the app if a project was removed or rebound before clicking', () => {
    const f = fixture(); f.notifier.publish(f.event()); f.data.owners = [];
    f.made[0].emit('click');
    assert.deepEqual(f.clicks, ['restore', 'show', 'focus']);
    f.notifier.close();
  });
  it('isolates OS failures and closes all handles on app shutdown', () => {
    const f = fixture(); f.data.fail = true;
    assert.equal(f.notifier.publish(f.event()), false);
    assert.equal(f.made[0].closed, true);
    f.data.fail = false; f.notifier.publish(f.event(2));
    f.made[1].emit('failed'); f.made[1].emit('click');
    assert.equal(f.clicks.length, 0);
    f.notifier.publish(f.event(3)); f.notifier.close();
    assert.equal(f.made[2].closed, true);
    f.made[2].emit('click'); assert.equal(f.clicks.length, 0);
    assert.equal(f.notifier.publish(f.event(4)), false);
  });
  it('bounds native notification handles', () => {
    const f = fixture();
    for (let i = 1; i <= 55; i++) f.notifier.publish(f.event(i));
    assert.equal(f.made.filter((notification) => notification.closed).length, 5);
    f.notifier.close();
    assert.ok(f.made.every((notification) => notification.closed));
  });
});
