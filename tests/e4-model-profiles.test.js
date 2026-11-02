'use strict';

// All providers, credentials and observations in this file are isolated synthetic data.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createModelRegistry, validateModelRegistry, publicModelRegistry,
  computeBindingRevision, normalizeModelEndpoint, effectiveModelCapabilities,
  resolveModelBinding, isResolvedModelBinding, updateModelRegistry,
  saveProfile, removeProfile, applyObservedCapabilities,
} = require('../src/ai/model-profiles');

const copy = (value) => JSON.parse(JSON.stringify(value));
const initial = () => createModelRegistry({
  baseUrl: 'https://synthetic.example/gateway/v1/chat/completions',
  model: 'synthetic-model', secretRef: 'sec_main_api_key', apiKeyConfigured: true,
});
const invalid = (fn) => assert.throws(fn, { code: 'MODEL_CONFIG_INVALID' });
const declared = (state) => ({ state, source: 'declared' });
function secondModel(registry) {
  return saveProfile(registry, 'model', {
    id: 'model_second', name: 'Second', providerId: registry.providers[0].id,
    model: 'synthetic-second',
  });
}
function observed(registry, capability = 'text') {
  const value = copy(registry);
  value.models[0].capabilities[capability] = {
    state: 'supported', source: 'observed', checkedAt: '2026-10-29T00:00:00.000Z',
    bindingRevision: computeBindingRevision(value.providers[0], value.models[0]),
  };
  return validateModelRegistry(value);
}

test('registry uses stable legacy and built-in identities with unknown capabilities', () => {
  const r = initial();
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.revision, 1);
  assert.equal(r.defaultModelProfileId, 'model_legacy_default');
  assert.equal(r.providers[0].id, 'provider_legacy_openai');
  assert.equal(r.models[0].id, 'model_legacy_default');
  assert.equal(r.providers[0].baseUrl, 'https://synthetic.example/gateway/v1');
  assert.equal(r.models[0].request.maxOutputTokens, 4096);
  assert.equal(Object.hasOwn(r.models[0].request, 'temperature'), false);
  assert.deepEqual(r.models[0].capabilities.text, {
    state: 'unknown', source: 'unknown', checkedAt: null, bindingRevision: null,
  });
  assert.deepEqual(r.assistants.map((a) => a.id), ['assistant_codex', 'assistant_general']);
  assert.equal(r.assistants[0].identityType, 'ai');
  assert.deepEqual(r.assistants[0].toolPolicy, { mode: 'allowlist', allowedTools: ['@host-authorized'] });
  assert.deepEqual(r.assistants[1].knowledge, { projectContext: false, projectMemory: false });
  assert.deepEqual(r.assistants[1].toolPolicy, { mode: 'none', allowedTools: [] });
  assert.deepEqual(r.migration, { from: 'legacy-single-model', completed: true });
});

test('registry and validated results are independent deep clones', () => {
  const r = initial();
  const clone = validateModelRegistry(r);
  clone.models[0].request.maxOutputTokens = 8;
  clone.providers[0].auth.secretRef = 'synthetic_other_ref';
  assert.equal(r.models[0].request.maxOutputTokens, 4096);
  assert.equal(r.providers[0].auth.secretRef, 'sec_main_api_key');
  const existing = createModelRegistry({ modelRegistry: r, model: 'must-not-replace' });
  assert.deepEqual(existing, r);
  assert.notEqual(existing, r);
});

test('unknown higher schemas fail rather than downgrade', () => {
  const r = initial(); r.schemaVersion = 88;
  assert.throws(() => validateModelRegistry(r), { code: 'MODEL_REGISTRY_VERSION_UNSUPPORTED' });
  assert.throws(() => createModelRegistry({ modelRegistry: r }), { code: 'MODEL_REGISTRY_VERSION_UNSUPPORTED' });
});

test('schema rejects duplicates, invalid references, missing builtins and identity impersonation', () => {
  const mutations = [
    (r) => r.models.push(copy(r.models[0])),
    (r) => { r.defaultModelProfileId = 'missing'; },
    (r) => { r.models[0].providerId = 'missing'; },
    (r) => { r.assistants[0].modelProfileId = 'missing'; },
    (r) => { r.assistants.pop(); },
    (r) => { r.assistants[0].identityType = 'human'; },
    (r) => { r.assistants[0].builtIn = false; },
    (r) => { r.revision = 1.5; },
    (r) => { r.models[0].revision = 0; },
  ];
  for (const mutate of mutations) {
    const r = initial(); mutate(r); invalid(() => validateModelRegistry(r));
  }
});

