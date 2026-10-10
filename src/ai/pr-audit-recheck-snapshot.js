'use strict';
const { AuditSnapshot } = require('./pr-audit-snapshot');
const A = require('./pr-audit-state');
const S = require('./pr-audit-recheck-state');
const { devNull } = require('node:os');
class RecheckSnapshot extends AuditSnapshot {
  constructor({ github, repo, target, source, recheckRef, signal, refNamespace = 'pr-audit-recheck', includeDiffs = true }) {
    super({ github, repo, source: target, signal });
    this.origin = S.source(source); this.recheckRef = recheckRef; this.readers = new Map(); this.evidence = new Map();
    this.refNamespace = refNamespace; this.includeDiffs = includeDiffs;
  }
  reader(stage) {
    if (!S.STAGES.includes(stage)) throw A.fail('LOCATION');
    if (!this.readers.has(stage)) {
      const headSha = { target: this.source.headSha, repair: this.origin.repairCommit, repair_base: this.origin.repairBaseHead,
        original_head: this.origin.originalHead, original_base: this.origin.originalBase }[stage];
      const reader = new AuditSnapshot({ github: this.github, repo: this.repo, source: { ...this.source, headSha, mergeBaseSha: headSha }, signal: this.signal });
      reader.consume = this.consume.bind(this); reader.blobs = this.blobs; reader.trees = this.trees;
      this.readers.set(stage, reader);
    }
    return this.readers.get(stage);
  }
  async init() {
    S.source(this.origin); S.target(this.source);
    const prefix = { 'pr-audit-recheck': 'pac', 'pr-audit-recheck-repair': 'pcr' }[this.refNamespace];
    if (!prefix || !A.isRef(this.recheckRef, prefix)) throw A.fail();
    this.refs = ['base', 'head'].map((n) => `refs/codex/${this.refNamespace}/${this.recheckRef}/${n}`);
    try {
      await this.git(['-c', 'gc.auto=0', '-c', 'fetch.writeCommitGraph=false', 'fetch', '--no-auto-maintenance', '--no-recurse-submodules', '--refmap=', '--no-tags', '--no-write-fetch-head', 'origin',
        `refs/heads/${this.source.baseRefName}:${this.refs[0]}`, `refs/heads/${this.source.headRefName}:${this.refs[1]}`], { timeoutMs: 60000 });
      for (let i = 0; i < 2; i++) if ((await this.git(['rev-parse', '--verify', `${this.refs[i]}^{commit}`])).trim() !== (i ? this.source.headSha : this.source.baseSha)) throw A.fail('CHANGED');
      if ((await this.git(['merge-base', '--all', this.source.baseSha, this.source.headSha])).trim() !== this.source.mergeBaseSha) throw A.fail('INCOMPLETE');
      if ((await this.git(['rev-list', '--parents', '-n', '1', this.origin.repairCommit])).trim() !== `${this.origin.repairCommit} ${this.origin.repairBaseHead}`
        || (await this.git(['rev-parse', `${this.origin.repairCommit}^{tree}`])).trim() !== this.origin.expectedTree) throw A.fail('RECHECK_DELIVERY');
      try {
        await this.git(['merge-base', '--is-ancestor', this.origin.repairCommit, this.source.headSha]);
        await this.git(['merge-base', '--is-ancestor', this.origin.originalBase, this.origin.originalHead]);
        if (this.origin.recheckRepairRef) await this.git(['merge-base', '--is-ancestor', this.origin.originalHead, this.origin.repairBaseHead]);
      } catch { A.assertCurrent({ signal: this.signal }); throw A.fail('RECHECK_ANCESTRY'); }
      this.diffs = this.includeDiffs ? [await this.delta(this.origin.recheckRepairRef ? 'repair_base' : 'original_head', 'repair'), await this.delta('repair', 'target')] : [];
      if (Buffer.byteLength(JSON.stringify(this.diffs)) > A.LIMITS.diff) throw A.fail('CONTEXT_LIMIT');
      return this;
    } catch (cause) { await this.cleanup(); throw cause; }
  }
  async delta(from, to) {
    const left = this.reader(from); const right = this.reader(to);
    const before = await left.tree('RIGHT'); const after = await right.tree('RIGHT');
    const names = (await this.git(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--name-status', '-z', left.source.headSha, right.source.headSha, '--'])).split('\0');
    const files = []; const skipped = []; let total = 0; let bytes = 0;
    for (let i = 0; i < names.length && names[i];) {
      const status = names[i++]; const oldPath = names[i++]; const newPath = /^[RC]/.test(status) ? names[i++] : oldPath;
      if (!/^(?:[AMDMTUXB]|[RC]\d+)$/.test(status) || !oldPath || !newPath || ++total > A.LIMITS.remoteFiles) throw A.fail('INCOMPLETE');
      const oldIn = A.scopePath(oldPath, this.source.prefix); const newIn = A.scopePath(newPath, this.source.prefix);
      if (!oldIn && !newIn) continue;
      if (!oldIn || !newIn) { skipped.push({ path: newIn ? newPath : oldPath, reason: '跨项目范围移动' }); continue; }
      if (files.length + skipped.length >= A.LIMITS.files) throw A.fail('LIMIT');
      const entries = [before.get(oldPath), after.get(newPath)].filter(Boolean);
      if (entries.some((e) => !['100644', '100755'].includes(e.mode))) { skipped.push({ path: newPath, reason: '符号链接或子模块' }); continue; }
      try { for (const entry of entries) await this.blob(entry); }
      catch (cause) {
        A.assertCurrent({ signal: this.signal });
        if (!['PR_AUDIT_LOCATION', 'PR_AUDIT_CONTEXT_LIMIT'].includes(cause.code)) throw cause;
        skipped.push({ path: newPath, reason: '文本不可读取或超过单文件上限' }); continue;
      }
      const patch = await this.git(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--unified=3', left.source.headSha, right.source.headSha, '--', ...new Set([oldPath, newPath])]);
      bytes += Buffer.byteLength(patch); if (bytes > A.LIMITS.diff) throw A.fail('CONTEXT_LIMIT');
      files.push({ status, oldPath, path: newPath, patch });
    }
    return { from, to, files, skipped };
  }
  async read({ stage = 'target', path, offset = 1, limit = 120 }) {
    const reader = this.reader(stage);
    if (!A.scopePath(path, this.source.prefix) || !A.number(offset) || !A.number(limit) || limit > 200) throw A.fail('LOCATION');
    const tree = await reader.tree('RIGHT');
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) if (tree.has(segments.slice(0, i).join('/'))) throw A.fail('LOCATION');
    let value; let item;
    if (!tree.has(path)) {
      if (stage !== 'target') throw A.fail('LOCATION');
      const before = (await this.reader('original_head').tree('RIGHT')).get(path)
        || (await this.reader('original_base').tree('RIGHT')).get(path);
      item = { kind: 'absence', existedBefore: !!before && ['100644', '100755'].includes(before.mode) };
      value = { path, sha: reader.source.headSha, absent: true };
    } else {
      value = await reader.read({ path, offset, limit }, false);
      if (!value.content || offset > value.totalLines) throw A.fail('LOCATION');
      item = { kind: 'code', startLine: offset, line: Math.min(value.totalLines, offset + limit - 1) };
    }
    const evidenceId = A.ref('pce');
    this.evidence.set(evidenceId, { evidenceId, stage, sha: reader.source.headSha, path, ...item });
    return this.consume({ ...value, stage, evidenceId });
  }
  list(args) { return this.reader('target').list(args); }
  search(args) { return this.reader('target').search(args); }
  async input(findings) {
    const originals = [];
    for (const finding of findings) {
      let snippet;
      try { snippet = await this.read({ stage: finding.side === 'LEFT' ? 'original_base' : 'original_head', path: finding.contextPath || finding.path,
        offset: Math.max(1, finding.startLine - 8), limit: Math.min(60, finding.line - finding.startLine + 17) }); }
      catch (cause) {
        A.assertCurrent({ signal: this.signal });
        if (!['PR_AUDIT_LOCATION', 'PR_AUDIT_CONTEXT_LIMIT'].includes(cause.code)) throw cause;
        snippet = { unavailable: true, code: cause.code };
      }
      originals.push({ ...finding, snippet });
    }
    return { prNumber: this.source.prNumber, originalHead: this.origin.originalHead, repairBaseHead: this.origin.repairBaseHead, repairCommit: this.origin.repairCommit,
      targetHead: this.source.headSha, scope: this.source.prefix || '.', findings: originals, diffs: this.diffs };
  }
}
async function cleanupRecheckRefs(github, repoRoot, active = new Set(), namespace = 'pr-audit-recheck') {
  const prefix = { 'pr-audit-recheck': 'pac', 'pr-audit-recheck-repair': 'pcr' }[namespace];
  if (!prefix) throw A.fail();
  const out = await github.runCommand('git', ['-C', repoRoot, 'for-each-ref', '--format=%(refname)', `refs/codex/${namespace}/`], { rawOutput: true });
  if (!out?.ok || out.truncated) return;
  for (const name of out.stdout.split(/\r?\n/)) {
    const match = name.match(new RegExp('^refs/codex/' + namespace + '/(' + prefix + '_[a-f0-9]{24})(?:/(?:base|head))?$'));
    if (match && !active.has(match[1])) await github.runCommand('git', ['-c', `core.hooksPath=${devNull}`, '-C', repoRoot, 'update-ref', '-d', name]);
  }
}
module.exports = { RecheckSnapshot, cleanupRecheckRefs };
