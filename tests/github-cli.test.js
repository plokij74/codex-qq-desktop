'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseRemote, runCommand, createGithubCli, normalizeChecks } = require('../src/ai/github-cli');

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
});
