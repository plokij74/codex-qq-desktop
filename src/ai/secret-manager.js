'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const registeredSecrets = new Map();
let electronSafeStorage = null;
try {
  const electron = require('electron');
  if (electron && electron.safeStorage) {
    electronSafeStorage = electron.safeStorage;
  }
} catch (_) {}

function deriveMachineKey(saltBuffer) {
  const fingerprint = [
    os.hostname(),
    os.arch(),
    process.env.USER || process.env.USERNAME || 'codex-qq-user',
    'codex-qq-e3-secrets-v1',
  ].join(':');
  return crypto.pbkdf2Sync(fingerprint, saltBuffer, 100000, 32, 'sha256');
}

class SecretManager {
  constructor(options = {}) {
    this.userDataPath = options.userDataPath || '';
    this.vaultPath = options.vaultPath || (this.userDataPath ? path.join(this.userDataPath, 'secrets.vault.json') : '');
    this.useSafeStorage = options.useSafeStorage !== false &&
      electronSafeStorage != null &&
      typeof electronSafeStorage.isEncryptionAvailable === 'function' &&
      electronSafeStorage.isEncryptionAvailable();

    this.vault = {
      version: 1,
      salt: crypto.randomBytes(16).toString('hex'),
      secrets: {},
    };

    this.vaultState = 'ready';
    this._vaultLoaded = false;
    this.registeredSecrets = registeredSecrets; // Process-wide: settings, tools and exports share registrations.
    if (this.vaultPath) {
      this.load();
    }
  }

  load() {
    if (!this.vaultPath) return this.vaultState === 'ready';
    try {
      const raw = fs.readFileSync(this.vaultPath, 'utf8');
      const parsed = JSON.parse(raw);
      const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
      if (!object(parsed) || parsed.version !== 1 || typeof parsed.salt !== 'string' || !/^[a-f0-9]{32}$/i.test(parsed.salt)
        || !object(parsed.secrets) || !Object.values(parsed.secrets).every(object)) throw new Error('Invalid vault document');
      this.vault = parsed;
      this._vaultLoaded = true;
      this.vaultState = 'ready';
      return true;
    } catch (error) {
      // Only a never-loaded, genuinely absent vault is safe to initialize. An
      // unreadable/corrupt existing vault (or a failed reload) must remain intact.
      if (error?.code === 'ENOENT' && !this._vaultLoaded && this.vaultState === 'ready') return false;
      this.vaultState = 'unavailable';
      return false;
    }
  }

  _assertVaultAvailable() {
    if (this.vaultState !== 'ready') {
      throw Object.assign(new Error('密钥保管库不可读取，已保留原文件；请先恢复并重新加载。'), { code: 'SECRET_VAULT_UNAVAILABLE' });
    }
  }

  save() {
    this._assertVaultAvailable();
    if (!this.vaultPath) return;
    try {
      const dir = path.dirname(this.vaultPath);
      fs.mkdirSync(dir, { recursive: true });
      const tempPath = `${this.vaultPath}.tmp.${Date.now()}`;
      fs.writeFileSync(tempPath, JSON.stringify(this.vault, null, 2), 'utf8');
      fs.renameSync(tempPath, this.vaultPath);
      this._vaultLoaded = true;
    } catch (e) {
      // Handle write failure
      throw new Error(`无法保存密钥保管库: ${e.message}`);
    }
  }

  _commitSecrets(secrets) {
    this._assertVaultAvailable();
    // Stage a copy for synchronous save; on failure preserve the loaded records
    // so credential cleanup cannot mistake a failed delete for success.
    const previous = this.vault;
    this.vault = { ...previous, secrets };
    try {
      this.save();
    } catch (error) {
      this.vault = previous;
      throw error;
    }
    return true;
  }

