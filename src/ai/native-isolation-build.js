'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const directory = path.resolve(__dirname, '../native/windows-isolation').replace(/\.asar([\\/])/, '.asar.unpacked$1');
const sourcePath = path.join(directory, 'Launcher.cs');
const executablePath = path.join(directory, 'Launcher.exe');
const manifestPath = path.join(directory, 'Launcher.manifest.json');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function inspectNativeBuild() {
  if (process.platform !== 'win32' || Number(os.release().split('.')[2]) < 19041) return { available: false, reason: 'Windows 10 build 19041 or newer is required' };
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const sourceHash = hash(fs.readFileSync(sourcePath));
    const executableHash = hash(fs.readFileSync(executablePath));
    if (manifest.version !== 1 || manifest.sourceHash !== sourceHash || manifest.executableHash !== executableHash) return { available: false, reason: 'Native launcher integrity check failed' };
    return { available: true, executablePath, executableHash, sourceHash, version: 1 };
  } catch (error) { return { available: false, reason: 'Native launcher has not been built', detail: error.code }; }
}
function buildNativeLauncher() {
  if (process.platform !== 'win32') return { available: false, reason: 'Windows native backend only' };
  const existing = inspectNativeBuild();
  if (existing.available) return existing;
  if (!fs.existsSync(sourcePath)) throw new Error('Native launcher source is missing');
  const compiler = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  if (!fs.existsSync(compiler)) throw new Error('The system Framework64 C# compiler is unavailable');
  const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Web.Extensions.dll', `/out:${executablePath}`, sourcePath], { cwd: directory, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Native launcher compilation failed: ${result.error?.message || result.stdout || result.stderr || result.status}`);
  const manifest = { version: 1, sourceHash: hash(fs.readFileSync(sourcePath)), executableHash: hash(fs.readFileSync(executablePath)) };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return inspectNativeBuild();
}
module.exports = { inspectNativeBuild, buildNativeLauncher, hash };
