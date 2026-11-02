'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createModelTextRedactor, redactModelPartialOutput } = require('../src/ai/model-text-redaction');
const { defaultSecretManager, redactSecrets } = require('../src/ai/secret-manager');
const fake = 'e4-fragment-probe-not-real-98765';
defaultSecretManager.registerSecret(fake, 'E4_FRAGMENT_TEST');

function publish(chunks, options) {
  const redactor = createModelTextRedactor(options);
  const pieces = chunks.map((chunk) => redactor.write(chunk));
  pieces.push(redactor.finish());
  assert.equal(redactor.finish(), '');
  assert.equal(redactor.write('late unsafe fragment'), '');
  return pieces;
}

test('the prior independent-fragment redaction leaks the synthetic credential but bounded stream state never does', () => {
  const chunks = [fake.slice(0, 9), fake.slice(9, 20), fake.slice(20)];
  assert.equal(chunks.map(redactSecrets).join(''), fake);
  for (let cut = 1; cut < fake.length; cut += 1) {
    const output = publish(['ordinary safe text. ', fake.slice(0, cut), fake.slice(cut), ' final safe text.']).join('');
    assert.equal(output, `ordinary safe text. ${redactSecrets(fake)} final safe text.`);
    assert.equal(output.includes(fake), false);
  }
  assert.equal(publish([...fake]).join(''), redactSecrets(fake));
});

test('self-overlapping credentials and arbitrary UTF-8 byte boundaries cannot defeat suffix withholding', () => {
  for (const value of ['aaaa', 'abcabcab', 'fixture凭据😀不是实际密钥']) {
    defaultSecretManager.registerSecret(value, 'E4_UTF8_TEST');
    const bytes = Buffer.from(value);
    const output = publish([...bytes].map((byte) => Buffer.from([byte]))).join('');
    assert.equal(output, redactSecrets(value));
    assert.equal(output.includes(value), false);
  }
});

test('cancellation/EOF never flushes a withheld prefix, and a safe bounded marker replaces overflow instead of a truncated secret', () => {
  const prefix = fake.slice(0, -1);
  assert.equal(publish([prefix]).join(''), '');
  assert.equal(redactModelPartialOutput(`Safe partial. ${prefix}`), 'Safe partial. ');
  assert.equal(redactModelPartialOutput(`Safe partial. ${fake}`), `Safe partial. ${redactSecrets(fake)}`);
  assert.equal(publish([prefix, fake.slice(-1)], { maxPendingBytes: 8 }).join(''), '[REDACTED:OUTPUT_LIMIT]');
});

test('ordinary text remains live and complete without waiting for terminal flush', () => {
  const stream = createModelTextRedactor();
  assert.equal(stream.write('Hello world. '), 'Hello world. ');
  assert.equal(stream.write('第二片正常文本。'), '第二片正常文本。');
  assert.equal(stream.finish(), '');
  assert.throws(() => createModelTextRedactor({ maxPendingBytes: 0 }), /bound/);
});
