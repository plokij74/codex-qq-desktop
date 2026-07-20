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
});

describe('createMcpClient', () => {
  it('start initialize + listTools + callTool via mock spawn', async () => {
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
    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'ping');

    const result = await client.callTool('ping', {});
    assert.deepEqual(result, { content: [{ type: 'text', text: 'pong' }] });

    client.close();
  });
});