test('configuration limits reject oversized values instead of truncating', () => {
  for (const [kind, field, length] of [
    ['providers', 'name', 129], ['providers', 'baseUrl', 2049],
    ['models', 'name', 129], ['models', 'model', 257],
    ['assistants', 'systemPrompt', 16385],
  ]) {
    const r = initial(); r[kind][0][field] = 'x'.repeat(length);
    invalid(() => validateModelRegistry(r));
  }
  for (const [kind, count] of [['providers', 33], ['models', 129], ['assistants', 129]]) {
    const r = initial();
    const template = copy(r[kind].at(-1));
    while (r[kind].length < count) r[kind].push({ ...copy(template), id: `${kind}_${r[kind].length}`, builtIn: false });
    invalid(() => validateModelRegistry(r));
  }
  const r = initial();
  r.assistants[0].toolPolicy = { mode: 'allowlist', allowedTools: Array.from({ length: 257 }, (_, i) => `tool_${i}`) };
  invalid(() => validateModelRegistry(r));
});

test('protocol, URL and authentication combinations are explicitly validated', () => {
  for (const url of [
    'file:///synthetic', 'https://user:synthetic@synthetic.example/v1',
    'https://synthetic.example/v1#fragment', 'https://synthetic.example/v1?api_key=synthetic',
    'https://synthetic.example/v1?Authorization=synthetic',
  ]) {
    const r = initial(); r.providers[0].baseUrl = url;
    invalid(() => validateModelRegistry(r));
  }
  const r = initial(); r.providers[0].protocol = 'unknown-protocol';
  invalid(() => validateModelRegistry(r));
  for (const kind of ['bearer', 'none']) {
    const value = initial(); value.providers[0].protocol = 'anthropic-messages';
    value.providers[0].auth.kind = kind;
    invalid(() => validateModelRegistry(value));
  }
  const none = initial(); none.providers[0].auth = { kind: 'none' };
  assert.equal(validateModelRegistry(none).providers[0].auth.kind, 'none');
});

test('authentication query aliases never become public endpoint configuration', () => {
  const secret = 'e4-fixture-query-private';
  for (const key of ['clientSecret', 'secretKey', 'client-secret', 'client_secret', 'accessToken', 'apiKey',
    'api.key', 'x-api-key', 'refreshToken', 'password', 'credentialValue', 'awsAccessKeyId', 'X-Amz-Signature']) {
    const raw = initial(); raw.providers[0].baseUrl = `https://fixture.example/v1?${encodeURIComponent(key)}=${secret}`;
    raw.providers[0].auth = { kind: 'none' };
    invalid(() => validateModelRegistry(raw));
    invalid(() => publicModelRegistry(raw));
    invalid(() => saveProfile(initial(), 'provider', { id: 'provider_legacy_openai', baseUrl: raw.providers[0].baseUrl }));
    invalid(() => normalizeModelEndpoint('openai-responses', raw.providers[0].baseUrl));
  }
  const benign = initial(); benign.providers[0].baseUrl = 'https://fixture.example/v1?api-version=2026-10-29&region=fixture';
  benign.providers[0].auth = { kind: 'none' };
  const dto = publicModelRegistry(validateModelRegistry(benign));
  assert.equal(dto.providers[0].baseUrl, 'https://fixture.example/v1?api-version=2026-10-29&region=fixture');
});

test('endpoint normalization preserves gateway prefixes and only removes its own operation', () => {
  assert.equal(normalizeModelEndpoint('openai-chat-completions', 'HTTPS://SYNTHETIC.EXAMPLE:443/gateway/v1/chat/completions/'), 'https://synthetic.example/gateway/v1/chat/completions');
  assert.equal(normalizeModelEndpoint('openai-responses', 'https://synthetic.example/gateway/responses'), 'https://synthetic.example/gateway/responses');
  assert.equal(normalizeModelEndpoint('anthropic-messages', 'https://synthetic.example/custom/v1/'), 'https://synthetic.example/custom/v1/messages');
  assert.equal(normalizeModelEndpoint('openai-responses', 'https://synthetic.example/chat/completions'), 'https://synthetic.example/chat/completions/responses');
  assert.equal(normalizeModelEndpoint('openai-responses', 'https://synthetic.example/v1?region=synthetic'), 'https://synthetic.example/v1/responses?region=synthetic');
});