  _encryptValue(plaintext) {
    if (this.useSafeStorage && electronSafeStorage) {
      const buf = electronSafeStorage.encryptString(plaintext);
      return {
        cipher: 'safestorage',
        data: buf.toString('base64'),
      };
    }

    const iv = crypto.randomBytes(12);
    const key = deriveMachineKey(Buffer.from(this.vault.salt, 'hex'));
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plaintext, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      cipher: 'aes-256-gcm',
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      data: encrypted.toString('base64'),
    };
  }

  _decryptValue(record) {
    if (!record || typeof record !== 'object') return null;

    if (record.cipher === 'safestorage') {
      if (electronSafeStorage && electronSafeStorage.isEncryptionAvailable()) {
        const buf = Buffer.from(record.data, 'base64');
        return electronSafeStorage.decryptString(buf);
      }
      throw new Error('当前环境不支持 safeStorage 解密');
    }

    if (record.cipher === 'aes-256-gcm') {
      const iv = Buffer.from(record.iv, 'base64');
      const authTag = Buffer.from(record.authTag, 'base64');
      const data = Buffer.from(record.data, 'base64');
      const key = deriveMachineKey(Buffer.from(this.vault.salt, 'hex'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(data, null, 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    }

    throw new Error(`不支持的加密算法: ${record.cipher}`);
  }

  setSecret(key, value, metadata = {}) {
    this._assertVaultAvailable();
    if (!key || typeof key !== 'string') throw new Error('无效的密钥名称');
    if (typeof value !== 'string') throw new Error('无效的密钥内容');

    const encrypted = this._encryptValue(value);
    const now = new Date().toISOString();
    const record = {
      ...encrypted,
      label: metadata.label || key,
      createdAt: this.vault.secrets[key]?.createdAt || now,
      updatedAt: now,
    };

    // Keep candidates registered even on save failure; redaction is monotonic.
    this.registerSecret(value, metadata.label || key);
    return this._commitSecrets({ ...this.vault.secrets, [key]: record });
  }

  getSecret(key) {
    if (this.vaultState !== 'ready') return null;
    if (!key || !this.vault.secrets[key]) return null;
    const record = this.vault.secrets[key];
    const decrypted = this._decryptValue(record);
    if (decrypted) {
      this.registerSecret(decrypted, record.label || key);
    }
    return decrypted;
  }

  hasSecret(key) {
    this._assertVaultAvailable();
    return Boolean(this.vault.secrets && this.vault.secrets[key]);
  }

  deleteSecret(key) {
    this._assertVaultAvailable();
    if (!key || !this.vault.secrets[key]) return false;
    const secrets = { ...this.vault.secrets };
    delete secrets[key];
    return this._commitSecrets(secrets);
  }

  listSecrets() {
    this._assertVaultAvailable();
    return Object.entries(this.vault.secrets).map(([key, record]) => ({
      key,
      label: record.label || key,
      cipher: record.cipher,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
  }

  registerSecret(value, label = 'SECRET') {
    if (typeof value === 'string' && value.trim().length >= 4) {
      this.registeredSecrets.set(value.trim(), label);
    }
  }

  redactSecrets(text) {
    if (typeof text !== 'string') return text;
    let redacted = text;

    // 1. Exact match against registered secrets (longest first)
    const sortedSecrets = Array.from(this.registeredSecrets.entries())
      .filter(([val]) => val.length >= 4)
      .sort((a, b) => b[0].length - a[0].length);

    for (const [val, label] of sortedSecrets) {
      if (redacted.includes(val)) {
        redacted = redacted.split(val).join(`[REDACTED:${label}]`);
      }
    }

    // 2. Pattern-based heuristic redactions
    // key/token/secret assignment e.g. apiKey: "...", authorization: Bearer ...
    redacted = redacted.replace(
      /(api[_-]?key|secret|token|password|auth|authorization)\s*([:=])(\s*)(["']?)(?:Bearer\s+)?([^\s"',;]{6,})\4/gi,
      (match, keyName, sep, space, quote, val) => {
        if (val.startsWith('[REDACTED')) return match;
        const isBearer = match.toLowerCase().includes('bearer');
        const quoteStr = quote || '';
        return `${keyName}${sep}${space}${quoteStr}${isBearer ? 'Bearer ' : ''}[REDACTED]${quoteStr}`;
      }
    );

    // Standalone Bearer token
    redacted = redacted.replace(/Bearer\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED]');

    // sk- OpenAI style keys
    redacted = redacted.replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED:API_KEY]');

    // ghp_ GitHub tokens
    redacted = redacted.replace(/ghp_[a-zA-Z0-9]{20,}/g, '[REDACTED:GITHUB_TOKEN]');

    return redacted;
  }
}

/**
 * Migrate legacy plaintext apiKey in settings.json to encrypted SecretManager vault.
 */
function migrateSettingsFile(settingsPathOrDir, secretManager) {
  let settingsPath = settingsPathOrDir;
  try {
    if (fs.existsSync(settingsPath) && fs.statSync(settingsPath).isDirectory()) {
      settingsPath = path.join(settingsPath, 'settings.json');
    }
  } catch (_) {}

  if (!fs.existsSync(settingsPath)) {
    return { migrated: false, reason: 'FILE_NOT_FOUND' };
  }

  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(raw);
    if (!settings || typeof settings !== 'object') {
      return { migrated: false, reason: 'INVALID_JSON' };
    }

    let modified = false;

    // If plaintext apiKey exists and has content
    if (typeof settings.apiKey === 'string' && settings.apiKey.trim().length > 0) {
      const plaintext = settings.apiKey.trim();
      secretManager.setSecret('main_api_key', plaintext, { label: 'OpenAI API Key' });
      settings.apiKeyConfigured = true;
      settings.secretRef = 'sec_main_api_key';
      delete settings.apiKey;
      modified = true;
    } else if (settings.apiKey !== undefined) {
      // Empty apiKey, remove it and set apiKeyConfigured based on vault
      delete settings.apiKey;
      settings.apiKeyConfigured = secretManager.hasSecret('main_api_key');
      modified = true;
    }

    if (modified) {
      const tempPath = `${settingsPath}.tmp.${Date.now()}`;
      fs.writeFileSync(tempPath, JSON.stringify(settings, null, 2), 'utf8');
      fs.renameSync(tempPath, settingsPath);
      return { migrated: true, secretRef: settings.secretRef };
    }

    return { migrated: false, alreadyMigrated: true };
  } catch (err) {
    return { migrated: false, error: err.message };
  }
}

const defaultSecretManager = new SecretManager();

function redactSecrets(text, seen = new WeakSet()) {
  if (!text || typeof text !== 'object') return defaultSecretManager.redactSecrets(text);
  if (seen.has(text)) return '[Circular]';
  seen.add(text);
  const result = Array.isArray(text) ? [] : {};
  for (const [key, value] of Object.entries(text)) {
    result[key] = /^(api_?key|password|secret|token|authorization|access_?token|refresh_?token)$/i.test(key)
      ? '[REDACTED]' : redactSecrets(value, seen);
  }
  seen.delete(text);
  return result;
}

// A bounded output window is published only at flush. This intentionally trades
// live latency for confidentiality across arbitrary chunk and UTF-8 boundaries.
function createSecretOutputBuffer(onOutput, maxBytes = 20000) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  let done = false;
  return {
    write(chunk) {
      if (done) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (bytes + data.length > maxBytes) { truncated = true; return; }
      chunks.push(data); bytes += data.length;
    },
    flush() {
      if (done) return '';
      done = true;
      // Overflow may cut a secret at the boundary: discard rather than expose
      // a partial credential that cannot be matched by the redactor.
      const text = truncated ? '[OUTPUT OMITTED: limit exceeded]' : redactSecrets(Buffer.concat(chunks).toString('utf8'));
      chunks.length = 0;
      if (text && typeof onOutput === 'function') { try { onOutput(text); } catch (_) {} }
      return text;
    },
  };
}

module.exports = {
  createSecretOutputBuffer,
  SecretManager,
  defaultSecretManager,
  redactSecrets,
  migrateSettingsFile,
};
