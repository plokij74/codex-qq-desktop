'use strict';

const { AGENT_EVENTS } = require('./agent-events');
const { publicModelSource } = require('./model-runtime');
const { normalizeModelUsage, resolvePricing, computeCost } = require('./usage');

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
function boundedString(value, max = 160) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000\r\n]/.test(value) ? value : null;
}
function positiveInteger(value) {
  const number = typeof value === 'number' ? value : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Build one public, legacy-compatible event per physical terminal attempt. Does not persist. */
function buildModelUsageEvent({ binding, settings = {}, attempt, kind } = {}) {
  if (settings?.usageEnabled === false || !binding || !attempt || !boundedString(binding.model, 256)) return null;
  const attemptId = boundedString(attempt.attemptId);
  if (!attemptId || !TERMINAL_STATUSES.has(attempt.status)) return null;
  const eventKind = boundedString(kind, 64) || boundedString(binding.kind, 64) || 'main';
  const modelSource = publicModelSource({
    providerId: boundedString(binding.providerId, 128),
    providerName: boundedString(binding.provider?.name, 128) || boundedString(binding.providerName, 128),
    modelProfileId: boundedString(binding.modelProfileId, 128),
    modelProfileName: boundedString(binding.modelProfile?.name, 128) || boundedString(binding.modelProfileName, 128),
    model: binding.model, protocol: boundedString(binding.protocol, 64), baseUrl: binding.baseUrl,
    assistantId: boundedString(binding.assistantId, 128),
    assistantName: boundedString(binding.assistant?.name, 128) || boundedString(binding.assistantName, 128),
    bindingRevision: boundedString(binding.bindingRevision, 128),
    providerRevision: positiveInteger(binding.providerRevision), modelRevision: positiveInteger(binding.modelRevision),
    assistantRevision: positiveInteger(binding.assistantRevision),
    runId: boundedString(binding.runId), clientRequestId: boundedString(binding.clientRequestId), kind: 'api',
  });
  const usage = normalizeModelUsage(attempt.usage);
  const pricing = resolvePricing(binding.model, settings?.usagePricing, {
    providerId: binding.providerId, modelProfileId: binding.modelProfileId,
  });
  const cost = computeCost(usage, pricing, { protocol: binding.protocol });
  // Regular-input pricing is only an estimate when cache discounts/counters are unknown.
  const costEstimated = cost !== null && (usage.source === 'estimated'
    || usage.cachedInputTokens === null || usage.cacheCreationInputTokens === null
    || usage.cachedInputTokens > 0 && pricing?.cachedInputPerM == null);
  const finishReason = boundedString(attempt.finishReason, 128);
  return {
    type: AGENT_EVENTS.USAGE, kind: eventKind, model: binding.model,
    ...usage, estimated: usage.source === 'estimated', cost, costEstimated,
    currency: typeof settings?.usageCurrency === 'string' ? settings.usageCurrency.slice(0, 4) || '$' : '$',
    contextTokens: usage.inputTokens,
    contextLimit: positiveInteger(binding.capabilities?.contextWindow?.tokens)
      || positiveInteger(binding.request?.contextWindowTokens)
      || positiveInteger(settings?.compactMaxApproxTokens) || 24000,
    attemptId, status: attempt.status,
    finishReason: finishReason && /^[A-Za-z0-9_.:-]+$/.test(finishReason) ? finishReason : null,
    providerId: modelSource.providerId, modelProfileId: modelSource.modelProfileId,
    assistantId: modelSource.assistantId, protocol: modelSource.protocol,
    bindingRevision: modelSource.bindingRevision, runId: modelSource.runId, clientRequestId: modelSource.clientRequestId,
    sessionId: boundedString(binding.sessionId), modelSource,
  };
}

module.exports = { buildModelUsageEvent };
