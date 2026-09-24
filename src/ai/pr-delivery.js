'use strict';
const { remoteCiError } = require('./remote-ci-state');
const { cleanText } = require('./remote-ci-state');
const { ref } = require('./pr-review-state');
function resultError(cause, fallback = 'PR_UPDATE_UNAVAILABLE') {
  const code = /^(?:PR_UPDATE_|PR_REVIEW_|REMOTE_CI_)[A-Z_]+$/.test(String(cause?.code || '')) ? cause.code : fallback;
  return { ok: false, code, error: code };
}
async function createRemoteWorktree(manager, sourceRef, { project, sessionId, subagentId, goal, signal } = {}, context = {}) {
  signal ||= context.signal;
  const root = project?.path;
  const { kind, refField } = manager.deliverySource || { kind: 'remote_ci', refField: 'remoteCiRef' };
  const fresh = await manager.resolveMetadata(root, sourceRef, { ...context, signal });
  const targetRef = kind === 'remote_ci' ? `refs/codex/remote-ci/${ref('rci')}` : `refs/codex/pr-review/${ref('prv')}`;
  const github = manager.github;
  if (!github.fetchBranchToRef || !github.resolveCommit || !github.deleteInternalRef || !manager.worktree?.createAtCommit) return resultError(null);
  let fetched = false;
  try {
    manager._current?.({ ...context, signal });
    if (signal?.aborted) return resultError(null);
    const check = await manager.worktree.preflightRemoteCreate?.({ projectPath: root });
    if (check && !check.ok) return check;
    fetched = true;
    const got = await github.fetchBranchToRef({ repoRoot: fresh.repo.repoRoot, branch: fresh.pr.headRefName, targetRef, signal });
    if (!got?.ok) return got;
    const commit = await github.resolveCommit({ repoRoot: fresh.repo.repoRoot, ref: targetRef, signal });
    if (!commit?.ok || commit.head !== fresh.baseHead) return resultError({ code: 'REMOTE_CI_FETCH_MISMATCH' });
    await manager.resolveMetadata(root, sourceRef, { ...context, signal });
    manager._current?.({ ...context, signal });
    if (signal?.aborted) return resultError(null);
    return await manager.worktree.createAtCommit({ project, baseHead: fresh.baseHead, sessionId, subagentId, goal,
      origin: { kind, [refField]: sourceRef }, delivery: 'github_pr_update', signal });
  } finally {
    if (fetched) { try { await github.deleteInternalRef({ repoRoot: fresh.repo.repoRoot, ref: targetRef }); } catch {} }
  }
}
async function updatePr(manager, projectPath, resultId, subject, context = {}) {
    const { kind, refField, label } = manager.deliverySource || { kind: 'remote_ci', refField: 'remoteCiRef', label: 'CI' };
    const root = manager._root(projectPath);
    if (!root) return resultError({ code: 'REMOTE_CI_PROJECT_BINDING_INVALID' });
    return manager._exclusive(`${root}:${resultId}`, async () => {
      let prepared = false;
      let pushStarted = false;
      try {
        manager._current?.(context);
        if (context.signal?.aborted || context.isCurrent?.() === false) throw remoteCiError('PR_UPDATE_CONFIRM_REQUIRED');
        const inspect = async () => {
          const found = await manager.worktree.inspectRemoteResult({ projectPath: root, resultId });
          if (!found?.ok || (found.marker.originKind && found.marker.originKind !== kind) || !found.marker[refField]) throw remoteCiError('PR_UPDATE_UNAVAILABLE');
          const item = manager.store?.get(found.marker[refField], manager.projectKey(root));
          if (!item || item.headSha !== found.marker.baseHead) throw remoteCiError('PR_UPDATE_UNAVAILABLE');
          const repo = await manager._repository(root, context);
          const pr = await manager._pr(repo, item.prNumber, context);
          if (repo.repoKey !== item.repoKey || pr.headRefName !== item.headRefName) throw remoteCiError('PR_UPDATE_HEAD_CHANGED');
          return { found, item, repo, pr };
        };
        const initial = await inspect();
        const identity = (value) => JSON.stringify([value.item[refField], value.item.repoKey, value.item.prNumber,
          value.item.headSha, value.item.headRefName, value.found.marker.expectedTree, value.found.marker.patchSha256]);
        const unchanged = (value) => { if (identity(value) !== identity(initial)) throw remoteCiError('PR_UPDATE_UNAVAILABLE'); };
        const reconcileOnly = ['pr_update_uncertain', 'pr_update_cleanup_pending', 'pr_updated'].includes(initial.found.marker.state);
        const frozenSubject = initial.found.marker.prUpdate?.subject || cleanText(subject, 300) || `Fix ${label} for PR #${initial.item.prNumber}`;
        const gate = context.permissionGate || context.gate;
        if (!reconcileOnly) {
          if (!gate?.authorize) throw remoteCiError('PR_UPDATE_CONFIRM_REQUIRED');
          const decision = await gate.authorize({ tool: `${kind}_update_pr`, risk: 'remote-mutation', source: kind === 'remote_ci' ? 'remote-ci' : 'pr-review',
            summary: `更新 PR #${initial.item.prNumber} · ${initial.item.headRefName}`,
            detail: `${initial.item.headSha.slice(0, 12)} · ${initial.found.marker.stats?.files || 0} 个文件 · ${frozenSubject}`, signal: context.signal });
          if (!decision?.allowed) throw remoteCiError('PR_UPDATE_CONFIRM_REQUIRED');
        }
        if (context.isCurrent?.() === false || context.signal?.aborted) throw remoteCiError('PR_UPDATE_CONFIRM_REQUIRED');
        const mutate = async () => {
          const fresh = await inspect();
          unchanged(fresh);
          const prior = fresh.found.marker.prUpdate;
          const tip = await manager.github.branchTip({ repoRoot: fresh.repo.repoRoot, branch: fresh.item.headRefName, signal: context.signal });
          if (!tip?.ok) throw remoteCiError('PR_UPDATE_UNCERTAIN');
          if (prior?.newCommit && fresh.pr.headSha === prior.newCommit && tip.head === prior.newCommit) {
            const verified = await manager.worktree.verifyPrUpdate({ projectPath: root, resultId });
            if (!verified?.ok) throw remoteCiError('PR_UPDATE_TREE_MISMATCH');
            if (context.isCurrent?.() === false || context.signal?.aborted) throw remoteCiError('PR_UPDATE_CONFIRM_REQUIRED');
            return manager.worktree.completePrUpdate({ projectPath: root, resultId, prNumber: fresh.item.prNumber });
          }
          // An uncertain push may still be in flight. Reconcile by reading;
          // even an old remote tip is not permission to dispatch another push.
          if (reconcileOnly || fresh.found.marker.state === 'pr_update_uncertain') throw remoteCiError('PR_UPDATE_UNCERTAIN');
          if (fresh.pr.headSha !== fresh.item.headSha || tip.head !== fresh.item.headSha) throw remoteCiError('PR_UPDATE_HEAD_CHANGED');
          await manager.resolveMetadata(root, fresh.item[refField], context);
          if (context.isCurrent?.() === false || context.signal?.aborted) throw remoteCiError('PR_UPDATE_CONFIRM_REQUIRED');
          const ready = await manager.worktree.preparePrUpdate({ projectPath: root, resultId, subject: frozenSubject });
          if (!ready?.ok) return ready;
          prepared = true;
          const verified = await manager.worktree.verifyPrUpdate({ projectPath: root, resultId });
          if (!verified?.ok) throw remoteCiError('PR_UPDATE_TREE_MISMATCH');
          const last = await inspect();
          unchanged(last);
          const lastTip = await manager.github.branchTip({ repoRoot: last.repo.repoRoot, branch: last.item.headRefName, signal: context.signal });
          if (!lastTip?.ok || lastTip.head !== ready.oldHead || last.pr.headSha !== ready.oldHead) throw remoteCiError('PR_UPDATE_HEAD_CHANGED');
          if (context.isCurrent?.() === false || context.signal?.aborted) throw remoteCiError('PR_UPDATE_CONFIRM_REQUIRED');
          await manager.resolveMetadata(root, last.item[refField], context);
          if (context.isCurrent?.() === false || context.signal?.aborted) throw remoteCiError('PR_UPDATE_CONFIRM_REQUIRED');
          pushStarted = true;
          const pushed = await manager.github.exactLeasePush({ repoRoot: last.repo.repoRoot, branch: last.item.headRefName, oldHead: ready.oldHead, newCommit: ready.commit, signal: context.signal });
          if (!pushed?.ok) {
            pushStarted = pushed?.uncertain !== false;
            throw remoteCiError(pushStarted ? 'PR_UPDATE_UNCERTAIN' : 'PR_UPDATE_PUSH_FAILED');
          }
          const afterRepo = await manager._repository(root, context);
          const after = await manager._pr(afterRepo, last.item.prNumber, context);
          const afterTip = await manager.github.branchTip({ repoRoot: afterRepo.repoRoot, branch: last.item.headRefName, signal: context.signal });
          if (afterRepo.repoKey !== last.repo.repoKey || after.headRefName !== last.item.headRefName || after.headSha !== ready.commit
            || !afterTip?.ok || afterTip.head !== ready.commit || context.isCurrent?.() === false || context.signal?.aborted) throw remoteCiError('PR_UPDATE_UNCERTAIN');
          return manager.worktree.completePrUpdate({ projectPath: root, resultId, prNumber: last.item.prNumber });
        };
        return await (manager.mutationLock ? manager.mutationLock(mutate) : mutate());
      } catch (cause) {
        const out = pushStarted ? resultError({ code: 'PR_UPDATE_UNCERTAIN' }) : resultError(cause, 'PR_UPDATE_UNAVAILABLE');
        if (prepared) return manager.worktree.failPrUpdate({ projectPath: root, resultId, code: out.code, error: out.error, uncertain: pushStarted });
        return out;
      }
    });
  }

module.exports = { createRemoteWorktree, updatePr };
