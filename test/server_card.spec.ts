/**
 * The MCP Server Card (SEO + AI visibility head, 2026-11-07): served here at /.well-known/mcp/server-card.json and
 * /.well-known/mcp.json, and by polyrank.app from apps/web/lib/mcp_server_card.ts. The two copies must be deep-equal,
 * the card's tool lists must be what this server lists on /mcp and /mcp/public, and its version must be VERSION — so
 * the card can never describe a server that is not the one running.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';
import {
  SERVER_CARD_PATHS,
  TOOL_COUNTS,
  httpConfigFromEnv,
  resourceMetadataUrl,
} from '../src/http.js';
import { MCP_FREE_TOOLS, MCP_KEY_TOOLS, mcpServerCard } from '../src/server_card.js';
// The web's twin: dependency-free on purpose, so this import resolves from here.
import * as web from '../../web/lib/mcp_server_card';
import { MCP_OAUTH_ARMED } from '../../web/lib/agent_discovery';
import { baseConfig, listTools, startServer } from './helpers.js';

let srv: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  srv = await startServer(baseConfig());
});
afterAll(async () => srv.close());

describe('server card', () => {
  it('both paths answer 200 JSON, readable cross-origin, without auth or an upstream call', async () => {
    expect(SERVER_CARD_PATHS).toEqual([
      '/.well-known/mcp/server-card.json',
      '/.well-known/mcp.json',
    ]);
    for (const p of SERVER_CARD_PATHS) {
      const res = await fetch(`${srv.base}${p}`);
      expect(res.status, p).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(await res.json()).toEqual(mcpServerCard());
    }
    expect(srv.upstream.calls).toEqual([]);
  });

  it('POST is 405', async () => {
    const res = await fetch(`${srv.base}/.well-known/mcp.json`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(405);
  });

  it('equals the card polyrank.app serves', () => {
    expect(mcpServerCard()).toEqual(web.mcpServerCard());
    expect(MCP_FREE_TOOLS).toEqual(web.MCP_FREE_TOOLS);
    expect(MCP_KEY_TOOLS).toEqual(web.MCP_KEY_TOOLS);
  });

  it("with OAuth armed, polyrank.app's static card = the card this server serves with MCP_OAUTH_ENABLED=1 (prod defaults)", () => {
    const o = httpConfigFromEnv({ MCP_OAUTH_ENABLED: '1' } as NodeJS.ProcessEnv).oauth;
    const served = mcpServerCard({
      issuer: o.issuer,
      resourceMetadata: resourceMetadataUrl(o),
      requireOnConnect: o.requireOnConnect,
    });
    expect(web.mcpServerCard(MCP_OAUTH_ARMED)).toEqual(served);
    // production: MCP_OAUTH_REQUIRE_ON_CONNECT=0 (founder 2026-11-07 22:04Z), the compose default
    expect(MCP_OAUTH_ARMED).toEqual({
      issuer: 'https://api.polyrank.app',
      resourceMetadata: 'https://mcp.polyrank.app/.well-known/oauth-protected-resource/mcp',
      requireOnConnect: false,
    });
  });

  it('the twin builders agree in every mode (off, armed, armed + sign-in at connect)', () => {
    expect(web.mcpServerCard()).toEqual(mcpServerCard());
    for (const requireOnConnect of [false, true]) {
      const o = { ...MCP_OAUTH_ARMED, requireOnConnect };
      expect(web.mcpServerCard(o)).toEqual(mcpServerCard(o));
    }
  });

  it('version, serverInfo, transport endpoint, capabilities', () => {
    const c = mcpServerCard() as Record<string, any>;
    expect(c.version).toBe(VERSION);
    expect(c.serverInfo).toEqual({ name: 'polyrank', title: 'Polyrank', version: VERSION });
    expect(c.transport).toEqual({
      type: 'streamable-http',
      endpoint: 'https://mcp.polyrank.app/mcp',
    });
    expect(c.capabilities).toEqual({ tools: { listChanged: false } });
    expect(c.packages[0].version).toBe(VERSION);
  });

  it('the tool lists are what the server lists: 17 on /mcp/public, all 36 on /mcp', async () => {
    const pub = (await listTools(`${srv.base}/mcp/public`)).map((t: { name: string }) => t.name);
    const all = (await listTools(`${srv.base}/mcp`)).map((t: { name: string }) => t.name);
    expect([...pub].sort()).toEqual([...MCP_FREE_TOOLS].sort());
    expect([...all].sort()).toEqual([...MCP_FREE_TOOLS, ...MCP_KEY_TOOLS].sort());
    expect(MCP_FREE_TOOLS.length).toBe(TOOL_COUNTS.public);
    expect(MCP_FREE_TOOLS.length + MCP_KEY_TOOLS.length).toBe(TOOL_COUNTS.all);
  });
});
