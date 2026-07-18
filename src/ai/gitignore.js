const fs = require('fs');
const path = require('path');

/**
 * Parse a .gitignore file body into rule objects.
 * Basic (YAGNI): comments, blank lines, trailing slash, simple star, double-star prefix;
 * skip negation rules starting with bang.
 * @param {string} text
 * @returns {{ pattern: string, dirOnly: boolean, anyDepth: boolean }[]}
 */
function parseGitignore(text) {
  const rules = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) continue; // Phase A: skip negation

    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }

    let anyDepth = false;
    if (line.startsWith('**/')) {
      anyDepth = true;
      line = line.slice(3);
    } else if (!line.includes('/')) {
      // bare pattern matches at any path segment depth
      anyDepth = true;
    }

    // strip trailing ** if present (rare)
    if (line.endsWith('/**')) {
      anyDepth = true;
      line = line.slice(0, -3);
    }

    if (!line) continue;
    rules.push({ pattern: line, dirOnly, anyDepth });
  }
  return rules;
}

/**
 * Convert a gitignore-style pattern segment to a RegExp source.
 * * matches within one path segment (no /).
 */
function patternToRegexSource(pattern) {
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      src += '[^/]*';
    } else if (ch === '?') {
      src += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      src += '\\' + ch;
    } else {
      src += ch;
    }
  }
  return src;
}

/**
 * @param {string} relPath posix-ish relative path, no leading ./
 * @param {{ pattern: string, dirOnly: boolean, anyDepth: boolean }[]} rules
 * @returns {boolean}
 */
function isIgnored(relPath, rules) {
  if (!rules || !rules.length) return false;
  const p = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p) return false;

  for (const rule of rules) {
    if (matchesRule(p, rule)) return true;
  }
  return false;
}

function matchesRule(relPath, rule) {
  const { pattern, dirOnly, anyDepth } = rule;
  const reSrc = patternToRegexSource(pattern);

  if (dirOnly) {
    // directory prefix: match path that is the dir or under it
    // e.g. node_modules/ matches node_modules, node_modules/foo
    if (anyDepth) {
      // bare dir pattern like node_modules/
      const re = new RegExp(
        `(^|/)${reSrc}(/|$)`
      );
      return re.test(relPath);
    }
    const re = new RegExp(`^${reSrc}(/|$)`);
    return re.test(relPath);
  }

  // file or any path match
  if (anyDepth) {
    // match as full path, or any trailing segment, or path ending with /pattern
    const re = new RegExp(`(^|/)${reSrc}$`);
    return re.test(relPath);
  }

  // anchored from root (contains /)
  const re = new RegExp(`^${reSrc}$`);
  return re.test(relPath);
}

/**
 * Load .gitignore from project root if present.
 * @param {string} projectRoot
 * @returns {{ pattern: string, dirOnly: boolean, anyDepth: boolean }[]}
 */
function loadGitignoreRules(projectRoot) {
  const file = path.join(projectRoot, '.gitignore');
  try {
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    return parseGitignore(text);
  } catch {
    return [];
  }
}

module.exports = {
  parseGitignore,
  isIgnored,
  loadGitignoreRules,
};
