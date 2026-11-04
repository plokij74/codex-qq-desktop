'use strict';

// Main-only authority. DTOs, locators, hashes, renderer flags and persisted
// drafts never become byte capabilities. No filesystem or transport is exposed.
const { createHash } = require('node:crypto');
const {
  LIMITS, attachmentError, checkAbort, assertFields, checkedId, checkedInteger,
  randomOpaqueId, normalizeRelativePath, normalizeLineRange, publicAttachmentRef,
  prefixCodePoints, countCodePoints,
} = require('./attachment-contract');
const { extractText: defaultExtract } = require('./attachment-reader');
const runData = new WeakMap();
const envelopeFields = ['sessionId', 'attachmentSessionBindingId', 'clientRequestId'];
const digest = value => createHash('sha256').update(value).digest('hex');
const generation = record => record.refGeneration ?? record.generation ?? 0;
const snapshotDigest = record => record.hash ?? record.rawDigest;
const snapshotBytes = record => checkedInteger(record.byteLength ?? record.rawByteLength, { max: LIMITS.MAX_FILE_BYTES, code: 'ATTACHMENT_CORRUPT' });

function getAttachmentRunData(run) {
  const data = runData.get(run);
  if (!data || data.released) throw attachmentError();
  return data;
}
function normalizeInventory(inventory) {
  if (!Array.isArray(inventory)) throw attachmentError();
  const result = [], keys = new Set();
  for (const ref of inventory) {
    const relativePath = normalizeRelativePath(String(ref.path || '').replace(/%20/gi, ' '));
    const normalized = normalizeLineRange({ startLine: ref.startLine, endLine: ref.endLine });
    const range = normalized.startLine === undefined ? undefined : { startLine: normalized.startLine, endLine: normalized.endLine };
    const key = `${relativePath}\n${range?.startLine ?? ''}\n${range?.endLine ?? ''}`;
    if (keys.has(key)) continue;
    keys.add(key); result.push({ key, relativePath, range });
    if (result.length > LIMITS.MAX_SELECTION_FILES) throw attachmentError('ATTACHMENT_SELECTION_LIMIT');
  }
  return result;
}
function ids(value) {
  if (!Array.isArray(value) || value.length > LIMITS.MAX_SELECTION_FILES || new Set(value).size !== value.length) throw attachmentError('ATTACHMENT_SELECTION_LIMIT');
  return value.map(id => checkedId(id, { prefix: 'att' }));
}
function selectionMap(value = []) {
  if (!Array.isArray(value) || value.length > LIMITS.MAX_SELECTION_FILES) throw attachmentError('ATTACHMENT_TEXT_LIMIT');
  const result = new Map();
  for (const selection of value) {
    assertFields(selection, ['attachmentId', 'prefixCodePoints']);
    const id = checkedId(selection.attachmentId, { prefix: 'att' });
    if (result.has(id)) throw attachmentError('ATTACHMENT_TEXT_LIMIT');
    result.set(id, checkedInteger(selection.prefixCodePoints, { max: LIMITS.MAX_FILE_TEXT_CODEPOINTS, code: 'ATTACHMENT_TEXT_LIMIT' }));
  }
  return result;
}
function readyRecord(store, id, namespace) {
  const record = store.getRecord(id, namespace);
  if (record.status !== 'ready') {
    const codes = { missing: 'ATTACHMENT_MISSING', corrupt: 'ATTACHMENT_CORRUPT', expired: 'ATTACHMENT_EXPIRED', deleted: 'ATTACHMENT_DELETED' };
    throw attachmentError(codes[record.status] || 'ATTACHMENT_REFERENCE_INVALID');
  }
  return record;
}
function metadataReservationBytes(entry) {
  let size = 1024 + entry.text.length * 2;
  for (const ancestor of entry.sourceAncestors || []) size += 64 + String(ancestor.path || '').length * 2 + String(ancestor.identity || '').length * 2;
  size += String(entry.record?.sourceInfo?.relativePath || '').length * 2;
  return size;
}

