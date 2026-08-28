'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');
const {
  encodeFrame,
  createFrameReader,
  createMcpClient,
} = require('../src/ai/mcp-client');

describe('mcp frames', () => {
  it('encodeFrame roundtrips via reader', () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
    const frame = encodeFrame(body);
    const reader = createFrameReader();
    const msgs = reader.push(frame);
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], body);
  });

  it('reader handles split chunks', () => {
    const body = { jsonrpc: '2.0', id: 2, result: { ok: true } };
    const frame = encodeFrame(body);
    const mid = Math.floor(frame.length / 2);
    const reader = createFrameReader();
    assert.deepEqual(reader.push(frame.slice(0, mid)), []);
    const msgs = reader.push(frame.slice(mid));
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], body);
  });

  it('encodes and reads newline JSON framing', () => {
    const body = { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} };
    const reader = createFrameReader();
    const frame = require('../src/ai/mcp-client').encodeNewlineFrame(body);
    assert.deepEqual(reader.push(frame.slice(0, 8)), []);
    assert.deepEqual(reader.push(frame.slice(8)), [body]);
    assert.equal(reader.getMode(), 'newline');
  });
});

describe('createMcpClient', () => {
  it('start initialize + listTools + callTool + listResources + readResource via mock spawn', async () => {
    const child = new EventEmitter();
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const inbound = createFrameReader();

    child.stdin = new Writable({
      write(chunk, _enc, cb) {
        const msgs = inbound.push(chunk);
        for (const msg of msgs) {
          if (msg.method === 'initialize') {
            stdout.push(
              encodeFrame({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  protocolVersion: '2024-11-05',
                  capabilities: {},
                  serverInfo: { name: 'mock', version: '0.0.1' },
                },
              })
            );
          } else if (msg.method === 'tools/list') {
            stdout.push(
              encodeFrame({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  tools: [
                    {
                      name: 'ping',
                      description: 'Ping',
                      inputSchema: { type: 'object', properties: {} },
                    },
                  ],
                },
              })
            );
          } else if (msg.method === 'tools/call') {
            stdout.push(
              encodeFrame({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  content: [{ type: 'text', text: 'pong' }],
                },
              })
            );
          } else if (msg.method === 'resources/list') {
            stdout.push(
              encodeFrame({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  resources: [{ uri: 'file://a', name: 'a' }],
                },
              })
            );
          } else if (msg.method === 'resources/read') {
            stdout.push(
              encodeFrame({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  contents: [{ text: 'hi' }],
                },
              })
            );
          }
        }
        cb();
      },
    });
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {
      child.emit('exit', 0, null);
    };

    let spawnOpts;
    const client = createMcpClient({
      command: 'mock-mcp',
      args: [],
      spawnFn: (_cmd, _args, opts) => {
        spawnOpts = opts;
        return child;
      },
    });

    await client.start();
    assert.equal(spawnOpts.shell, false);
    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'ping');

    const result = await client.callTool('ping', {});
    assert.deepEqual(result, { content: [{ type: 'text', text: 'pong' }] });

    const resources = await client.listResources();
    assert.equal(resources.length, 1);
    assert.equal(resources[0].uri, 'file://a');
    assert.equal(resources[0].name, 'a');

    const resource = await client.readResource('file://a');
    assert.deepEqual(resource, { contents: [{ text: 'hi' }] });

    client.close();
  });

  it('listResources returns [] when resources/list fails', async () => {
    const child = new EventEmitter();
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const inbound = createFrameReader();

    child.stdin = new Writable({
      write(chunk, _enc, cb) {
        const msgs = inbound.push(chunk);
        for (const msg of msgs) {
          if (msg.method === 'initialize') {
            stdout.push(
              encodeFrame({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  protocolVersion: '2024-11-05',
                  capabilities: {},
                  serverInfo: { name: 'mock', version: '0.0.1' },
                },
              })
            );
          } else if (msg.method === 'resources/list') {
            stdout.push(
              encodeFrame({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32601, message: 'Method not found' },
              })
            );
          }
        }
        cb();
      },
    });
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {
      child.emit('exit', 0, null);
    };

    const client = createMcpClient({
      command: 'mock-mcp',
      args: [],
      spawnFn: () => child,
    });

    await client.start();
    const resources = await client.listResources();
    assert.deepEqual(resources, []);
    client.close();
  });

  it('falls back once from newline framing to a legacy Content-Length server', { timeout: 5000 }, async () => {
    const child = new EventEmitter();
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    let content = Buffer.alloc(0);
    let ignoredNewlineProbe = false;
    let initializeCount = 0;
    const sendLegacyResponse = (message) => {
      const response = message.method === 'initialize'
        ? {
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'legacy' } },
        }
        : { jsonrpc: '2.0', id: message.id, result: { tools: [] } };
      const body = Buffer.from(JSON.stringify(response), 'utf8');
      stdout.push(Buffer.from(`Content-Length: ${body.length}\r\n\r\n`));
      stdout.push(body);
    };
    child.stdin = new Writable({
      write(chunk, _enc, cb) {
        content = Buffer.concat([content, chunk]);
        if (content[0] === 123 && content.includes(10)) {
          ignoredNewlineProbe = true;
          content = Buffer.alloc(0);
          cb();
          return;
        }
        const separator = content.indexOf(Buffer.from('\r\n\r\n'));
        if (separator >= 0) {
          const match = /Content-Length:\s*(\d+)/i.exec(content.slice(0, separator).toString('utf8'));
          const length = Number(match?.[1]);
          const start = separator + 4;
          if (Number.isSafeInteger(length) && content.length >= start + length) {
            const message = JSON.parse(content.slice(start, start + length).toString('utf8'));
            content = content.slice(start + length);
            if (message.method === 'initialize') initializeCount += 1;
            sendLegacyResponse(message);
          }
        }
        cb();
      },
    });
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => child.emit('exit', 0, null);

    const client = createMcpClient({ command: 'legacy-mcp', spawnFn: () => child });
    await client.start();
    assert.equal(ignoredNewlineProbe, true);
    assert.equal(initializeCount, 1);
    assert.equal(client.getProtocolVersion(), '2024-11-05');
    await client.close();
  });
});