test('HTTP origins need explicit matching confirmation on save and resolve', () => {
  let r = initial();
  const draft = { id: 'provider_local', name: 'Synthetic local', protocol: 'openai-chat-completions', baseUrl: 'http://127.0.0.1:19384/v1', auth: { kind: 'none' } };
  invalid(() => saveProfile(r, 'provider', draft));
  r = saveProfile(r, 'provider', { ...draft, transportConfirmation: { origin: 'http://127.0.0.1:19384', plainHttpAcceptedAt: '2026-10-29T00:00:00Z' } });
  r = saveProfile(r, 'model', { id: 'model_local', name: 'Local', providerId: 'provider_local', model: 'synthetic' });
  assert.equal(resolveModelBinding({ registry: r, modelProfileId: 'model_local' }).protocol, 'openai-chat-completions');
  const unconfirmed = copy(r); unconfirmed.providers[1].transportConfirmation.plainHttpAcceptedAt = null;
  invalid(() => resolveModelBinding({ registry: unconfirmed, modelProfileId: 'model_local' }));
  invalid(() => saveProfile(r, 'provider', { ...draft, baseUrl: 'http://127.0.0.1:19385/v1', transportConfirmation: r.providers[1].transportConfirmation }));
});

test('request and capability declarations reject invalid enum, range and source values', () => {
  for (const patch of [
    { request: { maxOutputTokens: 0 } }, { request: { maxOutputTokens: 32769 } },
    { request: { temperature: NaN } }, { request: { temperature: '0.7' } },
    { request: { chatTokenLimitField: 'guess' } },
    { compatibility: { toolMode: 'guess' } }, { compatibility: { streamMode: 'guess' } },
    { capabilities: { text: { state: 'healthy', source: 'declared' } } },
    { capabilities: { text: { state: 'supported', source: 'unknown' } } },
    { capabilities: { contextWindow: { tokens: -1, source: 'declared' } } },
  ]) {
    const r = initial(); Object.assign(r.models[0], patch);
    invalid(() => validateModelRegistry(r));
  }
  const r = saveProfile(initial(), 'model', { id: 'model_legacy_default', capabilities: { text: declared('supported'), nativeTools: declared('unsupported'), contextWindow: { tokens: 8192, source: 'declared' } } });
  assert.equal(r.models[0].capabilities.text.source, 'declared');
  assert.equal(r.models[0].capabilities.nativeTools.state, 'unsupported');
  assert.equal(r.models[0].capabilities.contextWindow.tokens, 8192);
});

test('wire fingerprints ignore display/entity revisions and capability results', () => {
  const r = initial();
  const a = computeBindingRevision(r.providers[0], r.models[0]);
  assert.match(a, /^[a-f0-9]{64}$/);
  const renamed = observed(r);
  renamed.providers[0].name = 'Renamed'; renamed.providers[0].revision += 8;
  renamed.models[0].name = 'Renamed'; renamed.models[0].revision += 4;
  renamed.revision += 10;
  assert.equal(computeBindingRevision(renamed.providers[0], renamed.models[0]), a);
  renamed.providers[0].baseUrl += '/chat/completions/';
  assert.equal(computeBindingRevision(renamed.providers[0], renamed.models[0]), a);
  const reordered = { ...r.models[0], compatibility: { includeUsage: true, streamMode: 'auto', toolMode: 'native' } };
  assert.equal(computeBindingRevision(r.providers[0], reordered), a);
});

test('each wire/credential change invalidates observed evidence without mutating its record', () => {
  for (const change of [
    (p) => { p.baseUrl = 'https://second.synthetic.example/v1'; },
    (p) => { p.protocol = 'openai-responses'; },
    (p) => { p.auth.kind = 'none'; p.auth.secretRef = ''; p.auth.credentialOrigin = null; },
    (p) => { p.auth.credentialRevision += 1; },
    (_p, m) => { m.model = 'another'; },
    (_p, m) => { m.request.maxOutputTokens = 2048; },
    (_p, m) => { m.request.temperature = 0.4; },
    (_p, m) => { m.compatibility.streamMode = 'off'; },
  ]) {
    const r = observed(initial()); const p = r.providers[0]; const m = r.models[0];
    const old = m.capabilities.text.bindingRevision;
    change(p, m);
    assert.notEqual(computeBindingRevision(p, m), old);
    const caps = effectiveModelCapabilities(p, m);
    assert.equal(caps.text.state, 'unknown');
    assert.equal(caps.text.stale, true);
    assert.equal(m.capabilities.text.state, 'supported');
  }
  const r = observed(initial()); r.models[0].name = 'Display only';
  assert.equal(effectiveModelCapabilities(r.providers[0], r.models[0]).text.state, 'supported');
});

