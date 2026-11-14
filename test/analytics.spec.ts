/**
 * tracking-full (2026-11-07): the hosted transport's product analytics — `mcp_connected` per initialize and
 * `mcp_tool_called {tool}` per tool call, keyed by the request log's fingerprints, never the key or the address; batched
 * to PostHog only when POSTHOG_PROJECT_API_KEY is set. Nothing here reaches the network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddressInfo } from 'node:net';
import { createHttpServer, fingerprint } from '../src/http.js';
import {
  createMcpAnalytics,
  mcpRequestEvents,
  NOOP_ANALYTICS,
  type McpAnalyticsEvent,
} from '../src/analytics.js';
import { INIT, VALID_KEY, baseConfig, callTool, fakeUpstream, rpc } from './helpers.js';

let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
});

async function serverWithRecorder() {
  const events: McpAnalyticsEvent[] = [];
  const upstream = fakeUpstream();
  const srv = createHttpServer(baseConfig(), {
    fetch: upstream.impl,
    log: () => undefined,
    analytics: {
      record: (e) => events.push(e),
      flush: async () => undefined,
      close: async () => undefined,
    },
  });
  await new Promise<void>((r) => srv.server.listen(0, '127.0.0.1', () => r()));
  closers.push(srv.close);
  const port = (srv.server.address() as AddressInfo).port;
  return { events, base: `http://127.0.0.1:${port}` };
}

describe('mcpRequestEvents (what one finished request sends)', () => {
  it('initialize → mcp_connected; tools/call → mcp_tool_called{tool}; keyed by the fingerprint', () => {
    expect(
      mcpRequestEvents({
        rpc: 'initialize',
        toolset: 'all',
        caller: 'anon',
        ip_fp: 'abc123abc123',
        status: 200,
      }),
    ).toEqual([
      {
        event: 'mcp_connected',
        distinctId: 'mcp_anon:abc123abc123',
        properties: { toolset: 'all', caller: 'anon' },
      },
    ]);
    expect(
      mcpRequestEvents({
        rpc: 'tools/call',
        tool: 'polyrank_get_leaderboard',
        toolset: 'public',
        caller: 'key',
        key_fp: 'fedcba987654',
        ip_fp: 'abc123abc123',
        status: 200,
      }),
    ).toEqual([
      {
        event: 'mcp_tool_called',
        distinctId: 'mcp_key:fedcba987654',
        properties: { toolset: 'public', caller: 'key', tool: 'polyrank_get_leaderboard' },
      },
    ]);
  });

  it('nothing for a refused request, a request without JSON-RPC, tools/list, or without a fingerprint', () => {
    expect(
      mcpRequestEvents({ rpc: 'initialize', caller: 'anon', ip_fp: 'a', status: 401 }),
    ).toEqual([]);
    expect(mcpRequestEvents({ caller: 'anon', ip_fp: 'a', status: 200 })).toEqual([]);
    expect(
      mcpRequestEvents({ rpc: 'tools/list', caller: 'anon', ip_fp: 'a', status: 200 }),
    ).toEqual([]);
    expect(mcpRequestEvents({ rpc: 'initialize', caller: 'anon', status: 200 })).toEqual([]);
  });
});

describe('the hosted server records them', () => {
  it('an anonymous initialize and a tool call; a keyed call is keyed by the key fingerprint, never the key', async () => {
    const s = await serverWithRecorder();
    await rpc(`${s.base}/mcp`, INIT);
    await callTool(`${s.base}/mcp`, 'polyrank_get_platform_stats');
    await callTool(
      `${s.base}/mcp`,
      'polyrank_get_platform_stats',
      {},
      { authorization: `Bearer ${VALID_KEY}` },
    );
    expect(s.events.map((e) => e.event)).toEqual([
      'mcp_connected',
      'mcp_tool_called',
      'mcp_tool_called',
    ]);
    expect(s.events[1]!.properties).toEqual({
      toolset: 'all',
      caller: 'anon',
      tool: 'polyrank_get_platform_stats',
    });
    expect(s.events[0]!.distinctId).toMatch(/^mcp_anon:[0-9a-f]{12}$/);
    expect(s.events[2]!.distinctId).toBe(`mcp_key:${fingerprint(VALID_KEY)}`);
    const all = JSON.stringify(s.events);
    expect(all).not.toContain(VALID_KEY);
    expect(all).not.toContain('127.0.0.1');
  });
});

describe('createMcpAnalytics (the PostHog sink)', () => {
  it('is a no-op without POSTHOG_PROJECT_API_KEY', () => {
    expect(createMcpAnalytics({})).toBe(NOOP_ANALYTICS);
    expect(createMcpAnalytics({ POSTHOG_PROJECT_API_KEY: '  ' })).toBe(NOOP_ANALYTICS);
    expect(createMcpAnalytics({ POSTHOG_PROJECT_API_KEY: 'off' })).toBe(NOOP_ANALYTICS);
  });

  it('batches to <host>/batch/ with no person profile, and never throws on a failed send', async () => {
    const fetchMock = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) => new Response('{}', { status: 200 }),
    );
    const a = createMcpAnalytics(
      {
        POSTHOG_PROJECT_API_KEY: 'phc_test',
        POSTHOG_HOST: 'https://ph.example/',
        MCP_ANALYTICS_FLUSH_MS: '60000',
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    a.record({
      event: 'mcp_connected',
      distinctId: 'mcp_anon:aaaaaaaaaaaa',
      properties: { toolset: 'all', caller: 'anon' },
    });
    a.record({
      event: 'mcp_tool_called',
      distinctId: 'mcp_anon:aaaaaaaaaaaa',
      properties: { toolset: 'all', caller: 'anon', tool: 'polyrank_search' },
    });
    expect(fetchMock).not.toHaveBeenCalled(); // queued until the flush
    await a.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://ph.example/batch/');
    const body = JSON.parse(String(init!.body));
    expect(body.api_key).toBe('phc_test');
    expect(body.batch).toHaveLength(2);
    expect(body.batch[1]).toMatchObject({
      event: 'mcp_tool_called',
      distinct_id: 'mcp_anon:aaaaaaaaaaaa',
      properties: { tool: 'polyrank_search', $process_person_profile: false, $lib: 'polyrank-mcp' },
    });

    const failing = createMcpAnalytics(
      { POSTHOG_PROJECT_API_KEY: 'phc_test' },
      {
        fetch: (async () => {
          throw new Error('down');
        }) as unknown as typeof fetch,
      },
    );
    failing.record({ event: 'mcp_connected', distinctId: 'mcp_anon:b', properties: {} });
    await expect(failing.flush()).resolves.toBeUndefined();
  });

  it('flushes at 50 queued events without waiting for the timer', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    const a = createMcpAnalytics(
      { POSTHOG_PROJECT_API_KEY: 'phc_test', MCP_ANALYTICS_FLUSH_MS: '60000' },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    for (let i = 0; i < 50; i++)
      a.record({ event: 'mcp_connected', distinctId: `mcp_anon:${i}`, properties: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await a.close();
  });
});
