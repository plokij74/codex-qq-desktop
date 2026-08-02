const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { fetchUrl, makeSafeLookup } = require('../src/ai/web-fetch');

function fakeRequest(routes) {
  const calls = [];
  const options = [];
  const fn = async (url, opts) => {
    calls.push(url);
    options.push(opts);
    const r = routes[url];
    if (!r) throw new Error(`ECONNREFUSED ${url}`);
    const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body ?? ''), 'utf8');
    const maxBytes = Number(opts?.maxBytes) || Infinity;
    return {
      status: r.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8', ...(r.headers || {}) },
      body: body.slice(0, maxBytes),
      truncated: body.length > maxBytes,
    };
  };
  fn.calls = calls;
  fn.options = options;
  return fn;
}

describe('fetchUrl', () => {
  it('fetches html, extracts markdown, and sends only public request headers', async () => {
    const requestFn = fakeRequest({
      'https://example.com/doc': { body: '<title>文档</title><main><h1>标题</h1><p>内容</p></main>' },
    });
    const r = await fetchUrl('https://example.com/doc', { requestFn });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.title, '文档');
    assert.match(r.text, /^# 标题$/m);
    assert.deepEqual(r.redirects, []);
    assert.equal(requestFn.options[0].headers['User-Agent'], 'codex-qq-desktop/D.3');
    assert.equal(requestFn.options[0].headers['Accept-Language'], 'zh-CN,zh;q=0.9,en;q=0.8');
    assert.equal(requestFn.options[0].headers.Cookie, undefined);
    assert.equal(requestFn.options[0].headers.Authorization, undefined);
  });

  it('rejects guarded urls before any request is made', async () => {
    const requestFn = fakeRequest({});
    const r = await fetchUrl('http://127.0.0.1/x', { requestFn });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PRIVATE_IP');
    assert.equal(requestFn.calls.length, 0);
  });

  it('follows redirects hop by hop and records them', async () => {
    const requestFn = fakeRequest({
      'https://a.com/1': { status: 301, headers: { location: '/2' }, body: '' },
      'https://a.com/2': { status: 302, headers: { location: 'https://b.com/3' }, body: '' },
      'https://b.com/3': { body: '<main>终点</main>' },
    });
    const r = await fetchUrl('https://a.com/1', { requestFn });
    assert.equal(r.ok, true);
    assert.equal(r.url, 'https://b.com/3');
    assert.equal(r.redirects.length, 2);
    assert.deepEqual(requestFn.calls, ['https://a.com/1', 'https://a.com/2', 'https://b.com/3']);
  });

  it('re-guards every hop: redirect into loopback is blocked', async () => {
    const requestFn = fakeRequest({
      'https://a.com/1': { status: 302, headers: { location: 'http://127.0.0.1/admin' }, body: '' },
    });
    const r = await fetchUrl('https://a.com/1', { requestFn });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PRIVATE_IP');
    assert.equal(requestFn.calls.length, 1);
  });

  it('re-guards every hop against domain lists', async () => {
    const requestFn = fakeRequest({
      'https://ok.com/1': { status: 302, headers: { location: 'https://evil.com/x' }, body: '' },
    });
    const r = await fetchUrl('https://ok.com/1', { requestFn, denyDomains: ['evil.com'] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DENIED');
  });

  it('stops after 5 redirects', async () => {
    const routes = {};
    for (let i = 0; i < 7; i += 1) {
      routes[`https://a.com/${i}`] = { status: 301, headers: { location: `/${i + 1}` }, body: '' };
    }
    const r = await fetchUrl('https://a.com/0', { requestFn: fakeRequest(routes) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'REDIRECT_LIMIT');
  });

  it('marks transport truncation', async () => {
    const requestFn = fakeRequest({
      'https://a.com/big': { headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(100000) },
    });
    const r = await fetchUrl('https://a.com/big', { requestFn, maxBytes: 40000 });
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.equal(r.bytes, 40000);
  });

  it('caps decompressed gzip output at maxBytes', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(1024 * 1024, 0x61));
    const requestFn = fakeRequest({
      'https://a.com/gz': {
        headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
        body: bomb,
      },
    });
    const r = await fetchUrl('https://a.com/gz', { requestFn, maxBytes: 65536 });
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.ok(Buffer.byteLength(r.text, 'utf8') <= 65536);
  });

  it('pretty-prints json and passes through text content', async () => {
    const requestFn = fakeRequest({
      'https://a.com/j': { headers: { 'content-type': 'application/json' }, body: '{"a":1,"b":[2]}' },
      'https://a.com/t': { headers: { 'content-type': 'text/plain' }, body: '纯文本' },
    });
    const j = await fetchUrl('https://a.com/j', { requestFn });
    assert.match(j.text, /"a": 1/);
    const t = await fetchUrl('https://a.com/t', { requestFn });
    assert.equal(t.text, '纯文本');
  });

  it('rejects binary content types', async () => {
    const requestFn = fakeRequest({
      'https://a.com/img': { headers: { 'content-type': 'image/png' }, body: Buffer.from([1, 2, 3]) },
    });
    const r = await fetchUrl('https://a.com/img', { requestFn });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONTENT_TYPE');
  });

  it('decodes gbk when charset says so', async () => {
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    const requestFn = fakeRequest({
      'https://a.com/g': { headers: { 'content-type': 'text/plain; charset=gbk' }, body: gbk },
    });
    const r = await fetchUrl('https://a.com/g', { requestFn });
    assert.equal(r.text, '你好');
  });

  it('reports http errors as ok:false with HTTP_<status>', async () => {
    const requestFn = fakeRequest({ 'https://a.com/404': { status: 404, body: 'nope' } });
    const r = await fetchUrl('https://a.com/404', { requestFn });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'HTTP_404');
  });

  it('applies maxChars to extracted text', async () => {
    const requestFn = fakeRequest({
      'https://a.com/long': { body: `<main><p>${'字'.repeat(5000)}</p></main>` },
    });
    const r = await fetchUrl('https://a.com/long', { requestFn, maxChars: 1000 });
    assert.equal(r.truncated, true);
    assert.ok(r.text.length <= 1000);
  });

  it('turns request failures into NETWORK errors, not throws', async () => {
    const r = await fetchUrl('https://nowhere.com/x', { requestFn: fakeRequest({}) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NETWORK');
    assert.match(r.error, /[一-龥]/);
  });

  it('enforces an overall timeout and aborts the transport', async () => {
    let transportAborted = false;
    const requestFn = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        transportAborted = true;
        reject(new Error('aborted'));
      }, { once: true });
    });
    const r = await fetchUrl('https://slow.example.com/', { requestFn, timeoutMs: 20 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TIMEOUT');
    assert.equal(transportAborted, true);
  });

  it('propagates caller abort with ABORTED instead of converting it', async () => {
    const controller = new AbortController();
    const requestFn = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const pending = fetchUrl('https://slow.example.com/', {
      requestFn, timeoutMs: 1000, signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, (err) => err?.code === 'ABORTED');
  });

  it('enforces one overall timeout across redirect hops', async () => {
    let transportAborted = false;
    const requestFn = async (url, { signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 15);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          transportAborted = true;
          reject(new Error('aborted'));
        }, { once: true });
      });
      if (url.endsWith('/1')) {
        return {
          status: 302,
          headers: { location: '/2', 'content-type': 'text/plain' },
          body: Buffer.alloc(0),
          truncated: false,
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('late'),
        truncated: false,
      };
    };
    const r = await fetchUrl('https://a.com/1', { requestFn, timeoutMs: 20 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TIMEOUT');
    assert.equal(transportAborted, true);
  });

  it('rejects promptly when the caller aborts an uncooperative transport', async () => {
    const controller = new AbortController();
    const pending = fetchUrl('https://slow.example.com/', {
      requestFn: () => new Promise(() => {}),
      timeoutMs: 1000,
      signal: controller.signal,
    });
    const started = Date.now();
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, (err) => err?.code === 'ABORTED');
    assert.ok(Date.now() - started < 200, 'caller abort should not wait for timeout');
  });

  it('returns a structured error for malformed compressed content', async () => {
    const requestFn = fakeRequest({
      'https://a.com/bad-gzip': {
        headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
        body: Buffer.from('not gzip'),
      },
    });
    const r = await fetchUrl('https://a.com/bad-gzip', { requestFn });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DECOMPRESSION');
  });

  it('rejects responses with no content type', async () => {
    const requestFn = fakeRequest({
      'https://a.com/no-type': {
        headers: { 'content-type': '' },
        body: Buffer.from([0, 1, 2]),
      },
    });
    const r = await fetchUrl('https://a.com/no-type', { requestFn });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONTENT_TYPE');
  });
});