test('public DTO is whitelisted and separates stored credentials from authentication proof', () => {
  const r = observed(initial());
  r.migration.privateNote = 'synthetic-private-migration';
  const called = [];
  const dto = publicModelRegistry(r, { getCredentialState: (provider) => { called.push(provider.id); return 'unavailable'; } });
  assert.deepEqual(called, ['provider_legacy_openai']);
  assert.equal(dto.providers[0].credentialState, 'unavailable');
  assert.deepEqual(dto.providers[0].auth, { kind: 'bearer' });
  assert.equal(dto.models[0].capabilities.text.source, 'observed');
  const text = JSON.stringify(dto);
  for (const forbidden of ['secretRef', 'credentialOrigin', 'credentialRevision', 'main_api_key', 'migration', 'synthetic-private']) assert.equal(text.includes(forbidden), false, forbidden);
  dto.models[0].request.maxOutputTokens = 1;
  assert.equal(r.models[0].request.maxOutputTokens, 4096);
  assert.equal(publicModelRegistry(initial()).providers[0].credentialState, 'configured');
});

test('update uses optimistic concurrency, increments changed entity revisions and never mutates input', () => {
  const r = initial();
  const next = updateModelRegistry(r, (draft) => { draft.models[0].name = 'Changed'; }, r.revision);
  assert.equal(next.revision, 2);
  assert.equal(next.models[0].revision, 2);
  assert.equal(next.providers[0].revision, 1);
  assert.equal(r.models[0].name, 'synthetic-model');
  assert.throws(() => updateModelRegistry(r, () => {}, 8), { code: 'CONFIG_CONFLICT' });
  invalid(() => updateModelRegistry(r, (draft) => { draft.defaultModelProfileId = 'missing'; }));
  assert.deepEqual(r, initial());
});

test('save creates stable opaque IDs and safe custom assistant defaults', () => {
  const r = initial();
  const a = saveProfile(r, 'assistant', { name: 'Synthetic assistant' }, { expectedRevision: r.revision });
  const profile = a.assistants.at(-1);
  assert.match(profile.id, /^assistant_[a-f0-9]{32}$/);
  assert.equal(profile.revision, 1);
  assert.equal(profile.identityType, 'ai');
  assert.equal(profile.builtIn, false);
  assert.deepEqual(profile.knowledge, { projectContext: false, projectMemory: false });
  assert.deepEqual(profile.toolPolicy, { mode: 'none', allowedTools: [] });
  assert.equal(profile.projectId, null);
  const b = saveProfile(a, 'assistant', { id: profile.id, name: 'Renamed' });
  assert.equal(b.assistants.at(-1).id, profile.id);
  assert.equal(b.assistants.at(-1).revision, 2);
});

test('save refuses private authentication, migration/journal and fabricated observation fields', () => {
  for (const field of ['secretRef', 'credentialRevision', 'credentialOrigin']) {
    invalid(() => saveProfile(initial(), 'provider', { id: 'provider_legacy_openai', auth: { kind: 'bearer', [field]: 'synthetic' } }));
  }
  for (const field of ['migration', 'journal', 'modelCredentialCleanup', 'observations', 'rawEvidence']) {
    invalid(() => saveProfile(initial(), 'model', { id: 'model_legacy_default', [field]: {} }));
  }
  invalid(() => saveProfile(initial(), 'model', { id: 'model_legacy_default', capabilities: { text: { state: 'supported', source: 'observed', bindingRevision: 'a'.repeat(64), checkedAt: '2026-10-29T00:00:00Z' } } }));
  invalid(() => saveProfile(initial(), 'assistant', { name: 'Fake builtin', builtIn: true }));
  invalid(() => saveProfile(initial(), 'assistant', { name: 'Fake host authority', toolPolicy: { mode: 'allowlist', allowedTools: ['@host-authorized'] } }));
  invalid(() => saveProfile(initial(), 'assistant', { name: 'Wildcard', toolPolicy: { mode: 'allowlist', allowedTools: ['*'] } }));
  invalid(() => saveProfile(initial(), 'assistant', { id: 'assistant_general', identityType: 'human' }));
});

