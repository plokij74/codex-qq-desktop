'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ModelError, safeError } = require('../src/ai/model-adapters/common');
const { safeHeaders, createRequestContext, postJson } = require('../src/ai/model-adapters/transport');
// Every credential in this file is fixture and registered only in memory.
const { defaultSecretManager, redactSecrets } = require('../src/ai/secret-manager');
const { redactModelPartialOutput } = require('../src/ai/model-text-redaction');
const project = (...args) => require('../src/ai/model-errors').publicModelError(...args);
const fake = 'e4-public-error-fixture-only-987654321';
defaultSecretManager.registerSecret(fake, 'E4_PUBLIC_ERROR_TEST');
const redaction = { redactMessage: redactModelPartialOutput, redactPartial: redactModelPartialOutput };

function assertPublic(dto) {
  const allowed = new Set(['code', 'safeMessage', 'message', 'retryable', 'httpStatus', 'requestId', 'retryAfterMs', 'partialOutput', 'modelSource']);
  assert.equal(Object.getPrototypeOf(dto), Object.prototype);
  assert.ok(Object.keys(dto).every(key => allowed.has(key)));
  assert.equal(typeof dto.code, 'string');
  assert.equal(typeof dto.safeMessage, 'string');
  assert.equal(typeof dto.retryable, 'boolean');
  assert.equal(dto.message, dto.safeMessage);
  assert.deepEqual(JSON.parse(JSON.stringify(dto)), dto);
}

test('ModelError adds compatible safe metadata without changing legacy aliases or ABORTED', () => {
  const error = new ModelError('MODEL_RATE_LIMITED', 'A controlled message.', { status: 429, retryAfter: 3, requestId: 'req_fixture_1', attemptId: 'attempt_fixture_1', usage: { source: 'unavailable' } });
  assert.equal(error.code, 'MODEL_RATE_LIMITED');
  assert.equal(error.status, 429); assert.equal(error.retryAfter, 3);
  assert.equal(error.safeMessage, 'A controlled message.'); assert.equal(error.retryable, true);
  assert.equal(error.httpStatus, 429); assert.equal(error.retryAfterMs, 3000);
  assert.equal(error.attemptId, 'attempt_fixture_1'); assert.deepEqual(error.usage, { source: 'unavailable' });
  const cancelled = new ModelError('ABORTED', 'Cancelled.');
  assert.equal(cancelled.code, 'ABORTED'); assert.equal(cancelled.retryable, false);
  assert.equal(safeError(cancelled), cancelled);
});

test('new safe metadata supplies legacy aliases and explicit false never becomes a retry', () => {
  const error = new ModelError('MODEL_RATE_LIMIT', 'Internal private message.', { safeMessage: 'Please try a new attempt later.', httpStatus: 429, retryAfterMs: 2500, retryable: false });
  assert.equal(error.status, 429); assert.equal(error.retryAfter, 2.5);
  assert.equal(error.httpStatus, 429); assert.equal(error.retryAfterMs, 2500);
  assert.equal(error.safeMessage, 'Please try a new attempt later.'); assert.equal(error.retryable, false);
  const dto = project(error);
  assert.equal(dto.safeMessage, error.safeMessage); assert.equal(dto.retryable, false); assertPublic(dto);
});

const mappings = [
  ['MODEL_FORBIDDEN', 'MODEL_PERMISSION_DENIED'], ['MODEL_RATE_LIMITED', 'MODEL_RATE_LIMIT'],
  ['MODEL_CONNECTION_FAILED', 'MODEL_NETWORK'], ['MODEL_UPSTREAM_ERROR', 'MODEL_NETWORK'],
  ['MODEL_PROTOCOL_ERROR', 'MODEL_PROTOCOL'], ['MODEL_BAD_REQUEST', 'MODEL_PROTOCOL'],
  ['MODEL_LIMIT_EXCEEDED', 'MODEL_LIMIT'], ['MODEL_AUTH_REQUIRED', 'MODEL_CREDENTIAL_UNAVAILABLE'], ['ABORTED', 'MODEL_CANCELLED'],
];
for (const [legacy, canonical] of mappings) {
  test(`public code ${legacy} maps to ${canonical} without exposing legacyCode`, () => {
    const error = new ModelError(legacy, 'A controlled fixed reason.');
    const dto = project(error);
    assert.equal(dto.code, canonical); assert.equal(error.code, legacy);
    assert.equal(Object.hasOwn(dto, 'legacyCode'), false); assertPublic(dto);
  });
}

