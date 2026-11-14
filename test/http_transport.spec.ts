/**
 * WP9 — the hosted transport (Streamable HTTP, MCP_HTTP_ENABLED=1): auth refused and accepted, the anonymous tool
 * list, annotations on every tool, health, the host/origin guards, the limits, and logs that never carry a key.
 * The upstream API is a fake (helpers.ts): nothing here reaches the network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { clientAddress, httpConfigFromEnv, MinuteLimiter } from '../src/http.js';
import {
  API,
  INIT,
  REVOKED_KEY,
  VALID_KEY,
  VALID_KEY_2,
  baseConfig,
  callTool,
  fakeUpstream,
  listTools,
  rpc,
  startServer,
} from './helpers.js';

const WRITES = [
  'polyrank_create_strategy',
  'polyrank_run_backtest',
  'polyrank_start_paper',
  'polyrank_update_strategy',
  'polyrank_lab_ask',
  'polyrank_lab_reply',
  'polyrank_lab_stop',
];
/** the writes that change nothing more when repeated: one paper run per strategy (409), the same edit, the same stop */
const IDEMPOTENT_WRITES = ['polyrank_start_paper', 'polyrank_update_strategy', 'polyrank_lab_stop'];

let running: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(running.map((s) => s.close()));
  running = [];
  delete process.env['POLYRANK_API_KEY'];
});
const start = async (...a: Parameters<typeof startServer>) => {
  const s = await startServer(...a);
  running.push(s);
  return s;
};