test('provider edits preserve main-owned auth only while origin and auth kind match', () => {
  const r = initial();
  const renamed = saveProfile(r, 'provider', { id: r.providers[0].id, name: 'Renamed' });
  assert.deepEqual(renamed.providers[0].auth, r.providers[0].auth);
  const pathOnly = saveProfile(renamed, 'provider', { id: r.providers[0].id, baseUrl: 'https://synthetic.example/other/v1' });
  assert.equal(pathOnly.providers[0].auth.secretRef, 'sec_main_api_key');
  const rebound = saveProfile(pathOnly, 'provider', { id: r.providers[0].id, baseUrl: 'https://new.synthetic.example/v1' });
  assert.equal(rebound.providers[0].auth.secretRef, '');
  assert.equal(rebound.providers[0].auth.credentialOrigin, null);
  assert.equal(rebound.providers[0].auth.credentialRevision, r.providers[0].auth.credentialRevision + 1);
  const none = saveProfile(r, 'provider', { id: r.providers[0].id, auth: { kind: 'none' } });
  assert.equal(none.providers[0].auth.secretRef, '');
});

test('remove respects default/assistant/provider/live references but not historical sources', () => {
  let r = secondModel(initial());
  assert.throws(() => removeProfile(r, 'model', 'model_legacy_default'), { code: 'PROFILE_IN_USE' });
  assert.throws(() => removeProfile(r, 'provider', 'provider_legacy_openai'), { code: 'PROFILE_IN_USE' });
  assert.throws(() => removeProfile(r, 'assistant', 'assistant_codex'), { code: 'BUILTIN_PROFILE' });
  r = saveProfile(r, 'assistant', { id: 'assistant_custom', name: 'Custom', modelProfileId: 'model_second' });
  assert.throws(() => removeProfile(r, 'model', 'model_second'), { code: 'PROFILE_IN_USE' });
  assert.throws(() => removeProfile(r, 'assistant', 'assistant_custom', { liveReferences: [{ sessionId: 'synthetic', assistantId: 'assistant_custom' }] }), { code: 'PROFILE_IN_USE' });
  r = removeProfile(r, 'assistant', 'assistant_custom');
  assert.throws(() => removeProfile(r, 'model', 'model_second', { liveReferences: { modelProfileIds: ['model_second'] } }), { code: 'PROFILE_IN_USE' });
  const next = removeProfile(r, 'model', 'model_second', { liveReferences: { history: [{ modelSource: { modelProfileId: 'model_second' } }] } });
  assert.equal(next.models.length, 1);
  assert.equal(r.models.length, 2);
});

test('binding resolves override then assistant then default and captures immutable internal clones', () => {
  let r = secondModel(initial());
  r = saveProfile(r, 'assistant', { id: 'assistant_general', modelProfileId: 'model_second' });
  const params = { registry: r, senderId: 7, sessionId: 'synthetic-session', assistantId: 'assistant_general', expectedRegistryRevision: r.revision };
  const b = resolveModelBinding(params);
  assert.equal(b.modelProfileId, 'model_second');
  assert.equal(resolveModelBinding({ ...params, modelProfileId: 'model_legacy_default' }).modelProfileId, 'model_legacy_default');
  assert.equal(resolveModelBinding({ registry: r }).modelProfileId, 'model_legacy_default');
  for (const key of ['protocol', 'baseUrl', 'model', 'providerId', 'modelProfileId', 'assistantId', 'registryRevision', 'providerRevision', 'modelRevision', 'assistantRevision', 'bindingRevision', 'auth', 'request', 'compatibility', 'capabilities', 'provider', 'modelProfile', 'assistant']) assert.ok(Object.hasOwn(b, key), key);
  assert.equal(b.auth.secretRef, 'sec_main_api_key');
  assert.equal(Object.hasOwn(b.auth, 'apiKey'), false);
  assert.equal(isResolvedModelBinding(b), true);
  assert.equal(isResolvedModelBinding(copy(b)), false);
  assert.ok(Object.isFrozen(b));
  assert.ok(Object.isFrozen(b.provider.auth));
  r.models[1].model = 'subsequently-changed';
  assert.equal(b.model, 'synthetic-second');
  assert.equal(b.modelProfile.model, 'synthetic-second');
  assert.throws(() => resolveModelBinding({ ...params, modelProfileId: 'missing' }), { code: 'MODEL_CONFIG_INVALID' });
  assert.throws(() => resolveModelBinding({ ...params, assistantId: 'missing' }), { code: 'MODEL_CONFIG_INVALID' });
  assert.throws(() => resolveModelBinding({ ...params, expectedRegistryRevision: 999 }), { code: 'CONFIG_CONFLICT' });
});

