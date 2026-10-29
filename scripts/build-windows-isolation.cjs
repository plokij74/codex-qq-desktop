'use strict';
const { buildNativeLauncher } = require('../src/ai/native-isolation-build');
try { console.log(JSON.stringify(buildNativeLauncher(), null, 2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
