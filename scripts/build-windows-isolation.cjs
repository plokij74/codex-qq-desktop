'use strict';
const { spawnSync } = require('node:child_process');
const { buildNativeLauncher } = require('../src/ai/native-isolation-build');
const { LIMITS } = require('../src/ai/attachment-contract');

// Hash validation alone cannot prove an older launcher implements E5. These
// bounded, input-free probes perform no filesystem capture or E3 execution.
function probe(executable, mode) {
  const result = spawnSync(executable, [mode, '--probe'], {
    windowsHide: true, shell: false, timeout: LIMITS.CAPTURE_TIMEOUT_MS,
    maxBuffer: LIMITS.MAX_REQUEST_BYTES + 16,
    env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', WINDIR: process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows' },
  });
  const bytes = result.stdout;
  if (result.error || result.status !== 0 || !Buffer.isBuffer(bytes) || bytes.length < 16 || !bytes.subarray(0, 8).equals(Buffer.from('E5IO0001')) || bytes.readUInt32LE(12) !== 0 || bytes.readUInt32LE(8) !== bytes.length - 16 || result.stderr?.length) throw new Error('Native E5 capability probe failed');
  let value; try { value = JSON.parse(bytes.toString('utf8', 16)); } catch { throw new Error('Native E5 capability probe failed'); }
  if (value.version !== 1 || value.captureProtocol !== 1 || value.mode !== (mode === '--capture-file' ? 'capture' : 'managed') || value.type !== 'result' || value.operation !== 'probe' || value.ok !== true || value.cleanupComplete !== true || value.sourceMaxBytes !== LIMITS.MAX_FILE_BYTES || value.managedMaxBytes !== LIMITS.MAX_BLOB_PACKAGE_BYTES || value.managedMaxBytes !== LIMITS.MAX_MANIFEST_PACKAGE_BYTES || value.timeoutMs !== LIMITS.CAPTURE_TIMEOUT_MS || value.sourceReadAccess !== 'GENERIC_READ' || value.sourceShare !== 'READ' || value.sourceWrites !== false || value.managedAtomic !== true) throw new Error('Native E5 capabilities do not match the attachment contract');
  return { protocol: value.captureProtocol, sourceMaxBytes: value.sourceMaxBytes, managedMaxBytes: value.managedMaxBytes, timeoutMs: value.timeoutMs };
}
try {
  const build = buildNativeLauncher();
  if (build.available) build.e5 = { capture: probe(build.executablePath, '--capture-file'), managed: probe(build.executablePath, '--managed-file') };
  console.log(JSON.stringify(build, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
