'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createGithubCli, runCommand } = require('../src/ai/github-cli');

const args = { repoRoot: 'D:/repo', host: 'ghe.example.test', owner: 'acme', repo: 'widget' };
function runner(response) {
  const calls = [];
  const cli = createGithubCli({ execFileImpl: (command, argv, options, callback) => {
    const call = { command, argv, options }; calls.push(call);
    const stdin = new EventEmitter();
    stdin.end = (input) => {
      call.input = JSON.parse(input);
      const result = typeof response === 'function' ? response(call) : response;
      callback(null, typeof result === 'string' ? result : JSON.stringify(result), '');
    };
    return { stdin, kill() {} };
  } });
  return { cli, calls };
}
describe('D16 GitHub review adapter', () => {
  it('sends fixed GraphQL via structured stdin, with literal IDs and an origin-derived host', async () => {
    const f = runner({ data: { addPullRequestReviewThreadReply: { comment: { id: 'COMMENT_2' } } } });
    const body = 'literal `code` $(Get-Secret) "quotes"\n第二行';
    assert.equal((await f.cli.replyReviewThread({ ...args, threadId: 'PRRT_kwDOExample==', body })).ok, true);
    const call = f.calls[0];
    assert.equal(call.command, 'gh');
    assert.deepEqual(call.argv, ['api', '--hostname', args.host, 'graphql', '--input', '-']);
    assert.deepEqual(call.input.variables, { id: 'PRRT_kwDOExample==', body });
    assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true); assert.equal(call.options.timeout, 15000);
    assert.doesNotMatch(call.argv.join(' '), /Get-Secret|quotes/);
    assert.match(call.input.query, /addPullRequestReviewThreadReply/);
  });
  it('projects exactly the code review connection with bounded thread and comment queries', async () => {
    const f = runner({ data: { repository: { pullRequest: { number: 7 } }, node: { id: 'THREAD_1' } } });
    await f.cli.getReviewThreads({ ...args, number: 7, after: 'cursor="literal"' });
    await f.cli.getReviewThread({ ...args, threadId: 'THREAD_1' });
    assert.match(f.calls[0].input.query, /reviewThreads\(first:100/);
    assert.equal(f.calls[0].input.variables.after, 'cursor="literal"');
    assert.match(f.calls[1].input.query, /comments\(first:50\)/);
    assert.doesNotMatch(f.calls[1].input.query, /originalCommit/);
  });
  it('fails closed on partial GraphQL errors, malformed data and ambiguous mutation responses', async () => {
    for (const value of [
      'not json', { data: null }, { data: {}, errors: [{ message: 'token=private-server-message' }] },
      { data: { node: {} }, errors: 'private error' },
    ]) {
      const f = runner(value);
      const read = await f.cli.getReviewThread({ ...args, threadId: 'THREAD_1' });
      const write = await f.cli.replyReviewThread({ ...args, threadId: 'THREAD_1', body: 'reply' });
      assert.equal(read.ok, false); assert.equal(write.code, 'PR_REVIEW_ACTION_UNCERTAIN');
      assert.doesNotMatch(JSON.stringify([read, write]), /private-server-message|private error/);
    }
    const wrong = runner({ data: { resolveReviewThread: { thread: { id: 'WRONG', isResolved: true } } } });
    assert.equal((await wrong.cli.resolveReviewThread({ ...args, threadId: 'THREAD_1' })).ok, false);
  });
  it('validates anchor paths and text file bounds and preserves line semantics', async () => {
    const payload = { data: { repository: { object: { isBinary: false, byteSize: 4, text: 'a\nb\n' } } } };
    const f = runner(payload); const input = { ...args, headSha: 'a'.repeat(40), path: 'src/a file.js' };
    assert.deepEqual(await f.cli.getReviewFile(input), { ok: true, lineCount: 2 });
    assert.equal(f.calls[0].input.variables.expression, `${input.headSha}:src/a file.js`);
    for (const file of ['../outside', '.git/config', 'a\\b', '/abs', 'D:/file', 'a/../b']) assert.equal((await f.cli.getReviewFile({ ...input, path: file })).code, 'PR_REVIEW_INVALID');
    assert.equal(f.calls.length, 1);
    for (const object of [null, { isBinary: true, byteSize: 1, text: 'x' }, { isBinary: false, byteSize: 131073, text: 'x' }, { isBinary: false, byteSize: 1, text: null }]) {
      payload.data.repository.object = object;
      assert.equal((await f.cli.getReviewFile(input)).code, 'PR_REVIEW_LOCATION_UNAVAILABLE');
    }
  });
  it('rejects forged hosts, IDs and oversized replies without a subprocess', async () => {
    const f = runner({ data: {} });
    for (const host of ['--hostname=evil', 'github.com/evil', 'github.com\n--help']) assert.equal((await f.cli.getReviewThreads({ ...args, host, number: 7 })).ok, false);
    for (const threadId of ['', 'node?bad', 'node with spaces', 'a'.repeat(201)]) assert.equal((await f.cli.getReviewThread({ ...args, threadId })).ok, false);
    assert.equal((await f.cli.replyReviewThread({ ...args, threadId: 'THREAD_1', body: 'x'.repeat(5001) })).ok, false);
    assert.equal(f.calls.length, 0);
  });
  it('handles asynchronous EPIPE and already-aborted structured input without crashing', async () => {
    let killed = false;
    const input = new EventEmitter(); input.end = () => queueMicrotask(() => input.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' })));
    const out = await runCommand('gh', [], { input: '{}', execFileImpl: () => ({ stdin: input, kill: () => { killed = true; } }) });
    assert.equal(out.ok, false); assert.equal(killed, true);
    const abort = new AbortController(); abort.abort(); let called = false;
    assert.equal((await runCommand('gh', [], { input: '{}', signal: abort.signal, execFileImpl: () => { called = true; } })).aborted, true);
    assert.equal(called, false);
  });
});