test('observations merge only current wire evidence and do not overwrite changed declarations', () => {
  const start = initial();
  const fp = computeBindingRevision(start.providers[0], start.models[0]);
  const baseline = copy(start.models[0].capabilities);
  const changed = saveProfile(start, 'model', { id: 'model_legacy_default', capabilities: { nativeTools: declared('unsupported') } });
  const merged = applyObservedCapabilities(changed, {
    modelProfileId: 'model_legacy_default', bindingRevision: fp,
    observations: { text: 'supported', nativeTools: 'supported', usage: 'unknown' },
    startedAt: '2026-10-29T00:00:00Z', expectedDeclarations: baseline,
  });
  assert.equal(merged.models[0].capabilities.text.state, 'supported');
  assert.equal(merged.models[0].capabilities.text.source, 'observed');
  assert.equal(merged.models[0].capabilities.nativeTools.state, 'unsupported');
  assert.equal(merged.models[0].capabilities.nativeTools.source, 'declared');
  assert.equal(merged.revision, changed.revision + 1);
  assert.equal(merged.models[0].revision, changed.models[0].revision, 'Observed evidence is not a model configuration or permission change');
  assert.deepEqual(merged.providers, changed.providers);
  assert.deepEqual(merged.assistants, changed.assistants);
  const wireChanged = saveProfile(merged, 'model', { id: 'model_legacy_default', model: 'new-wire' });
  const stale = applyObservedCapabilities(wireChanged, { modelProfileId: 'model_legacy_default', bindingRevision: fp, observations: { text: 'unsupported' } });
  assert.deepEqual(stale, wireChanged);
  assert.equal(stale.revision, wireChanged.revision);
  assert.equal(publicModelRegistry(stale).models[0].capabilities.text.state, 'unknown');
});

test('profile drafts reject malformed nested objects rather than treating them as omitted', () => {
  for (const [kind, patch] of [
    ['model', { request: null }], ['model', { request: 'synthetic-invalid' }],
    ['model', { compatibility: [] }], ['assistant', { knowledge: 'synthetic-invalid' }],
    ['assistant', { toolPolicy: null }],
  ]) {
    const profileId = kind === 'model' ? 'model_legacy_default' : 'assistant_general';
    invalid(() => saveProfile(initial(), kind, { id: profileId, ...patch }));
  }
});

test('legacy model identifiers up to the model limit do not overflow generated display names', () => {
  const name = 'x'.repeat(256);
  const r = createModelRegistry({ baseUrl: 'https://synthetic.example/v1', model: name });
  assert.equal(r.models[0].model, name);
  assert.ok(r.models[0].name.length <= 128);
});

test('cyclic non-JSON registry data fails with a typed configuration error', () => {
  const r = initial(); r.migration.syntheticCycle = r;
  invalid(() => validateModelRegistry(r));
});

test('trusted run metadata is frozen into a binding but never changes its wire fingerprint', () => {
  const registry = initial();
  const plain = resolveModelBinding({ registry });
  const binding = resolveModelBinding({ registry, runId: 'synthetic-run', clientRequestId: 'synthetic-request', kind: 'ai_chat' });
  assert.equal(binding.runId, 'synthetic-run');
  assert.equal(binding.clientRequestId, 'synthetic-request');
  assert.equal(binding.kind, 'ai_chat');
  assert.equal(plain.runId, null);
  assert.equal(binding.bindingRevision, plain.bindingRevision);
  for (const field of ['runId', 'clientRequestId', 'kind']) {
    invalid(() => resolveModelBinding({ registry, [field]: 'x'.repeat(field === 'kind' ? 65 : 129) }));
  }
});

test('partial migration merges missing stable identities without duplicate profiles', () => {
  const complete = initial();
  const partial = copy(complete);
  partial.models = []; partial.assistants = []; partial.migration.completed = false;
  const recovered = createModelRegistry({ modelRegistry: partial, model: 'synthetic-model', baseUrl: 'https://synthetic.example/gateway/v1' });
  assert.equal(recovered.providers.length, 1);
  assert.equal(recovered.models.length, 1);
  assert.equal(recovered.assistants.length, 2);
  assert.deepEqual(createModelRegistry({ modelRegistry: recovered }), recovered);
});
