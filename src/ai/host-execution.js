'use strict';

const { verifyPathSandbox } = require('./os-isolation');
const grants = new WeakMap();
function requestIdentity({ projectRoot, sessionKey, command, cwd }) {
  const paths = verifyPathSandbox(projectRoot, cwd || projectRoot);
  if (!sessionKey || !String(command || '').trim()) throw new Error('Host execution requires session and command');
  return { projectRoot: paths.canonicalRoot, cwd: paths.canonicalTarget, sessionKey: String(sessionKey), command: String(command).trim() };
}
function denied(message = 'OS 强隔离不可用；需要本次宿主执行的明确确认') {
  return Object.assign(new Error(message), { code: 'OS_ISOLATION_UNAVAILABLE' });
}
async function authorizeHostExecution(options = {}) {
  const identity = requestIdentity(options);
  if (options.signal?.aborted) throw Object.assign(new Error('已停止'), { code: 'ABORTED' });
  if (typeof options.confirm !== 'function') throw denied();
  const secretEnv = {};
  for (const [key, value] of Object.entries(options.secretEnv || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^(PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|NODE_OPTIONS|NODE_PATH|PYTHONPATH|LD_PRELOAD|LD_LIBRARY_PATH|BASH_ENV|ENV)$/i.test(key) || typeof value !== 'string') throw denied('无效的定向凭据');
    secretEnv[key] = value;
  }
  const approved = await options.confirm(Object.freeze({ ...identity, executionMode: 'host-unconfined', isolated: false, secretNames: Object.keys(secretEnv), warning: '本次命令在宿主执行，可访问项目外文件及网络；不受 OS 沙箱隔离。' }));
  if (approved !== true || options.signal?.aborted) throw denied('未获得本次宿主执行确认');
  const current = requestIdentity(options);
  if (JSON.stringify(current) !== JSON.stringify(identity)) throw denied('确认期间项目绑定已改变');
  const grant = Object.freeze(Object.create(null));
  grants.set(grant, { identity, secretEnv, signal: options.signal, expires: Date.now() + 60000 });
  return grant;
}
function consumeHostExecutionGrant(grant, options) {
  const record = grant && grants.get(grant);
  if (record) grants.delete(grant);
  if (!record || record.expires < Date.now() || record.signal?.aborted) throw denied();
  if (JSON.stringify(record.identity) !== JSON.stringify(requestIdentity(options))) throw denied('宿主授权与当前命令、项目或会话不匹配');
  return record.secretEnv;
}
module.exports = { authorizeHostExecution, consumeHostExecutionGrant };
