'use strict';

const crypto = require('crypto');
const { URL } = require('url');
const { checkUrl } = require('./url-guard');

const MAX_FIELDS = 16;
const MAX_TEXT = 2000;
const MAX_FIELD_TEXT = 500;
const MAX_VALUE_TEXT = 4096;
const MAX_URL = 2048;
const ALLOWED_FORMATS = new Set(['email', 'uri', 'date', 'date-time']);
const SENSITIVE_FIELD_RE = /password|passcode|secret|token|api[_-]?key|authorization|cookie|credit|card|cvv|cvc|payment|private[_-]?key/i;
const ALLOWED_SCHEMA_KEYS = new Set([
  'type', 'properties', 'required', 'title', 'description', 'default',
  'enum', 'oneOf', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'format',
]);

function elicitationError(code, message) {
  const error = new Error(String(message || code));
  error.code = code;
  return error;
}

function cleanText(value, max = MAX_TEXT) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, max);
}

function fieldName(name) {
  const value = String(name || '').trim();
  if (!value || value.length > 128 || /[^a-zA-Z0-9_. -]/.test(value)) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation field name invalid');
  if (SENSITIVE_FIELD_RE.test(value)) throw elicitationError('MCP_ELICITATION_SENSITIVE_FIELD', 'Elicitation field is sensitive');
  return value;
}

function allowedPrimitive(type) {
  return type === 'string' || type === 'number' || type === 'integer' || type === 'boolean';
}

function normalizeEnum(raw, type) {
  if (!Array.isArray(raw) && !Array.isArray(raw?.oneOf)) return undefined;
  const values = Array.isArray(raw) ? raw : raw.oneOf.map((item) => item?.const);
  if (!values.length || values.length > 50) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation enum invalid');
  const out = [];
  for (const value of values) {
    if ((type === 'string' && typeof value !== 'string') || (type === 'boolean' && typeof value !== 'boolean')
      || ((type === 'number' || type === 'integer') && (typeof value !== 'number' || !Number.isFinite(value)))) {
      throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation enum type invalid');
    }
    if (type === 'string' && String(value).length > MAX_VALUE_TEXT) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation enum value too long');
    if (!out.some((item) => Object.is(item, value))) out.push(value);
  }
  return out;
}

function normalizeField(raw, rawName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation field schema invalid');
  for (const key of Object.keys(raw)) if (!ALLOWED_SCHEMA_KEYS.has(key)) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation schema keyword unsupported');
  const name = fieldName(rawName);
  const type = String(raw.type || 'string');
  if (!allowedPrimitive(type)) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation field type unsupported');
  const out = {
    name,
    type,
    title: cleanText(raw.title || name, MAX_FIELD_TEXT),
    description: cleanText(raw.description, MAX_FIELD_TEXT),
  };
  const values = normalizeEnum(raw.enum, type) || normalizeEnum(raw.oneOf ? { oneOf: raw.oneOf } : null, type);
  if (values) out.enum = values;
  for (const key of ['minLength', 'maxLength', 'minimum', 'maximum']) {
    if (raw[key] !== undefined) {
      const value = Number(raw[key]);
      if (!Number.isFinite(value) || (key.includes('Length') && value < 0)) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation constraint invalid');
      out[key] = Math.floor(value);
    }
  }
  if (out.minLength != null && out.maxLength != null && out.minLength > out.maxLength) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation length range invalid');
  if (out.minimum != null && out.maximum != null && out.minimum > out.maximum) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation number range invalid');
  if (raw.pattern !== undefined) {
    const pattern = String(raw.pattern);
    if (pattern.length > 300) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation pattern too long');
    try { new RegExp(pattern); } catch { throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation pattern invalid'); }
    out.pattern = pattern;
  }
  if (raw.format !== undefined) {
    const format = String(raw.format);
    if (!ALLOWED_FORMATS.has(format)) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation format unsupported');
    out.format = format;
  }
  if (raw.default !== undefined) {
    validateFieldValue(out, raw.default);
    out.default = raw.default;
  }
  return out;
}

function validateElicitationSchema(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.type !== 'object' || !raw.properties || typeof raw.properties !== 'object' || Array.isArray(raw.properties)) {
    throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation schema must be a flat object');
  }
  for (const key of Object.keys(raw)) if (!ALLOWED_SCHEMA_KEYS.has(key)) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation schema keyword unsupported');
  const keys = Object.keys(raw.properties);
  if (!keys.length || keys.length > MAX_FIELDS) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation field count invalid');
  const required = Array.isArray(raw.required) ? raw.required.map(String) : [];
  if (required.some((name) => !keys.includes(name))) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation required field invalid');
  const fields = keys.map((key) => normalizeField(raw.properties[key], key));
  return {
    type: 'object',
    title: cleanText(raw.title, MAX_TEXT),
    description: cleanText(raw.description, MAX_TEXT),
    required: [...new Set(required)],
    fields,
  };
}