test('canonical spec categories survive and non-transient failures never suggest retrying', () => {
  const codes = ['MODEL_CONFIG_INVALID', 'MODEL_CREDENTIAL_UNAVAILABLE', 'MODEL_AUTH_FAILED', 'MODEL_PERMISSION_DENIED', 'MODEL_NOT_FOUND', 'MODEL_CAPABILITY_UNSUPPORTED', 'MODEL_CAPABILITY_UNKNOWN', 'MODEL_CONTEXT_LIMIT', 'MODEL_LIMIT', 'MODEL_PROTOCOL', 'MODEL_EMPTY_RESPONSE', 'MODEL_CANCELLED'];
  for (const code of codes) {
    const error = new ModelError(code, 'Safe reason.', { status: 503, retryable: true });
    assert.equal(error.retryable, false, code);
    const dto = project(error); assert.equal(dto.code, code); assert.equal(dto.retryable, false, code);
  }
  for (const code of ['MODEL_SCHEMA_UNSUPPORTED', 'MODEL_FEATURE_UNSUPPORTED', 'MODEL_INPUT_INVALID', 'MODEL_BINDING_INVALID', 'MODEL_TOOL_INVALID']) {
    assert.equal(project(new ModelError(code, 'Safe reason.', { status: 503, retryable: true })).retryable, false, code);
  }
});

test('existing main acceptance role and sender errors map to model configuration, not business codes', () => {
  for (const code of ['MODEL_MESSAGE_ROLE_INVALID', 'MODEL_SENDER_INVALID']) {
    const error = new ModelError(code, 'A controlled acceptance reason.', { status: 503, retryable: true });
    const dto = project(error);
    assert.equal(error.code, code); assert.equal(dto.code, 'MODEL_CONFIG_INVALID'); assert.equal(dto.retryable, false);
    const ordinary = Object.assign(new Error(fake), { code });
    assert.equal(project(ordinary).code, 'MODEL_CONFIG_INVALID'); assert.equal(JSON.stringify(project(ordinary)).includes(fake), false);
    assertPublic(dto);
  }
});

test('retryable means an explicit new attempt only for known rate, 5xx, network or timeout failures', () => {
  for (const [code, status, expected] of [
    ['MODEL_RATE_LIMITED', 429, true], ['MODEL_UPSTREAM_ERROR', 500, true], ['MODEL_UPSTREAM_ERROR', 503, true],
    ['MODEL_UPSTREAM_ERROR', 418, false], ['MODEL_UPSTREAM_ERROR', undefined, false],
    ['MODEL_CONNECTION_FAILED', undefined, true], ['MODEL_TIMEOUT', undefined, true], ['MODEL_REDIRECT_REFUSED', 302, false],
  ]) {
    const error = new ModelError(code, 'Safe fixed reason.', status === undefined ? {} : { status });
    assert.equal(error.retryable, expected, `${code}/${status}`);
    assert.equal(project(error).retryable, expected, `${code}/${status}`);
  }
});

test('required capability classification reads explicit safe code/state, never error text or body', () => {
  const error = new ModelError('MODEL_CAPABILITY_REQUIRED', 'Unsupported tools 400 - do not classify this text.');
  error.body = { unsupported: true }; error.cause = { capabilityState: 'unsupported' };
  assert.equal(project(error).code, 'MODEL_CAPABILITY_UNKNOWN');
  error.capabilityState = 'unsupported'; assert.equal(project(error).code, 'MODEL_CAPABILITY_UNSUPPORTED');
  error.capabilityState = 'unknown'; assert.equal(project(error).code, 'MODEL_CAPABILITY_UNKNOWN');
  error.publicCode = 'MODEL_CAPABILITY_UNSUPPORTED'; assert.equal(project(error).code, 'MODEL_CAPABILITY_UNSUPPORTED');
  error.publicCode = 'secret_or_noncanonical'; error.capabilityState = 'supported'; assert.equal(project(error).code, 'MODEL_CAPABILITY_UNKNOWN');
  assert.equal(project(error, { capabilityState: 'unsupported' }).code, 'MODEL_CAPABILITY_UNSUPPORTED');
  assert.equal(project(error, { publicCode: 'MODEL_CAPABILITY_UNKNOWN', capabilityState: 'unsupported' }).code, 'MODEL_CAPABILITY_UNKNOWN');
});

