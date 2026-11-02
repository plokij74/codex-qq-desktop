'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const LEGACY_PROVIDER_ID = 'provider_legacy_openai';
const LEGACY_MODEL_ID = 'model_legacy_default';
const MODEL_PROTOCOLS = Object.freeze(['openai-chat-completions', 'openai-responses', 'anthropic-messages']);
const CAPABILITY_NAMES = Object.freeze(['text', 'nativeTools', 'vision', 'streaming', 'usage', 'temperature', 'stop']);
const MODEL_PROFILE_LIMITS = Object.freeze({ providers: 32, models: 128, assistants: 128, name: 128, model: 256, baseUrl: 2048, systemPrompt: 16384, allowedTools: 256 });
const BUILTIN_ASSISTANT_IDS = Object.freeze(['assistant_codex', 'assistant_general']);
const HOST_AUTHORIZED_TOOLS = '@host-authorized';
const OPERATIONS = Object.freeze({ 'openai-chat-completions': '/chat/completions', 'openai-responses': '/responses', 'anthropic-messages': '/messages' });
const STATES = new Set(['supported', 'unsupported', 'unknown']);
const SOURCES = new Set(['declared', 'observed', 'unknown']);
const BINDINGS = new WeakSet();
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function configError(message, code = 'MODEL_CONFIG_INVALID') {
  const error = new Error(message);
  error.code = code;
  error.needsRepair = true;
  return error;
}
function requireConfig(condition, message) {
  if (!condition) throw configError(message);
}
function clone(value) {
  try { return structuredClone(value); }
  catch { throw configError('Model configuration must contain cloneable data only'); }
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function text(value, field, maximum, allowEmpty = false) {
  requireConfig(typeof value === 'string' && value.length <= maximum && !value.includes('\0'), `${field} must be a string of at most ${maximum} characters`);
  requireConfig(allowEmpty || value.trim().length > 0, `${field} cannot be empty`);
  return value;
}
function id(value, field = 'id') {
  text(value, field, 128);
  requireConfig(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value), `${field} must be an opaque identifier`);
  return value;
}
function revision(value, field = 'revision', allowZero = false) {
  requireConfig(Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1), `${field} must be a ${allowZero ? 'nonnegative' : 'positive'} integer`);
  return value;
}
function timestamp(value, field) {
  requireConfig(typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)), `${field} must be a valid timestamp`);
  return value;
}
function rejectPlaintext(value, ancestors = new WeakSet(), depth = 0) {
  if (!Array.isArray(value) && !record(value)) return;
  requireConfig(depth <= 64 && !ancestors.has(value), 'Registry data must be bounded, acyclic JSON data');
  ancestors.add(value);
  try {
    for (const [key, entry] of Object.entries(value)) {
      requireConfig(!/^(api_?key|key|password|authorization|access_?token|rawEvidence|rawResponse|rawRequest|headers)$/i.test(key), 'Plaintext credentials and raw wire evidence are not registry fields');
      rejectPlaintext(entry, ancestors, depth + 1);
    }
  } finally { ancestors.delete(value); }
}
function protocol(value) {
  requireConfig(MODEL_PROTOCOLS.includes(value), 'Unsupported model protocol');
  return value;
}
function parsedBaseUrl(value) {
  text(value, 'provider.baseUrl', MODEL_PROFILE_LIMITS.baseUrl);
  let url;
  try { url = new URL(value); } catch { throw configError('provider.baseUrl must be an absolute HTTP(S) URL'); }
  requireConfig(url.protocol === 'https:' || url.protocol === 'http:', 'provider.baseUrl must use HTTP(S)');
  requireConfig(!url.username && !url.password && !value.includes('#'), 'provider.baseUrl cannot contain credentials or a fragment');
  for (const key of url.searchParams.keys()) {
    // WHATWG URLSearchParams decodes escaped names first. Normalize common
    // camelCase, abbreviation and punctuation aliases before checking tokens;
    // benign gateway selectors such as api-version/region remain supported.
    const words = key.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .toLowerCase().split(/[^a-z\d]+/).filter(Boolean);
    const compact = words.join('');
    requireConfig(!words.some((word) => ['key', 'secret', 'password', 'passwd', 'authorization', 'auth', 'bearer', 'token', 'credential', 'credentials', 'signature'].includes(word))
      && !/(?:apikey|accesskey|secretkey|clientsecret|accesstoken|refreshtoken|credential|password|authorization|signature)/.test(compact),
    'provider.baseUrl cannot carry authentication query parameters');
  }
  url.searchParams.sort();
  return url;
}
function normalizeModelBaseUrl(providerProtocol, baseUrl) {
  protocol(providerProtocol);
  const url = parsedBaseUrl(baseUrl);
  let pathname = url.pathname.replace(/\/+$/, '');
  const operation = OPERATIONS[providerProtocol];
  if (pathname.endsWith(operation)) pathname = pathname.slice(0, -operation.length).replace(/\/+$/, '');
  return `${url.origin}${pathname}${url.search}`;
}
function normalizeModelEndpoint(providerProtocol, baseUrl) {
  const base = new URL(normalizeModelBaseUrl(providerProtocol, baseUrl));
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}${OPERATIONS[providerProtocol]}${base.search}`;
}
function normalizeProvider(input) {
  requireConfig(record(input), 'Provider must be an object');
  const providerProtocol = protocol(input.protocol);
  const baseUrl = normalizeModelBaseUrl(providerProtocol, input.baseUrl);
  const origin = new URL(baseUrl).origin;
  const rawAuth = input.auth === undefined ? {} : input.auth;
  requireConfig(record(rawAuth), 'provider.auth must be an object');
  const kind = rawAuth.kind === undefined ? (providerProtocol === 'anthropic-messages' ? 'api-key' : 'bearer') : rawAuth.kind;
  requireConfig(providerProtocol === 'anthropic-messages' ? kind === 'api-key' : kind === 'bearer' || kind === 'none', 'Authentication kind does not match the provider protocol');
  const secretRef = rawAuth.secretRef === undefined || rawAuth.secretRef === null ? '' : rawAuth.secretRef;
  text(secretRef, 'provider.auth.secretRef', 256, true);
  requireConfig(!secretRef || /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(secretRef), 'Credential references must be opaque identifiers');
  requireConfig(kind !== 'none' || !secretRef, 'No-auth providers cannot retain a credential reference');
  const credentialRevision = revision(rawAuth.credentialRevision === undefined ? (secretRef ? 1 : 0) : rawAuth.credentialRevision, 'provider.auth.credentialRevision', true);
  const credentialOrigin = rawAuth.credentialOrigin === undefined ? (secretRef ? origin : null) : rawAuth.credentialOrigin;
  requireConfig(credentialOrigin === null || typeof credentialOrigin === 'string', 'Credential origin must be an origin or null');
  requireConfig(!secretRef || credentialOrigin === origin, 'Credential reference is bound to a different origin');
  requireConfig(secretRef || credentialOrigin === null, 'An unset credential cannot retain its origin');
  let transportConfirmation = { origin: null, plainHttpAcceptedAt: null };
  if (input.transportConfirmation !== undefined && input.transportConfirmation !== null) {
    requireConfig(record(input.transportConfirmation), 'transportConfirmation must be an object');
    const confirmedOrigin = input.transportConfirmation.origin === undefined ? null : input.transportConfirmation.origin;
    const acceptedAt = input.transportConfirmation.plainHttpAcceptedAt === undefined ? null : input.transportConfirmation.plainHttpAcceptedAt;
    requireConfig(confirmedOrigin === null || confirmedOrigin === origin, 'HTTP confirmation must match the current origin');
    if (acceptedAt !== null) timestamp(acceptedAt, 'plainHttpAcceptedAt');
    requireConfig(acceptedAt === null || confirmedOrigin === origin, 'HTTP confirmation requires its origin');
    transportConfirmation = { origin: confirmedOrigin, plainHttpAcceptedAt: acceptedAt };
  }
  requireConfig(new URL(baseUrl).protocol !== 'http:' || (transportConfirmation.origin === origin && transportConfirmation.plainHttpAcceptedAt !== null), 'Plain HTTP requires explicit confirmation for this origin');
  return {
    id: id(input.id, 'provider.id'), name: text(input.name, 'provider.name', MODEL_PROFILE_LIMITS.name),
    protocol: providerProtocol, baseUrl,
    auth: { kind, secretRef, credentialOrigin, credentialRevision }, transportConfirmation,
    revision: revision(input.revision, 'provider.revision'),
  };
}
function normalizeRequest(input, providerProtocol) {
  const raw = input === undefined ? {} : input;
  requireConfig(record(raw), 'model.request must be an object');
  requireConfig(Object.keys(raw).every((key) => ['maxOutputTokens', 'temperature', 'chatTokenLimitField'].includes(key)), 'Unknown model request field');
  const maxOutputTokens = raw.maxOutputTokens === undefined ? 4096 : raw.maxOutputTokens;
  requireConfig(Number.isInteger(maxOutputTokens) && maxOutputTokens >= 1 && maxOutputTokens <= 32768, 'maxOutputTokens must be between 1 and 32768');
  const result = { maxOutputTokens };
  if (own(raw, 'temperature') && raw.temperature !== undefined) {
    requireConfig(typeof raw.temperature === 'number' && Number.isFinite(raw.temperature), 'temperature must be a finite number');
    result.temperature = raw.temperature;
  }
  if (providerProtocol === 'openai-chat-completions') {
    const field = raw.chatTokenLimitField === undefined ? 'max_tokens' : raw.chatTokenLimitField;
    requireConfig(field === 'max_tokens' || field === 'max_completion_tokens', 'Invalid Chat token-limit field');
    result.chatTokenLimitField = field;
  } else if (own(raw, 'chatTokenLimitField')) {
    requireConfig(raw.chatTokenLimitField === 'max_tokens' || raw.chatTokenLimitField === 'max_completion_tokens', 'Invalid Chat token-limit field');
  }
  return result;
}
function normalizeCompatibility(input) {
  const raw = input === undefined ? {} : input;
  requireConfig(record(raw), 'model.compatibility must be an object');
  requireConfig(Object.keys(raw).every((key) => ['toolMode', 'streamMode', 'includeUsage'].includes(key)), 'Unknown model compatibility field');
  const toolMode = raw.toolMode === undefined ? 'native' : raw.toolMode;
  const streamMode = raw.streamMode === undefined ? 'auto' : raw.streamMode;
  const includeUsage = raw.includeUsage === undefined ? true : raw.includeUsage;
  requireConfig(['native', 'text-compat', 'none'].includes(toolMode), 'Invalid tool compatibility mode');
  requireConfig(['auto', 'on', 'off'].includes(streamMode), 'Invalid stream compatibility mode');
  requireConfig(typeof includeUsage === 'boolean', 'includeUsage must be boolean');
  return { toolMode, streamMode, includeUsage };
}
function normalizeCapability(input, name) {
  if (input === undefined) return { state: 'unknown', source: 'unknown', checkedAt: null, bindingRevision: null };
  requireConfig(record(input), `capabilities.${name} must be an object`);
  const state = input.state;
  const source = input.source === undefined ? (state === 'unknown' ? 'unknown' : 'declared') : input.source;
  requireConfig(STATES.has(state) && SOURCES.has(source), `Invalid capability ${name} state or source`);
  requireConfig(source !== 'unknown' || state === 'unknown', 'Unknown evidence cannot assert capability support');
  let checkedAt = input.checkedAt === undefined ? null : input.checkedAt;
  let bindingRevision = input.bindingRevision === undefined ? null : input.bindingRevision;
  if (source === 'observed') {
    timestamp(checkedAt, `capabilities.${name}.checkedAt`);
    requireConfig(typeof bindingRevision === 'string' && /^[a-f0-9]{64}$/.test(bindingRevision), 'Observed capabilities require a wire fingerprint');
  } else {
    requireConfig(checkedAt === null && bindingRevision === null, 'Only observed capabilities can carry wire evidence');
    checkedAt = null; bindingRevision = null;
  }
  return { state, source, checkedAt, bindingRevision };
}
function normalizeCapabilities(input) {
  const raw = input === undefined ? {} : input;
  requireConfig(record(raw), 'model.capabilities must be an object');
  requireConfig(Object.keys(raw).every((name) => CAPABILITY_NAMES.includes(name) || name === 'contextWindow'), 'Unknown capability name');
  const result = {};
  for (const name of CAPABILITY_NAMES) result[name] = normalizeCapability(raw[name], name);
  const context = raw.contextWindow === undefined ? {} : raw.contextWindow;
  requireConfig(record(context), 'contextWindow must be an object');
  const tokens = context.tokens === undefined ? null : context.tokens;
  const source = context.source === undefined ? (tokens === null ? 'unknown' : 'declared') : context.source;
  requireConfig(tokens === null || (Number.isSafeInteger(tokens) && tokens > 0), 'contextWindow.tokens must be a positive integer or null');
  requireConfig(SOURCES.has(source) && (source !== 'unknown' || tokens === null), 'Invalid context-window source');
  const evidence = normalizeCapability({ state: tokens === null ? 'unknown' : 'supported', source, checkedAt: context.checkedAt, bindingRevision: context.bindingRevision }, 'contextWindow');
  result.contextWindow = { tokens, source: evidence.source, checkedAt: evidence.checkedAt, bindingRevision: evidence.bindingRevision };
  return result;
}
function normalizeModel(input, providers) {
  requireConfig(record(input), 'Model profile must be an object');
  const providerId = id(input.providerId, 'model.providerId');
  const provider = providers.find((entry) => entry.id === providerId);
  requireConfig(Boolean(provider), 'Model provider does not exist');
  return {
    id: id(input.id, 'model.id'), name: text(input.name, 'model.name', MODEL_PROFILE_LIMITS.name),
    providerId, model: text(input.model, 'model.model', MODEL_PROFILE_LIMITS.model),
    revision: revision(input.revision, 'model.revision'), request: normalizeRequest(input.request, provider.protocol),
    compatibility: normalizeCompatibility(input.compatibility), capabilities: normalizeCapabilities(input.capabilities),
  };
}
function normalizeAssistant(input, models) {
  requireConfig(record(input), 'Assistant profile must be an object');
  const assistantId = id(input.id, 'assistant.id');
  const builtIn = BUILTIN_ASSISTANT_IDS.includes(assistantId);
  requireConfig(input.identityType === 'ai', 'Assistant identityType must be ai');
  requireConfig(input.builtIn === builtIn, 'Built-in assistant identity cannot be changed or impersonated');
  const modelProfileId = input.modelProfileId === undefined ? null : input.modelProfileId;
  requireConfig(modelProfileId === null || models.some((entry) => entry.id === modelProfileId), 'Assistant model profile does not exist');
  const knowledge = input.knowledge === undefined ? {} : input.knowledge;
  requireConfig(record(knowledge), 'assistant.knowledge must be an object');
  const projectContext = knowledge.projectContext === undefined ? false : knowledge.projectContext;
  const projectMemory = knowledge.projectMemory === undefined ? false : knowledge.projectMemory;
  requireConfig(typeof projectContext === 'boolean' && typeof projectMemory === 'boolean', 'Knowledge flags must be boolean');
  const toolPolicy = input.toolPolicy === undefined ? {} : input.toolPolicy;
  requireConfig(record(toolPolicy), 'assistant.toolPolicy must be an object');
  const mode = toolPolicy.mode === undefined ? 'none' : toolPolicy.mode;
  const allowedTools = toolPolicy.allowedTools === undefined ? [] : toolPolicy.allowedTools;
  requireConfig(mode === 'none' || mode === 'allowlist', 'Invalid assistant tool policy');
  requireConfig(Array.isArray(allowedTools) && allowedTools.length <= MODEL_PROFILE_LIMITS.allowedTools, 'Tool allowlist exceeds the allowed limit');
  requireConfig(mode !== 'none' || allowedTools.length === 0, 'The none tool policy must have an empty allowlist');
  const toolSet = new Set();
  for (const tool of allowedTools) {
    text(tool, 'tool name', 128);
    requireConfig(tool === HOST_AUTHORIZED_TOOLS ? assistantId === 'assistant_codex' && builtIn : /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(tool), 'Tool allowlists require exact names; the host selector is reserved for built-in Codex');
    requireConfig(!toolSet.has(tool), 'Duplicate tool allowlist entry'); toolSet.add(tool);
  }
  const projectId = input.projectId === undefined ? null : input.projectId;
  if (projectId !== null) text(projectId, 'assistant.projectId', 128);
  requireConfig(input.archived === undefined || typeof input.archived === 'boolean', 'assistant.archived must be boolean');
  requireConfig(!builtIn || input.archived !== true, 'Built-in assistants cannot be archived');
  return {
    id: assistantId, name: text(input.name, 'assistant.name', MODEL_PROFILE_LIMITS.name),
    builtIn, identityType: 'ai', modelProfileId, revision: revision(input.revision, 'assistant.revision'),
    systemPrompt: text(input.systemPrompt === undefined ? '' : input.systemPrompt, 'assistant.systemPrompt', MODEL_PROFILE_LIMITS.systemPrompt, true),
    knowledge: { projectContext, projectMemory }, projectId, toolPolicy: { mode, allowedTools: [...allowedTools] },
    ...(input.archived === undefined ? {} : { archived: input.archived }),
  };
}
function validateModelRegistry(input) {
  requireConfig(record(input), 'Model registry must be an object');
  if (Number.isInteger(input.schemaVersion) && input.schemaVersion > SCHEMA_VERSION) throw configError('This model registry was created by a newer application; preserve it and use a compatible version', 'MODEL_REGISTRY_VERSION_UNSUPPORTED');
  requireConfig(input.schemaVersion === SCHEMA_VERSION, 'Unsupported model registry schema');
  rejectPlaintext(input);
  for (const kind of ['providers', 'models', 'assistants']) {
    requireConfig(Array.isArray(input[kind]) && input[kind].length > 0 && input[kind].length <= MODEL_PROFILE_LIMITS[kind], `Invalid ${kind} collection size`);
  }
  const identifiers = new Set();
  for (const kind of ['providers', 'models', 'assistants']) for (const profile of input[kind]) {
    requireConfig(record(profile), 'Profiles must be objects');
    id(profile.id);
    requireConfig(!identifiers.has(profile.id), 'Duplicate profile identifier'); identifiers.add(profile.id);
  }
  const providers = input.providers.map(normalizeProvider);
  const models = input.models.map((entry) => normalizeModel(entry, providers));
  const assistants = input.assistants.map((entry) => normalizeAssistant(entry, models));
  requireConfig(BUILTIN_ASSISTANT_IDS.every((assistantId) => assistants.some((entry) => entry.id === assistantId)), 'Required built-in assistants are missing');
  requireConfig(models.some((entry) => entry.id === input.defaultModelProfileId), 'Default model profile does not exist');
  const migration = input.migration === undefined ? { from: 'legacy-single-model', completed: true } : input.migration;
  requireConfig(record(migration) && migration.from === 'legacy-single-model' && migration.completed === true, 'Model registry migration is incomplete');
  return {
    schemaVersion: SCHEMA_VERSION, revision: revision(input.revision), defaultModelProfileId: input.defaultModelProfileId,
    providers, models, assistants, migration: { from: 'legacy-single-model', completed: true },
  };
}
function builtInAssistant(assistantId) {
  const codex = assistantId === 'assistant_codex';
  return {
    id: assistantId, name: codex ? 'Codex' : '通用助手', builtIn: true, identityType: 'ai', modelProfileId: null, revision: 1,
    systemPrompt: codex ? 'You are Codex, an engineering assistant. Use only host-authorized tools and project context permitted by the current session.' : '',
    knowledge: { projectContext: codex, projectMemory: codex }, projectId: null,
    toolPolicy: codex ? { mode: 'allowlist', allowedTools: [HOST_AUTHORIZED_TOOLS] } : { mode: 'none', allowedTools: [] },
  };
}
function legacyRegistry(settings) {
  const baseUrl = settings.baseUrl === undefined ? 'https://api.openai.com/v1' : settings.baseUrl;
  const modelName = settings.model === undefined ? 'gpt-4o-mini' : settings.model;
  const modelDisplayName = typeof modelName === 'string' && modelName.length <= MODEL_PROFILE_LIMITS.name ? modelName : 'Legacy model';
  const secretRef = typeof settings.secretRef === 'string' && settings.secretRef ? settings.secretRef : (settings.apiKeyConfigured === true || (typeof settings.apiKey === 'string' && settings.apiKey) ? 'sec_main_api_key' : '');
  const origin = parsedBaseUrl(baseUrl).origin;
  return {
    schemaVersion: SCHEMA_VERSION, revision: 1, defaultModelProfileId: LEGACY_MODEL_ID,
    providers: [{ id: LEGACY_PROVIDER_ID, name: 'Legacy OpenAI', protocol: 'openai-chat-completions', baseUrl, revision: 1,
      auth: { kind: 'bearer', secretRef, credentialOrigin: secretRef ? origin : null, credentialRevision: secretRef ? 1 : 0 },
      ...(settings.transportConfirmation ? { transportConfirmation: clone(settings.transportConfirmation) } : {}),
    }],
    models: [{ id: LEGACY_MODEL_ID, name: modelDisplayName, providerId: LEGACY_PROVIDER_ID, model: modelName, revision: 1 }],
    assistants: BUILTIN_ASSISTANT_IDS.map(builtInAssistant), migration: { from: 'legacy-single-model', completed: true },
  };
}
function createModelRegistry(settings = {}) {
  requireConfig(record(settings), 'Settings must be an object');
  if (!own(settings, 'modelRegistry')) return validateModelRegistry(legacyRegistry(settings));
  const existing = settings.modelRegistry;
  requireConfig(record(existing), 'modelRegistry must be an object');
  if (Number.isInteger(existing.schemaVersion) && existing.schemaVersion > SCHEMA_VERSION) throw configError('This model registry requires a newer application version', 'MODEL_REGISTRY_VERSION_UNSUPPORTED');
  if (!record(existing.migration) || existing.migration.completed !== false) return validateModelRegistry(existing);
  requireConfig(existing.schemaVersion === SCHEMA_VERSION && existing.migration.from === 'legacy-single-model', 'Unsupported partial registry migration');
  const seed = legacyRegistry(settings);
  const resumed = clone(existing);
  for (const kind of ['providers', 'models', 'assistants']) {
    requireConfig(Array.isArray(resumed[kind]), `Incomplete migration has invalid ${kind}`);
    for (const profile of seed[kind]) if (!resumed[kind].some((entry) => record(entry) && entry.id === profile.id)) resumed[kind].push(profile);
  }
  if (!resumed.defaultModelProfileId) resumed.defaultModelProfileId = LEGACY_MODEL_ID;
  resumed.revision = revision(existing.revision) + 1;
  resumed.migration = { from: 'legacy-single-model', completed: true };
  return validateModelRegistry(resumed);
}
function computeBindingRevision(provider, model) {
  requireConfig(record(provider) && record(model), 'Provider and model are required for a wire fingerprint');
  const providerProtocol = protocol(provider.protocol);
  const auth = provider.auth === undefined ? {} : provider.auth;
  requireConfig(record(auth), 'Invalid provider auth');
  const descriptor = {
    protocol: providerProtocol, endpoint: normalizeModelEndpoint(providerProtocol, provider.baseUrl),
    auth: { kind: auth.kind === undefined ? (providerProtocol === 'anthropic-messages' ? 'api-key' : 'bearer') : auth.kind, credentialRevision: revision(auth.credentialRevision === undefined ? 0 : auth.credentialRevision, 'credentialRevision', true) },
    model: text(model.model, 'model.model', MODEL_PROFILE_LIMITS.model),
    request: normalizeRequest(model.request, providerProtocol), compatibility: normalizeCompatibility(model.compatibility),
  };
  return crypto.createHash('sha256').update(canonical(descriptor)).digest('hex');
}
function effectiveModelCapabilities(provider, model) {
  const capabilities = normalizeCapabilities(model.capabilities);
  const fingerprint = computeBindingRevision(provider, model);
  for (const name of [...CAPABILITY_NAMES, 'contextWindow']) {
    const value = capabilities[name];
    if (value.source !== 'observed' || value.bindingRevision === fingerprint) continue;
    capabilities[name] = name === 'contextWindow'
      ? { tokens: null, source: 'unknown', checkedAt: null, bindingRevision: null, stale: true }
      : { state: 'unknown', source: 'unknown', checkedAt: null, bindingRevision: null, stale: true };
  }
  return capabilities;
}
function publicModelRegistry(input, { getCredentialState } = {}) {
  const registry = validateModelRegistry(input);
  const providers = registry.providers.map((provider) => {
    let credentialState = provider.auth.secretRef ? 'configured' : 'unset';
    if (typeof getCredentialState === 'function') {
      try { credentialState = getCredentialState(clone(provider)); }
      catch { credentialState = provider.auth.secretRef ? 'unavailable' : 'unset'; }
      if (!['unset', 'configured', 'unavailable'].includes(credentialState)) credentialState = provider.auth.secretRef ? 'unavailable' : 'unset';
    }
    return { id: provider.id, name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl, revision: provider.revision, auth: { kind: provider.auth.kind }, transportConfirmation: clone(provider.transportConfirmation), credentialState };
  });
  const models = registry.models.map((model) => ({
    id: model.id, name: model.name, providerId: model.providerId, model: model.model, revision: model.revision,
    request: clone(model.request), compatibility: clone(model.compatibility),
    bindingRevision: computeBindingRevision(registry.providers.find((provider) => provider.id === model.providerId), model),
    capabilities: effectiveModelCapabilities(registry.providers.find((provider) => provider.id === model.providerId), model),
  }));
  return { schemaVersion: SCHEMA_VERSION, revision: registry.revision, defaultModelProfileId: registry.defaultModelProfileId, providers, models, assistants: clone(registry.assistants) };
}
function checkExpectedRevision(registry, expectedRevision) {
  if (expectedRevision !== undefined && expectedRevision !== registry.revision) throw configError('Model configuration changed; reload it before retrying', 'CONFIG_CONFLICT');
}
function withoutRevision(profile) {
  const value = { ...profile }; delete value.revision; return value;
}
function updateModelRegistry(input, mutatorFn, expectedRevision) {
  const registry = validateModelRegistry(input);
  checkExpectedRevision(registry, expectedRevision);
  requireConfig(typeof mutatorFn === 'function', 'A registry mutator function is required');
  const draft = clone(registry);
  const returned = mutatorFn(draft);
  requireConfig(returned === undefined || record(returned), 'Registry mutations must be synchronous');
  const next = returned === undefined ? draft : clone(returned);
  for (const kind of ['providers', 'models', 'assistants']) {
    requireConfig(Array.isArray(next[kind]), `Invalid ${kind}`);
    for (const profile of next[kind]) {
      requireConfig(record(profile), 'Invalid profile');
      const previous = registry[kind].find((entry) => entry.id === profile.id);
      profile.revision = previous ? (canonical(withoutRevision(previous)) === canonical(withoutRevision(profile)) ? previous.revision : previous.revision + 1) : 1;
    }
  }
  next.revision = registry.revision + 1;
  return validateModelRegistry(next);
}
const PROFILE_COLLECTIONS = Object.freeze({ provider: 'providers', model: 'models', assistant: 'assistants' });
const DRAFT_FIELDS = Object.freeze({
  provider: new Set(['id', 'name', 'revision', 'protocol', 'baseUrl', 'auth', 'transportConfirmation']),
  model: new Set(['id', 'name', 'revision', 'providerId', 'model', 'request', 'compatibility', 'capabilities']),
  assistant: new Set(['id', 'name', 'revision', 'identityType', 'builtIn', 'modelProfileId', 'systemPrompt', 'knowledge', 'projectId', 'toolPolicy', 'archived']),
});
function validatePublicDraft(kind, draft) {
  requireConfig(own(PROFILE_COLLECTIONS, kind) && record(draft), 'Invalid profile kind or draft');
  requireConfig(Object.keys(draft).every((key) => DRAFT_FIELDS[kind].has(key)), 'Profile draft contains a private or unsupported field');
  rejectPlaintext(draft);
  const nested = kind === 'model' ? ['request', 'compatibility', 'capabilities'] : (kind === 'assistant' ? ['knowledge', 'toolPolicy'] : ['auth']);
  for (const field of nested) if (own(draft, field)) requireConfig(record(draft[field]), `${field} must be an object`);
  if (kind === 'provider' && own(draft, 'auth')) {
    requireConfig(record(draft.auth) && Object.keys(draft.auth).every((key) => key === 'kind'), 'Credential references and revisions are controlled by the main process');
  }
  if (kind === 'model' && own(draft, 'capabilities')) {
    requireConfig(record(draft.capabilities), 'Capabilities must be declarations');
    for (const [name, capability] of Object.entries(draft.capabilities)) {
      requireConfig(CAPABILITY_NAMES.includes(name) || name === 'contextWindow', 'Unknown capability declaration');
      requireConfig(record(capability) && capability.source !== 'observed' && (capability.checkedAt === undefined || capability.checkedAt === null) && (capability.bindingRevision === undefined || capability.bindingRevision === null), 'Observed capability evidence cannot be supplied by profile drafts');
      const allowed = new Set(name === 'contextWindow' ? ['tokens', 'source', 'checkedAt', 'bindingRevision'] : ['state', 'source', 'checkedAt', 'bindingRevision']);
      requireConfig(Object.keys(capability).every((key) => allowed.has(key)), 'Unsupported capability evidence field');
    }
  }
}
function saveProfile(input, kind, draft, { expectedRevision } = {}) {
  validatePublicDraft(kind, draft);
  const registry = validateModelRegistry(input);
  checkExpectedRevision(registry, expectedRevision);
  const collection = PROFILE_COLLECTIONS[kind];
  const profileId = own(draft, 'id') ? id(draft.id) : `${kind}_${crypto.randomBytes(16).toString('hex')}`;
  const previous = registry[collection].find((entry) => entry.id === profileId);
  if (draft.revision !== undefined && draft.revision !== (previous ? previous.revision : 1)) throw configError('Profile revision is stale', 'CONFIG_CONFLICT');
  let next;
  if (kind === 'provider') {
    const providerProtocol = draft.protocol === undefined ? (previous ? previous.protocol : 'openai-chat-completions') : draft.protocol;
    const baseUrl = draft.baseUrl === undefined ? (previous ? previous.baseUrl : undefined) : draft.baseUrl;
    const origin = parsedBaseUrl(baseUrl).origin;
    const oldOrigin = previous ? new URL(previous.baseUrl).origin : null;
    const kindValue = draft.auth && own(draft.auth, 'kind') ? draft.auth.kind : (previous && previous.protocol === providerProtocol ? previous.auth.kind : (providerProtocol === 'anthropic-messages' ? 'api-key' : 'bearer'));
    const invalidated = Boolean(previous && (origin !== oldOrigin || kindValue !== previous.auth.kind));
    const auth = previous && !invalidated ? clone(previous.auth) : {
      kind: kindValue, secretRef: '', credentialOrigin: null,
      credentialRevision: previous ? previous.auth.credentialRevision + 1 : 0,
    };
    auth.kind = kindValue;
    next = {
      ...(previous || {}), ...clone(draft), id: profileId, revision: previous ? previous.revision : 1,
      name: draft.name === undefined ? (previous ? previous.name : 'New provider') : draft.name,
      protocol: providerProtocol, baseUrl, auth,
      transportConfirmation: own(draft, 'transportConfirmation') ? clone(draft.transportConfirmation) : (previous && origin === oldOrigin ? clone(previous.transportConfirmation) : { origin: null, plainHttpAcceptedAt: null }),
    };
  } else if (kind === 'model') {
    next = {
      ...(previous || {}), ...clone(draft), id: profileId, revision: previous ? previous.revision : 1,
      name: draft.name === undefined ? (previous ? previous.name : draft.model) : draft.name,
      request: { ...(previous ? previous.request : {}), ...(draft.request || {}) },
      compatibility: { ...(previous ? previous.compatibility : {}), ...(draft.compatibility || {}) },
      capabilities: { ...(previous ? previous.capabilities : {}), ...(draft.capabilities || {}) },
    };
    // Public edits may explicitly clear optional wire fields; null is never a stored request value.
    for (const optional of ['temperature', 'chatTokenLimitField']) {
      if (draft.request && own(draft.request, optional) && draft.request[optional] === null) delete next.request[optional];
    }
  } else {
    if (previous) requireConfig((draft.builtIn === undefined || draft.builtIn === previous.builtIn) && (draft.identityType === undefined || draft.identityType === 'ai'), 'Assistant identity is immutable');
    else requireConfig(!BUILTIN_ASSISTANT_IDS.includes(profileId) && draft.builtIn !== true && (draft.identityType === undefined || draft.identityType === 'ai'), 'Built-in assistant identities cannot be fabricated');
    next = {
      identityType: 'ai', builtIn: false, modelProfileId: null, systemPrompt: '', projectId: null,
      ...(previous || {}), ...clone(draft), id: profileId, revision: previous ? previous.revision : 1,
      knowledge: { projectContext: false, projectMemory: false, ...(previous ? previous.knowledge : {}), ...(draft.knowledge || {}) },
      toolPolicy: { mode: 'none', allowedTools: [], ...(previous ? previous.toolPolicy : {}), ...(draft.toolPolicy || {}) },
    };
    if (draft.toolPolicy && draft.toolPolicy.mode === 'none' && !own(draft.toolPolicy, 'allowedTools')) next.toolPolicy.allowedTools = [];
  }
  return updateModelRegistry(registry, (value) => {
    const index = value[collection].findIndex((entry) => entry.id === profileId);
    if (index < 0) value[collection].push(next); else value[collection][index] = next;
  }, expectedRevision);
}
function hasLiveReference(value, kind, profileId) {
  if (typeof value === 'function') return Boolean(value(kind, profileId));
  if (value instanceof Set) return value.has(profileId);
  if (typeof value === 'string') return value === profileId;
  if (Array.isArray(value)) return value.some((entry) => hasLiveReference(entry, kind, profileId));
  if (!record(value)) return false;
  if (value.kind === kind && value.id === profileId) return true;
  const direct = kind === 'provider' ? ['providerId', 'providerIds', 'providers'] : kind === 'model' ? ['modelProfileId', 'modelProfileIds', 'modelId', 'modelIds', 'models'] : ['assistantId', 'assistantIds', 'assistants'];
  for (const key of direct) if (own(value, key) && hasLiveReference(value[key], kind, profileId)) return true;
  for (const [key, nested] of Object.entries(value)) {
    if (['history', 'historical', 'modelSource', 'messages', 'archivedMessages'].includes(key) || direct.includes(key)) continue;
    if ((Array.isArray(nested) || record(nested) || nested instanceof Set) && hasLiveReference(nested, kind, profileId)) return true;
  }
  return value[profileId] === true;
}
function removeProfile(input, kind, profileId, { expectedRevision, liveReferences } = {}) {
  requireConfig(own(PROFILE_COLLECTIONS, kind), 'Invalid profile kind');
  const registry = validateModelRegistry(input);
  checkExpectedRevision(registry, expectedRevision);
  const collection = PROFILE_COLLECTIONS[kind];
  requireConfig(registry[collection].some((entry) => entry.id === profileId), 'Profile does not exist');
  if (kind === 'assistant' && BUILTIN_ASSISTANT_IDS.includes(profileId)) throw configError('Built-in assistants cannot be removed', 'BUILTIN_PROFILE');
  const referenced = (kind === 'provider' && registry.models.some((model) => model.providerId === profileId))
    || (kind === 'model' && (registry.defaultModelProfileId === profileId || registry.assistants.some((assistant) => assistant.modelProfileId === profileId)))
    || hasLiveReference(liveReferences, kind, profileId);
  if (referenced) throw configError('Profile has live references and cannot be removed', 'PROFILE_IN_USE');
  return updateModelRegistry(registry, (next) => { next[collection] = next[collection].filter((entry) => entry.id !== profileId); }, expectedRevision);
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}
function resolveModelBinding({ registry: input, senderId, sessionId, runId, clientRequestId, kind, assistantId = 'assistant_codex', modelProfileId, projectBindingId, expectedRegistryRevision } = {}) {
  const registry = validateModelRegistry(input);
  checkExpectedRevision(registry, expectedRegistryRevision);
  const assistant = registry.assistants.find((entry) => entry.id === assistantId);
  requireConfig(Boolean(assistant) && assistant.archived !== true, 'Assistant profile does not exist or is archived');
  const selectedId = modelProfileId === undefined || modelProfileId === null ? (assistant.modelProfileId || registry.defaultModelProfileId) : modelProfileId;
  const model = registry.models.find((entry) => entry.id === selectedId);
  requireConfig(Boolean(model), 'Selected model profile does not exist');
  const provider = registry.providers.find((entry) => entry.id === model.providerId);
  requireConfig(Boolean(provider), 'Selected provider does not exist');
  if (senderId !== undefined && senderId !== null) requireConfig((typeof senderId === 'number' && Number.isSafeInteger(senderId) && senderId >= 0) || (typeof senderId === 'string' && senderId.length > 0 && senderId.length <= 128), 'Invalid sender identity');
  if (sessionId !== undefined && sessionId !== null) text(sessionId, 'sessionId', 128);
  for (const [field, value, maximum] of [['runId', runId, 128], ['clientRequestId', clientRequestId, 128], ['kind', kind, 64]]) {
    if (value !== undefined && value !== null) text(value, field, maximum);
  }
  if (projectBindingId !== undefined && projectBindingId !== null) text(projectBindingId, 'projectBindingId', 128);
  const binding = {
    protocol: provider.protocol, baseUrl: provider.baseUrl, model: model.model,
    providerId: provider.id, modelProfileId: model.id, assistantId: assistant.id, identityType: 'ai',
    registryRevision: registry.revision, providerRevision: provider.revision, modelRevision: model.revision, assistantRevision: assistant.revision,
    bindingRevision: computeBindingRevision(provider, model), auth: clone(provider.auth),
    request: clone(model.request), compatibility: clone(model.compatibility), capabilities: effectiveModelCapabilities(provider, model),
    provider: clone(provider), modelProfile: clone(model), assistant: clone(assistant),
    senderId: senderId === undefined ? null : senderId, sessionId: sessionId === undefined ? null : sessionId,
    runId: runId === undefined ? null : runId, clientRequestId: clientRequestId === undefined ? null : clientRequestId, kind: kind === undefined ? null : kind,
    projectBindingId: projectBindingId === undefined ? null : projectBindingId,
    systemPrompt: assistant.systemPrompt, knowledge: clone(assistant.knowledge), toolPolicy: clone(assistant.toolPolicy),
  };
  BINDINGS.add(binding);
  return deepFreeze(binding);
}
function isResolvedModelBinding(binding) { return Boolean(binding && typeof binding === 'object' && BINDINGS.has(binding)); }
function applyObservedCapabilities(input, { modelProfileId, bindingRevision, observations, startedAt, expectedDeclarations } = {}) {
  const registry = validateModelRegistry(input);
  const model = registry.models.find((entry) => entry.id === modelProfileId);
  requireConfig(Boolean(model), 'Observed model profile does not exist');
  const provider = registry.providers.find((entry) => entry.id === model.providerId);
  if (computeBindingRevision(provider, model) !== bindingRevision) return registry;
  requireConfig(record(observations), 'Observations must be an object');
  requireConfig(expectedDeclarations === undefined || record(expectedDeclarations), 'Expected declarations must be a capability snapshot');
  const patches = {};
  for (const [name, observation] of Object.entries(observations)) {
    requireConfig(['text', 'nativeTools', 'streaming', 'usage'].includes(name), 'This capability cannot be inferred by a compatibility check');
    const current = model.capabilities[name];
    if (expectedDeclarations !== undefined) {
      if (!own(expectedDeclarations, name) || canonical(current) !== canonical(expectedDeclarations[name])) continue;
    } else if (current.source === 'declared') continue;
    const value = typeof observation === 'string' ? { state: observation } : observation;
    requireConfig(record(value) && STATES.has(value.state), 'Invalid observed capability state');
    requireConfig(Object.keys(value).every((key) => ['state', 'checkedAt'].includes(key)), 'Raw diagnostic evidence is not accepted');
    patches[name] = normalizeCapability({ state: value.state, source: 'observed', checkedAt: value.checkedAt || startedAt || new Date().toISOString(), bindingRevision }, name);
  }
  if (Object.keys(patches).length === 0) return registry;
  // Evidence changes invalidate stale registry writes, not accepted model/Plan rights.
  // Only explicit profile edits may advance an entity's configuration revision.
  const next = clone(registry);
  Object.assign(next.models.find((entry) => entry.id === modelProfileId).capabilities, patches);
  next.revision = registry.revision + 1;
  return validateModelRegistry(next);
}

module.exports = {
  SCHEMA_VERSION, LEGACY_PROVIDER_ID, LEGACY_MODEL_ID, MODEL_PROTOCOLS, CAPABILITY_NAMES, MODEL_PROFILE_LIMITS,
  BUILTIN_ASSISTANT_IDS, HOST_AUTHORIZED_TOOLS, createModelRegistry, validateModelRegistry, publicModelRegistry,
  normalizeModelBaseUrl, normalizeModelEndpoint, computeBindingRevision, effectiveModelCapabilities,
  resolveModelBinding, isResolvedModelBinding, updateModelRegistry, saveProfile, removeProfile, applyObservedCapabilities,
};
