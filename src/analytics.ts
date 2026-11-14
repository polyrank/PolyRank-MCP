/**
 * Product analytics of the HOSTED MCP server (tracking-full, 2026-11-07): `mcp_connected` (a client's `initialize`)
 * and `mcp_tool_called {tool}` counts, to the Polyrank PostHog project. The stdio server (what ships on npm) never
 * sends anything: only createHttpServer builds a sink.
 *
 * WHAT IS SENT. Per event: the tool name (the server's own /^[a-z_]{1,64}$/ names), the toolset (all | public), the
 * caller class (key | anon) and the HTTP status class. The distinct id is a fingerprint, never a key or an address:
 * `mcp_key:<12-hex SHA-256 of the key>` for a keyed caller, `mcp_anon:<12-hex SHA-256 of the address>` otherwise —
 * the same fingerprints the request log already carries. No person profile is made (`$process_person_profile:false`).
 *
 * HOW. Events are queued and sent to PostHog's /batch/ endpoint at most every MCP_ANALYTICS_FLUSH_MS (10 s) or once 50
 * are queued, fire-and-forget; the queue is bounded (1,000: beyond it events are dropped, never the request). A
 * no-op unless POSTHOG_PROJECT_API_KEY is set (compose passes the public project key).
 */
export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const FLUSH_AT = 50;
const MAX_QUEUE = 1000;

export interface McpAnalyticsEvent {
  event: 'mcp_connected' | 'mcp_tool_called';
  distinctId: string;
  properties: Record<string, string | number | boolean>;
}

export interface McpAnalytics {
  record: (e: McpAnalyticsEvent) => void;
  flush: () => Promise<void>;
  close: () => Promise<void>;
}

export const NOOP_ANALYTICS: McpAnalytics = {
  record: () => undefined,
  flush: async () => undefined,
  close: async () => undefined,
};

/** The analytics events of one finished request (pure, so the spec pins exactly what is sent). */
export function mcpRequestEvents(rec: {
  rpc?: unknown;
  tool?: unknown;
  toolset?: unknown;
  caller?: unknown;
  key_fp?: unknown;
  ip_fp?: unknown;
  status: number;
}): McpAnalyticsEvent[] {
  if (rec.status >= 400 || typeof rec.rpc !== 'string') return [];
  const caller = rec.caller === 'key' ? 'key' : 'anon';
  const fp = caller === 'key' ? rec.key_fp : rec.ip_fp;
  if (typeof fp !== 'string' || fp === '') return [];
  const base = {
    distinctId: `mcp_${caller}:${fp}`,
    common: {
      toolset: rec.toolset === 'public' ? 'public' : 'all',
      caller,
    },
  };
  const out: McpAnalyticsEvent[] = [];
  const methods = rec.rpc.split(',');
  if (methods.includes('initialize'))
    out.push({
      event: 'mcp_connected',
      distinctId: base.distinctId,
      properties: { ...base.common },
    });
  if (typeof rec.tool === 'string' && /^[a-z_]{1,64}$/.test(rec.tool))
    out.push({
      event: 'mcp_tool_called',
      distinctId: base.distinctId,
      properties: { ...base.common, tool: rec.tool },
    });
  return out;
}

export function createMcpAnalytics(
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetch?: typeof fetch; onError?: (m: string) => void; lib?: string } = {},
): McpAnalytics {
  const key = env['POSTHOG_PROJECT_API_KEY']?.trim() ?? '';
  // off switch: `off` / `0` (compose's `:-` default comes back for an empty value)
  if (key === '' || key === '0' || key.toLowerCase() === 'off') return NOOP_ANALYTICS;
  const host = (env['POSTHOG_HOST']?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/+$/, '');
  const n = Number(env['MCP_ANALYTICS_FLUSH_MS']);
  const flushMs = Number.isInteger(n) && n > 0 ? n : 10_000;
  const doFetch = deps.fetch ?? fetch;
  const lib = deps.lib ?? 'polyrank-mcp';
  let queue: Array<McpAnalyticsEvent & { at: string }> = [];
  let timer: NodeJS.Timeout | undefined;

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    try {
      const res = await doFetch(`${host}/batch/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: key,
          batch: batch.map((e) => ({
            event: e.event,
            distinct_id: e.distinctId,
            timestamp: e.at,
            properties: { ...e.properties, $lib: lib, $process_person_profile: false },
          })),
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) deps.onError?.(`posthog batch HTTP ${res.status}`);
    } catch (err) {
      deps.onError?.((err as Error).message);
    }
  };

  return {
    record: (e) => {
      if (queue.length >= MAX_QUEUE) return;
      queue.push({ ...e, at: new Date().toISOString() });
      if (queue.length >= FLUSH_AT) {
        void flush();
      } else if (timer === undefined) {
        timer = setTimeout(() => void flush(), flushMs);
        timer.unref();
      }
    },
    flush,
    close: flush,
  };
}
