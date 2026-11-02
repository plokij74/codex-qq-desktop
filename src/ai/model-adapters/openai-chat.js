'use strict';
const { buildChatPayload, invokeChatCompletionWire } = require('../openai-compatible');

function encodeMessages(messages) {
  return messages.map(message => ({ role: message.role, content: message.content,
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.argumentsJson } })) } : {}),
  }));
}
async function invoke({ binding, messages, tools, request, headers, url, context, fetchFn, onAttempt }) {
  const body = buildChatPayload(binding.model, encodeMessages(messages), {
    defaultTemperature: false, temperature: request.temperature,
    stop: request.stop, maxTokens: request.maxOutputTokens,
    maxTokenField: binding.request.chatTokenLimitField || 'max_tokens',
    stream: request.stream, includeUsage: request.includeUsage,
    ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: tool })) } : {}),
  });
  body.stream = request.stream;
  return invokeChatCompletionWire({ body, url, headers, context, fetchFn, onAttempt, strict: true });
}
module.exports = { invoke, encodeMessages };
