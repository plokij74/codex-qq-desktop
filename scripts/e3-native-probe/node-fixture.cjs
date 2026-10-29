'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [work, outside] = process.argv.slice(2);
const checks = [];
function check(name, action) {
  try { action(); checks.push(`${name}=PASS`); }
  catch (error) { checks.push(`${name}=FAIL`); checks.push(`detail=${error.code || error.message}`); }
}
function denied(action) {
  try { action(); } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') return;
    throw error;
  }
  throw new Error('Unexpected outside access');
}
check('node-inside-io', () => {
  const file = path.join(work, 'node-inside.txt');
  fs.writeFileSync(file, 'node-inside');
  if (fs.readFileSync(file, 'utf8') !== 'node-inside') throw new Error('Read mismatch');
});
check('node-env-clean', () => {
  if (process.env.E3_PROBE_SECRET || process.env.E3_PROBE_ORDINARY) throw new Error('Inherited host environment');
});
check('node-outside-read-denied', () => denied(() => fs.readFileSync(outside)));
check('node-outside-write-denied', () => denied(() => fs.writeFileSync(outside, 'changed')));
check('node-junction-read-denied', () => denied(() => fs.readFileSync(path.join(work, 'escape', 'canary.txt'))));
check('node-junction-write-denied', () => denied(() => fs.writeFileSync(path.join(work, 'escape', 'canary.txt'), 'changed')));
fs.writeFileSync(path.join(work, 'node-results.txt'), checks.join('\n') + '\n');
process.exitCode = checks.some(line => line.endsWith('=FAIL')) ? 1 : 0;