test('ordinary model-coded Error has a safe canonical fixed reason, not raw message or forged safeMessage', () => {
  const error = Object.assign(new Error(`Private upstream body ${fake}`), { code: 'MODEL_BAD_REQUEST', safeMessage: `Forged safe message ${fake}`, body: { unsupported: true }, status: 400 });
  const dto = project(error, redaction);
  assert.equal(dto.code, 'MODEL_PROTOCOL'); assert.equal(dto.httpStatus, 400); assert.equal(dto.retryable, false);
  assert.equal(dto.safeMessage.includes('Private'), false); assert.equal(dto.safeMessage.includes('Forged'), false); assertPublic(dto);
});

test('unknown thrown values fail closed even when they look like a ModelError or carry secrets', () => {
  const baseline = project(new Error('Private reference or secret.'));
  for (const error of [null, undefined, fake, 42, new Error(fake), { name: 'ModelError', message: fake, safeMessage: fake, code: 'UNRECOGNIZED', status: 503, retryable: true, partialOutput: fake }, Object.assign(new Error(fake), { code: 'BUSY' })]) {
    const dto = project(error);
    assert.equal(dto.code, 'MODEL_NETWORK'); assert.equal(dto.retryable, false);
    assert.equal(dto.safeMessage, baseline.safeMessage); assert.equal(JSON.stringify(dto).includes(fake), false);
    assert.equal(dto.partialOutput, undefined); assertPublic(dto);
  }
});

test('trusted callers must explicitly preserve each business code and provide a fixed safe reason', () => {
  const error = Object.assign(new Error(`Raw business reason ${fake}`), { code: 'BUSY', safeMessage: `Forged business reason ${fake}` });
  const dto = project(error, { ...redaction, preserveCodes: ['BUSY', 'PLAN_BINDING_CHANGED'], safeMessage: 'A foreground request is already running.' });
  assert.equal(dto.code, 'BUSY'); assert.equal(dto.safeMessage, 'A foreground request is already running.'); assert.equal(dto.retryable, false); assertPublic(dto);
  assert.equal(project(error, { preserveCodes: ['PLAN_BINDING_CHANGED'], safeMessage: fake }).code, 'MODEL_NETWORK');
  const fixed = project(error, { preserveCodes: new Set(['BUSY']) });
  assert.equal(fixed.code, 'BUSY'); assert.equal(fixed.safeMessage.includes('Raw business'), false);
  assert.equal(project(new ModelError('MODEL_FORBIDDEN', 'Safe.'), { preserveCodes: ['MODEL_FORBIDDEN'] }).code, 'MODEL_PERMISSION_DENIED');
});

test('a ModelError safeMessage is independent of a subsequently polluted legacy message', () => {
  const error = new ModelError('MODEL_AUTH_FAILED', `Internal reason ${fake}`, { safeMessage: 'The provider rejected authentication.' });
  error.message = `Later raw body ${fake}`;
  assert.equal(project(error).safeMessage, 'The provider rejected authentication.');
});

test('default projection and main callbacks redact full model echoes and withheld secret prefixes', () => {
  for (const options of [{}, redaction]) {
    const error = new ModelError('MODEL_NETWORK', `A safe introduction. ${fake}`);
    error.partialOutput = `An incomplete answer. ${fake.slice(0, -1)}`;
    const dto = project(error, options);
    assert.equal(dto.safeMessage, `A safe introduction. ${redactSecrets(fake)}`);
    assert.equal(dto.partialOutput, 'An incomplete answer. ');
    assert.equal(JSON.stringify(dto).includes(fake.slice(0, -1)), false); assertPublic(dto);
  }
});

test('projection callbacks fail closed and never coerce objects, promises or thrown messages', () => {
  const error = new ModelError('MODEL_NETWORK', `A controlled model echo ${fake}`); error.partialOutput = fake;
  const baseline = project(new Error('ignored'));
  for (const redact of [() => { throw new Error(fake); }, () => ({ toString: () => fake }), async () => fake, null]) {
    const dto = project(error, { redactMessage: redact, redactPartial: redact });
    assert.equal(dto.safeMessage, baseline.safeMessage); assert.equal(dto.partialOutput, undefined);
    assert.equal(JSON.stringify(dto).includes(fake), false); assertPublic(dto);
  }
});

