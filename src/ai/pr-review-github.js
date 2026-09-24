'use strict';

const { nodeId, validPath, MAX_REPLY } = require('./pr-review-state');
const PR_FIELDS = 'number state isCrossRepository headRefName headSha:headRefOid headRepository { nameWithOwner } repository { nameWithOwner }';
const THREAD_FIELDS = 'id path line startLine diffSide startDiffSide subjectType isResolved isOutdated viewerCanReply viewerCanResolve';
const LIST_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){${PR_FIELDS} reviewThreads(first:100,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{${THREAD_FIELDS} comments(first:1){totalCount}}}}}}`;
const THREAD_QUERY = `query($id:ID!){node(id:$id){... on PullRequestReviewThread{${THREAD_FIELDS} pullRequest{${PR_FIELDS}} comments(first:50){totalCount pageInfo{hasNextPage endCursor} nodes{id body state author{login} createdAt updatedAt}}}}}`;
const FILE_QUERY = 'query($owner:String!,$repo:String!,$expression:String!){repository(owner:$owner,name:$repo){object(expression:$expression){... on Blob{isBinary byteSize text}}}}';
const REPLY_MUTATION = 'mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}';
const RESOLVE_MUTATION = 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}';

function createReviewGithub(command, qualifiedRepo) {
  async function request(args, query, variables, mutation = false) {
    if (typeof args.host !== 'string' || args.host.length > 255 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i.test(args.host)
      || !/^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(args.owner) || !/^[a-z0-9_.-]{1,100}$/i.test(args.repo)
      || ['.', '..'].includes(args.repo) || !qualifiedRepo(args.host, args.owner, args.repo)) return { ok: false, code: 'PR_REVIEW_INVALID' };
    let response;
    try {
      response = await command('gh', ['api', '--hostname', args.host, 'graphql', '--input', '-'], {
        cwd: args.repoRoot, rawOutput: true, timeoutMs: 15000, signal: args.signal,
        input: JSON.stringify({ query, variables }),
      });
    } catch { return { ok: false, code: mutation ? 'PR_REVIEW_ACTION_UNCERTAIN' : 'PR_REVIEW_UNAVAILABLE' }; }
    if (!response?.ok) return { ok: false, code: mutation ? 'PR_REVIEW_ACTION_UNCERTAIN' : 'PR_REVIEW_UNAVAILABLE' };
    let parsed;
    try { parsed = JSON.parse(response.stdout); } catch { return { ok: false, code: mutation ? 'PR_REVIEW_ACTION_UNCERTAIN' : 'PR_REVIEW_INCOMPLETE' }; }
    if (!parsed?.data || (parsed.errors != null && (!Array.isArray(parsed.errors) || parsed.errors.length))) {
      return { ok: false, code: mutation ? 'PR_REVIEW_ACTION_UNCERTAIN' : 'PR_REVIEW_UNSUPPORTED' };
    }
    return { ok: true, data: parsed.data };
  }
  return {
    async getReviewThreads(args) {
      if (!Number.isSafeInteger(args.number) || args.number < 1 || args.number > 0x7fffffff
        || (args.after != null && (typeof args.after !== 'string' || args.after.length > 1000))) return { ok: false, code: 'PR_REVIEW_INVALID' };
      const out = await request(args, LIST_QUERY, { owner: args.owner, repo: args.repo, number: args.number, after: args.after || null });
      return out.ok ? { ok: true, pr: out.data.repository?.pullRequest } : out;
    },
    async getReviewThread(args) {
      if (!nodeId(args.threadId)) return { ok: false, code: 'PR_REVIEW_INVALID' };
      const out = await request(args, THREAD_QUERY, { id: args.threadId });
      return out.ok ? { ok: true, thread: out.data.node } : out;
    },
    async getReviewFile(args) {
      if (!/^[a-f0-9]{40}$/.test(args.headSha) || !validPath(args.path)) return { ok: false, code: 'PR_REVIEW_INVALID' };
      const out = await request(args, FILE_QUERY, { owner: args.owner, repo: args.repo, expression: `${args.headSha}:${args.path}` });
      if (!out.ok) return out;
      const blob = out.data.repository?.object;
      if (!blob || blob.isBinary !== false || !Number.isSafeInteger(blob.byteSize) || blob.byteSize < 0 || blob.byteSize > 128 * 1024 || typeof blob.text !== 'string'
        || Buffer.byteLength(blob.text, 'utf8') > 128 * 1024) return { ok: false, code: 'PR_REVIEW_LOCATION_UNAVAILABLE' };
      return { ok: true, lineCount: blob.text.length ? blob.text.split('\n').length - (blob.text.endsWith('\n') ? 1 : 0) : 0 };
    },
    async replyReviewThread(args) {
      if (!nodeId(args.threadId) || typeof args.body !== 'string' || !args.body.trim() || args.body.length > MAX_REPLY || args.body.includes('\0')) return { ok: false, code: 'PR_REVIEW_INVALID' };
      const out = await request(args, REPLY_MUTATION, { id: args.threadId, body: args.body }, true);
      const id = out.data?.addPullRequestReviewThreadReply?.comment?.id;
      return out.ok && nodeId(id) ? { ok: true, commentId: id } : { ok: false, code: out.code || 'PR_REVIEW_ACTION_UNCERTAIN' };
    },
    async resolveReviewThread(args) {
      if (!nodeId(args.threadId)) return { ok: false, code: 'PR_REVIEW_INVALID' };
      const out = await request(args, RESOLVE_MUTATION, { id: args.threadId }, true);
      const thread = out.data?.resolveReviewThread?.thread;
      return out.ok && thread?.id === args.threadId && thread.isResolved === true
        ? { ok: true } : { ok: false, code: out.code || 'PR_REVIEW_ACTION_UNCERTAIN' };
    },
  };
}
module.exports = { createReviewGithub, LIST_QUERY, THREAD_QUERY, FILE_QUERY, REPLY_MUTATION, RESOLVE_MUTATION };
