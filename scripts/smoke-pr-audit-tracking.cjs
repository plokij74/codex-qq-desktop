'use strict';
process.argv.push('--recheck-repair', '--tracking');
require('./smoke-pr-audit-repair.cjs');
