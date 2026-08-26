'use strict';

const fs = require('fs');

const MAX_MESSAGE_BYTES = 1024 * 1024;
const launchLog = process.argv[2];
let input = Buffer.alloc(0);
let initializeCapabilities = {};
let rootsChanged = 0;
let nextServerRequestId = 1000;
const pendingServerRequests = new Map();

if (launchLog) {
  fs.appendFileSync(launchLog, `${JSON.stringify({ pid: process.pid, cwd: process.cwd() })}\n`);
}

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function requestHost(method, params, probe, field) {
  const id = nextServerRequestId++;
  pendingServerRequests.set(id, { probe, field });
  send({ jsonrpc: '2.0', id, method, params });
}

function finishProbe(probe) {
  if (probe.roots === undefined || probe.sampling === undefined) return;
  result(probe.id, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        pid: process.pid,
        cwd: process.cwd(),
        initializeCapabilities,
        roots: probe.roots,
        sampling: probe.sampling,
        rootsChanged,
      }),
    }],
  });
}

function handleResponse(message) {
  const pending = pendingServerRequests.get(message.id);
  if (!pending) return;
  pendingServerRequests.delete(message.id);
  pending.probe[pending.field] = message.error ? { error: message.error } : message.result;
  finishProbe(pending.probe);
}

function handleRequest(message) {
  const method = String(message.method || '');
  if (method === 'initialize') {
    initializeCapabilities = message.params?.capabilities || {};
    result(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
        resources: {},
        prompts: { listChanged: true },
        sampling: {},
      },
      serverInfo: { name: 'd9-stdio-smoke', version: '1.0.0' },
    });
    return;
  }
  if (method === 'tools/list') {
    result(message.id, {
      tools: [
        { name: 'probe', description: 'Probe host callbacks', inputSchema: { type: 'object', properties: {} } },
        { name: 'crash', description: 'Exit before responding', inputSchema: { type: 'object', properties: {} } },
      ],
    });
    return;
  }
  if (method === 'tools/call') {
    if (message.params?.name === 'crash') {
      setTimeout(() => process.exit(23), 10);
      return;
    }
    const probe = { id: message.id, roots: undefined, sampling: undefined };
    requestHost('roots/list', {}, probe, 'roots');
    requestHost('sampling/createMessage', {
      messages: [{ role: 'user', content: { type: 'text', text: 'stdio smoke request' } }],
      maxTokens: 16,
      includeContext: 'none',
    }, probe, 'sampling');
    return;
  }
  if (method === 'resources/list') {
    result(message.id, { resources: [{ uri: 'smoke://resource', name: 'Smoke resource', mimeType: 'text/plain' }] });
    return;
  }
  if (method === 'resources/read') {
    result(message.id, { contents: [{ uri: message.params?.uri, text: 'stdio resource content' }] });
    return;
  }
  if (method === 'prompts/list') {
    result(message.id, { prompts: [{ name: 'smoke_prompt', description: 'Real stdio prompt' }] });
    return;
  }
  if (method === 'prompts/get') {
    result(message.id, {
      description: 'Real stdio prompt',
      messages: [{ role: 'user', content: { type: 'text', text: `prompt:${message.params?.arguments?.value || ''}` } }],
    });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
}

function handleMessage(message) {
  if (message && Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
    handleResponse(message);
    return;
  }
  if (message?.method === 'notifications/roots/list_changed') {
    rootsChanged += 1;
    return;
  }
  if (message?.method && Object.prototype.hasOwnProperty.call(message, 'id')) handleRequest(message);
}

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  if (input.length > MAX_MESSAGE_BYTES * 2) process.exit(2);
  while (true) {
    const separator = input.indexOf('\r\n\r\n');
    if (separator < 0) break;
    const header = input.slice(0, separator).toString('utf8');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) process.exit(3);
    const length = Number(match[1]);
    const bodyStart = separator + 4;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) process.exit(4);
    if (input.length < bodyStart + length) break;
    const body = input.slice(bodyStart, bodyStart + length).toString('utf8');
    input = input.slice(bodyStart + length);
    handleMessage(JSON.parse(body));
  }
});
