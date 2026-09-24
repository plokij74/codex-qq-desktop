'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  parseRemote, runCommand, runRawCommand, createGithubCli, normalizeChecks,
  parseActionsDetailsUrl,
} = require('../src/ai/github-cli');

describe('D6 GitHub CLI adapter', () => {
  it('parses github.com and Enterprise HTTPS/SSH remotes', () => {
    assert.deepEqual(parseRemote('https://github.com/acme/widget.git'), {
      host: 'github.com', owner: 'acme', repo: 'widget', nameWithOwner: 'acme/widget',
    });
    assert.deepEqual(parseRemote('git@ghe.example.test:team/repo.git'), {
      host: 'ghe.example.test', owner: 'team', repo: 'repo', nameWithOwner: 'team/repo',
    });
    assert.deepEqual(parseRemote('ssh://git@ghe.example.test:2222/team/repo.git'), {
      host: 'ghe.example.test:2222', owner: 'team', repo: 'repo', nameWithOwner: 'team/repo',
    });
    assert.deepEqual(parseRemote('https://user:github_pat_supersecret@ghe.example.test/team/repo.git'), {
      host: 'ghe.example.test', owner: 'team', repo: 'repo', nameWithOwner: 'team/repo',
    });
    assert.equal(parseRemote('https://gitlab.com/acme/widget.git')?.host, 'gitlab.com');
    assert.equal(parseRemote('not a remote'), null);
  });

  it('uses argument arrays and keeps editable PR text as one argument', async () => {
    const calls = [];
    const sha = 'a'.repeat(40);
    const execFileImpl = (command, args, _options, callback) => {
      calls.push([command, args]);
      let stdout = '';
      if (command === 'git' && args.includes('remote.origin.url')) stdout = 'https://github.com/acme/widget.git\n';
      else if (command === 'gh' && args[0] === 'repo') stdout = JSON.stringify({ defaultBranchRef: { name: 'main' }, nameWithOwner: 'acme/widget' });
      else if (command === 'git' && args.includes('ls-remote')) stdout = `${sha}\trefs/heads/main\n`;
      else if (command === 'gh' && args[1] === 'list') stdout = '[]';
      else if (command === 'gh' && args[1] === 'create') stdout = 'https://github.com/acme/widget/pull/7\n';
      callback(null, stdout, '');
      return { kill() {} };
    };
    const cli = createGithubCli({ execFileImpl });
    const checked = await cli.preflight({ repoRoot: 'D:/repo', baseHead: sha });
    assert.equal(checked.ok, true);
    const title = 'fix: literal ; $(no shell)';
    const body = 'body && still literal';
    const created = await cli.createPr({ repoRoot: 'D:/repo', host: 'github.com', owner: 'acme', repo: 'widget', base: 'main', head: 'codex/wt_123456', title, body, draft: true });
    assert.equal(created.ok, true);
    const createArgs = calls.find(([command, args]) => command === 'gh' && args[1] === 'create')[1];
    assert.equal(createArgs[createArgs.indexOf('--title') + 1], title);
    assert.equal(createArgs[createArgs.indexOf('--body') + 1], body);
  });

  it('redacts GitHub credentials from command failures', async () => {
    const result = await runCommand('gh', ['x'], {
      execFileImpl: (_command, _args, _options, callback) => {
        const error = Object.assign(new Error('failed'), { code: 1 });
        callback(error, '', 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz');
        return { kill() {} };
      },
    });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /ghp_/);
    assert.match(result.error, /REDACTED/);
  });

  it('redacts cloud credentials and terminal control sequences from failures', async () => {
    const result = await runCommand('gh', ['x'], {
      execFileImpl: (_command, _args, _options, callback) => {
        const error = Object.assign(new Error('failed'), { code: 1 });
        callback(error, '', '\x1b]0;token=private\x07 AWS_SECRET_ACCESS_KEY=supersecret');
        return { kill() {} };
      },
    });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /supersecret|private/);
    assert.doesNotMatch(result.error, /\x1b/);
  });

  it('does not echo command arguments when a failure has no stderr', async () => {
    const result = await runCommand('gh', ['pr', 'create', '--body', 'private body'], {
      execFileImpl: (_command, args, _options, callback) => {
        const error = Object.assign(new Error(`Command failed: gh ${args.join(' ')}`), { code: 1 });
        callback(error, '', '');
        return { kill() {} };
      },
    });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /private body/);
    assert.match(result.error, /^gh 执行失败/);
  });

  it('fails closed when the existing PR lookup is not valid JSON', async () => {
    const cli = createGithubCli({
      execFileImpl: (_command, _args, _options, callback) => {
        callback(null, '{truncated', '');
        return { kill() {} };
      },
    });
    const found = await cli.findExistingPr({
      repoRoot: 'D:/repo', host: 'github.com', owner: 'acme', repo: 'widget', head: 'codex/wt_123456',
    });
    assert.equal(found.ok, false);
    assert.equal(found.code, 'PR_LOOKUP_FAILED');
  });

  it('normalizes lifecycle list, detail, and non-zero checks JSON', async () => {
    const calls = [];
    const execFileImpl = (command, args, _options, callback) => {
      calls.push([command, args]);
      let stdout = '';
      let error = null;
      if (args[0] === 'pr' && args[1] === 'list') {
        stdout = JSON.stringify([{ number: 7, url: 'https://github.com/acme/widget/pull/7', title: 'Change', state: 'OPEN', isDraft: false, author: { login: 'alice' }, headRefOid: 'a'.repeat(40) }]);
      } else if (args[0] === 'pr' && args[1] === 'view') {
        stdout = JSON.stringify({ number: 7, url: 'https://github.com/acme/widget/pull/7', title: 'Change', body: 'Body', state: 'OPEN', isDraft: false, author: { login: 'alice' }, headRefOid: 'a'.repeat(40), comments: [{ author: { login: 'bob' }, body: 'Looks good' }], files: [{ path: 'src/a.js', additions: 2, deletions: 1 }] });
      } else if (args[0] === 'pr' && args[1] === 'checks') {
        stdout = JSON.stringify([{ name: 'test', state: 'SUCCESS', bucket: 'pass', link: 'https://github.com/acme/widget/actions/1' }]);
        error = Object.assign(new Error('checks exit'), { code: 8 });
      }
      callback(error, stdout, '');
      return { kill() {} };
    };
    const cli = createGithubCli({ execFileImpl });
    const listed = await cli.listPrs({ repoRoot: 'D:/repo', host: 'github.com', owner: 'acme', repo: 'widget', state: 'open', limit: 51 });
    assert.equal(listed.ok, true);
    assert.equal(listed.prs[0].author, 'alice');
    const detail = await cli.getPr({ repoRoot: 'D:/repo', host: 'github.com', owner: 'acme', repo: 'widget', number: 7 });
    assert.equal(detail.pr.comments[0].body, 'Looks good');
    assert.equal(detail.pr.files[0].path, 'src/a.js');
    const checks = await cli.getChecks({ repoRoot: 'D:/repo', host: 'github.com', owner: 'acme', repo: 'widget', number: 7 });
    assert.equal(checks.ok, true);
    assert.deepEqual(checks.summary, { total: 1, passed: 1, pending: 0, failed: 0, skipped: 0, unknown: 0 });
    assert.ok(calls.every(([command]) => command === 'gh'));
  });

  it('counts SKIPPING checks as skipped instead of unknown', () => {
    const normalized = normalizeChecks([
      { name: 'optional', state: 'SKIPPING', bucket: '' },
    ]);
    assert.deepEqual(normalized.summary, {
      total: 1, passed: 0, pending: 0, failed: 0, skipped: 1, unknown: 0,
    });
  });

  it('keeps lifecycle text literal and pins merge to the observed head without deleting the branch', async () => {
    const calls = [];
    const execFileImpl = (command, args, _options, callback) => {
      calls.push([command, args]);
      callback(null, '', '');
      return { kill() {} };
    };
    const cli = createGithubCli({ execFileImpl });
    const title = 'literal ; $(no shell)';
    const body = 'body && still one argument';
    assert.equal((await cli.editPr({ repoRoot: 'D:/repo', host: 'github.com', owner: 'acme', repo: 'widget', number: 7, title, body })).ok, true);
    assert.equal((await cli.commentPr({ repoRoot: 'D:/repo', host: 'github.com', owner: 'acme', repo: 'widget', number: 7, body })).ok, true);
    assert.equal((await cli.mergePr({ repoRoot: 'D:/repo', host: 'github.com', owner: 'acme', repo: 'widget', number: 7, method: 'squash', headSha: 'a'.repeat(40) })).ok, true);
    const editArgs = calls.find(([, args]) => args[1] === 'edit')[1];
    assert.equal(editArgs[editArgs.indexOf('--title') + 1], title);
    assert.equal(editArgs[editArgs.indexOf('--body') + 1], body);
    const mergeArgs = calls.find(([, args]) => args[1] === 'merge')[1];
    assert.ok(mergeArgs.includes('--squash'));
    assert.equal(mergeArgs[mergeArgs.indexOf('--match-head-commit') + 1], 'a'.repeat(40));
    assert.ok(mergeArgs.includes('--delete-branch=false'));
  });

  it('strictly parses Actions details URLs for the current host and repository', () => {
    assert.deepEqual(parseActionsDetailsUrl('https://github.com/acme/widget/actions/runs/123/job/456', {
      host: 'github.com', owner: 'acme', repo: 'widget',
    }), { runId: '123', jobId: '456' });
    assert.equal(parseActionsDetailsUrl('https://evil.test/acme/widget/actions/runs/123/job/456', {
      host: 'github.com', owner: 'acme', repo: 'widget',
    }), null);
    assert.equal(parseActionsDetailsUrl('https://github.com/acme/other/actions/runs/123/job/456?token=secret', {
      host: 'github.com', owner: 'acme', repo: 'widget',
    }), null);
  });

  it('reads bounded raw job logs without flattening line breaks or exposing stderr', async () => {
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('line one\nline two\n'));
        child.stderr.emit('data', Buffer.from('Authorization: Bearer ghp_supersecret'));
        child.emit('close', 0);
      });
      return child;
    };
    const result = await runRawCommand('gh', ['api', 'fixed'], { spawnImpl, maxBytes: 1024 });
    assert.equal(result.ok, true);
    assert.equal(result.stdout, 'line one\nline two\n');
    assert.equal(result.stderr, '');
    assert.doesNotMatch(JSON.stringify(result), /supersecret/);
  });

  it('pages annotations with a bounded result and reports truncation', async () => {
    const calls = [];
    const execFileImpl = (command, args, _options, callback) => {
      calls.push([command, args]);
      if (command === 'gh' && args[0] === 'api' && args.some((arg) => String(arg).includes('/annotations?'))) {
        const page = Number(String(args.find((arg) => String(arg).includes('page=')) || '').split('page=')[1]) || 1;
        const rows = Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({
          path: `src/file-${page}-${index}.js`, start_line: index + 1, annotation_level: 'failure', message: `failure ${index}`,
        }));
        callback(null, JSON.stringify(rows), '');
        return { kill() {} };
      }
      callback(null, '[]', '');
      return { kill() {} };
    };
    const cli = createGithubCli({ execFileImpl });
    const result = await cli.getCheckAnnotations({ repoRoot: 'D:/repo', host: 'github.com', owner: 'acme', repo: 'widget', checkRunId: '34' });
    assert.equal(result.ok, true);
    assert.equal(result.annotations.length, 50);
    assert.equal(result.truncated, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0][1].find((arg) => String(arg).includes('/annotations?')), /per_page=100&page=1/);
  });

  it('treats ambiguous exact-lease transport failures as uncertain even with a nonzero exit code', async () => {
    const newCommit = 'b'.repeat(40);
    const target = `${newCommit}:refs/heads/feature`;
    const cases = [
      { code: 1, stdout: '', uncertain: true },
      { code: 128, stdout: 'To https://github.com/acme/widget.git\n', uncertain: true },
      { code: 1, stdout: `!\t${target}\t[remote failed] (remote did not report status)\n`, uncertain: true },
      { code: 1, stdout: `!\t${newCommit}:refs/heads/other\t[rejected] (stale info)\n`, uncertain: true },
      { code: 1, stdout: `!\t${target}\t[rejected] (stale info)\n`, uncertain: false },
      { code: 1, stdout: `!\t${target}\t[remote rejected] (protected branch hook declined)\n`, uncertain: false },
      { code: 'ENOENT', stdout: '', uncertain: false },
    ];
    for (const scenario of cases) {
      const cli = createGithubCli({ execFileImpl: (_command, args, _options, callback) => {
        assert.ok(args.includes('--porcelain'));
        callback(Object.assign(new Error('push transport failed'), { code: scenario.code }), scenario.stdout, 'connection closed');
        return { kill() {} };
      } });
      const result = await cli.exactLeasePush({ repoRoot: 'D:/repo', branch: 'feature', oldHead: 'a'.repeat(40), newCommit });
      assert.equal(result.ok, false);
      assert.equal(result.uncertain, scenario.uncertain, JSON.stringify(scenario));
    }
  });

  it('uses string-preserving jq projections for check runs, Actions jobs, rerun, and exact lease push', async () => {
    const calls = [];
    const head = 'a'.repeat(40);
    const execFileImpl = (command, args, _options, callback) => {
      calls.push([command, args]);
      let stdout = '';
      if (command === 'gh' && args[0] === 'api' && args.some((arg) => String(arg).includes('/commits/'))) {
        stdout = JSON.stringify([{ id: '90071992547409931', name: 'tests', status: 'completed', conclusion: 'failure', details_url: 'https://github.com/acme/widget/actions/runs/12/job/34', app_slug: 'github-actions', annotations_count: 2 }]);
      } else if (command === 'gh' && args[0] === 'api' && args.some((arg) => String(arg).includes('/actions/jobs/34')) && !args.includes('--method')) {
        stdout = JSON.stringify({ id: '34', run_id: '12', workflow_name: 'CI', head_sha: head, run_attempt: 1, name: 'tests', status: 'completed', conclusion: 'failure', logs_url: 'https://api.github.com/log' });
      } else if (command === 'git' && args.includes('ls-remote')) {
        stdout = `${head}\trefs/heads/feature\n`;
      }
      callback(null, stdout, '');
      return { kill() {} };
    };
    const cli = createGithubCli({ execFileImpl });
    const checks = await cli.getCheckRunsForRef({ repoRoot: 'D:/repo', host: 'github.com', owner: 'acme', repo: 'widget', headSha: head });
    assert.equal(checks.checks[0].id, '90071992547409931');
    assert.equal(checks.checks[0].output, undefined);
    const job = await cli.getActionsJob({ repoRoot: 'D:/repo', host: 'github.com', owner: 'acme', repo: 'widget', jobId: '34' });
    assert.equal(job.job.runId, '12');
    assert.equal((await cli.rerunActionsJob({ repoRoot: 'D:/repo', host: 'github.com', owner: 'acme', repo: 'widget', jobId: '34' })).ok, true);
    assert.equal((await cli.branchTip({ repoRoot: 'D:/repo', branch: 'feature' })).head, head);
    assert.equal((await cli.exactLeasePush({ repoRoot: 'D:/repo', branch: 'feature', oldHead: head, newCommit: 'b'.repeat(40) })).ok, true);
    assert.equal((await cli.fetchBranchToRef({ repoRoot: 'D:/repo', branch: 'feature', targetRef: `refs/codex/remote-ci/rci_${'1'.repeat(24)}` })).ok, true);
    assert.equal((await cli.deleteInternalRef({ repoRoot: 'D:/repo', ref: `refs/codex/remote-ci/rci_${'1'.repeat(24)}` })).ok, true);
    const checkCall = calls.find(([, args]) => args.some((arg) => String(arg).includes('/commits/')));
    assert.match(checkCall[1][checkCall[1].indexOf('--jq') + 1], /tostring/);
    assert.doesNotMatch(checkCall[1][checkCall[1].indexOf('--jq') + 1], /output_title|output_summary/);
    const push = calls.find(([command, args]) => command === 'git' && args.includes('push'))[1];
    assert.ok(push.includes(`--force-with-lease=refs/heads/feature:${head}`));
    assert.ok(push.includes(`${'b'.repeat(40)}:refs/heads/feature`));
    const fetch = calls.find(([command, args]) => command === 'git' && args.includes('fetch'))[1];
    assert.deepEqual(fetch.slice(-4), ['--no-tags', '--no-write-fetch-head', 'origin', `refs/heads/feature:refs/codex/remote-ci/rci_${'1'.repeat(24)}`]);
  });
});
