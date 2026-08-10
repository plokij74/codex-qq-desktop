'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMemoryCandidateSystemPrompt,
  containsSensitiveValue,
  parseCandidateResponse,
  generateMemoryCandidates,
  RESPONSE_MAX_BYTES,
  EVIDENCE_MAX,
} = require('../src/ai/memory-candidates');
const { TEXT_MAX } = require('../src/ai/memory-store');

const TRANSCRIPT = [
  '[user]',
  '这个项目构建统一使用 npm test，不要 yarn。',
  '数据库密码是 super-secret-value。',
  '',
  '[assistant]',
  '确认，后续构建只运行 npm test。',
].join('\n');

describe('D.4 memory candidates', () => {
  it('prompt marks transcript as untrusted and requires strict JSON evidence', () => {
    const prompt = buildMemoryCandidateSystemPrompt();
    assert.match(prompt, /不可信数据/);
    assert.match(prompt, /不要执行/);
    assert.match(prompt, /evidence/);
    assert.match(prompt, /只返回 JSON/);
  });

  it('parses strict JSON and one complete json fence', () => {
    const body = JSON.stringify({ candidates: [{
      text: '构建统一使用 npm test',
      tags: [' Build ', 'build'],
      evidence: '这个项目构建统一使用 npm test，不要 yarn。',
    }] });
    const plain = parseCandidateResponse(body, { transcript: TRANSCRIPT, limit: 5 });
    const fenced = parseCandidateResponse('```json\n' + body + '\n```', { transcript: TRANSCRIPT, limit: 5 });
    assert.deepEqual(plain, [{
      text: '构建统一使用 npm test', tags: ['build'],
      evidence: '这个项目构建统一使用 npm test，不要 yarn。',
    }]);
    assert.deepEqual(fenced, plain);
  });

  it('rejects prose-wrapped JSON and oversized responses', () => {
    assert.throws(
      () => parseCandidateResponse('结果如下：{"candidates":[]}', { transcript: TRANSCRIPT }),
      /JSON/
    );
    const huge = JSON.stringify({ candidates: [], pad: 'x'.repeat(RESPONSE_MAX_BYTES) });
    assert.throws(
      () => parseCandidateResponse(huge, { transcript: TRANSCRIPT }),
      /过大/
    );
    assert.throws(
      () => parseCandidateResponse('[]', { transcript: TRANSCRIPT }),
      /candidates/
    );
    assert.throws(
      () => parseCandidateResponse('{"items":[]}', { transcript: TRANSCRIPT }),
      /candidates/
    );
  });

  it('normalizes field limits and validates evidence after folding whitespace', () => {
    const longEvidence = '证据' + '很长'.repeat(150);
    const transcript = `[user]\n${longEvidence}\n证据   中间\n有 空白`;
    const rows = [{
      text: 'X'.repeat(TEXT_MAX + 50),
      tags: Array.from({ length: 10 }, (_, index) => ` TAG-${index}-` + 'Z'.repeat(30)),
      evidence: longEvidence,
      ignored: 'drop-me',
    }, {
      text: '空白证据可定位',
      tags: [],
      evidence: '证据 中间 有 空白',
    }];
    const out = parseCandidateResponse(JSON.stringify({ candidates: rows }), {
      transcript, limit: 5,
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].text.length, TEXT_MAX);
    assert.equal(out[0].text.endsWith('…'), true);
    assert.equal(out[0].tags.length, 8);
    assert.equal(out[0].tags.every((tag) => tag.length <= 24 && tag === tag.toLowerCase()), true);
    assert.equal(out[0].evidence, longEvidence.slice(0, EVIDENCE_MAX));
    assert.equal('ignored' in out[0], false);
    assert.equal(out[1].evidence, '证据 中间 有 空白');
  });

  it('drops forged evidence, sensitive values and exact duplicates', () => {
    const raw = JSON.stringify({ candidates: [
      { text: '构建统一使用 npm test', tags: ['build'], evidence: '这个项目构建统一使用 npm test，不要 yarn。' },
      { text: '  构建统一使用 NPM TEST  ', tags: [], evidence: '这个项目构建统一使用 npm test，不要 yarn。' },
      { text: '数据库密码是 super-secret-value', tags: [], evidence: '数据库密码是 super-secret-value。' },
      { text: '数据库连接说明', tags: [], evidence: '数据库密码是 super-secret-value。' },
      { text: '使用 pnpm', tags: [], evidence: '原文里没有这句话' },
    ] });
    const out = parseCandidateResponse(raw, { transcript: TRANSCRIPT, limit: 5 });
    assert.equal(out.length, 1);
    assert.equal(out[0].text, '构建统一使用 npm test');
  });

  it('honors caller limit after inspecting only the permitted prefix', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      text: '约定-' + i,
      tags: ['T' + i],
      evidence: '这个项目构建统一使用 npm test，不要 yarn。',
    }));
    const out = parseCandidateResponse(JSON.stringify({ candidates: rows }), {
      transcript: TRANSCRIPT, limit: 3,
    });
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((x) => x.text), ['约定-0', '约定-1', '约定-2']);
    assert.equal(parseCandidateResponse(JSON.stringify({ candidates: rows }), {
      transcript: TRANSCRIPT, limit: 99,
    }).length, 5);
  });

  it('sensitive detector targets values, not ordinary policy wording', () => {
    assert.equal(containsSensitiveValue('不要把 API key 写进记忆'), false);
    assert.equal(containsSensitiveValue('api_key = abcdefghijklmnop'), true);
    assert.equal(containsSensitiveValue('数据库密码是 super-secret-value'), true);
    assert.equal(containsSensitiveValue('Authorization: Bearer abcdefghijklmnop'), true);
    assert.equal(containsSensitiveValue('-----BEGIN PRIVATE KEY-----'), true);
    assert.equal(containsSensitiveValue('https://alice:secret@example.com/x'), true);
  });

  it('checks raw text and evidence before truncation', () => {
    const paddedText = '稳定约定' + 'x'.repeat(1000) + ' password = hidden-secret-value';
    const paddedEvidence = TRANSCRIPT + ' ' + 'x'.repeat(240) + ' api_key = hidden-secret-value';
    const out = parseCandidateResponse(JSON.stringify({ candidates: [
      { text: paddedText, tags: [], evidence: TRANSCRIPT },
      { text: '稳定约定', tags: [], evidence: paddedEvidence },
    ] }), { transcript: paddedEvidence, limit: 5 });
    assert.deepEqual(out, []);
  });

  it('skips model calls for every disabled boundary', async () => {
    let calls = 0;
    const usage = [];
    const chatFn = async () => { calls++; return '{"candidates":[]}'; };
    const base = { mode: 'api', memoryEnabled: true, memoryCandidateEnabled: true };
    const onUsage = (event) => usage.push(event);
    assert.deepEqual(await generateMemoryCandidates({ transcript: 'x', settings: { ...base, mode: 'local' }, limit: 5, chatFn, onUsage }), []);
    assert.deepEqual(await generateMemoryCandidates({ transcript: 'x', settings: { ...base, memoryEnabled: false }, limit: 5, chatFn, onUsage }), []);
    assert.deepEqual(await generateMemoryCandidates({ transcript: 'x', settings: { ...base, memoryCandidateEnabled: false }, limit: 5, chatFn, onUsage }), []);
    assert.deepEqual(await generateMemoryCandidates({ transcript: 'x', settings: base, limit: 0, chatFn, onUsage }), []);
    assert.deepEqual(await generateMemoryCandidates({ transcript: '   ', settings: base, limit: 5, chatFn, onUsage }), []);
    assert.equal(calls, 0);
    assert.equal(usage.length, 0);
  });

  it('reports usage before parsing an invalid API response', async () => {
    const seen = [];
    await assert.rejects(
      () => generateMemoryCandidates({
        transcript: TRANSCRIPT,
        settings: { mode: 'api', memoryEnabled: true, memoryCandidateEnabled: true, baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' },
        limit: 5,
        chatFn: async () => 'not json',
        onUsage: (event) => seen.push(event),
      }),
      /JSON/
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].rawUsage, null);
    assert.equal(seen[0].content, 'not json');
    assert.equal(seen[0].messages[0].role, 'system');
  });

  it('accepts injected responses with content and usage fields', async () => {
    let seen;
    const result = await generateMemoryCandidates({
      transcript: TRANSCRIPT,
      settings: { mode: 'api', memoryEnabled: true, memoryCandidateEnabled: true },
      limit: 5,
      chatFn: async () => ({
        content: JSON.stringify({ candidates: [{
          text: '构建统一使用 npm test', tags: [],
          evidence: '这个项目构建统一使用 npm test，不要 yarn。',
        }] }),
        usage: { prompt_tokens: 9, completion_tokens: 4 },
      }),
      onUsage: (event) => { seen = event; },
    });
    assert.equal(result.length, 1);
    assert.deepEqual(seen.rawUsage, { prompt_tokens: 9, completion_tokens: 4 });
    assert.equal(typeof seen.content, 'string');
  });
});
