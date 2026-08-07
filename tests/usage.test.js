'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeUsage,
  estimateUsage,
  resolvePricing,
  computeCost,
  aggregate,
} = require('../src/ai/usage');

describe('normalizeUsage', () => {
  it('reads OpenAI-style fields including cached tokens', () => {
    assert.deepEqual(normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 60 },
    }), {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 60,
      estimated: false,
    });
  });

  it('reads Anthropic-style gateway fields', () => {
    assert.deepEqual(normalizeUsage({ input_tokens: 8, output_tokens: 3 }), {
      inputTokens: 8,
      outputTokens: 3,
      cachedInputTokens: 0,
      estimated: false,
    });
  });

  it('adds Anthropic cache-read and cache-creation tokens to total input', () => {
    assert.deepEqual(normalizeUsage({
      input_tokens: 8,
      output_tokens: 3,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 4,
    }), {
      inputTokens: 72,
      outputTokens: 3,
      cachedInputTokens: 60,
      estimated: false,
    });
  });

  it('returns null for junk', () => {
    assert.equal(normalizeUsage(null), null);
    assert.equal(normalizeUsage({}), null);
    assert.equal(normalizeUsage({ prompt_tokens: 'x' }), null);
    assert.equal(normalizeUsage({ prompt_tokens: '', completion_tokens: false }), null);
    assert.equal(normalizeUsage({ prompt_tokens: -1, completion_tokens: 1 }), null);
  });
});

describe('estimateUsage', () => {
  it('estimates messages and content and marks the result estimated', () => {
    const usage = estimateUsage(
      [{ role: 'user', content: 'a'.repeat(400) }],
      'b'.repeat(80),
    );
    assert.equal(usage.estimated, true);
    assert.ok(usage.inputTokens >= 100);
    assert.equal(usage.outputTokens, 20);
    assert.equal(usage.cachedInputTokens, 0);
  });
});

describe('resolvePricing / computeCost', () => {
  const pricing = [
    { modelPrefix: 'gpt-4o', inputPerM: 2.5, outputPerM: 10 },
    { modelPrefix: 'gpt-4o-mini', inputPerM: 0.15, outputPerM: 0.6 },
  ];

  it('uses the longest matching prefix', () => {
    assert.equal(resolvePricing('gpt-4o-mini-2024', pricing).inputPerM, 0.15);
    assert.equal(resolvePricing('gpt-4o-2024-11-20', pricing).inputPerM, 2.5);
    assert.equal(resolvePricing('claude-3', pricing), null);
  });

  it('computes per-million cost without a cached-token discount', () => {
    const cost = computeCost(
      { inputTokens: 1000000, outputTokens: 500000, cachedInputTokens: 400000 },
      { modelPrefix: 'x', inputPerM: 2, outputPerM: 10 },
    );
    assert.equal(cost, 7);
  });

  it('returns null without pricing', () => {
    assert.equal(computeCost({ inputTokens: 1, outputTokens: 1 }, null), null);
  });
});

describe('aggregate', () => {
  const records = [
    { ts: 1785000000000, session: 's1', model: 'm1', kind: 'main', in: 100, out: 10, est: false, cost: 0.01 },
    { ts: 1785000060000, session: 's1', model: 'm1', kind: 'explore', in: 200, out: 20, est: true, cost: null },
    { ts: 1785086400000, session: 's2', model: 'm2', kind: 'main', in: 300, out: 30, est: false, cost: 0.03 },
  ];

  it('computes totals with estimatedShare and null-safe cost', () => {
    const { totals } = aggregate(records, { groupBy: 'kind' });
    assert.equal(totals.in, 600);
    assert.equal(totals.out, 60);
    assert.ok(Math.abs(totals.cost - 0.04) < 1e-9);
    assert.ok(totals.estimatedShare > 0.3 && totals.estimatedShare < 0.4);
  });

  it('groups by kind and local calendar day', () => {
    const byKind = aggregate(records, { groupBy: 'kind' }).groups;
    assert.deepEqual(byKind.map((group) => group.key).sort(), ['explore', 'main']);
    assert.equal(aggregate(records, { groupBy: 'day' }).groups.length, 2);
  });

  it('falls back to model for an unknown groupBy', () => {
    const groups = aggregate(records, { groupBy: 'unknown' }).groups;
    assert.deepEqual(groups.map((group) => group.key).sort(), ['m1', 'm2']);
  });

  it('defensively ignores invalid and negative numeric fields', () => {
    const { totals } = aggregate([
      { ts: 1, model: 'm', in: Infinity, out: -2, est: true, cost: -1 },
    ]);
    assert.deepEqual(totals, { in: 0, out: 0, cost: 0, estimatedShare: 0 });
  });
});