test('HTTP status, request id and retry-after metadata are bounded and no raw headers are projected', () => {
  const error = new ModelError('MODEL_RATE_LIMITED', 'Safe.', { status: 429, retryAfter: '3', requestId: 'req_fixture:1' });
  error.headers = { authorization: fake }; error.body = fake; error.upstreamCode = fake;
  const dto = project(error);
  assert.equal(dto.httpStatus, 429); assert.equal(dto.retryAfterMs, 3000); assert.equal(dto.requestId, 'req_fixture:1'); assertPublic(dto);
  for (const value of [0, 600, -1, 429.5, '429', NaN, Infinity, {}, []]) {
    const invalid = new ModelError('MODEL_NETWORK', 'Safe.'); invalid.httpStatus = value; invalid.status = value;
    assert.equal(project(invalid).httpStatus, undefined, String(value));
  }
  for (const value of [fake, fake.slice(0, -1), 'bad\nrequest', 'x'.repeat(129), {}, ['req']]) {
    const invalid = new ModelError('MODEL_NETWORK', 'Safe.'); invalid.requestId = value;
    assert.equal(project(invalid, redaction).requestId, undefined);
  }
});

test('Retry-After supports bounded seconds and milliseconds without guessing from error bodies', () => {
  for (const [value, expected] of [[0, 0], [3, 3000], ['003', 3000], [86400, 86400000]]) {
    const error = new ModelError('MODEL_RATE_LIMITED', 'Safe.', { retryAfter: value });
    assert.equal(error.retryAfterMs, expected); assert.equal(project(error).retryAfterMs, expected);
  }
  for (const value of [-1, '1.5', 86401, '999999999999999999', 'tomorrow', '3\r\nauthorization: fixture', Infinity, {}]) {
    const error = new ModelError('MODEL_RATE_LIMITED', 'Safe.', { retryAfter: value });
    assert.equal(project(error).retryAfterMs, undefined);
  }
  for (const value of [-1, 86400001, 1.5, '3000', NaN, Infinity, {}]) {
    const error = new ModelError('MODEL_RATE_LIMITED', 'Safe.'); error.retryAfterMs = value;
    assert.equal(project(error).retryAfterMs, undefined);
  }
  const error = new ModelError('MODEL_RATE_LIMITED', 'Safe.'); error.body = { retry_after: 3 };
  assert.equal(project(error).retryAfterMs, undefined);
});

test('safeHeaders keeps legacy seconds, adds milliseconds and rejects sent credentials and overflow', () => {
  const response = headers => ({ headers: new Headers(headers) });
  assert.deepEqual(safeHeaders(response({ 'x-request-id': 'req_fixture_1', 'retry-after': '3' })), { requestId: 'req_fixture_1', retryAfter: 3, retryAfterMs: 3000 });
  assert.deepEqual(safeHeaders(response({ 'x-request-id': fake, 'retry-after': '86401' }), { Authorization: `Bearer ${fake}` }), {});
  assert.deepEqual(safeHeaders(response({ 'request-id': `req_${fake}`, 'retry-after': '3' }), { 'X-API-Key': fake }), { retryAfter: 3, retryAfterMs: 3000 });
  assert.deepEqual(safeHeaders(response({ 'x-request-id': 'x'.repeat(129), 'retry-after': '1.5' })), {});
});

test('modelSource is a bounded fresh record whitelist, never a polluted resolved binding', () => {
  const source = { kind: 'api', providerId: 'provider_fixture', providerName: 'Fixture provider', modelProfileId: 'model_fixture', modelProfileName: 'Fixture model', assistantId: 'assistant_fixture', assistantName: 'Fixture assistant', model: 'm'.repeat(256), protocol: 'openai-chat-completions', providerRevision: 1, modelRevision: 2, assistantRevision: 3, runId: 'run_fixture', clientRequestId: 'request_fixture_1', bindingRevision: 'a'.repeat(64), secretRef: fake, apiKey: fake, provider: { auth: { secretRef: fake } }, baseUrl: `https://fixture.invalid/private?token=${fake}`, providerState: { raw: fake }, ownerId: 1 };
  const error = new ModelError('MODEL_NETWORK', 'Safe.', { modelSource: source });
  const dto = project(error, redaction);
  assert.notEqual(dto.modelSource, source); assert.equal(dto.modelSource.model.length, 256);
  assert.equal(dto.modelSource.providerRevision, 1); assert.equal(dto.modelSource.clientRequestId, 'request_fixture_1');
  const allowed = new Set(['kind', 'providerId', 'providerName', 'modelProfileId', 'modelProfileName', 'assistantId', 'assistantName', 'model', 'protocol', 'providerRevision', 'modelRevision', 'assistantRevision', 'runId', 'clientRequestId', 'bindingRevision']);
  assert.ok(Object.keys(dto.modelSource).every(key => allowed.has(key)));
  assert.equal(JSON.stringify(dto).includes(fake), false); assertPublic(dto);
  const override = { ...source, runId: 'accepted_run_fixture_1', secretRef: fake };
  assert.equal(project(error, { ...redaction, modelSource: override }).modelSource.runId, 'accepted_run_fixture_1');
  assert.equal(override.secretRef, fake);
});

