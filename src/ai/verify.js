const fs = require('fs');
const path = require('path');

/**
 * Resolve the project verify command.
 * 1. settings.verifyCommand non-empty → use (unless none/-)
 * 2. package.json scripts.test → `npm test`
 * 3. else null
 *
 * @param {string|null|undefined} projectPath
 * @param {{ verifyCommand?: string }} settings
 * @returns {string|null}
 */
function resolveVerifyCommand(projectPath, settings) {
  const raw = String(settings?.verifyCommand ?? '').trim();
  if (raw.length > 0) {
    if (/^(none|-)$/i.test(raw)) return null;
    return raw;
  }
  if (!projectPath) return null;
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    const rawJson = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(rawJson);
    if (pkg && pkg.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, 'test')) {
      return 'npm test';
    }
  } catch {
    return null;
  }
  return null;
}

module.exports = {
  resolveVerifyCommand,
};
