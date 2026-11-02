'use strict';

const { StringDecoder } = require('node:string_decoder');
const { defaultSecretManager, redactSecrets } = require('./secret-manager');

// Main-owned output state only. Neither the known values nor the withheld suffix
// is exported to the renderer, history, usage, or a model request.
function createModelTextRedactor({ manager = defaultSecretManager, redact = redactSecrets, maxPendingBytes = 65536 } = {}) {
  if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1 || maxPendingBytes > 262144) throw new TypeError('Invalid stream redaction bound');
  const decoder = new StringDecoder('utf8');
  const prefixTables = new Map();
  let pending = '', closed = false, overflowed = false;
  function prefixTable(value) {
    if (prefixTables.has(value)) return prefixTables.get(value);
    const table = new Uint32Array(value.length);
    for (let i = 1, matched = 0; i < value.length; i += 1) {
      while (matched && value[i] !== value[matched]) matched = table[matched - 1];
      if (value[i] === value[matched]) matched += 1;
      table[i] = matched;
    }
    prefixTables.set(value, table);
    return table;
  }
  function drain(chunk) {
    if (closed || overflowed) return '';
    // Remove complete values before suffix matching, including self-overlapping
    // secrets. Redacting each independent input fragment is not sufficient.
    const text = redact(pending + chunk);
    const values = [...(manager.registeredSecrets?.keys?.() || [])].filter((value) => typeof value === 'string' && value.length >= 4);
    for (const value of prefixTables.keys()) if (!values.includes(value)) prefixTables.delete(value);
    let withheld = 0;
    for (const value of values) {
      const table = prefixTable(value);
      let matched = 0;
      for (let i = 0; i < text.length; i += 1) {
        while (matched && text[i] !== value[matched]) matched = table[matched - 1];
        if (text[i] === value[matched]) matched += 1;
        if (matched === value.length) matched = table[matched - 1];
      }
      withheld = Math.max(withheld, matched);
    }
    pending = withheld ? text.slice(-withheld) : '';
    if (Buffer.byteLength(pending, 'utf8') > maxPendingBytes) {
      pending = ''; overflowed = true;
      return '[REDACTED:OUTPUT_LIMIT]';
    }
    return withheld ? text.slice(0, -withheld) : text;
  }
  return Object.freeze({
    write(chunk) {
      if (closed || overflowed) return '';
      return drain(Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk ?? ''));
    },
    finish() {
      if (closed) return '';
      const safe = drain(decoder.end());
      // A suffix which might be a credential prefix is never published on EOF,
      // error or cancellation. It is not a successful complete model answer.
      pending = ''; prefixTables.clear(); closed = true;
      return safe;
    },
  });
}

function redactModelPartialOutput(text) {
  const output = createModelTextRedactor();
  const safe = output.write(String(text ?? ''));
  return safe + output.finish();
}

module.exports = { createModelTextRedactor, redactModelPartialOutput };