test('invalid source values, arrays, inherited fields and accessor pollution are not serialized', () => {
  const error = new ModelError('MODEL_NETWORK', 'Safe.');
  for (const source of [[], fake, true, { kind: 'invalid', providerId: 'p' }, Object.create({ kind: 'api', providerId: fake })]) {
    error.modelSource = source; assert.equal(project(error).modelSource, undefined);
  }
  let reads = 0;
  const source = { kind: 'api', protocol: 'untrusted-protocol', model: { private: fake }, providerRevision: -1, modelRevision: Infinity, assistantRevision: '3', providerId: fake, runId: 'r'.repeat(161), apiKey: fake };
  Object.defineProperty(source, 'assistantName', { enumerable: true, get() { reads++; throw new Error(fake); } });
  error.modelSource = source;
  const dto = project(error, redaction);
  assert.deepEqual(dto.modelSource, { kind: 'api' }); assert.equal(reads, 0); assertPublic(dto);
});

test('projection does not serialize cause, stack, attempt usage, private state or input toJSON', () => {
  let serializations = 0;
  const error = new ModelError('MODEL_PROTOCOL_ERROR', 'Safe fixed error.', { status: 400, attemptId: 'private_attempt_fixture', usage: { private: fake } });
  Object.assign(error, { cause: new Error(fake), stack: fake, body: fake, header: fake, secretRef: fake, providerState: { raw: fake }, privateSource: fake, toJSON() { serializations++; return { private: fake }; } });
  const dto = project(error);
  assert.equal(serializations, 0); assert.equal(JSON.stringify(dto).includes(fake), false); assertPublic(dto);
});

test('message and partial bounds fail closed rather than creating a secret prefix by truncation', () => {
  const error = new ModelError('MODEL_NETWORK', 'x'.repeat(2048) + fake); error.partialOutput = '😀'.repeat(16384) + fake;
  const dto = project(error, redaction);
  assert.ok(dto.safeMessage.length <= 2048); assert.ok(Buffer.byteLength(dto.partialOutput || '', 'utf8') <= 65536);
  assert.equal(dto.safeMessage.includes(fake), false); assert.equal((dto.partialOutput || '').includes(fake), false);
  const bounded = new ModelError('MODEL_NETWORK', 'Safe.'); bounded.partialOutput = '😀'.repeat(16384);
  assert.equal(Buffer.byteLength(project(bounded).partialOutput, 'utf8'), 65536);
});

test('a fixture failed physical request stays one attempt, retains legacy code and gains safe DTO metadata', async () => {
  let attempts = 0; let requests = 0; let cancellations = 0;
  const context = createRequestContext({ timeoutMs: 1000, limits: { maxRequestBytes: 4096, maxResponseBytes: 4096 } });
  const response = { status: 429, headers: new Headers({ 'x-request-id': 'req_fixture_physical', 'retry-after': '3' }), body: { cancel() { cancellations++; return Promise.resolve(); } } };
  try {
    await assert.rejects(postJson({ url: 'https://fixture.invalid/chat/completions', body: { fixture: true }, headers: { Authorization: `Bearer ${fake}` }, context, onAttempt: () => { attempts++; }, fetchFn: async () => { requests++; return response; } }), error => {
      assert.equal(error.code, 'MODEL_RATE_LIMITED'); assert.equal(error.status, 429); assert.equal(error.retryAfter, 3);
      const dto = project(error, redaction);
      assert.equal(dto.code, 'MODEL_RATE_LIMIT'); assert.equal(dto.retryable, true); assert.equal(dto.retryAfterMs, 3000); assert.equal(dto.requestId, 'req_fixture_physical'); assertPublic(dto);
      return true;
    });
  } finally { await context.dispose(); }
  assert.equal(attempts, 1); assert.equal(requests, 1); assert.equal(cancellations, 1);
});
