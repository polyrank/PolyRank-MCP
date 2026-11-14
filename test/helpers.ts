/** Shared spec helpers: a fake upstream API and a JSON-RPC client that reads either JSON or SSE answers. */
import type { AddressInfo } from 'node:net';
import { createHttpServer, type HttpConfig, type LogRecord } from '../src/http.js';

export const API = 'http://api.test';
export const AGENT = 'http://agent.test';
export const VALID_KEY = 'pk_live_ABCDEFGHIJKLMNOPQRSTUV';
export const VALID_KEY_2 = 'pk_test_ZYXWVUTSRQPONMLKJIHGFE';
export const REVOKED_KEY = 'pk_live_REVOKEDREVOKEDREVOKEDX';

export interface UpstreamCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A fetch that plays the Polyrank API: knows VALID_KEY(_2), refuses REVOKED_KEY with the API's 401 body. */
export function fakeUpstream(opts: { down?: boolean } = {}) {
  const calls: UpstreamCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    });
    if (opts.down) throw new TypeError('fetch failed');
    const auth = headers['authorization'];
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (auth !== undefined && auth !== `Bearer ${VALID_KEY}` && auth !== `Bearer ${VALID_KEY_2}`)
      return json(401, { error: 'invalid_api_key', trace_id: 't' });
    if (url.startsWith(`${API}/v1/stats/overview`))
      return json(200, { wallets: 3, trades: 4, markets: 5, metrics: 84, since_year: 2022 });
    if (url.startsWith(`${API}/v1/rankings/custom`)) return json(200, { rows: [], total: 0 });
    if (url.startsWith(`${API}/v1/public/leaderboard`)) return json(200, { rows: [] });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  return { calls, impl };
}

export const baseConfig = (over: Partial<HttpConfig> = {}): HttpConfig => ({
  host: '127.0.0.1',
  port: 0,
  apiBase: API,
  agentBase: AGENT,
  allowedHosts: ['mcp.polyrank.app', 'localhost', '127.0.0.1', '[::1]'],
  allowedOrigins: [],
  verifyKeys: true,
  anonPerMin: 1000,
  keyPerMin: 1000,
  forwardClientIp: false,
  maxBodyBytes: 1024 * 1024,
  oauth: {
    enabled: false,
    issuer: 'https://api.polyrank.app',
    publicUrl: 'https://mcp.polyrank.app',
    requireOnConnect: false,
  },
  ...over,
});

export async function startServer(cfg: HttpConfig, upstream = fakeUpstream()) {
  const logs: LogRecord[] = [];
  const srv = createHttpServer(cfg, { fetch: upstream.impl, log: (r) => logs.push(r) });
  await new Promise<void>((r) => srv.server.listen(0, '127.0.0.1', () => r()));
  const port = (srv.server.address() as AddressInfo).port;
  return { ...srv, upstream, logs, base: `http://127.0.0.1:${port}` };
}

export const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'spec', version: '0' },
  },
};

/** POST one JSON-RPC message the way a 2025-era client does; returns status, headers and the parsed answer. */
export async function rpc(
  url: string,
  message: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; body: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...headers,
    },
    body: typeof message === 'string' ? message : JSON.stringify(message),
  });
  const text = await res.text();
  let body: any = null;
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6));
    body = data.length ? JSON.parse(data[data.length - 1]!) : null;
  } else if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, headers: res.headers, body };
}

export const listTools = async (url: string, headers: Record<string, string> = {}) =>
  (await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers)).body?.result
    ?.tools as Array<{
    name: string;
    title?: string;
    description?: string;
    annotations?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }>;

export const callTool = async (
  url: string,
  name: string,
  args: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) =>
  rpc(
    url,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } },
    headers,
  );