function valueMatches(field, value) {
  if (field.type === 'string') return typeof value === 'string';
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'integer') return Number.isInteger(value);
  return typeof value === 'number' && Number.isFinite(value);
}

function validateFieldValue(field, value) {
  if (!valueMatches(field, value)) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', `Elicitation field type invalid: ${field.name}`);
  if (field.type === 'string') {
    if (value.length > MAX_VALUE_TEXT || field.minLength != null && value.length < field.minLength || field.maxLength != null && value.length > field.maxLength) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', `Elicitation field length invalid: ${field.name}`);
    if (field.pattern && !new RegExp(field.pattern).test(value)) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', `Elicitation field format invalid: ${field.name}`);
    if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', `Elicitation email invalid: ${field.name}`);
    if (field.format === 'uri') { try { new URL(value); } catch { throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', `Elicitation URI invalid: ${field.name}`); } }
    if (field.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', `Elicitation date invalid: ${field.name}`);
    if (field.format === 'date-time' && Number.isNaN(Date.parse(value))) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', `Elicitation date-time invalid: ${field.name}`);
  }
  if (field.type === 'number' || field.type === 'integer') {
    if (field.minimum != null && value < field.minimum || field.maximum != null && value > field.maximum) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', `Elicitation number range invalid: ${field.name}`);
  }
  if (field.enum && !field.enum.some((item) => Object.is(item, value))) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', `Elicitation value not allowed: ${field.name}`);
}

function validateElicitationContent(schema, rawContent) {
  if (!schema || !Array.isArray(schema.fields)) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation schema invalid');
  if (!rawContent || typeof rawContent !== 'object' || Array.isArray(rawContent)) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation response invalid');
  const content = {};
  const allowed = new Set(schema.fields.map((field) => field.name));
  for (const key of Object.keys(rawContent)) if (!allowed.has(key)) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation response contains an unknown field');
  for (const field of schema.fields) {
    const value = rawContent[field.name];
    if (value === undefined) {
      if (schema.required.includes(field.name)) throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', `Elicitation field required: ${field.name}`);
      continue;
    }
    validateFieldValue(field, value);
    content[field.name] = value;
  }
  return content;
}

function checkElicitationUrl(rawUrl, options = {}) {
  const text = String(rawUrl || '').trim();
  if (!text || text.length > MAX_URL) throw elicitationError('MCP_ELICITATION_URL_INVALID', 'Elicitation URL invalid');
  let url;
  try { url = new URL(text); } catch { throw elicitationError('MCP_ELICITATION_URL_INVALID', 'Elicitation URL invalid'); }
  const privateAllowed = options.allowPrivateUrl === true && options.devPrivateUrls === true;
  if ((url.protocol !== 'https:' && !(privateAllowed && url.protocol === 'http:')) || url.username || url.password || url.hash || !url.hostname) throw elicitationError('MCP_ELICITATION_URL_INVALID', 'Elicitation URL must be HTTPS without credentials or fragment');
  const checked = checkUrl(url.href, { allowPrivate: privateAllowed });
  if (!checked.ok) throw elicitationError('MCP_ELICITATION_URL_INVALID', 'Elicitation URL is not a permitted public HTTPS address');
  for (const [key] of url.searchParams) if (/token|secret|password|code|state|auth|session|key/i.test(key)) throw elicitationError('MCP_ELICITATION_URL_INVALID', 'Elicitation URL contains a sensitive query parameter');
  return { url: url.href, host: url.hostname, private: privateAllowed };
}

function publicRequest(request) {
  return {
    elicitationId: request.elicitationId,
    server: request.server,
    mode: request.mode,
    message: request.message,
    title: request.title,
    schema: request.schema,
    url: request.mode === 'url' ? request.url : undefined,
  };
}

function createMcpElicitationController(options = {}) {
  const enabled = options.enabled !== false;
  const allowPrivateUrl = options.allowPrivateUrl === true;
  const devPrivateUrls = options.devPrivateUrls === true || process.env.CODEX_DEV_MCP_PRIVATE_URLS === '1';
  const queue = [];
  const active = new Map();
  const listeners = new Set();
  let foreground = null;

  function emit(request) {
    const event = { type: 'mcp-elicitation-requested', ...publicRequest(request) };
    for (const listener of listeners) { try { listener(event); } catch { /* listener isolation */ } }
    options.onEvent?.(event);
  }

  function pump() {
    if (foreground || !queue.length) return;
    while (queue.length) {
      const next = queue.shift();
      if (next?.request && active.has(next.request.elicitationId) && !next.request.settled) {
        foreground = next;
        break;
      }
    }
    if (!foreground) return;
    emit(foreground.request);
  }

  function enqueue(server, params = {}, ownerId = null) {
    if (!enabled) return Promise.reject(elicitationError('MCP_ELICITATION_DISABLED', 'MCP elicitation is disabled'));
    const mode = params.mode === 'url' ? 'url' : 'form';
    let schema;
    let url;
    try {
      if (mode === 'form') schema = validateElicitationSchema(params.requestedSchema);
      else {
        const configuredPrivate = typeof options.allowPrivateUrlForServer === 'function'
          ? options.allowPrivateUrlForServer(String(server || '')) === true
          : allowPrivateUrl;
        url = checkElicitationUrl(params.url, { allowPrivateUrl: configuredPrivate, devPrivateUrls });
      }
    } catch (error) { return Promise.reject(error); }
    const request = {
      elicitationId: `mcp_elicit_${crypto.randomBytes(10).toString('hex')}`,
      server: cleanText(server, 96),
      mode,
      message: cleanText(params.message, MAX_TEXT),
      title: cleanText(params.title || 'MCP 请求输入', MAX_FIELD_TEXT),
      schema,
      url: url?.url,
      ownerId: ownerId == null ? null : Number(ownerId),
      resolve: null,
      reject: null,
      settled: false,
    };
    const promise = new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
    // The ID is needed by the transport cancellation path, but remains a
    // non-enumerable property so it cannot become part of the MCP response.
    Object.defineProperty(promise, 'elicitationId', { value: request.elicitationId, enumerable: false });
    active.set(request.elicitationId, request);
    queue.push({ request });
    pump();
    return promise;
  }

  function lookup(id, ownerId = null) {
    const request = active.get(String(id || ''));
    if (!request) throw elicitationError('MCP_ELICITATION_CANCELLED', 'Elicitation request not found');
    if (ownerId != null && request.ownerId != null && request.ownerId !== Number(ownerId)) throw elicitationError('MCP_ELICITATION_CANCELLED', 'Elicitation request is not owned by this window');
    return request;
  }

  function finish(request, response) {
    if (!request || request.settled) return false;
    request.settled = true;
    active.delete(request.elicitationId);
    if (foreground?.request === request) foreground = null;
    if (response.action === 'accept') request.resolve(response);
    else request.resolve({ action: response.action });
    pump();
    return true;
  }

  function respond(id, action, rawContent, ownerId = null) {
    const request = lookup(id, ownerId);
    const selected = String(action || '');
    if (selected !== 'accept' && selected !== 'decline' && selected !== 'cancel') throw elicitationError('MCP_ELICITATION_SCHEMA_INVALID', 'Elicitation action invalid');
    if (foreground?.request !== request) throw elicitationError('MCP_ELICITATION_BUSY', 'Elicitation request is queued');
    if (selected === 'accept') {
      if (request.mode === 'form') return finish(request, { action: 'accept', content: validateElicitationContent(request.schema, rawContent) });
      return finish(request, { action: 'accept' });
    }
    return finish(request, { action: selected });
  }

  async function openUrl(id, ownerId = null) {
    const request = lookup(id, ownerId);
    if (request.mode !== 'url' || foreground?.request !== request) throw elicitationError('MCP_ELICITATION_BUSY', 'Elicitation URL is not foreground');
    if (typeof options.openExternal !== 'function') throw elicitationError('MCP_ELICITATION_OPEN_FAILED', 'External URL opener unavailable');
    try { await options.openExternal(request.url); return { ok: true }; } catch { throw elicitationError('MCP_ELICITATION_OPEN_FAILED', 'External URL could not be opened'); }
  }

  function cancel(id, ownerId = null) { return finish(lookup(id, ownerId), { action: 'cancel' }); }

  function complete(id, ownerId = null) {
    return finish(lookup(id, ownerId), { action: 'cancel' });
  }

  function cancelAll() {
    for (const request of [...active.values()]) finish(request, { action: 'cancel' });
    queue.length = 0;
  }

  function cancelOwner(ownerId) {
    const id = Number(ownerId);
    for (const request of [...active.values()]) {
      if (request.ownerId === id) finish(request, { action: 'cancel' });
    }
  }

  return {
    enqueue,
    create: enqueue,
    respond,
    cancel,
    complete,
    cancelAll,
    cancelOwner,
    openUrl,
    get(id) { return publicRequest(lookup(id)); },
    list() { return [...active.values()].map(publicRequest); },
    onEvent(listener) { if (typeof listener !== 'function') return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
    validateElicitationSchema,
    validateElicitationContent,
    checkElicitationUrl,
  };
}

module.exports = {
  MAX_FIELDS,
  MAX_TEXT,
  SENSITIVE_FIELD_RE,
  elicitationError,
  validateElicitationSchema,
  validateElicitationContent,
  checkElicitationUrl,
  publicRequest,
  createMcpElicitationController,
};
