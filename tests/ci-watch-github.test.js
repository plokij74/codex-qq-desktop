'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createGithubCli, runCommand } = require('../src/ai/github-cli');

const HEAD = 'a'.repeat(40);
const args = { repoRoot: 'D:/repo', host: 'ghe.example.test', owner: 'acme', repo: 'widget', number: 7 };
function http(value, status = 200, headers = {}) {
  return `HTTP/2.0 ${status} Status\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n${JSON.stringify(value)}`;
}
function runner(response) {
  const calls = [];
  const cli = createGithubCli({ execFileImpl: (command, argv, opts, callback) => {
    calls.push({ command, argv, opts });
    const result = typeof response === 'function' ? response(command, argv) : response;
    callback(result.error || null, result.stdout ?? result, result.stderr || '');
    return { kill() {} };
  } });
  return { cli, calls };
}
function run(id) { return { id: String(id), name: 'tests', head_sha: HEAD, run_attempt: 2, status: 'completed', conclusion: 'success' }; }

describe('D15 GitHub metadata adapter', () => {
  it('uses only GETs, limited projections and an origin-derived repository', async () => {
    const f = runner((command, argv) => {
      if (command === 'git') return argv.includes('--show-toplevel') ? 'D:/repo' : 'git@ghe.example.test:acme/widget.git';
      if (argv.includes('repos/acme/widget')) return http({ full_name: 'acme/widget' });
      return http({ number: 7, state: 'open', merged: false, head_sha: HEAD, head_ref: 'feature', head_repo: 'acme/widget', base_repo: 'acme/widget' });
    });
    const repo = await f.cli.getCiWatchRepository({ projectPath: 'D:/repo' });
    assert.equal(repo.repository.nameWithOwner, 'acme/widget');
    const result = await f.cli.getCiPrStatus(args);
    assert.equal(result.pr.headSha, HEAD); assert.equal(result.pr.isCrossRepository, false);
    for (const { command, argv, opts } of f.calls) {
      assert.equal(opts.shell, false); assert.equal(opts.windowsHide, true);
      if (command === 'gh') {
        assert.equal(argv[argv.indexOf('--method') + 1], 'GET');
        assert.equal(argv[argv.indexOf('--hostname') + 1], args.host);
        assert.doesNotMatch(argv.join(' '), /annotations|\/logs|comments|Authorization/);
      }
    }
  });
  it('paginates exactly 200 runs without rounding IDs or falsely marking truncation', async () => {
    const f = runner((_c, argv) => http({ total_count: 200, workflow_runs: Array.from({ length: 100 }, (_, i) => run(argv.some((a) => a.includes('page=2')) ? i + 101 : i + 1)) }));
    const result = await f.cli.getCiRunsForHead({ ...args, headSha: HEAD });
    assert.equal(result.ok, true); assert.equal(result.runs.length, 200); assert.equal(result.truncated, false);
    assert.equal(f.calls.length, 2);
    const one = runner(http({ total_count: 1, workflow_runs: [run('900719925474099312')] }));
    assert.equal((await one.cli.getCiRunsForHead({ ...args, headSha: HEAD })).runs[0].id, '900719925474099312');
  });
  it('honors a shared host cooldown after local origin resolution and before any GET', async () => {
    const f = runner((_command, argv) => argv.includes('--show-toplevel') ? 'D:/repo' : 'git@ghe.example.test:acme/widget.git');
    const result = await f.cli.getCiWatchRepository({ projectPath: 'D:/repo', getHostCooldownMs: (host) => host === args.host ? 90_000 : 0 });
    assert.equal(result.code, 'CI_WATCH_RATE_LIMITED');
    assert.equal(result.host, args.host);
    assert.equal(result.retryAfterMs, 90_000);
    assert.ok(f.calls.every((call) => call.command === 'git'));
  });
  it('rejects partial, duplicate, mismatched and malformed metadata', async () => {
    for (const value of [
      { total_count: 2, workflow_runs: [run('1')] },
      { total_count: 2, workflow_runs: [run('1'), run('1')] },
      { total_count: 1, workflow_runs: [{ ...run('1'), head_sha: 'b'.repeat(40) }] },
      { total_count: 1, workflow_runs: [{ ...run('1'), run_attempt: 0 }] },
    ]) {
      const f = runner(http(value));
      assert.equal((await f.cli.getCiRunsForHead({ ...args, headSha: HEAD })).code, 'CI_WATCH_INCOMPLETE');
    }
    const f = runner(http({ total_count: 201, workflow_runs: [] }));
    assert.equal((await f.cli.getCiRunsForHead({ ...args, headSha: HEAD })).truncated, true);
    assert.equal(f.calls.length, 1);
  });
  it('classifies rate limits, permissions and transient errors without leaking HTTP bodies', async () => {
    for (const [status, headers, expected] of [
      [429, { 'Retry-After': '120' }, 'CI_WATCH_RATE_LIMITED'],
      [403, { 'X-RateLimit-Remaining': '0' }, 'CI_WATCH_RATE_LIMITED'],
      [403, {}, 'CI_WATCH_FORBIDDEN'], [401, {}, 'CI_WATCH_AUTH_REQUIRED'],
      [404, {}, 'CI_WATCH_TARGET_NOT_FOUND'], [503, {}, 'CI_WATCH_NETWORK'],
    ]) {
      const f = runner({ stdout: http({ message: 'private log ghp_123456789012345' }, status, headers), error: { code: 1 } });
      const result = await f.cli.getCiPrStatus(args);
      assert.equal(result.code, expected);
      assert.doesNotMatch(JSON.stringify(result), /private|ghp_|stdout|stderr/);
      if (status === 429) assert.equal(result.retryAfterMs, 120_000);
    }
  });
  it('does not run commands with forged repo selectors or invalid heads', async () => {
    const f = runner('unused');
    for (const extra of [{ owner: '../other' }, { repo: 'widget/../../other' }, { host: '--hostname=evil' }]) {
      assert.equal((await f.cli.getCiPrStatus({ ...args, ...extra })).ok, false);
    }
    assert.equal((await f.cli.getCiRunsForHead({ ...args, headSha: 'bad' })).ok, false);
    assert.equal(f.calls.length, 0);
  });
  it('returns a fixed error for malformed PR repository or merge metadata', async () => {
    const pr = { number: 7, state: 'open', merged: false, head_sha: HEAD, head_ref: 'feature', head_repo: 'acme/widget', base_repo: 'acme/widget' };
    for (const extra of [{ head_repo: {} }, { head_repo: 1 }, { merged: 'false' }, { base_repo: 'another/widget' }]) {
      const f = runner(http({ ...pr, ...extra }));
      assert.equal((await f.cli.getCiPrStatus(args)).code, 'CI_WATCH_PR_INVALID');
    }
  });
  it('aborts before spawning or kills an active metadata command and ignores late callbacks', async () => {
    const early = new AbortController(); early.abort(); let calls = 0;
    const result = await runCommand('gh', [], { signal: early.signal, execFileImpl: () => { calls++; } });
    assert.equal(result.aborted, true); assert.equal(calls, 0);
    let killed = 0; let reply;
    const active = new AbortController();
    const promise = runCommand('gh', [], { signal: active.signal, execFileImpl: (_c, _a, _o, cb) => { reply = cb; return { kill: () => killed++ }; } });
    active.abort(); assert.equal((await promise).aborted, true); assert.equal(killed, 1);
    reply(null, 'late sensitive output', '');
  });
});