function createAttachmentPreviewService(options = {}) {
  const { store, reader, budget, now = Date.now } = options;
  const extract = options.extractText || defaultExtract;
  if (!store || !reader || !budget || typeof options.describeSend !== 'function' || typeof options.authorizeSender !== 'function') throw attachmentError();
  const owners = new Map(), namespaceOwners = new Map(), tickets = new Map(), used = new Set(), runs = new Set(), operations = new Set();
  let closed = false;
  const clock = () => checkedInteger(Math.floor(now()));
  function authorize(event) {
    if (closed || !event?.sender || !options.authorizeSender(event)) throw attachmentError();
    return checkedInteger(event.sender.id, { min: 1 });
  }
  function authenticate(event, payload) {
    const senderId = authorize(event), sessionId = checkedId(payload?.sessionId);
    const key = checkedId(payload?.attachmentSessionBindingId, { prefix: 'asb' });
    const owner = owners.get(key);
    if (!owner || !owner.valid || owner.senderId !== senderId || owner.sessionId !== sessionId) throw attachmentError();
    return owner;
  }
  function checkOwner(owner) {
    if (!owner.valid || closed || !options.authorizeSender(owner.event)) throw attachmentError('ABORTED');
  }
  async function operate(event, payload, callback) {
    const owner = authenticate(event, payload), requestId = checkedId(payload.clientRequestId);
    if (owner.pending.has(requestId)) throw attachmentError('ATTACHMENT_WORK_BUSY');
    const controller = new AbortController(), operation = { owner, requestId, controller, promise: null };
    owner.pending.set(requestId, operation); operations.add(operation);
    const promise = (async () => {
      try { return await callback(owner, controller.signal, controller); }
      finally { owner.pending.delete(requestId); operations.delete(operation); }
    })();
    operation.promise = promise; return promise;
  }
  function ownerDTO(owner) {
    return { sessionId: owner.sessionId, namespaceRef: owner.namespace.namespaceRef, attachmentSessionBindingId: owner.key, storageMode: owner.namespace.storageMode || store.cacheStatus().storageMode };
  }
  function pruneAliases(owner, all = false) {
    for (const [id, alias] of owner.selectionAliases) if (all || alias.expiresAt <= clock()) {
      alias.reservation.release(); owner.selectionAliases.delete(id);
    }
  }
  function rememberSelection(owner, entry) {
    if (!entry.token) return;
    pruneAliases(owner);
    const id = entry.record.attachmentId, old = owner.selectionAliases.get(id);
    if (old) { old.reservation.release(); owner.selectionAliases.delete(id); }
    while (owner.selectionAliases.size >= LIMITS.MAX_PREVIEWS * LIMITS.MAX_SELECTION_FILES) {
      const oldest = owner.selectionAliases.keys().next().value;
      owner.selectionAliases.get(oldest).reservation.release(); owner.selectionAliases.delete(oldest);
    }
    const reservation = budget.reserveRetained(256 + entry.token.key.length * 2);
    owner.selectionAliases.set(id, { key: entry.token.key, maximum: entry.selected.selectedChars, reservation, expiresAt: clock() + LIMITS.PREVIEW_TTL_MS });
  }
  function normalizedSelections(owner, attachmentIds, inventory, requested) {
    const direct = new Map(), tokens = new Map(), currentTokens = new Set(inventory.map(ref => ref.key));
    if (owner) pruneAliases(owner);
    for (const [id, limit] of requested) {
      if (attachmentIds.includes(id)) { direct.set(id, limit); continue; }
      const alias = owner?.selectionAliases.get(id);
      if (!alias || !currentTokens.has(alias.key) || limit > alias.maximum || tokens.has(alias.key)) throw attachmentError('ATTACHMENT_TEXT_LIMIT');
      tokens.set(alias.key, limit);
    }
    return { direct, tokens };
  }
  function attachOwner(event, namespace) {
    const senderId = authorize(event), existing = namespaceOwners.get(namespace.namespaceRef);
    if (existing?.valid) {
      if (existing.senderId !== senderId || existing.sessionId !== namespace.sessionId) throw attachmentError();
      return existing;
    }
    const owner = { key: randomOpaqueId('asb'), senderId, sessionId: namespace.sessionId, namespace, event, valid: true, pending: new Map(), selectionAliases: new Map(), localMessageRevision: 0 };
    owners.set(owner.key, owner); namespaceOwners.set(namespace.namespaceRef, owner); return owner;
  }
  function markUsed(id) { used.add(id); if (used.size > LIMITS.MAX_PREVIEWS) used.delete(used.values().next().value); }
  async function disposeTicket(ticket) {
    if (ticket.disposed || ticket.consumed || ticket.claiming) return;
    ticket.disposed = true; tickets.delete(ticket.id);
    for (const allocation of ticket.allocations) allocation.release();
    ticket.allocations = []; ticket.entries = [];
    await ticket.hold?.release?.();
    for (const id of ticket.autoIds || []) {
      try { await store.removeFromDraft(id, ticket.owner.namespace); } catch { /* GC remains visible/retryable in the controlled store. */ }
    }
  }
  async function prune() {
    for (const ticket of [...tickets.values()]) {
      if (!ticket.consumed && (ticket.expiresAt <= clock() || !ticket.owner.valid || ticket.invalid)) {
        ticket.invalid = true; ticket.claimController?.abort(); await disposeTicket(ticket);
      }
    }
  }
  async function invalidate(owner, attachmentId) {
    for (const ticket of tickets.values()) {
      if (ticket.owner !== owner || ticket.consumed || attachmentId && !ticket.entries.some(entry => entry.record.attachmentId === attachmentId)) continue;
      ticket.invalid = true; ticket.claimController?.abort(); await disposeTicket(ticket);
    }
    for (const run of runs) {
      const data = runData.get(run);
      if (data.owner !== owner || attachmentId && !data.entries.some(entry => entry.record.attachmentId === attachmentId)) continue;
      data.invalidated = true; options.onRunInvalidated?.(run, attachmentId ? 'attachment' : 'owner');
    }
  }
  async function projectFor(event, description, work, signal) {
    if (typeof options.resolveProject !== 'function') throw attachmentError('ATTACHMENT_READ_DENIED');
    const project = await options.resolveProject(event, description, { work, signal });
    checkAbort(signal);
    if (!project?.projectRoot || !project.rootIdentity) throw attachmentError('ATTACHMENT_READ_DENIED');
    return project;
  }
  function mapCapture(captured, selected, sourceInfo) {
    return { name: selected.name, mimeType: selected.mimeType, sourceKind: captured.sourceKind,
      rawBytes: captured.bytes, rawDigest: selected.rawDigest, extractedChars: selected.extractedChars,
      selectedChars: Math.min(selected.selectedChars, selected.extractedChars), sourceInfo,
      decodeVersion: 1, extractVersion: 1, selectedAt: clock() };
  }
  async function importExternal(owner, paths, signal) {
    if (!Array.isArray(paths) || paths.length > LIMITS.MAX_SELECTION_FILES) throw attachmentError('ATTACHMENT_SELECTION_LIMIT');
    if (!paths.length) return { refs: [], cancelled: true, ...ownerDTO(owner) };
    return budget.withWork({ signal }, async work => {
      const captures = [], releases = []; let total = 0;
      try {
        for (const path of paths) {
          if (typeof path !== 'string') throw attachmentError();
          const grant = reader.createExternalGrant(path);
          const captured = await reader.capture(grant, { signal, work, maxBytes: LIMITS.MAX_FILE_BYTES });
          releases.push(() => captured.release?.()); checkAbort(signal); checkOwner(owner);
          total += captured.bytes.length;
          if (total > LIMITS.MAX_SELECTION_RAW_BYTES) throw attachmentError('ATTACHMENT_SELECTION_LIMIT');
          const selected = extract(captured, { redact: options.redact, work });
          captures.push(mapCapture(captured, selected, { sourceIdentity: captured.identity, selectedAt: clock() }));
        }
        const result = await store.importBatch({ namespace: owner.namespace, sessionId: owner.sessionId, captures }, { signal, work });
        checkAbort(signal); checkOwner(owner); return { ...result, ...ownerDTO(owner) };
      } finally { for (const release of releases) await release(); }
    });
  }
  async function describe(event, payload) {
    authorize(event); checkedId(payload.sessionId); checkedId(payload.clientRequestId);
    const requested = selectionMap(payload.attachmentSelections);
    const description = await options.describeSend(event, payload);
    const attachmentIds = ids(description.attachmentIds || []), inventory = normalizeInventory(description.inventory || []);
    if (attachmentIds.length + inventory.length > LIMITS.MAX_SELECTION_FILES) throw attachmentError('ATTACHMENT_SELECTION_LIMIT');
    if (typeof description.fingerprint !== 'string' || !description.fingerprint || typeof description.userText !== 'string') throw attachmentError();
    const owner = requested.size ? authenticate(event, payload) : null;
    const { direct: selections, tokens: tokenSelections } = normalizedSelections(owner, attachmentIds, inventory, requested);
    const ordered = map => [...map].sort(([a], [b]) => a.localeCompare(b));
    const fingerprint = createHash('sha256').update(description.fingerprint).update(JSON.stringify([ordered(selections), ordered(tokenSelections)])).digest('hex');
    return { ...description, fingerprint, selections, tokenSelections, attachmentIds, inventory, required: !!(attachmentIds.length || inventory.length) };
  }
  async function captureInventory(owner, description, work, signal) {
    const result = [], autoIds = []; let project;
    try {
      if (description.inventory.length) project = await projectFor(owner.event, description, work, signal);
      for (const ref of description.inventory) {
        const grant = reader.createProjectGrant({ projectRoot: project.projectRoot, relativePath: ref.relativePath, rootIdentity: project.rootIdentity,
          ...(project.ancestors ? { expectedAncestors: project.ancestors } : {}), ...(ref.range || {}) });
        const captured = await reader.capture(grant, { signal, work, maxBytes: LIMITS.MAX_FILE_BYTES });
        try {
          checkOwner(owner); checkAbort(signal);
          const selected = extract(captured, { ...(ref.range || {}), redact: options.redact, work });
          const sourceInfo = { relativePath: ref.relativePath, ...(ref.range ? { range: ref.range } : {}), rootIdentity: captured.rootIdentity,
            sourceIdentity: captured.identity, ancestorIdentities: (captured.ancestors || []).map(ancestor => ancestor.identity),
            ...(project.projectId ? { projectId: project.projectId } : {}) };
          const imported = await store.importBatch({ namespace: owner.namespace, sessionId: owner.sessionId, captures: [mapCapture(captured, selected, sourceInfo)] }, { signal, work });
          const id = imported.refs[0].attachmentId; autoIds.push(id);
          result.push({ id, token: ref, sourceAncestors: captured.ancestors || [] });
        } finally { await captured.release?.(); }
      }
      return { result, autoIds };
    } catch (error) {
      // All imported application copies remain main-owned; never delete sources.
      for (const id of autoIds) {
        try { await store.removeFromDraft(id, owner.namespace, {}, { work }); } catch { /* preserved for safe bounded GC */ }
      }
      throw error;
    }
  }
  function selectedEntry(record, bytes, selection, work, extra = {}) {
    const sourceInfo = record.sourceInfo;
    const captured = { bytes, name: record.name, sourceKind: record.sourceKind, rawDigest: snapshotDigest(record) };
    const selected = extract(captured, { ...(sourceInfo?.range || {}), prefixCodePoints: selection, redact: options.redact, work });
    return { record, generation: generation(record), text: selected.text, selectedDigest: selected.selectedDigest,
      selected, ref: publicAttachmentRef({ ...record, budget: selected }), ...extra };
  }
  async function verifyProject(owner, description, entry, work, signal) {
    const info = entry.record.sourceInfo;
    if (!info?.relativePath || !info.rootIdentity || !info.sourceIdentity) throw attachmentError('ATTACHMENT_REFERENCE_INVALID');
    const project = await projectFor(owner.event, description, work, signal);
    if (project.rootIdentity !== info.rootIdentity) throw attachmentError('ATTACHMENT_SOURCE_CHANGED');
    const grant = reader.createProjectGrant({ projectRoot: project.projectRoot, relativePath: info.relativePath, rootIdentity: info.rootIdentity,
      expectedIdentity: info.sourceIdentity, expectedDigest: snapshotDigest(entry.record),
      ...(entry.sourceAncestors?.length ? { expectedAncestors: entry.sourceAncestors } : {}), ...(info.range || {}) });
    const captured = await reader.capture(grant, { signal, work, maxBytes: LIMITS.MAX_FILE_BYTES });
    try {
      checkAbort(signal); checkOwner(owner);
      if (captured.rawDigest !== snapshotDigest(entry.record) || captured.identity !== info.sourceIdentity || captured.rootIdentity !== info.rootIdentity) throw attachmentError('ATTACHMENT_SOURCE_CHANGED');
      const previous = info.ancestorIdentities || [], current = (captured.ancestors || []).map(ancestor => ancestor.identity);
      if (previous.length !== current.length || previous.some((identity, index) => identity !== current[index])) throw attachmentError('ATTACHMENT_SOURCE_CHANGED');
    } finally { await captured.release?.(); }
  }
  async function checkRun(data, { work: borrowedWork } = {}) {
    if (data.released || !data.consumed) throw attachmentError();
    await data.ready; checkOwner(data.owner); checkAbort(data.signal);
    if (data.redactionGeneration !== (options.getRedactionGeneration?.() ?? 0)) throw attachmentError('ATTACHMENT_PREVIEW_STALE');
    for (const entry of data.entries) {
      const record = readyRecord(store, entry.record.attachmentId, data.owner.namespace);
      if (generation(record) !== entry.generation) throw attachmentError('ATTACHMENT_PREVIEW_STALE');
    }
    if (data.invalidated) throw attachmentError('ATTACHMENT_PREVIEW_STALE');
    await options.validateCurrent?.(data.owner.event, data.description, { signal: data.signal, work: borrowedWork, stage: 'dispatch' });
    const projectEntries = data.entries.filter(entry => entry.record.sourceKind === 'at_project_ref');
    if (projectEntries.length) {
      await budget.withWork({ signal: data.signal, work: borrowedWork }, async work => {
        const project = await projectFor(data.owner.event, data.description, work, data.signal);
        if (projectEntries.some(entry => entry.record.sourceInfo.rootIdentity !== project.rootIdentity)) throw attachmentError('ATTACHMENT_SOURCE_CHANGED');
      });
    }
    checkOwner(data.owner); checkAbort(data.signal);
    if (data.invalidated || data.redactionGeneration !== (options.getRedactionGeneration?.() ?? 0)) throw attachmentError('ATTACHMENT_PREVIEW_STALE');
    for (const entry of data.entries) if (generation(readyRecord(store, entry.record.attachmentId, data.owner.namespace)) !== entry.generation) throw attachmentError('ATTACHMENT_PREVIEW_STALE');
  }

  async function syncRunMessageLinks(data, messages) {
    const linked = new Set(data.entries.map(entry => entry.record.attachmentId));
    for (const message of messages || []) for (const part of message.parts || []) if (part.type === 'attachment_ref') {
      try { const record = readyRecord(store, part.attachmentId, data.owner.namespace); linked.add(record.attachmentId); } catch { /* historical locator is metadata, not authority */ }
    }
    if (typeof store.syncMessageLinks !== 'function') return;
    const revisions = typeof store.getLinkRevisions === 'function' ? store.getLinkRevisions(data.owner.namespace) : null;
    const revision = revisions ? revisions.messageRevision + 1 : ++data.owner.localMessageRevision;
    await store.syncMessageLinks(data.owner.namespace, { revision, ids: [...linked] }, { signal: data.signal });
    for (const entry of data.entries) entry.generation = generation(readyRecord(store, entry.record.attachmentId, data.owner.namespace));
  }
  const service = {
    async registerSession(event, payload = {}) {
      assertFields(payload, ['sessionId', 'clientRequestId']); authorize(event); const sessionId = checkedId(payload.sessionId); checkedId(payload.clientRequestId);
      for (const owner of owners.values()) if (owner.valid && owner.senderId === event.sender.id && owner.sessionId === sessionId) return ownerDTO(owner);
      const namespace = await store.createNamespace({ sessionId }); return ownerDTO(attachOwner(event, namespace));
    },
    async restoreSession(event, payload = {}) {
      assertFields(payload, ['sessionId', 'clientRequestId', 'namespaceRef']); authorize(event);
      const sessionId = checkedId(payload.sessionId); checkedId(payload.clientRequestId); checkedId(payload.namespaceRef, { prefix: 'ans' });
      const existing = namespaceOwners.get(payload.namespaceRef);
      if (existing?.valid && existing.senderId !== event.sender.id) throw attachmentError();
      if (typeof options.confirmRestore !== 'function' || !await options.confirmRestore(event, { sessionId, namespaceRef: payload.namespaceRef })) throw attachmentError('ATTACHMENT_READ_DENIED');
      authorize(event); const namespace = store.getNamespace(payload.namespaceRef, sessionId); return { ...ownerDTO(attachOwner(event, namespace)), refs: store.list(namespace) };
    },
    async chooseExternal(event, payload = {}) {
      assertFields(payload, envelopeFields);
      return operate(event, payload, async (owner, signal) => {
        if (typeof options.chooseExternal !== 'function') throw attachmentError('ATTACHMENT_READ_DENIED');
        const paths = await options.chooseExternal(event, { sessionId: owner.sessionId }); checkAbort(signal); checkOwner(owner);
        return importExternal(owner, paths || [], signal);
      });
    },
    async proposeDrop(event, payload = {}) {
      assertFields(payload, [...envelopeFields, 'paths']);
      return operate(event, payload, async (owner, signal) => {
        if (!Array.isArray(payload.paths) || payload.paths.length < 1 || payload.paths.length > LIMITS.MAX_SELECTION_FILES || payload.paths.some(path => typeof path !== 'string' || path.length > 32768 || /[\u0000-\u001f]/.test(path))) throw attachmentError('ATTACHMENT_SELECTION_LIMIT');
        if (typeof options.confirmDrop !== 'function' || !await options.confirmDrop(event, { paths: payload.paths, sessionId: owner.sessionId })) throw attachmentError('ATTACHMENT_READ_DENIED');
        checkAbort(signal); checkOwner(owner); return importExternal(owner, payload.paths, signal);
      });
    },
    async list(event, payload = {}) { assertFields(payload, envelopeFields); const owner = authenticate(event, payload); return { ...ownerDTO(owner), refs: store.list(owner.namespace) }; },
    async captureProjectRefs(event, payload = {}) {
      const description = await describe(event, payload);
      return operate(event, payload, (owner, signal) => budget.withWork({ signal }, async work => {
        const captured = await captureInventory(owner, description, work, signal); checkOwner(owner);
        return { ...ownerDTO(owner), refs: captured.result.map(value => publicAttachmentRef(store.getRecord(value.id, owner.namespace))) };
      }));
    },
    async prepareSend(event, payload = {}) {
      const description = await describe(event, payload);
      if (!description.required) return { required: false, target: description.target, budget: description.budget };
      selectionMap(payload.attachmentSelections); await prune();
      if (tickets.size >= LIMITS.MAX_PREVIEWS) throw attachmentError('ATTACHMENT_CACHE_LIMIT');
      return operate(event, payload, (owner, signal) => budget.withWork({ signal }, async work => {
        const allocations = [], entries = []; let held, autoIds = [], published = false;
        try {
          const automatic = await captureInventory(owner, description, work, signal); autoIds = automatic.autoIds;
          const allIds = [...description.attachmentIds, ...automatic.result.map(result => result.id)];
          held = store.hold(allIds, owner.namespace, { kind: 'preview' }); const selections = description.selections;
          let totalRaw = 0, totalText = 0;
          for (const id of allIds) {
            const record = readyRecord(store, id, owner.namespace); const extra = automatic.result.find(result => result.id === id) || {};
            const value = await store.read(id, owner.namespace, { signal, work });
            try {
              checkOwner(owner); checkAbort(signal);
              const entry = selectedEntry(record, value.bytes, extra.token ? description.tokenSelections.get(extra.token.key) : selections.get(id), work, { token: extra.token, sourceAncestors: extra.sourceAncestors });
              totalRaw += snapshotBytes(record); totalText += entry.selected.selectedChars;
              if (totalRaw > LIMITS.MAX_SELECTION_RAW_BYTES) throw attachmentError('ATTACHMENT_SELECTION_LIMIT');
              if (totalText > LIMITS.MAX_SELECTION_TEXT_CODEPOINTS) throw attachmentError('ATTACHMENT_TEXT_LIMIT');
              allocations.push(budget.reserveRetained(metadataReservationBytes(entry))); entries.push(entry);
            } finally { await value.release?.(); }
          }
          const redactionGeneration = options.getRedactionGeneration?.() ?? 0;
          const preflight = await options.preflightSelection?.(description, entries, { work, signal }) || description.budget || {};
          const estimated = (preflight.estimatedInputTokens || 0) + (options.preflightSelection ? 0 : entries.reduce((sum, entry) => sum + entry.selected.estimatedTokens, 0));
          if (preflight.contextLimit && estimated + (preflight.maxOutputTokens || 0) > preflight.contextLimit) throw attachmentError('ATTACHMENT_TEXT_LIMIT');
          checkOwner(owner); checkAbort(signal);
          const id = randomOpaqueId('apv'); const ticket = { id, owner, description: { ...description, messages: undefined }, entries, allocations, hold: held, autoIds,
            fingerprint: description.fingerprint, redactionGeneration, expiresAt: clock() + LIMITS.PREVIEW_TTL_MS, invalid: false, disposed: false, claiming: false, consumed: false,
            target: description.target, budget: { ...preflight, estimatedInputTokens: estimated } };
          for (const entry of entries) rememberSelection(owner, entry);
          tickets.set(id, ticket); published = true;
          return { required: true, previewId: id, expiresAt: ticket.expiresAt, target: ticket.target, attachments: entries.map(entry => entry.ref), budget: ticket.budget, ...ownerDTO(owner) };
        } finally {
          if (!published) {
            for (const allocation of allocations) allocation.release(); await held?.release?.();
            for (const id of autoIds) try { await store.removeFromDraft(id, owner.namespace, {}, { work }); } catch { /* controlled GC can retry */ }
          }
        }
      }));
    },
    async previewPage(event, payload = {}) {
      assertFields(payload, [...envelopeFields, 'previewId', 'attachmentId', 'offset', 'limit']); const owner = authenticate(event, payload);
      await prune(); const ticket = tickets.get(checkedId(payload.previewId, { prefix: 'apv' }));
      if (!ticket || ticket.owner !== owner || ticket.invalid || ticket.consumed) throw attachmentError('ATTACHMENT_PREVIEW_STALE');
      const entry = ticket.entries.find(value => value.record.attachmentId === payload.attachmentId); if (!entry) throw attachmentError();
      const offset = checkedInteger(payload.offset ?? 0, { max: entry.selected.selectedChars }), limit = checkedInteger(payload.limit ?? LIMITS.PREVIEW_PAGE_CODEPOINTS, { min: 1, max: LIMITS.PREVIEW_PAGE_CODEPOINTS });
      return budget.withWork({}, async work => {
        work.reserve(LIMITS.PREVIEW_PAGE_CODEPOINTS * 8 + 4096);
        const head = prefixCodePoints(entry.text, offset); const text = prefixCodePoints(entry.text.slice(head.length), limit);
        return { attachmentId: entry.record.attachmentId, offset, text, totalCodePoints: entry.selected.selectedChars, nextOffset: offset + countCodePoints(text), truncated: entry.selected.truncated, empty: entry.selected.empty, done: offset + countCodePoints(text) >= entry.selected.selectedChars };
      });
    },
    async claimSend(event, payload = {}) {
      const description = await describe(event, payload);
      if (!description.required) { if (payload.attachmentPreviewId) throw attachmentError('ATTACHMENT_PREVIEW_STALE'); return null; }
      if (!payload.attachmentPreviewId) throw attachmentError('ATTACHMENT_PREVIEW_REQUIRED');
      const owner = authenticate(event, payload), previewId = checkedId(payload.attachmentPreviewId, { prefix: 'apv' });
      if (used.has(previewId) || tickets.get(previewId)?.consumed) throw attachmentError('ATTACHMENT_PREVIEW_USED');
      await prune(); const ticket = tickets.get(previewId);
      if (!ticket || ticket.owner !== owner || ticket.invalid || ticket.disposed || ticket.fingerprint !== description.fingerprint || ticket.redactionGeneration !== (options.getRedactionGeneration?.() ?? 0) || ticket.claiming) throw attachmentError('ATTACHMENT_PREVIEW_STALE');
      ticket.claiming = true;
      try {
        return await operate(event, payload, (currentOwner, signal, controller) => budget.withWork({ signal }, async work => {
          ticket.claimController = controller;
          for (const entry of ticket.entries) {
            const record = readyRecord(store, entry.record.attachmentId, owner.namespace);
            if (generation(record) !== entry.generation) throw attachmentError('ATTACHMENT_PREVIEW_STALE');
            if (record.sourceKind === 'at_project_ref') await verifyProject(owner, description, entry, work, signal);
            const value = await store.read(record.attachmentId, owner.namespace, { signal, work });
            try {
              const repeated = selectedEntry(record, value.bytes, entry.selected.selectedChars, work);
              if (repeated.text !== entry.text || repeated.selectedDigest !== entry.selectedDigest || generation(value.record) !== entry.generation) throw attachmentError('ATTACHMENT_PREVIEW_STALE');
            } finally { await value.release?.(); }
          }
          await options.validateCurrent?.(owner.event, description, { signal, stage: 'claim' });
          checkOwner(owner); checkAbort(signal);
          if (ticket.invalid || ticket.redactionGeneration !== (options.getRedactionGeneration?.() ?? 0)) throw attachmentError('ATTACHMENT_PREVIEW_STALE');
          const sourceValidatedAt = clock(), userMessage = { ...description.userMessage, content: description.userText,
            parts: [...(description.userMessage?.parts || [{ type: 'text', text: description.userText }]).filter(part => part.type !== 'attachment_ref'), ...ticket.entries.map(entry => ({ type: 'attachment_ref', ...entry.ref }))] };
          const data = { owner, ticket, entries: ticket.entries, inventory: description.inventory, description, userMessage, sourceValidatedAt,
            redactionGeneration: ticket.redactionGeneration, signal: undefined, consumed: false, released: false, ready: Promise.resolve(), invalidated: false };
          const run = Object.freeze({
            check: (options = {}) => checkRun(data, options),
            async ready() { await data.ready; },
            async syncMessageLinks(messages) {
              if (!data.consumed || data.released) throw attachmentError();
              await data.ready; await checkRun(data);
              data.ready = syncRunMessageLinks(data, messages); await data.ready;
            },
            setSignal(signalValue) { if (data.consumed || data.released) throw attachmentError(); data.signal = signalValue; },
            async release() {
              if (data.released) return; data.released = true; runs.delete(run); ticket.claiming = false; ticket.claimController = null;
              if (data.consumed) {
                await Promise.allSettled([data.ready]); tickets.delete(ticket.id); markUsed(ticket.id);
                for (const allocation of ticket.allocations) allocation.release(); ticket.allocations = []; ticket.entries = []; data.entries = [];
                await ticket.hold?.release?.();
                for (const id of ticket.autoIds) try { await store.removeFromDraft(id, owner.namespace); } catch { /* safe bounded GC remains retryable */ }
              } else if (ticket.invalid || !owner.valid || ticket.expiresAt <= clock()) await disposeTicket(ticket);
            },
          });
          runData.set(run, data); runs.add(run); ticket.claimController = null; return run;
        }));
      } catch (error) {
        ticket.claiming = false; ticket.claimController = null;
        if (ticket.invalid || !owner.valid || ticket.expiresAt <= clock()) await disposeTicket(ticket);
        throw error;
      }
    },
    consume(run) {
      const data = getAttachmentRunData(run), ticket = data.ticket;
      if (data.consumed || ticket.consumed || ticket.invalid || !ticket.claiming || ticket.expiresAt <= clock()) throw attachmentError('ATTACHMENT_PREVIEW_STALE');
      checkOwner(data.owner); checkAbort(data.signal);
      for (const entry of data.entries) if (generation(readyRecord(store, entry.record.attachmentId, data.owner.namespace)) !== entry.generation) throw attachmentError('ATTACHMENT_PREVIEW_STALE');
      data.consumed = true; ticket.consumed = true; markUsed(ticket.id);
      data.ready = syncRunMessageLinks(data, data.description.messages);
      data.ready.catch(() => {}); // Caller/dispatch awaits the same failure; no unhandled rejection.
    },
    async remove(event, payload = {}) {
      assertFields(payload, [...envelopeFields, 'attachmentId', 'draftRevision']); const owner = authenticate(event, payload); checkedId(payload.attachmentId, { prefix: 'att' });
      const result = await store.removeFromDraft(payload.attachmentId, owner.namespace, payload.draftRevision === undefined ? {} : { revision: payload.draftRevision });
      await invalidate(owner, payload.attachmentId); return result;
    },
    async deleteCopy(event, payload = {}) {
      assertFields(payload, [...envelopeFields, 'attachmentId']); const owner = authenticate(event, payload); const record = store.getRecord(payload.attachmentId, owner.namespace);
      if (typeof options.confirmDelete !== 'function' || !await options.confirmDelete(event, { attachment: publicAttachmentRef(record), sessionId: owner.sessionId })) throw attachmentError('ATTACHMENT_READ_DENIED');
      checkOwner(owner); const result = await store.deleteCopy(payload.attachmentId, owner.namespace); await invalidate(owner, payload.attachmentId); return result;
    },
    async cancel(event, payload = {}) {
      assertFields(payload, [...envelopeFields, 'previewId', 'targetClientRequestId']); const owner = authenticate(event, payload);
      const pending = payload.targetClientRequestId
        ? [owner.pending.get(checkedId(payload.targetClientRequestId))].filter(Boolean)
        : payload.previewId ? [] : [...owner.pending.values()];
      for (const operation of pending) operation.controller.abort();
      for (const ticket of [...tickets.values()]) if (ticket.owner === owner && !ticket.consumed && (!payload.previewId || ticket.id === payload.previewId)) {
        ticket.invalid = true; ticket.claimController?.abort(); await disposeTicket(ticket);
      }
      await Promise.allSettled(pending.map(operation => operation.promise));
      return { cancelled: true };
    },
    async cacheStatus(event, payload = {}) { assertFields(payload, envelopeFields); authenticate(event, payload); return { ...store.cacheStatus(), previewCount: tickets.size, pendingOperations: operations.size }; },
    async clearCache(event, payload = {}) {
      assertFields(payload, envelopeFields); const owner = authenticate(event, payload);
      if (typeof options.confirmClear !== 'function' || !await options.confirmClear(event, { sessionId: owner.sessionId })) throw attachmentError('ATTACHMENT_READ_DENIED');
      checkOwner(owner); const result = await store.clear(owner.namespace); await invalidate(owner); return result;
    },
    async dropOwner(senderId) {
      for (const owner of owners.values()) if (owner.senderId === senderId && owner.valid) {
        owner.valid = false; pruneAliases(owner, true); owners.delete(owner.key); namespaceOwners.delete(owner.namespace.namespaceRef);
        for (const operation of owner.pending.values()) operation.controller.abort(); await invalidate(owner);
      }
      await Promise.allSettled([...operations].filter(operation => operation.owner.senderId === senderId).map(operation => operation.promise));
    },
    async close() {
      if (closed) return; closed = true;
      for (const owner of [...owners.values()]) await service.dropOwner(owner.senderId);
      await Promise.allSettled([...operations].map(operation => operation.promise));
      for (const ticket of [...tickets.values()]) { if (!ticket.consumed) { ticket.invalid = true; await disposeTicket(ticket); } }
    },
  };
  return Object.freeze(service);
}

module.exports = { createAttachmentPreviewService, getAttachmentRunData, normalizeInventory };
