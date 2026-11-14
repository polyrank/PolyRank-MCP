/**
 * WP9 — stdio, what ships on npm, still behaves as before after the move to SDK v2: the process starts on stdio when
 * MCP_HTTP_ENABLED is unset, answers a 2025-era `initialize`, lists the same 36 tools in the same order as HTTP, and
 * its "needs a key" answer names POLYRANK_API_KEY (the stdio way to pass a key), not a header.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baseConfig, listTools, startServer } from './helpers.js';

const APP = resolve(__dirname, '..');
const TSX = resolve(APP, 'node_modules/.bin/tsx');

let child: ChildProcessWithoutNullStreams | undefined;
afterEach(() => {
  child?.kill();
  child = undefined;
});

function startStdio(env: Record<string, string> = {}) {
  const { MCP_HTTP_ENABLED: _off, POLYRANK_API_KEY: _key, ...rest } = process.env;
  child = spawn(TSX, ['src/index.ts'], {
    cwd: APP,
    // An unroutable API base: the spec calls only tools that answer without the network.
    env: { ...rest, POLYRANK_API_BASE: 'http://127.0.0.1:9', ...env },
  });
  const p = child;
  let buf = '';
  let stderr = '';
  const waiting = new Map<number, (m: any) => void>();
  p.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (typeof m.id === 'number') waiting.get(m.id)?.(m);
    }
  });
  p.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const send = (m: object) => p.stdin.write(`${JSON.stringify(m)}\n`);
  const request = (id: number, method: string, params?: object) =>
    new Promise<any>((res) => {
      waiting.set(id, res);
      send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    });
  return { send, request, stderr: () => stderr };
}

describe('stdio transport (npx -y @polyrank/mcp)', () => {
  it('answers initialize and lists the 36 tools in the same order as the HTTP server', async () => {
    const s = startStdio();
    const init = await s.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'spec', version: '0' },
    });
    expect(init.result.serverInfo).toEqual({ name: 'polyrank', version: '0.5.1' });
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await s.request(2, 'tools/list');
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toHaveLength(36);

    const http = await startServer(baseConfig());
    try {
      const httpTools = await listTools(`${http.base}/mcp`);
      expect(names).toEqual(httpTools.map((t) => t.name));
      expect(list.result.tools.map((t: { annotations: unknown }) => t.annotations)).toEqual(
        httpTools.map((t) => t.annotations),
      );
    } finally {
      await http.close();
    }
    expect(s.stderr()).toMatch(/Polyrank MCP server 0\.5\.1 running \(stdio\)/);
  });

  it('a keyed tool without POLYRANK_API_KEY says to set POLYRANK_API_KEY', async () => {
    const s = startStdio();
    await s.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'spec', version: '0' },
    });
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const r = await s.request(2, 'tools/call', {
      name: 'polyrank_list_lab_templates',
      arguments: {},
    });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(
      /set POLYRANK_API_KEY in this MCP server's environment/,
    );
  });
});