describe('health', () => {
  it('answers 200 with the version and tool counts, without auth and without an upstream call', async () => {
    const s = await start(baseConfig());
    const res = await fetch(`${s.base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      service: 'polyrank-mcp',
      version: '0.5.1',
      transport: 'streamable-http',
      endpoints: { '/mcp': 36, '/mcp/public': 17 },
    });
    expect(s.upstream.calls).toEqual([]);
    expect(s.logs).toEqual([]); // the 10-s healthcheck is not logged
  });
});

describe('initialize and tools/list without a key', () => {
  it('initialize answers with the server identity (2025-era handshake)', async () => {
    const s = await start(baseConfig());
    const r = await rpc(`${s.base}/mcp`, INIT);
    expect(r.status).toBe(200);
    expect(r.body.result.serverInfo).toEqual({ name: 'polyrank', version: '0.5.1' });
    expect(r.body.result.capabilities.tools).toBeDefined();
  });

  it('/mcp lists the 36 tools: 29 read-only first, the 7 writes last', async () => {
    const s = await start(baseConfig());
    const tools = await listTools(`${s.base}/mcp`);
    expect(tools).toHaveLength(36);
    expect(tools.slice(29).map((t) => t.name)).toEqual(WRITES);
    expect(tools.slice(0, 29).every((t) => t.annotations?.['readOnlyHint'] === true)).toBe(true);
    expect(s.upstream.calls).toEqual([]);
  });

  it('every tool carries a title and all four hints; writes are non-destructive', async () => {
    const s = await start(baseConfig());
    for (const t of await listTools(`${s.base}/mcp`)) {
      expect(t.title, t.name).toMatch(/\S/);
      expect(t.name.length, t.name).toBeLessThanOrEqual(64);
      for (const h of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'])
        expect(typeof t.annotations?.[h], `${t.name}.${h}`).toBe('boolean');
      const write = WRITES.includes(t.name);
      expect(t.annotations?.['readOnlyHint'], t.name).toBe(!write);
      expect(t.annotations?.['destructiveHint'], t.name).toBe(false);
      expect(t.annotations?.['openWorldHint'], t.name).toBe(false);
      // A read repeats with no further effect; start_paper refuses a second run (409), an edit or a stop repeated
      // changes nothing more; the other writes create anew.
      expect(t.annotations?.['idempotentHint'], t.name).toBe(
        !write || IDEMPOTENT_WRITES.includes(t.name),
      );
    }
  });

  it('every tool repeats its title in annotations.title, on both tool lists (2026-11-14)', async () => {
    // Claude's connector directory read the hosted server's 36 tools and flagged each one "Missing title annotation.
    // Add annotations.title": a client may read the display name from either place, so both carry the same words.
    const s = await start(baseConfig());
    for (const path of ['/mcp', '/mcp/public']) {
      const tools = await listTools(`${s.base}${path}`);
      expect(tools.length, path).toBe(path === '/mcp' ? 36 : 17);
      for (const t of tools) {
        expect(t.annotations?.['title'], `${path} ${t.name}`).toBe(t.title);
        expect(String(t.annotations?.['title']), `${path} ${t.name}`).toMatch(/^Polyrank /);
      }
    }
  });

  it('each tool names its access tier: 17 free, 3 need a key, 16 need the Lab', async () => {
    const s = await start(baseConfig());
    const tiers = (await listTools(`${s.base}/mcp`)).map((t) => t._meta?.['app.polyrank/access']);
    expect(tiers.filter((x) => x === 'free')).toHaveLength(17);
    expect(tiers.filter((x) => x === 'api_key')).toHaveLength(3);
    expect(tiers.filter((x) => x === 'lab')).toHaveLength(16);
    expect(tiers.slice(0, 17).every((x) => x === 'free')).toBe(true);
  });

  it('/mcp/public lists only the 17 free read-only tools', async () => {
    const s = await start(baseConfig());
    const tools = await listTools(`${s.base}/mcp/public`);
    expect(tools).toHaveLength(17);
    expect(tools.every((t) => t._meta?.['app.polyrank/access'] === 'free')).toBe(true);
    expect(tools.every((t) => t.annotations?.['readOnlyHint'] === true)).toBe(true);
    const all = (await listTools(`${s.base}/mcp`)).slice(0, 17).map((t) => t.name);
    expect(tools.map((t) => t.name)).toEqual(all);
  });

  it('a free tool works anonymously; a keyed tool answers how to send a key, without calling the API', async () => {
    const s = await start(baseConfig());
    const free = await callTool(`${s.base}/mcp`, 'polyrank_get_platform_stats');
    expect(free.body.result.isError).toBeUndefined();
    expect(free.body.result.structuredContent.metrics).toBe(84);
    expect(s.upstream.calls.map((c) => c.url)).toEqual([`${API}/v1/stats/overview`]);
    expect(s.upstream.calls[0]!.headers['authorization']).toBeUndefined();

    const keyed = await callTool(`${s.base}/mcp`, 'polyrank_rank_wallets', {
      weights: { brier: 1 },
    });
    expect(keyed.body.result.isError).toBe(true);
    expect(keyed.body.result.content[0].text).toMatch(/Authorization: Bearer pk_live_…/);
    expect(keyed.body.result.content[0].text).not.toMatch(/POLYRANK_API_KEY/);
    expect(s.upstream.calls).toHaveLength(1);
  });

  it("the process env POLYRANK_API_KEY is never used for a caller (it would hand one account's key to everyone)", async () => {
    process.env['POLYRANK_API_KEY'] = VALID_KEY;
    const s = await start(baseConfig());
    await callTool(`${s.base}/mcp`, 'polyrank_get_leaderboard');
    expect(s.upstream.calls).toHaveLength(1);
    expect(s.upstream.calls[0]!.headers['authorization']).toBeUndefined();
    const keyed = await callTool(`${s.base}/mcp`, 'polyrank_get_trader_metrics', {
      address: '0x' + 'a'.repeat(40),
    });
    expect(keyed.body.result.isError).toBe(true);
  });
});

describe('auth', () => {
  it('accepts a key: checks it once with the API, then sends it on every keyed call', async () => {
    const s = await start(baseConfig());
    const auth = { authorization: `Bearer ${VALID_KEY}` };
    expect(await listTools(`${s.base}/mcp`, auth)).toHaveLength(36);
    const r = await callTool(
      `${s.base}/mcp`,
      'polyrank_rank_wallets',
      { weights: { brier: 1 } },
      auth,
    );
    expect(r.body.result.isError).toBeUndefined();
    const checks = s.upstream.calls.filter((c) => c.url === `${API}/v1/stats/overview`);
    expect(checks).toHaveLength(1); // cached for the second request
    const ranked = s.upstream.calls.find((c) => c.url === `${API}/v1/rankings/custom`)!;
    expect(ranked.method).toBe('POST');
    expect(ranked.headers['authorization']).toBe(`Bearer ${VALID_KEY}`);
    expect(ranked.body).toEqual({ weights: { brier: { weight: 1, window: 'lifetime' } } });
  });

  it('pk_test_ keys are accepted like pk_live_ (the API takes both)', async () => {
    const s = await start(baseConfig());
    const r = await rpc(`${s.base}/mcp`, INIT, { authorization: `Bearer ${VALID_KEY_2}` });
    expect(r.status).toBe(200);
  });

  it('refuses a key the API does not accept: 401 with a Bearer challenge, no tools', async () => {
    const s = await start(baseConfig());
    const r = await rpc(`${s.base}/mcp`, INIT, { authorization: `Bearer ${REVOKED_KEY}` });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(
      /^Bearer realm="polyrank", error="invalid_token"/,
    );
    expect(r.body.error).toBe('invalid_api_key');
  });

  it.each([['Bearer nope'], ['Basic dXNlcjpwYXNz'], [`Bearer ${VALID_KEY} extra`], ['pk_live_x']])(
    'refuses a malformed Authorization header (%s) with 401 and no upstream call',
    async (header) => {
      const s = await start(baseConfig());
      const r = await rpc(`${s.base}/mcp`, INIT, { authorization: header });
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toMatch(/error="invalid_token"/);
      expect(s.upstream.calls).toEqual([]);
    },
  );

  it('fails open when the API cannot be reached for the check (the API re-checks every call anyway)', async () => {
    const s = await start(baseConfig(), fakeUpstream({ down: true }));
    const r = await rpc(`${s.base}/mcp`, INIT, { authorization: `Bearer ${VALID_KEY}` });
    expect(r.status).toBe(200);
    expect(s.logs.at(-1)?.['key_check']).toBe('unknown');
  });

  it('MCP_HTTP_VERIFY_KEYS=0 skips the check', async () => {
    const s = await start(baseConfig({ verifyKeys: false }));
    expect(
      (await rpc(`${s.base}/mcp`, INIT, { authorization: `Bearer ${REVOKED_KEY}` })).status,
    ).toBe(200);
    expect(s.upstream.calls).toEqual([]);
  });

  it('/mcp/public ignores an Authorization header and never forwards it', async () => {
    const s = await start(baseConfig());
    const r = await callTool(
      `${s.base}/mcp/public`,
      'polyrank_get_leaderboard',
      {},
      {
        authorization: 'Bearer garbage',
      },
    );
    expect(r.status).toBe(200);
    expect(s.upstream.calls).toHaveLength(1);
    expect(s.upstream.calls[0]!.headers['authorization']).toBeUndefined();
  });

  it('a modern (2026-07-28) client with a key lists the same 36 tools', async () => {
    const s = await start(baseConfig());
    const client = new Client({ name: 'spec-modern', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${VALID_KEY}` } },
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(36);
    expect(tools.slice(29).map((t) => t.name)).toEqual(WRITES);
    expect(tools.every((t) => typeof t.annotations?.readOnlyHint === 'boolean' && t.title)).toBe(
      true,
    );
    await client.close();
  });
});

