'use strict';

/**
 * Cap full LCS to avoid huge Uint32Array allocations.
 * Fall back to full-replace when product or sum exceeds these bounds.
 */
const LCS_LINE_SUM_CAP = 4000;
const LCS_LINE_PRODUCT_CAP = 2_000_000;

/**
 * Heuristic text detection: reject NUL and high non-text ratio on samples.
 * @param {string|Buffer|Uint8Array|null|undefined} bufOrString
 * @returns {boolean}
 */
function isProbablyText(bufOrString) {
  if (bufOrString == null) return true;

  let sample;
  if (typeof bufOrString === 'string') {
    sample = bufOrString;
  } else if (Buffer.isBuffer(bufOrString)) {
    sample = bufOrString.toString('latin1', 0, Math.min(bufOrString.length, 8192));
  } else if (bufOrString instanceof Uint8Array) {
    sample = Buffer.from(bufOrString.subarray(0, 8192)).toString('latin1');
  } else {
    sample = String(bufOrString);
  }

  if (sample.includes('\0')) return false;
  if (sample.length === 0) return true;

  const n = Math.min(sample.length, 8192);
  let nonText = 0;
  for (let i = 0; i < n; i++) {
    const c = sample.charCodeAt(i);
    // tab/LF/CR or printable (incl. high-bit UTF-8 bytes as latin1)
    if (!(c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c !== 0x7f))) {
      nonText++;
    }
  }
  if (n <= 32) return nonText === 0;
  return nonText / n < 0.3;
}

/** Split on newlines; drop trailing empty segment from a final newline. */
function toLines(text) {
  if (text == null || text === '') return [];
  const lines = String(text).split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** LCS lengths for line arrays. */
function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const rows = new Array(n + 1);
  for (let i = 0; i <= n; i++) rows[i] = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    const prev = rows[i - 1];
    const cur = rows[i];
    for (let j = 1; j <= m; j++) {
      cur[j] = ai === b[j - 1] ? prev[j - 1] + 1 : prev[j] >= cur[j - 1] ? prev[j] : cur[j - 1];
    }
  }
  return rows;
}

/** Backtrack LCS into unified body lines + stats. */
function lcsEditScript(a, b) {
  const table = lcsTable(a, b);
  let i = a.length;
  let j = b.length;
  const rev = [];
  let additions = 0;
  let deletions = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      rev.push(' ' + a[i - 1]);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      rev.push('+' + b[j - 1]);
      additions++;
      j--;
    } else {
      rev.push('-' + a[i - 1]);
      deletions++;
      i--;
    }
  }
  rev.reverse();
  return { body: rev, additions, deletions };
}

function fullReplaceScript(a, b) {
  const body = a.map((line) => '-' + line).concat(b.map((line) => '+' + line));
  return { body, additions: b.length, deletions: a.length };
}

function formatUnified(path, aLen, bLen, body) {
  const aRange = aLen === 0 ? '0,0' : `1,${aLen}`;
  const bRange = bLen === 0 ? '0,0' : `1,${bLen}`;
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -${aRange} +${bRange} @@`, ...body].join('\n') + '\n';
}

/**
 * @param {string} path
 * @param {string} beforeText
 * @param {string} afterText
 * @returns {{ path: string, text: string, stats: { additions: number, deletions: number }, isBinary: boolean }}
 */
function computeUnifiedDiff(path, beforeText, afterText) {
  const before = beforeText == null ? '' : String(beforeText);
  const after = afterText == null ? '' : String(afterText);

  if (!isProbablyText(before) || !isProbablyText(after)) {
    return { path, text: '', stats: { additions: 0, deletions: 0 }, isBinary: true };
  }

  const a = toLines(before);
  const b = toLines(after);
  const product = a.length * b.length;
  const useFullReplace =
    a.length + b.length > LCS_LINE_SUM_CAP || product > LCS_LINE_PRODUCT_CAP;
  const script =
    useFullReplace
      ? fullReplaceScript(a, b)
      : a.length === 0 && b.length === 0
        ? { body: [], additions: 0, deletions: 0 }
        : lcsEditScript(a, b);

  return {
    path,
    text: formatUnified(path, a.length, b.length, script.body),
    stats: { additions: script.additions, deletions: script.deletions },
    isBinary: false,
  };
}

/**
 * Keep first ~60% and last ~20% of budgeted lines with a middle marker.
 * Does not recompute stats.
 * @param {string} text
 * @param {{ maxBytes?: number, maxLines?: number }} [opts]
 * @returns {{ text: string, truncated: boolean }}
 */
function truncateDiff(text, { maxBytes = 32768, maxLines = 400 } = {}) {
  const src = text == null ? '' : String(text);
  const lines = src.split('\n');
  const byteLen = Buffer.byteLength(src, 'utf8');

  if (lines.length <= maxLines && byteLen <= maxBytes) {
    return { text: src, truncated: false };
  }

  let budget = maxLines;
  if (byteLen > maxBytes && lines.length > 0) {
    const avg = byteLen / lines.length;
    budget = Math.min(budget, Math.max(10, Math.floor(maxBytes / Math.max(avg, 1))));
  }
  budget = Math.max(3, budget);

  let head = Math.max(1, Math.floor(budget * 0.6));
  let tail = Math.max(1, Math.floor(budget * 0.2));
  const usable = Math.min(head + tail, Math.max(1, lines.length - 1));
  if (head + tail > usable) {
    head = Math.max(1, Math.floor(usable * 0.75));
    tail = Math.max(1, usable - head);
  }

  return {
    text: [...lines.slice(0, head), '... diff truncated ...', ...lines.slice(lines.length - tail)].join(
      '\n'
    ),
    truncated: true,
  };
}

module.exports = {
  computeUnifiedDiff,
  truncateDiff,
  isProbablyText,
};
