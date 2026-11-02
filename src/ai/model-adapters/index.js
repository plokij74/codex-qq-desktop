'use strict';
const { ModelError } = require('./common');
const adapters = Object.freeze({
  'openai-chat-completions': require('./openai-chat'),
  'openai-responses': require('./openai-responses'),
  'anthropic-messages': require('./anthropic-messages'),
});
function getModelAdapter(protocol) { const adapter = adapters[protocol]; if (!Object.hasOwn(adapters, protocol) || !adapter) throw new ModelError('MODEL_PROTOCOL_UNSUPPORTED', 'The selected model protocol is not supported.'); return adapter; }
module.exports = { getModelAdapter, MODEL_PROTOCOLS: Object.freeze(Object.keys(adapters)) };