describe('guards', () => {
  it('refuses a Host that is not allowed (DNS rebinding) with 403', async () => {
    const s = await start(baseConfig({ allowedHosts: ['mcp.polyrank.app'] }));
    const r = await rpc(`${s.base}/mcp`, INIT); // Host: 127.0.0.1:<port>
    expect(r.status).toBe(403);
    expect(s.logs.at(-1)?.['refused']).toBe('host');
  });

  it('refuses any Origin by default; serves an allow-listed one with CORS', async () => {
    const s1 = await start(baseConfig());
    expect((await rpc(`${s1.base}/mcp`, INIT, { origin: 'https://evil.example' })).status).toBe(
      403,
    );
    const s2 = await start(baseConfig({ allowedOrigins: ['inspector.example'] }));
    const ok = await rpc(`${s2.base}/mcp`, INIT, { origin: 'https://inspector.example' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://inspector.example');
    expect((await rpc(`${s2.base}/mcp`, INIT, { origin: 'https://evil.example' })).status).toBe(
      403,
    );
  });

  it('GET and DELETE answer 405 (stateless: no session stream); unknown paths 404', async () => {
    const s = await start(baseConfig());
    expect(
      (await fetch(`${s.base}/mcp`, { headers: { accept: 'text/event-stream' } })).status,
    ).toBe(405);
    expect((await fetch(`${s.base}/mcp`, { method: 'DELETE' })).status).toBe(405);
    // The root answers a 200 pointer (readiness scanners stop at a 404 root); unknown paths still 404.
    const root = await fetch(`${s.base}/`);
    expect(root.status).toBe(200);
    const rootBody = (await root.json()) as { endpoints: Record<string, string>; discovery: { server_card: string } };
    expect(Object.keys(rootBody.endpoints)).toEqual(['/mcp', '/mcp/public']);
    expect(rootBody.discovery.server_card).toBe('/.well-known/mcp.json');
    expect((await fetch(`${s.base}/`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${s.base}/sse`)).status).toBe(404);
  });

  it('a body over the cap is 413, a body that is not JSON a -32700 parse error', async () => {
    const s = await start(baseConfig({ maxBodyBytes: 512 }));
    const big = await rpc(`${s.base}/mcp`, JSON.stringify({ pad: 'x'.repeat(2000) }));
    expect(big.status).toBe(413);
    const bad = await rpc(`${s.base}/mcp`, '{not json');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe(-32700);
  });
});

describe('limits', () => {
  it('anonymous callers: per address, 429 with Retry-After and a JSON-RPC error past the limit', async () => {
    const s = await start(baseConfig({ anonPerMin: 2 }));
    expect((await rpc(`${s.base}/mcp`, INIT)).status).toBe(200);
    expect((await rpc(`${s.base}/mcp`, INIT)).status).toBe(200);
    const r = await rpc(`${s.base}/mcp`, INIT);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(r.body.error.code).toBe(-32000);
    // A key holder from the same address is a different window.
    expect(
      (await rpc(`${s.base}/mcp`, INIT, { authorization: `Bearer ${VALID_KEY}` })).status,
    ).toBe(200);
  });

  it('per key: one key past its window is refused, another key is not', async () => {
    const s = await start(baseConfig({ keyPerMin: 2 }));
    const k1 = { authorization: `Bearer ${VALID_KEY}` };
    expect((await rpc(`${s.base}/mcp`, INIT, k1)).status).toBe(200);
    expect((await rpc(`${s.base}/mcp`, INIT, k1)).status).toBe(200);
    expect((await rpc(`${s.base}/mcp`, INIT, k1)).status).toBe(429);
  });

  it('rotating made-up keys is held per address BEFORE any key check reaches the API', async () => {
    const s = await start(baseConfig({ keyPerMin: 3 }));
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const fake = `pk_live_${String.fromCharCode(65 + i).repeat(22)}`;
      statuses.push((await rpc(`${s.base}/mcp`, INIT, { authorization: `Bearer ${fake}` })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429, 429]);
    expect(s.upstream.calls).toHaveLength(3);
  });

  it('MinuteLimiter resets at the minute and stays bounded', () => {
    const l = new MinuteLimiter(4);
    expect(l.hit('a', 1, 60_000).ok).toBe(true);
    expect(l.hit('a', 1, 60_500).ok).toBe(false);
    expect(l.hit('a', 1, 120_000).ok).toBe(true);
    for (let i = 0; i < 20; i++) l.hit(`k${i}`, 1, 120_001);
    expect(l.size).toBeLessThanOrEqual(4);
  });
});

describe('client address and forwarding', () => {
  const sock = (remoteAddress: string) => ({ remoteAddress }) as never;
  it("believes cf-connecting-ip only from our own proxy's address", () => {
    const h = { 'cf-connecting-ip': '203.0.113.7' };
    expect(clientAddress({ headers: h, socket: sock('172.18.0.1') })).toBe('203.0.113.7');
    expect(clientAddress({ headers: h, socket: sock('::ffff:127.0.0.1') })).toBe('203.0.113.7');
    expect(clientAddress({ headers: h, socket: sock('198.51.100.9') })).toBe('198.51.100.9');
    expect(
      clientAddress({ headers: { 'cf-connecting-ip': 'ssr' }, socket: sock('10.0.0.2') }),
    ).toBe('10.0.0.2');
  });

  it('MCP_FORWARD_CLIENT_IP=1 hands the caller address to the API (its own per-caller bucket); off by default', async () => {
    const on = await start(baseConfig({ forwardClientIp: true }));
    await callTool(
      `${on.base}/mcp`,
      'polyrank_get_leaderboard',
      {},
      { 'cf-connecting-ip': '203.0.113.7' },
    );
    expect(on.upstream.calls[0]!.headers['cf-connecting-ip']).toBe('203.0.113.7');
    const off = await start(baseConfig());
    await callTool(
      `${off.base}/mcp`,
      'polyrank_get_leaderboard',
      {},
      { 'cf-connecting-ip': '203.0.113.7' },
    );
    expect(off.upstream.calls[0]!.headers['cf-connecting-ip']).toBeUndefined();
  });
});

describe('logs', () => {
  it('one JSON record per request, with the tool name and fingerprints, never the key or the address', async () => {
    const s = await start(baseConfig());
    const auth = { authorization: `Bearer ${VALID_KEY}`, 'cf-connecting-ip': '203.0.113.7' };
    await callTool(`${s.base}/mcp`, 'polyrank_get_leaderboard', {}, auth);
    await rpc(`${s.base}/mcp`, INIT, { authorization: `Bearer ${REVOKED_KEY}` });
    expect(s.logs).toHaveLength(2);
    const [ok, refused] = s.logs;
    expect(ok).toMatchObject({
      msg: 'mcp_request',
      service: 'polyrank-mcp',
      level: 30,
      method: 'POST',
      path: '/mcp',
      toolset: 'all',
      rpc: 'tools/call',
      tool: 'polyrank_get_leaderboard',
      caller: 'key',
      key_check: 'valid',
      status: 200,
    });
    expect(ok!['key_fp']).toMatch(/^[0-9a-f]{12}$/);
    expect(refused).toMatchObject({ refused: 'auth_key', status: 401, level: 40 });
    const all = JSON.stringify(s.logs);
    for (const secret of [VALID_KEY, REVOKED_KEY, '203.0.113.7', VALID_KEY.slice(8)])
      expect(all).not.toContain(secret);
  });
});

describe('config from env', () => {
  it('defaults: loopback bind, port 3005, mcp.polyrank.app + localhost hosts, no origins, checks on', () => {
    expect(httpConfigFromEnv({})).toEqual({
      host: '127.0.0.1',
      port: 3005,
      apiBase: 'https://api.polyrank.app',
      agentBase: 'https://api-agent.polyrank.app',
      allowedHosts: ['mcp.polyrank.app', 'localhost', '127.0.0.1', '[::1]'],
      allowedOrigins: [],
      verifyKeys: true,
      anonPerMin: 100,
      keyPerMin: 600,
      forwardClientIp: false,
      maxBodyBytes: 1048576,
      // OAuth is off until MCP_OAUTH_ENABLED=1 (armed with the api's OAUTH_ENABLED=1).
      oauth: {
        enabled: false,
        issuer: 'https://api.polyrank.app',
        publicUrl: 'https://mcp.polyrank.app',
        requireOnConnect: false,
      },
    });
  });
  it('reads every knob', () => {
    const c = httpConfigFromEnv({
      MCP_HTTP_HOST: '0.0.0.0',
      MCP_HTTP_PORT: '4000',
      POLYRANK_API_BASE: 'http://api:3000',
      POLYRANK_AGENT_BASE: 'http://api-agent:3002',
      MCP_HTTP_ALLOWED_HOSTS: 'mcp.polyrank.app, localhost',
      MCP_HTTP_ALLOWED_ORIGINS: 'claude.ai',
      MCP_HTTP_VERIFY_KEYS: '0',
      MCP_HTTP_ANON_PER_MIN: '50',
      MCP_HTTP_KEY_PER_MIN: '300',
      MCP_FORWARD_CLIENT_IP: '1',
      MCP_HTTP_MAX_BODY_BYTES: '2048',
      MCP_OAUTH_ENABLED: '1',
      MCP_OAUTH_ISSUER: 'http://localhost:4100/',
      MCP_PUBLIC_URL: 'http://localhost:3105/',
      MCP_OAUTH_REQUIRE_ON_CONNECT: '1',
    });
    expect(c).toEqual({
      host: '0.0.0.0',
      port: 4000,
      apiBase: 'http://api:3000',
      agentBase: 'http://api-agent:3002',
      allowedHosts: ['mcp.polyrank.app', 'localhost'],
      allowedOrigins: ['claude.ai'],
      verifyKeys: false,
      anonPerMin: 50,
      keyPerMin: 300,
      forwardClientIp: true,
      maxBodyBytes: 2048,
      oauth: {
        enabled: true,
        issuer: 'http://localhost:4100',
        publicUrl: 'http://localhost:3105',
        requireOnConnect: true,
      },
    });
  });
});
