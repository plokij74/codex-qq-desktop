'use strict';

const path = require('path');
const { resolveSafe } = require('./project-fs');

const MAX_DIAGNOSTICS = 200;
const MAX_MESSAGE = 1000;

function clean(value, max = MAX_MESSAGE) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .trim().slice(0, max);
}

function severityFor(value) {
  const s = String(value || '').toLowerCase();
  if (s.includes('warn')) return 'warning';
  if (s.includes('info') || s.includes('note')) return 'info';
  return 'error';
}

function normalizePath(raw, projectRoot) {
  let p = clean(raw, 500).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p) return null;
  try {
    let resolved;
    if (p.startsWith('/') || /^[A-Za-z]:\//.test(p)) {
      resolved = path.resolve(p);
      const root = path.resolve(projectRoot);
      const outside = path.relative(root, resolved);
      if (outside.startsWith('..') || path.isAbsolute(outside)) return null;
    } else {
      if (p.split('/').includes('..')) return null;
      resolved = resolveSafe(projectRoot, p);
    }
    const rel = path.relative(path.resolve(projectRoot), resolved).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel;
  } catch { return null; }
}

function diagnostic(pathValue, line, column, severity, code, message, source, projectRoot) {
  const p = normalizePath(pathValue, projectRoot);
  const ln = Number(line); const col = Number(column);
  if (!p || !Number.isFinite(ln) || ln < 1 || !Number.isFinite(col) || col < 1) return null;
  return { path: p, line: Math.floor(ln), column: Math.floor(col), severity: severityFor(severity), code: code ? clean(code, 120) : null, message: clean(message), source: clean(source || 'verification', 80) };
}

function splitMessage(raw, fallbackSeverity = 'error') {
  let message = String(raw || '').trim(); let severity = fallbackSeverity; let code = null;
  const m = message.match(/^(error|warning|warn|info|note)\s*(?:(?:\[)?([A-Za-z][\w-]*\d*|no-[\w-]+)(?:\])?)?\s*[:\-]?\s*(.*)$/i);
  if (m) { severity = severityFor(m[1]); if (m[2]) code = m[2]; message = m[3] || message; }
  else { const cm = message.match(/^\[?([A-Za-z]+\d+)\]?\s*[:\-]\s*(.*)$/); if (cm) { code = cm[1]; message = cm[2]; } }
  return { severity, code, message: message || raw };
}

function parseLine(line, projectRoot) {
  const text = String(line || '');
  let m;
  // Maven/Gradle: [ERROR] file.java:[12,7] message
  m = text.match(/(?:^|\s)([^\s:]+):\[(\d+),(\d+)\]\s*(.*)$/);
  if (m) { const parsed = splitMessage(m[4] || text, /warning/i.test(text) ? 'warning' : 'error'); return diagnostic(m[1], m[2], m[3], parsed.severity, parsed.code, parsed.message, 'java', projectRoot); }
  // ESLint pretty formatter: file.js: line 10, col 5, Error - message (rule)
  m = text.match(/(?:^|\s)([^\s:]+):\s*line\s+(\d+),\s*col(?:umn)?\s+(\d+),\s*(Error|Warning)\s*-\s*(.*)$/i);
  if (m) { const parsed = splitMessage(m[5], m[4]); return diagnostic(m[1], m[2], m[3], parsed.severity, parsed.code, parsed.message, 'eslint', projectRoot); }
  // TypeScript compiler, ESLint, Jest, pytest, Go, Rust and javac all commonly emit path:line:column.
  m = text.match(/(?:^|\s|\()((?:[A-Za-z]:)?[^\s():]+):(\d+):(\d+)(?:\)?)(?:\s*[-:]?\s*(.*))?$/);
  if (m) {
    const parsed = splitMessage(m[4] || text, /\bwarning\b|\bwarn\b/i.test(text) ? 'warning' : /\binfo\b|\bnote\b/i.test(text) ? 'info' : 'error');
    return diagnostic(m[1], m[2], m[3], parsed.severity, parsed.code, parsed.message, inferSource(text), projectRoot);
  }
  // path(line,column): message (MSBuild/ESLint variants)
  m = text.match(/(?:^|\s|\()((?:[A-Za-z]:)?[^\s():]+)\((\d+),(\d+)\)\s*[:\-]?\s*(.*)$/);
  if (m) { const parsed = splitMessage(m[4] || text, /warning/i.test(text) ? 'warning' : 'error'); return diagnostic(m[1], m[2], m[3], parsed.severity, parsed.code, parsed.message, inferSource(text), projectRoot); }
  // pytest: file.py:12: in test / E   file.py:12: assertion
  m = text.match(/^(?:E\s+)?((?:[A-Za-z]:)?[^\s:]+):(\d+)(?::\s*(.*))?$/);
  if (m) return diagnostic(m[1], m[2], 1, 'error', null, m[3] || text, 'pytest', projectRoot);
  // Compiler output without an explicit column: file:line: message
  m = text.match(/^(?:\s*\[?(?:ERROR|WARNING)\]?\s*)?((?:[A-Za-z]:)?[^\s:]+):(\d+):\s*(.*)$/i);
  if (m) { const parsed = splitMessage(m[3], /warning/i.test(text) ? 'warning' : 'error'); return diagnostic(m[1], m[2], 1, parsed.severity, parsed.code, parsed.message, inferSource(text), projectRoot); }
  // Jest/Vitest stack line: at fn (file:line:column)
  m = text.match(/\(([^()\s]+):(\d+):(\d+)\)/);
  if (m) return diagnostic(m[1], m[2], m[3], 'error', null, text, 'test', projectRoot);
  return null;
}

function inferSource(text) {
  // Jest/Vitest stack frames: "at fn (file:line:col)" or Vitest " ❯ file:line:col"
  if (/\sat\s+\S+\s*\([^)]+:\d+:\d+\)/i.test(text) || /^\s*❯/.test(text)) return 'test';
  if (/eslint/i.test(text)) return 'eslint';
  if (/pytest/i.test(text)) return 'pytest';
  if (/jest|vitest/i.test(text)) return 'test';
  if (/\bgo\b|panic:/i.test(text)) return 'go';
  if (/rustc|cargo/i.test(text)) return 'rust';
  if (/-->\s+|error\[[A-Z]\d+\]/i.test(text)) return 'rust';
  if (/javac|maven|gradle/i.test(text)) return 'java';
  return 'compiler';
}

function parseDiagnostics(output, options = {}) {
  if (typeof options === 'string') options = { projectRoot: options };
  const projectRoot = options.projectRoot || options.root || process.cwd();
  const max = Math.max(1, Math.min(MAX_DIAGNOSTICS, Number(options.max) || MAX_DIAGNOSTICS));
  const diagnostics = []; let skipped = 0; let truncated = false;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const d = parseLine(line, projectRoot);
    if (!d) {
      if (/(?:[^\s():]+):(\d+):(\d+)|(?:[^\s():]+)\((\d+),(\d+)\)/.test(line)) skipped += 1;
      continue;
    }
    if (diagnostics.length >= max) { truncated = true; break; }
    diagnostics.push(d);
  }
  return { diagnostics, truncated, skipped };
}

module.exports = {
  MAX_DIAGNOSTICS,
  MAX_MESSAGE,
  parseDiagnostics,
  parse: parseDiagnostics,
  parseVerificationDiagnostics: parseDiagnostics,
  parseDiagnosticLine: parseLine,
  normalizeDiagnostic: diagnostic,
  normalizePath,
  normalizeDiagnosticPath: normalizePath,
};