describe('makeSafeLookup', () => {
  const fakeDns = (answers) => (hostname, opts, cb) => {
    assert.equal(opts.all, true);
    const answer = answers[hostname];
    if (!answer) return cb(new Error(`ENOTFOUND ${hostname}`));
    return cb(null, answer.map(([address, family]) => ({ address, family })));
  };

  it('passes public addresses through', (t, done) => {
    const lookup = makeSafeLookup(fakeDns({ 'ok.com': [['93.184.216.34', 4]] }));
    lookup('ok.com', { all: false }, (err, address, family) => {
      assert.equal(err, null);
      assert.equal(address, '93.184.216.34');
      assert.equal(family, 4);
      done();
    });
  });

  it('preserves the all:true callback shape', (t, done) => {
    const lookup = makeSafeLookup(fakeDns({
      'ok.com': [['93.184.216.34', 4], ['2001:db8::1', 6]],
    }));
    lookup('ok.com', { all: true }, (err, addresses) => {
      assert.equal(err, null);
      assert.deepEqual(addresses, [
        { address: '93.184.216.34', family: 4 },
        { address: '2001:db8::1', family: 6 },
      ]);
      done();
    });
  });

  it('errors when any resolved address is blocked', (t, done) => {
    const lookup = makeSafeLookup(fakeDns({
      'evil.com': [['93.184.216.34', 4], ['127.0.0.1', 4]],
    }));
    lookup('evil.com', { all: false }, (err) => {
      assert.ok(err);
      assert.match(err.message, /内网|保留/);
      done();
    });
  });

  it('errors on blocked IPv6 answers', (t, done) => {
    const lookup = makeSafeLookup(fakeDns({ 'v6.com': [['fc00::1', 6]] }));
    lookup('v6.com', { all: false }, (err) => {
      assert.ok(err);
      done();
    });
  });
});
