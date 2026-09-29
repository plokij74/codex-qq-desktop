'use strict';
const S = require('./pr-audit-state');

function createAuditGithub(command, qualifiedRepo) {
  function endpoint(args, suffix = '') {
    if (!qualifiedRepo(args.host, args.owner, args.repo) || !/^[a-z0-9][a-z0-9.-]*(?::\d{1,5})?$/i.test(args.host)
      || ![args.owner, args.repo].every((s) => /^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(s) && !['.', '..'].includes(s))) throw S.fail();
    return `repos/${args.owner}/${args.repo}${suffix}`;
  }
  async function request(args, route, { jq, body } = {}) {
    S.assertCurrent(args);
    const mutation = body != null;
    const argv = ['api', '--hostname', args.host, '--method', mutation ? 'POST' : 'GET', '--include', route,
      '-H', 'Accept: application/vnd.github+json'];
    if (jq) argv.push('--jq', jq);
    if (mutation) argv.push('--input', '-');
    let result;
    try { result = await command('gh', argv, { cwd: args.repoRoot, rawOutput: true, maxBytes: 2 * 1024 * 1024,
      timeoutMs: 15000, signal: args.signal, ...(mutation ? { input: JSON.stringify(body) } : {}) }); }
    catch { throw S.fail(mutation ? 'UNCERTAIN' : 'UNAVAILABLE'); }
    if (result.commandMissing) throw S.fail(mutation ? 'PUBLISH_FAILED' : 'UNAVAILABLE');
    let content = String(result.stdout || ''); let status = 0; let next = false;
    for (let i = 0; i < 5 && /^HTTP\//.test(content); i++) {
      const split = content.match(/\r?\n\r?\n/); if (!split) break;
      const header = content.slice(0, split.index); status = Number(header.match(/^HTTP\/[\d.]+\s+(\d{3})/)?.[1]);
      next = /^link:.*rel="next"/im.test(header); content = content.slice(split.index + split[0].length);
    }
    if (!result.ok || status < 200 || status >= 300 || result.truncated) {
      throw S.fail(mutation ? ([401, 403, 404, 422, 429].includes(status) ? 'PUBLISH_FAILED' : 'UNCERTAIN') : 'UNAVAILABLE');
    }
    try { return { value: JSON.parse(content), next }; }
    catch { throw S.fail(mutation ? 'UNCERTAIN' : 'INCOMPLETE'); }
  }
  const prRoute = (a, suffix = '') => { if (!S.number(a.number)) throw S.fail(); return endpoint(a, `/pulls/${a.number}${suffix}`); };
  async function pages(args, route, maxPages) {
    const rows = []; const ids = new Set();
    for (let page = 1; page <= maxPages; page++) {
      const result = await request(args, `${route}?per_page=100&page=${page}`);
      if (!Array.isArray(result.value) || result.value.length > 100) throw S.fail('INCOMPLETE');
      for (const row of result.value) { if (!S.remoteId(row.id) || ids.has(row.id)) throw S.fail('INCOMPLETE'); ids.add(row.id); rows.push(row); }
      if (!result.next) return rows;
      if (result.value.length !== 100) throw S.fail('INCOMPLETE');
    }
    throw S.fail('INCOMPLETE');
  }
  return {
    async getAuditPr(args) {
      return (await request(args, prRoute(args), { jq: '{number,state,merged,title,body,headSha:.head.sha,baseSha:.base.sha,headRefName:.head.ref,baseRefName:.base.ref,headRepo:.head.repo.full_name,baseRepo:.base.repo.full_name,changedFiles:.changed_files}' })).value;
    },
    async getAuditFiles(args) {
      const rows = []; const names = new Set();
      for (let page = 1; page <= 10; page++) {
        const result = await request(args, `${prRoute(args, '/files')}?per_page=100&page=${page}`,
          { jq: '[.[]|{filename,previous_filename,status,sha,additions,deletions,patch}]' });
        if (!Array.isArray(result.value) || result.value.length > 100) throw S.fail('INCOMPLETE');
        for (const row of result.value) { if (typeof row.filename !== 'string' || names.has(row.filename)) throw S.fail('INCOMPLETE'); names.add(row.filename); rows.push(row); }
        if (!result.next) return rows;
        if (result.value.length !== 100) throw S.fail('INCOMPLETE');
      }
      throw S.fail('LIMIT');
    },
    async getAuditMergeBase(args) {
      if (!/^[a-f0-9]{40}$/.test(args.baseSha) || !/^[a-f0-9]{40}$/.test(args.headSha)) throw S.fail();
      const result = await request(args, endpoint(args, `/compare/${args.baseSha}...${args.headSha}?per_page=1`), { jq: '.merge_base_commit.sha' });
      if (!/^[a-f0-9]{40}$/.test(result.value)) throw S.fail('INCOMPLETE'); return result.value;
    },
    async getAuditViewer(args) {
      endpoint(args); const result = await request(args, 'user', { jq: '{id,login}' });
      if (!S.remoteId(result.value?.id) || typeof result.value.login !== 'string') throw S.fail('UNAVAILABLE'); return result.value;
    },
    async createAuditReview(args) {
      const payload = args.payload;
      S.keys(payload, ['event', 'commit_id', 'body', 'comments']);
      if (payload.event !== 'COMMENT' || !/^[a-f0-9]{40}$/.test(payload.commit_id) || !Array.isArray(payload.comments)
        || payload.comments.length > S.LIMITS.findings || Buffer.byteLength(JSON.stringify(payload)) > S.LIMITS.report) throw S.fail();
      S.text(payload.body, S.LIMITS.body);
      for (const c of payload.comments) {
        S.keys(c, ['path', 'side', 'line', 'body', 'start_line', 'start_side']); S.text(c.body, S.LIMITS.body);
        if (!S.scopePath(c.path) || !['LEFT', 'RIGHT'].includes(c.side) || !S.number(c.line)
          || (c.start_line !== undefined && (!S.number(c.start_line) || c.start_line > c.line || c.line - c.start_line >= 20 || c.start_side !== c.side))
          || (c.start_side !== undefined && c.start_line === undefined)) throw S.fail();
      }
      return (await request(args, prRoute(args, '/reviews'), { body: payload })).value;
    },
    async getAuditReview(args) {
      if (!S.remoteId(args.reviewId)) throw S.fail(); return (await request(args, prRoute(args, `/reviews/${args.reviewId}`))).value;
    },
    listAuditReviews: (args) => pages(args, prRoute(args, '/reviews'), 5),
    async getAuditComments(args) {
      if (!S.remoteId(args.reviewId)) throw S.fail(); return pages(args, prRoute(args, `/reviews/${args.reviewId}/comments`), 1);
    },
  };
}
module.exports = { createAuditGithub };
