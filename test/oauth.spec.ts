/**
 * The hosted server as an OAuth 2.1 protected resource (MCP authorization spec 2025-06-18; MCP_OAUTH_ENABLED=1):
 * RFC 9728 metadata, the 401 that starts a client's sign-in, OAuth access tokens next to pk_ keys, step-up on the
 * Lab scope, and a token cache that never outlives the token. The API is faked: it plays apps/api's answers
 * (auth_api_key.ts + oauth/access.ts): 200 + X-OAuth-Scope / X-OAuth-Expires-At for a known token, 401
 * invalid_token for any other.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  API,
  INIT,
  VALID_KEY,
  baseConfig,
  callTool,
  listTools,
  rpc,
  startServer,
  type UpstreamCall,
} from './helpers.js';
import {
  KeyVerifier,
  OAUTH_TOKEN_RE,
  accessTiers,
  oauthChallenge,
  protectedResourceMetadata,
  type HttpConfig,
} from '../src/http.js';

const TOKEN_FULL = 'a'.repeat(21) + '_' + 'B'.repeat(21); // 43 chars, scopes read + lab
const TOKEN_READ = 'c'.repeat(21) + '-' + 'D'.repeat(21); // 43 chars, scope read only
const TOKEN_SOON = 'e'.repeat(43); // expires in 10 s
const TOKEN_BAD = 'z'.repeat(43);

function oauthUpstream(nowSec: () => number) {
  const calls: UpstreamCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url, method: init?.method ?? 'GET', headers });
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...extra },
      });
    const auth = headers['authorization'];
    const known: Record<string, { scope: string; exp: number }> = {
      [`Bearer ${TOKEN_FULL}`]: { scope: 'read lab', exp: nowSec() + 1800 },
      [`Bearer ${TOKEN_READ}`]: { scope: 'read', exp: nowSec() + 1800 },
      [`Bearer ${TOKEN_SOON}`]: { scope: 'read lab', exp: nowSec() + 10 },
    };
    let extra: Record<string, string> = {};
    if (auth !== undefined) {
      if (auth === `Bearer ${VALID_KEY}`) extra = {};
      else if (known[auth] !== undefined)
        extra = {
          'x-oauth-scope': known[auth]!.scope,
          'x-oauth-expires-at': String(known[auth]!.exp),
        };
      else
        return json(
          401,
          { error: 'invalid_token', trace_id: 't' },
          { 'www-authenticate': 'Bearer error="invalid_token"' },
        );
    }
    if (url.startsWith(`${API}/v1/stats/overview`)) return json(200, { wallets: 3 }, extra);
    if (url.startsWith(`${API}/v1/t/`)) return json(200, { address: `0x${'1'.repeat(40)}` }, extra);
    if (url.startsWith(`${API}/v1/lab/limits`)) return json(200, { plan: 'lab' }, extra);
    if (url.startsWith(`${API}/v1/public/leaderboard`)) return json(200, { rows: [] }, extra);
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  return { calls, impl };
}

const oauthOn = (over: Partial<HttpConfig['oauth']> = {}): Partial<HttpConfig> => ({
  oauth: {
    enabled: true,
    issuer: 'https://api.polyrank.app',
    publicUrl: 'https://mcp.polyrank.app',
    requireOnConnect: false,
    ...over,
  },
});

let s: Awaited<ReturnType<typeof startServer>> | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});
const start = async (cfg: Partial<HttpConfig>) => {
  s = await startServer(
    baseConfig(cfg),
    oauthUpstream(() => Math.floor(Date.now() / 1000)),
  );
  return s;
};
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('protected-resource metadata (RFC 9728)', () => {
  it('serves /.well-known/oauth-protected-resource/mcp for the /mcp resource, and the root form for the origin', async () => {
    const srv = await start(oauthOn());
    const r = await fetch(`${srv.base}/.well-known/oauth-protected-resource/mcp`, {
      headers: { origin: 'http://localhost:6274' },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(await r.json()).toEqual({
      resource: 'https://mcp.polyrank.app/mcp',
      authorization_servers: ['https://api.polyrank.app'],
      scopes_supported: ['read', 'lab'],
      bearer_methods_supported: ['header'],
      resource_name: 'Polyrank',
      resource_documentation: 'https://docs.polyrank.app/mcp',
    });
    const root = (await (
      await fetch(`${srv.base}/.well-known/oauth-protected-resource`)
    ).json()) as { resource: string };
    expect(root.resource).toBe('https://mcp.polyrank.app');
    expect(srv.upstream.calls).toHaveLength(0);
  });
  it('is not served while OAuth is off (no metadata without the server behind it)', async () => {
    const srv = await start({});
    expect((await fetch(`${srv.base}/.well-known/oauth-protected-resource/mcp`)).status).toBe(404);
  });
  it('the root and path forms agree on everything but the resource', () => {
    const o = oauthOn().oauth!;
    const a = protectedResourceMetadata(o, '/.well-known/oauth-protected-resource/mcp');
    const b = protectedResourceMetadata(o, '/.well-known/oauth-protected-resource');
    expect({ ...a, resource: '' }).toEqual({ ...b, resource: '' });
  });
});

describe('the 401 that starts the sign-in', () => {
  it('anonymous: initialize, tools/list (36) and a free tool still work', async () => {
    const srv = await start(oauthOn());
    expect((await rpc(`${srv.base}/mcp`, INIT)).status).toBe(200);
    expect(await listTools(`${srv.base}/mcp`)).toHaveLength(36);
    expect(
      (await callTool(`${srv.base}/mcp`, 'polyrank_get_leaderboard', { limit: 1 })).status,
    ).toBe(200);
  });
  it('anonymous call of a tool that needs an account: HTTP 401 + WWW-Authenticate naming the metadata and scopes', async () => {
    const srv = await start(oauthOn());
    const before = srv.upstream.calls.length;
    const r = await callTool(`${srv.base}/mcp`, 'polyrank_get_lab_limits');
    expect(r.status).toBe(401);
    const h = r.headers.get('www-authenticate')!;
    expect(h).toMatch(/^Bearer /);
    expect(h).toContain(
      'resource_metadata="https://mcp.polyrank.app/.well-known/oauth-protected-resource/mcp"',
    );
    expect(h).toContain('scope="read lab"');
    expect(h).not.toContain('error=');
    expect(srv.upstream.calls.length).toBe(before);
    expect(srv.logs.at(-1)).toMatchObject({ refused: 'auth_required', status: 401 });
  });
  it('a keyed tool inside a batch triggers it too', async () => {
    const srv = await start(oauthOn());
    const r = await rpc(`${srv.base}/mcp`, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'polyrank_get_pulse', arguments: {} },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'polyrank_resolve_tid', arguments: { tid: 'x' } },
      },
    ]);
    expect(r.status).toBe(401);
  });
  it('MCP_OAUTH_REQUIRE_ON_CONNECT=1: every anonymous /mcp request answers 401; /mcp/public never does', async () => {
    const srv = await start(oauthOn({ requireOnConnect: true }));
    expect((await rpc(`${srv.base}/mcp`, INIT)).status).toBe(401);
    expect((await rpc(`${srv.base}/mcp/public`, INIT)).status).toBe(200);
    expect(await listTools(`${srv.base}/mcp/public`)).toHaveLength(17);
  });
  it('/mcp/public is never challenged, even for a name it does not list', async () => {
    const srv = await start(oauthOn());
    expect((await callTool(`${srv.base}/mcp/public`, 'polyrank_get_lab_limits')).status).toBe(200);
  });
  it('OAuth off: the keyed tool answers "needs a key" as before (no 401)', async () => {
    const srv = await start({});
    const r = await callTool(`${srv.base}/mcp`, 'polyrank_get_lab_limits');
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBe(true);
  });
});

describe('OAuth access tokens', () => {
  it('a valid token: 36 tools, checked once with the API, forwarded on every keyed call', async () => {
    const srv = await start(oauthOn());
    expect(await listTools(`${srv.base}/mcp`, bearer(TOKEN_FULL))).toHaveLength(36);
    const r = await callTool(`${srv.base}/mcp`, 'polyrank_get_lab_limits', {}, bearer(TOKEN_FULL));
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBeFalsy();
    const checks = srv.upstream.calls.filter((c) => c.url.endsWith('/v1/stats/overview'));
    expect(checks).toHaveLength(1);
    const lab = srv.upstream.calls.find((c) => c.url.endsWith('/v1/lab/limits'))!;
    expect(lab.headers['authorization']).toBe(`Bearer ${TOKEN_FULL}`);
    expect(srv.logs.at(-1)).toMatchObject({ caller: 'oauth' });
    expect(JSON.stringify(srv.logs)).not.toContain(TOKEN_FULL);
  });
  it('a token the API refuses: 401 invalid_token with the metadata, no tools', async () => {
    const srv = await start(oauthOn());
    const r = await rpc(`${srv.base}/mcp`, INIT, bearer(TOKEN_BAD));
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('invalid_token');
    expect(r.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata=');
  });
  it('a token that expires within 30 s is refused now, so the client refreshes before the call', async () => {
    const srv = await start(oauthOn());
    const r = await callTool(`${srv.base}/mcp`, 'polyrank_get_lab_limits', {}, bearer(TOKEN_SOON));
    expect(r.status).toBe(401);
    expect(srv.logs.at(-1)).toMatchObject({ refused: 'auth_token_expiring' });
  });
  it('step-up: a read-only token calling a Lab tool answers 403 insufficient_scope; its read tools work', async () => {
    const srv = await start(oauthOn());
    const lab = await callTool(
      `${srv.base}/mcp`,
      'polyrank_get_lab_limits',
      {},
      bearer(TOKEN_READ),
    );
    expect(lab.status).toBe(403);
    expect(lab.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(lab.headers.get('www-authenticate')).toContain('scope="read lab"');
    const read = await callTool(
      `${srv.base}/mcp`,
      'polyrank_resolve_tid',
      { tid: 'abc' },
      bearer(TOKEN_READ),
    );
    expect(read.status).toBe(200);
  });
  it('pk_ keys still work unchanged next to tokens', async () => {
    const srv = await start(oauthOn());
    expect(
      (await callTool(`${srv.base}/mcp`, 'polyrank_get_lab_limits', {}, bearer(VALID_KEY))).status,
    ).toBe(200);
  });
  it('OAuth off: a token-shaped Bearer is a malformed key (401), never sent upstream', async () => {
    const srv = await start({});
    const r = await rpc(`${srv.base}/mcp`, INIT, bearer(TOKEN_FULL));
    expect(r.status).toBe(401);
    expect(srv.upstream.calls).toHaveLength(0);
  });
});

describe('the Server Card follows the OAuth switch', () => {
  it('OAuth on: the card names OAuth, the issuer and the metadata URL', async () => {
    const srv = await start(oauthOn());
    const card = (await (await fetch(`${srv.base}/.well-known/mcp.json`)).json()) as {
      authentication: {
        schemes: string[];
        authorizationServers: string[];
        resourceMetadata: string;
      };
    };
    expect(card.authentication.schemes).toEqual(['oauth2', 'bearer']);
    expect(card.authentication.authorizationServers).toEqual(['https://api.polyrank.app']);
    expect(card.authentication.resourceMetadata).toBe(
      'https://mcp.polyrank.app/.well-known/oauth-protected-resource/mcp',
    );
  });
  it('OAuth off: the card of before ("No OAuth")', async () => {
    const srv = await start({});
    const card = (await (await fetch(`${srv.base}/.well-known/mcp.json`)).json()) as {
      authentication: { description: string };
    };
    expect(card.authentication.description).toMatch(/^No OAuth\./);
  });
});

describe('pieces', () => {
  it('19 tools need an account and 16 of them the Lab, read from the server definition', () => {
    const t = accessTiers();
    expect(t.keyed.size).toBe(19);
    expect(t.lab.size).toBe(16);
    for (const l of t.lab) expect(t.keyed.has(l)).toBe(true);
    expect(t.keyed.has('polyrank_get_leaderboard')).toBe(false);
  });
  it('OAUTH_TOKEN_RE is the library token shape and never a pk_ key', () => {
    expect(OAUTH_TOKEN_RE.test(TOKEN_FULL)).toBe(true);
    expect(OAUTH_TOKEN_RE.test(VALID_KEY)).toBe(false);
    expect(OAUTH_TOKEN_RE.test('a'.repeat(42))).toBe(false);
  });
  it('a valid token is cached at most a minute and never past its own expiry', async () => {
    let n = 0;
    const exp = 1_000_000; // unix s
    const fetchImpl = (async () => {
      n += 1;
      return new Response('{}', {
        status: 200,
        headers: { 'x-oauth-scope': 'read', 'x-oauth-expires-at': String(exp) },
      });
    }) as typeof fetch;
    const v = new KeyVerifier(API, fetchImpl);
    const t0 = (exp - 600) * 1000;
    expect((await v.checkDetailed(TOKEN_FULL, t0, {})).scopes).toEqual(['read']);
    await v.checkDetailed(TOKEN_FULL, t0 + 59_000, {});
    expect(n).toBe(1);
    await v.checkDetailed(TOKEN_FULL, t0 + 61_000, {});
    expect(n).toBe(2);
    // 40 s before expiry: cached only until 30 s before it.
    const late = (exp - 40) * 1000;
    await v.checkDetailed(TOKEN_FULL, late, {});
    await v.checkDetailed(TOKEN_FULL, late + 11_000, {});
    expect(n).toBe(4);
  });
  it('the challenge always names the metadata URL', () => {
    expect(oauthChallenge(oauthOn().oauth!)).toBe(
      'Bearer realm="polyrank", scope="read lab", resource_metadata="https://mcp.polyrank.app/.well-known/oauth-protected-resource/mcp"',
    );
  });
});
