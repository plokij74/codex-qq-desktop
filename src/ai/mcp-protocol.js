'use strict';

const LATEST_PROTOCOL_VERSION = '2025-11-25';
const LEGACY_PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  LATEST_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
]);

function isSupportedProtocolVersion(value) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(String(value || ''));
}

function protocolError(message, code = 'MCP_PROTOCOL_VERSION_UNSUPPORTED', data) {
  const error = new Error(String(message || code));
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

function validateNegotiatedVersion(value) {
  // Older MCP fixtures and pre-2025 servers omitted the field even though
  // they otherwise implement the 2024-11-05 initialize contract.
  const version = value == null || value === '' ? LEGACY_PROTOCOL_VERSION : String(value);
  if (!isSupportedProtocolVersion(version)) {
    throw protocolError('MCP server protocol version is unsupported', undefined, {
      supported: SUPPORTED_PROTOCOL_VERSIONS,
      received: version || null,
    });
  }
  return version;
}

function buildClientCapabilities(opts = {}) {
  const configured = opts.capabilities && typeof opts.capabilities === 'object'
    ? { ...opts.capabilities }
    : {};
  if (opts.rootsProvider || opts.getRoots) configured.roots = { listChanged: true };
  if (opts.samplingHandler) configured.sampling = { ...(configured.sampling || {}) };
  if (opts.elicitationHandler || opts.elicitation?.form || opts.elicitation?.url) {
    const modes = opts.elicitation || {};
    configured.elicitation = {};
    if (modes.form !== false) configured.elicitation.form = {};
    if (modes.url !== false) configured.elicitation.url = {};
  }
  if (opts.tasksEnabled === true) {
    configured.tasks = {
      list: {},
      cancel: {},
      requests: {
        sampling: opts.samplingHandler ? { createMessage: {} } : undefined,
        elicitation: opts.elicitationHandler ? { create: {} } : undefined,
      },
    };
    if (!configured.tasks.requests.sampling) delete configured.tasks.requests.sampling;
    if (!configured.tasks.requests.elicitation) delete configured.tasks.requests.elicitation;
  }
  return configured;
}

function tasksCapability(capabilities) {
  return capabilities?.tasks && typeof capabilities.tasks === 'object'
    ? capabilities.tasks
    : null;
}

function supportsTaskRequest(capabilities, path) {
  let current = tasksCapability(capabilities);
  for (const part of String(path || '').split('.')) {
    if (!current || typeof current !== 'object') return false;
    current = current[part];
  }
  return Boolean(current && typeof current === 'object');
}

module.exports = {
  LATEST_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  isSupportedProtocolVersion,
  protocolError,
  validateNegotiatedVersion,
  buildClientCapabilities,
  tasksCapability,
  supportsTaskRequest,
};
