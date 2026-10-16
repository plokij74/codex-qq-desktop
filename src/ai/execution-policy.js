'use strict';

const { verifyPathSandbox, checkOutboundPolicy } = require('./os-isolation');

const ExecutionPolicyLevel = {
  STRICT_ISOLATED: 'STRICT_ISOLATED',
  WORKSPACE_WRITE: 'WORKSPACE_WRITE',
  HOST_UNCONFINED: 'HOST_UNCONFINED',
};

function buildScopedPermissionKey(projectId, sessionKey, risk) {
  const p = (projectId && String(projectId).trim()) || 'global-default';
  const s = (sessionKey && String(sessionKey).trim()) || 'anonymous-session';
  const r = (risk && String(risk).trim()) || 'general';
  return `${p}::${s}::${r}`;
}

class ScopedSessionStore {
  constructor() {
    this._store = new Set();
  }

  grant(projectId, sessionKey, risk) {
    if (!risk) return;
    const key = buildScopedPermissionKey(projectId, sessionKey, risk);
    this._store.add(key);
  }

  isGranted(projectId, sessionKey, risk) {
    if (!risk) return false;
    const key = buildScopedPermissionKey(projectId, sessionKey, risk);
    return this._store.has(key);
  }

  revoke(projectId, sessionKey, risk) {
    if (risk) {
      const key = buildScopedPermissionKey(projectId, sessionKey, risk);
      this._store.delete(key);
    } else {
      const prefix = `${projectId || 'global-default'}::${sessionKey || 'anonymous-session'}::`;
      for (const k of this._store) {
        if (k.startsWith(prefix)) this._store.delete(k);
      }
    }
  }

  clear(sessionKey) {
    if (sessionKey) {
      const suffix = `::${sessionKey}::`;
      for (const k of this._store) {
        if (k.includes(suffix)) this._store.delete(k);
      }
    } else {
      this._store.clear();
    }
  }
}

const defaultScopedSessionStore = new ScopedSessionStore();

/**
 * Evaluate whether tool execution conforms to current execution policy.
 * Refuses traversal, internal network access, or dangerous escapes unless unconfined host elevation is granted.
 */
function evaluateToolExecution(toolName, args = {}, context = {}) {
  const {
    projectRoot,
    projectId,
    sessionKey,
    policyLevel = ExecutionPolicyLevel.STRICT_ISOLATED,
    isElevated = false,
  } = context;

  // If in HOST_UNCONFINED and elevated explicitly by the user
  if (policyLevel === ExecutionPolicyLevel.HOST_UNCONFINED && isElevated) {
    return {
      allowed: true,
      policyLevel: ExecutionPolicyLevel.HOST_UNCONFINED,
      elevated: true,
      reason: 'Host unconfined execution permitted by user elevation',
    };
  }

  // 1. Filesystem path tools
  const fsPathTools = ['read_file', 'write_file', 'search_replace', 'delete_path', 'list_dir'];
  if (fsPathTools.includes(toolName)) {
    const targetPath = args.path || args.dir || args.targetPath || '.';
    if (projectRoot) {
      try {
        const mode = (toolName === 'write_file' || toolName === 'search_replace')
          ? 'write'
          : (toolName === 'delete_path' ? 'delete' : 'read');
        verifyPathSandbox(projectRoot, targetPath, { mode });
      } catch (err) {
        return {
          allowed: false,
          requiresElevation: true,
          code: err.code || 'SECURITY_TRAVERSAL_DETECTED',
          reason: `路径越界，操作被安全隔离拦截: ${err.message}`,
          targetPath,
        };
      }
    }
  }

  // 2. Terminal tool
  if (toolName === 'run_terminal') {
    const cwd = args.cwd || '.';
    if (projectRoot) {
      try {
        verifyPathSandbox(projectRoot, cwd, { mode: 'read' });
      } catch (err) {
        return {
          allowed: false,
          requiresElevation: true,
          code: err.code || 'SECURITY_TRAVERSAL_DETECTED',
          reason: `终端工作目录越界: ${err.message}`,
          targetPath: cwd,
        };
      }
    }
  }

  // 3. Network fetch tool
  if (toolName === 'web_fetch') {
    const url = args.url;
    if (url) {
      const check = checkOutboundPolicy(url, {
        allowPrivate: false,
        allow: context.allowDomains || [],
        deny: context.denyDomains || [],
      });
      if (!check.allowed) {
        return {
          allowed: false,
          requiresElevation: true,
          code: check.code || 'SECURITY_OUTBOUND_BLOCKED',
          reason: `网络出站被拦截: ${check.reason || '不允许访问内部或元数据地址'}`,
          url,
        };
      }
    }
  }

  return {
    allowed: true,
    policyLevel,
    elevated: false,
  };
}

module.exports = {
  ExecutionPolicyLevel,
  buildScopedPermissionKey,
  ScopedSessionStore,
  defaultScopedSessionStore,
  evaluateToolExecution,
};
