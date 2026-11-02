'use strict';

// The only legacy snake_case boundary. Production callers never supply endpoint/key/model authority.
const { invokeModelTurn } = require('./model-router');
const { isResolvedModelBinding } = require('./model-profiles');
const { ModelError, requireValue, normalizeMessages, unavailableUsage } = require('./model-adapters/common');
const responses = require('./model-adapters/openai-responses');
function legacyMessages(messages) {
  requireValue(Array.isArray(messages), 'MODEL_INPUT_INVALID', 'Model messages must be an array.');
  return normalizeMessages(messages.map((m) => ({ role: m?.role, content: m?.content, ...(m?.tool_call_id !== undefined ? { toolCallId: m.tool_call_id } : m?.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}), ...(m?.tool_calls?.length ? { toolCalls: m.tool_calls.map((t) => ({ id: t.id, name: t.function?.name, argumentsJson: t.function?.arguments })) } : m?.toolCalls?.length ? { toolCalls: m.toolCalls } : {}) })));
}
function legacyTools(tools) { if (tools === undefined) return []; requireValue(Array.isArray(tools), 'MODEL_INPUT_INVALID'); return tools.map((t) => t?.type === 'function' ? { name: t.function?.name, description: t.function?.description, parameters: t.function?.parameters } : t); }
function combineSignals(signals) {
  const unique = [...new Set(signals.filter(Boolean))]; if (unique.length <= 1) return { signal: unique[0], dispose() {} };
  const controller = new AbortController(); const abort = () => controller.abort();
  for (const signal of unique) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
  return { signal: controller.signal, dispose() { for (const signal of unique) signal.removeEventListener('abort', abort); } };
}
function notify(onUsage, event) { if (typeof onUsage !== 'function') return; try { Promise.resolve(onUsage(event)).catch(() => {}); } catch {} }
function createModelChatFunction({ binding, resolveCredential, fetchFn, signal, onUsage, onResult } = {}) {
  requireValue(isResolvedModelBinding(binding), 'MODEL_BINDING_INVALID', 'A main-process resolved model binding is required.');
  let state; let expectedHistory; let active = false;
  return async function boundModelChat(options = {}) {
    requireValue(!active, 'MODEL_BUSY', 'A request is already using this bound model client.'); active = true;
    const combined = combineSignals([signal, options.signal]); let result;
    try {
      const messages = legacyMessages(options.messages);
      if (state && (!expectedHistory || messages.length <= expectedHistory.length || JSON.stringify(messages.slice(0, expectedHistory.length)) !== JSON.stringify(expectedHistory))) { responses.invalidate(state); state = undefined; expectedHistory = undefined; }
      const request = {};
      if (options.maxTokens !== undefined) request.maxTokens = options.maxTokens;
      if (options.temperature !== undefined) request.temperaturePreference = options.temperature;
      if (options.timeoutMs !== undefined) request.timeoutMs = options.timeoutMs;
      if (options.deadlineAt !== undefined) request.deadlineAt = options.deadlineAt;
      if (binding.compatibility.streamMode === 'auto' && options.stream === false) request.stream = false;
      if (options.stop !== undefined) request.stop = options.stop;
      result = await invokeModelTurn({ binding, resolveCredential, fetchFn, signal: combined.signal, messages, tools: legacyTools(options.tools), request, providerState: state,
        onEvent: typeof options.onDelta === 'function' ? (event) => { if (event.type === 'text-delta') options.onDelta({ text: event.delta }); } : undefined });
      state = result.providerState;
      expectedHistory = [...messages, { role: 'assistant', content: result.content, ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}) }];
      if (result.attemptId) notify(onUsage, { usage: result.usage, attemptId: result.attemptId, modelSource: result.modelSource, status: 'completed', finishReason: result.finishReason });
      if (typeof onResult === 'function') { try { await onResult(result); } catch { /* successful output is not rolled back by evidence persistence */ } }
      return { role: 'assistant', content: result.content, tool_calls: result.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.argumentsJson } })), usage: result.usage, modelSource: result.modelSource, attemptId: result.attemptId, finish_reason: result.finishReason };
    } catch (error) {
      responses.invalidate(state); state = undefined; expectedHistory = undefined;
      if (error.attemptId) notify(onUsage, { usage: error.usage || unavailableUsage(), attemptId: error.attemptId, modelSource: error.modelSource, status: error.code === 'ABORTED' ? 'cancelled' : 'failed', finishReason: 'unknown' });
      throw error;
    } finally { combined.dispose(); active = false; }
  };
}
module.exports = { createModelChatFunction };
