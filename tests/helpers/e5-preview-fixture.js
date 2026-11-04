'use strict';

// Unit-only main authority and byte capabilities. This fixture does not assert
// Windows object pinning, DPAPI encryption, or Electron consent evidence.
const { createHash } = require('node:crypto');
const { createAttachmentBudget, newAttachmentId, randomOpaqueId, attachmentError, publicAttachmentRef, checkAbort } = require('../../src/ai/attachment-contract');
const { extractText } = require('../../src/ai/attachment-reader');
const { parseAtRefs } = require('../../src/ai/at-ref');
const hash = value => createHash('sha256').update(value).digest('hex');

function createPreviewFixture() {
  const budget = createAttachmentBudget();
  const counters = { sourceReads: 0, storeReads: 0, picker: 0, consent: 0, projectResolves: 0, holds: 0 };
  const state = { now: 100, revision: 1, redactionGeneration: 1, allowRestore: true, allowDrop: true, paused: null, projectAllowed: true };
  const sources = new Map([['C:\\outside\\note.txt', Buffer.from('EXTERNAL_CANARY\n')], ['C:\\project\\code.js', Buffer.from('const x = 7;\nconst y = 8;\n')]]);
  const namespaces = new Map(), records = new Map(), live = new Map(), sourceGrants = new WeakMap();
  const sender = id => { if (!live.has(id)) live.set(id, { id, isDestroyed: () => false }); return { sender: live.get(id) }; };
  const store = {
    createNamespace({ sessionId }) { const value = { sessionId, namespaceRef: randomOpaqueId('ans'), storageMode: 'memory' }; namespaces.set(value.namespaceRef, value); return value; },
    getNamespace(ref, sessionId) { const value = namespaces.get(ref); if (!value || value.sessionId !== sessionId) throw attachmentError(); return value; },
    async importBatch({ namespace, captures }) {
      const refs = [];
      for (const capture of captures) {
        const id = newAttachmentId();
        const record = { ...capture, attachmentId: id, rawByteLength: capture.rawBytes.length, generation: 1, status: 'ready', storageMode: 'memory', namespaceRef: namespace.namespaceRef, sessionId: namespace.sessionId,
          budget: { extractedChars: capture.extractedChars, selectedChars: capture.selectedChars, selectedBytes: 0, estimatedTokens: 0, truncated: false } };
        records.set(id, record); refs.push(publicAttachmentRef(record));
      }
      return { refs, storageMode: 'memory', namespace, deduplicated: 0 };
    },
    getRecord(id, namespace) { const record = records.get(id); if (!record || record.namespaceRef !== namespace.namespaceRef) throw attachmentError(); return record; },
    async read(id, namespace, { signal } = {}) { checkAbort(signal); counters.storeReads++; const record = this.getRecord(id, namespace); if (record.status !== 'ready') throw attachmentError('ATTACHMENT_' + record.status.toUpperCase()); return { record, bytes: record.rawBytes, release() {} }; },
    list(namespace) { return [...records.values()].filter(record => record.namespaceRef === namespace.namespaceRef).map(publicAttachmentRef); },
    hold(ids, namespace) { const held = ids.map(id => this.getRecord(id, namespace)); counters.holds++; let released = false; return { records: held, release() { if (!released) { released = true; counters.holds--; } } }; },
    syncDraftLinks(namespace, { ids }) { for (const id of ids) this.getRecord(id, namespace); return { ok: true }; },
    removeFromDraft(id, namespace) { const record = this.getRecord(id, namespace); record.generation++; return { ok: true, deferred: false }; },
    deleteCopy(id, namespace) { const record = this.getRecord(id, namespace); record.generation++; record.status = 'deleted'; return { ok: true }; },
    clear() { for (const record of records.values()) { record.generation++; record.status = 'deleted'; } return { ok: true }; },
    cacheStatus() { return { storageMode: 'memory', records: records.size }; },
  };
  const reader = {
    createExternalGrant(path) { const grant = {}; sourceGrants.set(grant, { path, sourceKind: 'user_upload' }); return grant; },
    createProjectGrant(options) { const grant = {}; sourceGrants.set(grant, { path: 'C:\\project\\' + options.relativePath.replace(/\//g, '\\'), sourceKind: 'at_project_ref', ...options }); return grant; },
    async capture(grant, { signal } = {}) {
      const info = sourceGrants.get(grant); if (!info) throw attachmentError();
      checkAbort(signal); counters.sourceReads++; if (state.paused) await state.paused;
      checkAbort(signal); const bytes = sources.get(info.path); if (!bytes) throw attachmentError('ATTACHMENT_READ_DENIED');
      const rawDigest = hash(bytes);
      if (info.expectedDigest && info.expectedDigest !== rawDigest || info.rootIdentity && info.rootIdentity !== '1:7') throw attachmentError('ATTACHMENT_SOURCE_CHANGED');
      return { bytes, name: info.path.split('\\').at(-1), rawDigest, identity: '1:8', rootIdentity: '1:7', ancestors: [{ path: 'C:\\project', identity: '1:7' }], sourceKind: info.sourceKind, release() {} };
    },
  };
  function describeSend(_event, payload) {
    const messages = payload.messages || []; const current = messages.filter(message => message.role === 'user').at(-1);
    const userText = current?.content || '';
    const derived = (current?.parts || []).filter(part => part.type === 'attachment_ref').map(part => part.attachmentId);
    const attachmentIds = payload.attachmentIds || derived;
    if (derived.some(id => !attachmentIds.includes(id))) throw attachmentError('ATTACHMENT_PREVIEW_REQUIRED');
    const inventory = parseAtRefs(userText);
    const fingerprint = hash(JSON.stringify({ messages, attachmentIds, draftRevision: payload.draftRevision, revision: state.revision, requestKind: payload.requestKind || 'chat' }));
    return { userText, userMessage: current || { role: 'user', content: '' }, messages, attachmentIds, inventory, fingerprint,
      projectBindingId: payload.projectBindingId || 'pb_project', target: { model: 'fixture-model', protocol: 'openai-chat-completions', origin: 'https://fixture.invalid', modelProfileId: 'fixture' },
      budget: { estimatedInputTokens: 100, contextLimit: 32000, maxOutputTokens: 1000 } };
  }
  const options = {
    store, reader, extractText, budget, now: () => state.now,
    authorizeSender: event => event?.sender && live.get(event.sender.id) === event.sender && !event.sender.isDestroyed(),
    chooseExternal: async () => { counters.picker++; return ['C:\\outside\\note.txt']; },
    confirmDrop: async () => { counters.consent++; return state.allowDrop; },
    confirmRestore: async () => { counters.consent++; return state.allowRestore; },
    confirmDelete: async () => true,
    resolveProject: async () => { counters.projectResolves++; if (!state.projectAllowed) throw attachmentError('ATTACHMENT_READ_DENIED'); return { projectRoot: 'C:\\project', projectBindingId: 'pb_project', rootIdentity: '1:7', ancestors: [{ path: 'C:\\project', identity: '1:7' }] }; },
    describeSend, validateCurrent: async () => { if (!state.projectAllowed) throw attachmentError('ATTACHMENT_READ_DENIED'); },
    redact: value => value.replace(/SECRET_VALUE/g, '[REDACTED]'), getRedactionGeneration: () => state.redactionGeneration,
  };
  return { options, budget, counters, state, sources, sender, store, records, namespaces, hash, describeSend };
}
module.exports = { createPreviewFixture };
