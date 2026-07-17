const test = require('node:test');
const assert = require('node:assert/strict');
const { assertNotAborted } = require('../src/ai/agent');

test('assertNotAborted throws when signal aborted', () => {
  const ac = new AbortController();
  ac.abort();
  assert.throws(() => assertNotAborted(ac.signal), (err) => {
    assert.equal(err.code, 'ABORTED');
    assert.match(err.message, /已停止/);
    return true;
  });
});

test('assertNotAborted no-op when open', () => {
  const ac = new AbortController();
  assert.doesNotThrow(() => assertNotAborted(ac.signal));
  assert.doesNotThrow(() => assertNotAborted(null));
});
