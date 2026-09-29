'use strict';
const S = require('./pr-audit-state');
const { devNull } = require('node:os');

class AuditSnapshot {
  constructor({ github, repo, source, auditRef, files, signal }) {
    this.github = github; this.repo = repo; this.source = source; this.auditRef = auditRef;
    this.rawFiles = files; this.signal = signal; this.files = []; this.trees = new Map(); this.blobs = new Map();
    this.refs = []; this.contextBytes = 0;
  }
  async git(args, options = {}) {
    S.assertCurrent({ signal: options.cleanup ? undefined : this.signal });
    const out = await this.github.runCommand('git', ['--no-replace-objects', '--literal-pathspecs', '-c', `core.hooksPath=${devNull}`, '-C', this.repo.repoRoot, ...args], {
      rawOutput: true, maxBytes: 2 * 1024 * 1024, timeoutMs: options.timeoutMs || 15000,
      ...(options.cleanup ? {} : { signal: this.signal }),
    });
    if (!out?.ok || out.truncated) { S.assertCurrent({ signal: options.cleanup ? undefined : this.signal }); throw S.fail('INCOMPLETE'); }
    return out.stdout;
  }
  async cleanup() {
    for (const name of this.refs.splice(0)) {
      try { await this.git(['update-ref', '-d', name], { cleanup: true }); } catch { /* A later bound-project scan retries this namespace only. */ }
    }
  }
  async tree(side) {
    const sha = side === 'LEFT' ? this.source.mergeBaseSha : this.source.headSha;
    if (this.trees.has(sha)) return this.trees.get(sha);
    const output = await this.git(['ls-tree', '-r', '-z', '--full-tree', sha]);
    const tree = new Map();
    for (const raw of output.split('\0').filter(Boolean)) {
      const match = raw.match(/^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/);
      if (!match) throw S.fail('INCOMPLETE');
      if (S.scopePath(match[4], this.source.prefix)) tree.set(match[4], { mode: match[1], oid: match[3], path: match[4] });
    }
    this.trees.set(sha, tree); return tree;
  }
  async blob(entry) {
    if (!entry || !['100644', '100755'].includes(entry.mode)) throw S.fail('LOCATION');
    if (this.blobs.has(entry.oid)) return this.blobs.get(entry.oid);
    const size = Number((await this.git(['cat-file', '-s', entry.oid])).trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > S.LIMITS.blob) throw S.fail('CONTEXT_LIMIT');
    const body = await this.git(['cat-file', 'blob', entry.oid]);
    if (Buffer.byteLength(body) !== size) throw S.fail('LOCATION');
    if (body.includes('\0') || body.includes('\ufffd')) throw S.fail('LOCATION');
    this.blobs.set(entry.oid, body); return body;
  }
  async init() {
    if (!S.isRef(this.auditRef) || !Array.isArray(this.rawFiles) || this.rawFiles.length !== this.source.changedFiles) throw S.fail('INCOMPLETE');
    try {
      const refs = ['base', 'head'].map((name) => `refs/codex/pr-audit/${this.auditRef}/${name}`);
      this.refs.push(...refs);
      await this.git(['-c', 'gc.auto=0', '-c', 'fetch.writeCommitGraph=false', 'fetch', '--no-auto-maintenance', '--no-recurse-submodules', '--refmap=', '--no-tags', '--no-write-fetch-head', 'origin',
        `refs/heads/${this.source.baseRefName}:${refs[0]}`, `refs/heads/${this.source.headRefName}:${refs[1]}`], { timeoutMs: 60000 });
      for (let i = 0; i < refs.length; i++) {
        const actual = (await this.git(['rev-parse', '--verify', `${refs[i]}^{commit}`])).trim();
        if (actual !== (i ? this.source.headSha : this.source.baseSha)) throw S.fail('CHANGED');
      }
      const bases = (await this.git(['merge-base', '--all', this.source.baseSha, this.source.headSha])).trim().split(/\s+/);
      if (bases.length !== 1 || bases[0] !== this.source.mergeBaseSha) throw S.fail('INCOMPLETE');
      const left = await this.tree('LEFT'); const right = await this.tree('RIGHT');
      let total = 0; let scoped = 0; let outside = 0;
      const seen = new Set();
      for (const raw of this.rawFiles) {
        if (!raw || typeof raw.filename !== 'string' || seen.has(raw.filename)) throw S.fail('INCOMPLETE');
        seen.add(raw.filename);
        const oldPath = raw.previous_filename || raw.filename;
        if (!S.scopePath(raw.filename, this.source.prefix)) { outside++; continue; }
        if (++scoped > S.LIMITS.files) throw S.fail('LIMIT');
        const file = { path: raw.filename, oldPath, status: raw.status, hunks: [] };
        this.files.push(file);
        if (!['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged'].includes(raw.status)
          || !Number.isSafeInteger(raw.additions) || raw.additions < 0 || !Number.isSafeInteger(raw.deletions) || raw.deletions < 0) throw S.fail('INCOMPLETE');
        if (!S.scopePath(oldPath, this.source.prefix)) { file.skipped = '跨项目范围重命名'; continue; }
        const before = raw.status === 'added' ? null : left.get(oldPath);
        const after = raw.status === 'removed' ? null : right.get(raw.filename);
        if ((raw.status !== 'added' && !before) || (raw.status !== 'removed' && !after)) throw S.fail('INCOMPLETE');
        if ([before, after].filter(Boolean).some((entry) => !['100644', '100755'].includes(entry.mode))) { file.skipped = '符号链接或子模块'; continue; }
        if (after && raw.sha !== after.oid) throw S.fail('INCOMPLETE');
        let beforeBody; let afterBody;
        try { beforeBody = before ? await this.blob(before) : ''; afterBody = after ? await this.blob(after) : ''; }
        catch (cause) { if (cause.code === 'PR_AUDIT_LOCATION') { file.skipped = '二进制或非 UTF-8 文本'; continue; } throw cause; }
        if (!raw.patch && raw.additions === 0 && raw.deletions === 0) {
          if (beforeBody !== afterBody) throw S.fail('INCOMPLETE');
          file.skipped = '无文本行改动'; continue;
        }
        if (typeof raw.patch !== 'string') throw S.fail('INCOMPLETE');
        total += Buffer.byteLength(raw.patch); if (total > S.LIMITS.diff) throw S.fail('LIMIT');
        file.hunks = S.parsePatch(raw.patch, raw); file.patch = raw.patch;
        verifyPatch(raw.patch, beforeBody, afterBody);
      }
      this.coverage = { total: this.rawFiles.length, scoped, outside, reviewed: this.files.filter((f) => !f.skipped).length,
        skipped: this.files.filter((f) => f.skipped).map((f) => ({ path: f.path, reason: f.skipped })) };
      if (!this.coverage.reviewed) throw S.fail('INCOMPLETE');
      return this;
    } catch (cause) { await this.cleanup(); throw cause; }
  }
  consume(value) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (this.contextBytes + bytes > S.LIMITS.context) throw S.fail('CONTEXT_LIMIT');
    this.contextBytes += bytes; return value;
  }
  async read({ path, side = 'RIGHT', offset = 1, limit = 120 }, count = true) {
    if (!['LEFT', 'RIGHT'].includes(side) || !S.scopePath(path, this.source.prefix) || !S.number(offset)
      || !S.number(limit) || limit > 200) throw S.fail('LOCATION');
    const tree = await this.tree(side); const body = await this.blob(tree.get(path));
    const lines = splitLines(body);
    const value = { path, side, sha: side === 'LEFT' ? this.source.mergeBaseSha : this.source.headSha,
      offset, totalLines: lines.length, content: lines.slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i}: ${line}`).join('\n') };
    return count ? this.consume(value) : value;
  }
  async list({ prefix = this.source.prefix || '', side = 'RIGHT' } = {}) {
    if (!['LEFT', 'RIGHT'].includes(side) || (prefix && !S.scopePath(prefix.endsWith('/') ? `${prefix}file` : `${prefix}/file`, this.source.prefix))) throw S.fail('LOCATION');
    const rows = [...(await this.tree(side)).values()].filter((e) => ['100644', '100755'].includes(e.mode) && e.path.startsWith(prefix));
    return this.consume({ files: rows.slice(0, 500).map((e) => e.path), truncated: rows.length > 500 });
  }
  async search({ query, prefix = this.source.prefix || '' }) {
    S.text(query, 200);
    const listed = await this.list({ prefix }); const matches = []; let scanned = 0; let truncated = listed.truncated;
    for (const path of listed.files) {
      if (++scanned > 100 || matches.length >= 50) { truncated = true; break; }
      let body;
      try { body = await this.blob((await this.tree('RIGHT')).get(path)); }
      catch (cause) { if (['PR_AUDIT_LOCATION', 'PR_AUDIT_CONTEXT_LIMIT'].includes(cause.code)) { truncated = true; continue; } throw cause; }
      // Bound scanned data as well as returned snippets; repeated broad searches cannot grow without limit.
      this.consume(body);
      for (const [index, line] of splitLines(body).entries()) {
        if (line.includes(query)) matches.push({ path, line: index + 1, text: line.slice(0, 500) });
        if (matches.length >= 50) { truncated = true; break; }
      }
    }
    return this.consume({ matches, truncated });
  }
}
function splitLines(body) { const rows = body.split('\n'); if (rows.at(-1) === '') rows.pop(); return rows; }
function verifyPatch(patch, before, after) {
  const left = splitLines(before); const right = splitLines(after); let l = 0; let r = 0;
  const same = (a, b) => a != null && b != null && a.replace(/\r$/, '') === b.replace(/\r$/, '');
  for (const line of patch.split('\n')) {
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (h) {
      const nextL = Number(h[1]) - (Number(h[2] ?? 1) ? 1 : 0);
      const nextR = Number(h[3]) - (Number(h[4] ?? 1) ? 1 : 0);
      if (nextL < l || nextR < r || nextL - l !== nextR - r || nextL > left.length || nextR > right.length) throw S.fail('INCOMPLETE');
      while (l < nextL) if (!same(left[l++], right[r++])) throw S.fail('INCOMPLETE');
      continue;
    }
    if (line.startsWith('\\') || line === '') continue;
    const equal = (value) => value != null && value.replace(/\r$/, '') === line.slice(1).replace(/\r$/, '');
    if (line[0] !== '+' && !equal(left[l++])) throw S.fail('INCOMPLETE');
    if (line[0] !== '-' && !equal(right[r++])) throw S.fail('INCOMPLETE');
  }
  if (left.length - l !== right.length - r) throw S.fail('INCOMPLETE');
  while (l < left.length) if (!same(left[l++], right[r++])) throw S.fail('INCOMPLETE');
}
async function cleanupAuditRefs(github, repoRoot, activeRefs = new Set()) {
  const out = await github.runCommand('git', ['-C', repoRoot, 'for-each-ref', '--format=%(refname)', 'refs/codex/pr-audit/'], { rawOutput: true });
  if (!out?.ok) return;
  for (const name of out.stdout.split(/\r?\n/)) {
    const match = name.match(/^refs\/codex\/pr-audit\/(pra_[a-f0-9]{24})\/(base|head)$/);
    if (!match || activeRefs.has(match[1])) continue;
    await github.runCommand('git', ['-c', `core.hooksPath=${devNull}`, '-C', repoRoot, 'update-ref', '-d', name]);
  }
}
module.exports = { AuditSnapshot, verifyPatch, splitLines, cleanupAuditRefs };
