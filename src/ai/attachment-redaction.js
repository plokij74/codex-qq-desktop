'use strict';

const { defaultSecretManager, getSecretRedactionGeneration } = require('./secret-manager');
const { attachmentError, LIMITS } = require('./attachment-contract');

// E5 uses a neutral, single-pass replacement. Secret labels never become file
// contents and replacement text is not repeatedly matched against other keys.
let cachedGeneration = -1, cachedCount = -1, cachedPattern = null;
function knownPattern() {
  const secrets = defaultSecretManager.registeredSecrets;
  const generation = getSecretRedactionGeneration();
  if (generation === cachedGeneration && secrets.size === cachedCount) return cachedPattern;
  if (secrets.size > 1024) throw attachmentError('ATTACHMENT_TEXT_LIMIT');
  let units = 0;
  for (const value of secrets.keys()) {
    units += value.length;
    if (units > 128 * 1024) throw attachmentError('ATTACHMENT_TEXT_LIMIT');
  }
  const values = [...secrets.keys()].filter(value => value.length >= 4).sort((a, b) => b.length - a.length);
  const source = values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  cachedPattern = source ? new RegExp(source, 'g') : null;
  cachedGeneration = generation; cachedCount = secrets.size;
  return cachedPattern;
}

function redactAttachmentText(text) {
  if (typeof text !== 'string' || text.length > LIMITS.MAX_FILE_BYTES) throw attachmentError('ATTACHMENT_TEXT_LIMIT');
  const pattern = knownPattern();
  let output = pattern ? text.replace(pattern, '[REDACTED]') : text;
  output = output.replace(/(api[_-]?key|secret|token|password|auth|authorization)\s*([:=])(\s*)(["']?)(?:Bearer\s+)?([^\s"',;]{6,})\4/gi,
    (match, name, separator, space, quote, value) => value.startsWith('[REDACTED') ? match
      : `${name}${separator}${space}${quote}${match.toLowerCase().includes('bearer') ? 'Bearer ' : ''}[REDACTED]${quote}`);
  output = output.replace(/Bearer\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED]');
  output = output.replace(/sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{20,}/g, '[REDACTED]');
  if (Buffer.byteLength(output, 'utf8') > Math.ceil(LIMITS.MAX_FILE_BYTES * 2.5)) throw attachmentError('ATTACHMENT_TEXT_LIMIT');
  return output;
}

// Exact secrets have length >=4 and neutral replacements have length 10.
// Heuristics do not rematch neutral replacements and grow remaining spans less.
Object.defineProperties(redactAttachmentText, {
  attachmentMaxOutputCodeUnits: { value: units => Math.ceil(units * 2.5) },
  attachmentMaxOutputBytes: { value: bytes => Math.ceil(bytes * 2.5) },
  attachmentWorkspaceBytes: { value: 1024 * 1024 },
});

module.exports = { redactAttachmentText, getSecretRedactionGeneration };
