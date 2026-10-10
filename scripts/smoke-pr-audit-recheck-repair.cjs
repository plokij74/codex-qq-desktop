'use strict';
// Exercise D18 delivery, D19 rechecking and two D20 rounds in the real desktop.
process.argv.push('--recheck-repair');
require('./smoke-pr-audit-repair.cjs');
