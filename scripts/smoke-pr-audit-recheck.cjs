'use strict';
// Reuse the complete D18 delivery fixture, then exercise real D19 snapshot/runtime/IPC/UI.
process.argv.push('--recheck');
require('./smoke-pr-audit-repair.cjs');
