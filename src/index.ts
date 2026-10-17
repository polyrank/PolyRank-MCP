#!/usr/bin/env node
/**
 * Polyrank MCP server — lets any LLM agent (Claude, etc.) query Polyrank's
 * Polymarket skill analytics directly.
 *
 *   - Anonymous tools wrap the free public /v1/public/* API and the free agent manifests
 *     (metric catalog, metric windows, Builder goals).
 *   - With POLYRANK_API_KEY (a pk_live_… key from polyrank.app/settings/api), the ranking,
 *     trader-metrics and Strategy Lab tools call the authenticated API with the key: the SAME
 *     POST /v1/rankings/custom the Ranking Builder runs (all metrics, weights, windows, filters,
 *     as_of), plan-gated and quota-counted like any key call.
 *
 * Transport: stdio (agents launch it locally, e.g. `npx @polyrank/mcp`).
 *
 * Config: POLYRANK_API_BASE (default https://api.polyrank.app), POLYRANK_AGENT_BASE (default
 * https://api-agent.polyrank.app — only its free manifests are read), POLYRANK_API_KEY.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export const VERSION = '0.4.0';

const API_BASE = process.env.POLYRANK_API_BASE ?? 'https://api.polyrank.app';
/** The x402 agent host. Only its FREE manifests are called (no payment is ever signed here). */
const AGENT_BASE = process.env.POLYRANK_AGENT_BASE ?? 'https://api-agent.polyrank.app';
/** Optional API key — enables the authenticated tools (rankings, trader metrics, Strategy Lab, tid resolve). */
const API_KEY = process.env.POLYRANK_API_KEY;

const NEEDS_KEY =
  "This tool needs a Polyrank API key: create one at https://polyrank.app/settings/api (a plan with the Ranking Builder / Strategy Lab), then set POLYRANK_API_KEY in this MCP server's environment.";

/**
 * Call the API and return parsed JSON, or throw an actionable error. A non-2xx answer is reported
 * WITH the server's own message — a 400 from the ranking or Lab API names exactly which metric,
 * window or filter was refused and why, and an agent can only fix what it is told.
 */
async function call<T>(
  base: string,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(API_KEY && init.auth !== false ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(
      `Could not reach Polyrank at ${base}${path}: ${(err as Error).message}. Check network or POLYRANK_API_BASE / POLYRANK_AGENT_BASE.`,
    );
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as Record<string, unknown>;
      detail = [j['error'], j['message']].filter((x) => typeof x === 'string').join(': ');
      if (Array.isArray(j['issues'])) detail += ` ${JSON.stringify(j['issues'])}`;
    } catch {
      /* not JSON */
    }
    if (res.status === 401)
      throw new Error(
        `Polyrank API 401 for ${path}: the API key was not accepted. ${detail}`.trim(),
      );
    if (res.status === 403)
      throw new Error(
        `Polyrank API 403 for ${path}: your plan does not include this. ${detail}`.trim(),
      );
    if (res.status === 404) throw new Error(`Not found: ${method} ${path}. ${detail}`.trim());
    if (res.status === 429) throw new Error(`Rate limited on ${path}. ${detail}`.trim());
    throw new Error(`Polyrank API ${res.status} for ${method} ${path}. ${detail}`.trim());
  }
  return (await res.json()) as T;
}

/** GET the main API (the original helper — the public tools use it). */
async function api<T>(path: string): Promise<T> {
  return call<T>(API_BASE, path);
}

/** A tool result: pretty JSON text + the structured object. */
function ok(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}
function fail(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const server = new McpServer({ name: 'polyrank', version: VERSION });

server.registerTool(
  'polyrank_get_leaderboard',
  {
    title: 'Polyrank skill leaderboard',
    description:
      'Top Polymarket traders ranked by genuine SKILL (calibration/Brier, alpha-vs-mid, risk-adjusted return) — not vanity P&L or win rate. Returns rank, composite score, identity, P&L, win-rate, volume. Use this to find traders worth copying or studying.',
    inputSchema: {
      preset: z
        .string()
        .optional()
        .describe(
          'Ranking preset id (default "polyrank-default", the calibration-heavy headline ranking).',
        ),
      limit: z.number().int().min(1).max(25).optional().describe('Rows to return (max 25).'),
    },
    annotations: READ_ONLY,
  },
  async ({ preset, limit }) => {
    try {
      const qs = `?preset=${encodeURIComponent(preset ?? 'polyrank-default')}&limit=${limit ?? 25}`;
      return ok(await api(`/v1/public/leaderboard${qs}`));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_get_trader_skill',
  {
    title: 'Polyrank trader skill profile',
    description:
      'A single Polymarket wallet’s skill profile: composite rank, P&L, win-rate, volume, trades/markets, and commodity percentiles. The deep skill grid — full Brier decomposition, alpha-vs-mid, information coefficient, Sharpe, copyability & max copyable clip, true slippage, realized volatility, the hold-time split, peak/avg capital-at-risk, copier-realized return, and the copy verdict — is gated to the paid x402 agent tier (/v1/agent/*).',
    inputSchema: {
      address: z.string().describe('Proxy wallet address (0x + 40 hex).'),
    },
    annotations: READ_ONLY,
  },
  async ({ address }) => {
    try {
      return ok(await api(`/v1/public/trader/${encodeURIComponent(address)}`));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_get_trader_calibration',
  {
    title: 'Polyrank trader calibration',
    description:
      'A wallet’s 10-bin reliability diagram (predicted probability vs observed outcome rate). Calibration is the core skill signal — whether the trader’s probabilities match reality. Returns bins + total resolved count.',
    inputSchema: {
      address: z.string().describe('Proxy wallet address (0x + 40 hex).'),
    },
    annotations: READ_ONLY,
  },
  async ({ address }) => {
    try {
      return ok(await api(`/v1/public/trader/${encodeURIComponent(address)}/calibration`));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_get_market_consensus',
  {
    title: 'Polyrank market consensus',
    description:
      'Smart-money consensus on a Polymarket market vs the market mid (the Polyrank-vs-mid delta is a differentiated signal), plus 24h volume/fills, positioner counts, and top holders. Accepts a conditionId (0x + 64 hex) or a market slug.',
    inputSchema: {
      market: z.string().describe('conditionId (0x + 64 hex) or market slug.'),
    },
    annotations: READ_ONLY,
  },
  async ({ market }) => {
    try {
      return ok(await api(`/v1/public/market/${encodeURIComponent(market)}`));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_get_pulse',
  {
    title: 'Polyrank live pulse',
    description:
      'Live Polymarket activity: big wins just banked (realized profit), sharp-money moves, the biggest recent trades, trending markets by volume, and markets where Polyrank consensus diverges most from the market mid. Good for "what is smart money doing right now".',
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(await api(`/v1/public/pulse`));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_get_platform_stats',
  {
    title: 'Polyrank platform coverage & metric count',
    description:
      'Live Polyrank coverage and the canonical skill-metric count: total wallets ranked, trades indexed, markets covered, the number of skill metrics in the catalog, and the earliest year of data. Use this instead of hardcoding "N wallets / N metrics".',
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(await api(`/v1/stats/overview`));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_get_top_roi_trades',
  {
    title: 'Polyrank highest-ROI resolved trades',
    description:
      'The biggest return-on-cost RESOLVED Polymarket bets (won positions with a real cost floor) — a hall-of-fame of single trades by ROI multiple. Optionally filter by market category (e.g. "Sports", "Politics", "Crypto"). Identities are masked (pseudonym only).',
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Rows to return (max 100, default 50).'),
      category: z
        .string()
        .optional()
        .describe('Market category filter, e.g. "Sports", "Politics", "Crypto".'),
      since_days: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .optional()
        .describe('Only trades resolved within the last N days.'),
      sort: z
        .enum(['roi', 'profit', 'cost', 'entry', 'recency'])
        .optional()
        .describe('Sort key (default "roi").'),
      dir: z.enum(['desc', 'asc']).optional().describe('Sort direction (default "desc").'),
    },
    annotations: READ_ONLY,
  },
  async ({ limit, category, since_days, sort, dir }) => {
    try {
      const p = new URLSearchParams();
      p.set('limit', String(limit ?? 50));
      if (category !== undefined) p.set('category', category);
      if (since_days !== undefined) p.set('since_days', String(since_days));
      if (sort !== undefined) p.set('sort', sort);
      if (dir !== undefined) p.set('dir', dir);
      return ok(await api(`/v1/public/trades/top-roi?${p.toString()}`));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_get_movers',
  {
    title: 'Polyrank skill-rank movers',
    description:
      'Traders whose skill rank climbed or fell the most recently (leaderboard momentum). Returns top climbers and fallers for a ranking preset over a lookback window.',
    inputSchema: {
      preset: z.string().optional().describe('Ranking preset id (default "polyrank-default").'),
      lookback_days: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe('Lookback window in days (max 30, default 7).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Rows per direction (max 10, default 5).'),
    },
    annotations: READ_ONLY,
  },
  async ({ preset, lookback_days, limit }) => {
    try {
      const p = new URLSearchParams();
      p.set('preset', preset ?? 'polyrank-default');
      p.set('lookback_days', String(lookback_days ?? 7));
      p.set('limit', String(limit ?? 5));
      return ok(await api(`/v1/public/movers?${p.toString()}`));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_get_smart_money_reports',
  {
    title: 'Polyrank Smart-Money Report archive',
    description:
      'The archive of Polyrank weekly Smart-Money Reports (published each week): a list of report ids/weeks with summaries. Fetch one in full with polyrank_get_smart_money_report.',
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(104)
        .optional()
        .describe('How many recent reports to list (max 104, default 52).'),
    },
    annotations: READ_ONLY,
  },
  async ({ limit }) => {
    try {
      return ok(await api(`/v1/public/reports/smart-money?limit=${limit ?? 52}`));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_get_smart_money_report',
  {
    title: 'Polyrank Smart-Money Report (one week)',
    description:
      'One Polyrank weekly Smart-Money Report in full: big wins, skill-rank movers, new entrants, the calibration leader, consensus divergence, and the editorial intro. Pass the week/report id from polyrank_get_smart_money_reports.',
    inputSchema: {
      week: z.string().describe('Report/week id from the archive, e.g. "2026-w26".'),
    },
    annotations: READ_ONLY,
  },
  async ({ week }) => {
    try {
      return ok(await api(`/v1/public/reports/smart-money/${encodeURIComponent(week)}`));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_get_trader_by_tid',
  {
    title: 'Polyrank trader teaser (by masked id)',
    description:
      'Look up a trader by the opaque masked id (tid) returned in leaderboard / pulse / movers / top-ROI rows — those masked surfaces omit the raw wallet, so use the tid to follow a trader. Returns the same masked skill teaser as the wallet lookup. Full wallet/identity resolution requires signing in on polyrank.app.',
    inputSchema: {
      tid: z.string().describe('Opaque trader id (tid) from a masked row.'),
    },
    annotations: READ_ONLY,
  },
  async ({ tid }) => {
    try {
      return ok(await api(`/v1/public/t/${encodeURIComponent(tid)}`));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_get_trader_calibration_by_tid',
  {
    title: 'Polyrank trader calibration (by masked id)',
    description:
      'A trader’s 10-bin reliability diagram (predicted probability vs observed outcome rate) keyed by the opaque masked id (tid) from a leaderboard / pulse / movers / top-ROI row. Calibration is the core skill signal — whether the trader’s probabilities match reality. Completes the discovery → tid → calibration loop without needing the raw wallet. Returns bins + total resolved count.',
    inputSchema: {
      tid: z.string().describe('Opaque trader id (tid) from a masked row.'),
    },
    annotations: READ_ONLY,
  },
  async ({ tid }) => {
    try {
      return ok(await api(`/v1/public/t/${encodeURIComponent(tid)}/calibration`));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_get_custom_ranking',
  {
    title: 'Polyrank published Builder ranking',
    description:
      'A published Polyrank Builder ranking: masked top-25 + the weight/filter definition. Builder rankings are custom skill leaderboards (a weighting over the metric catalog plus filters) that users publish and share by slug. Returns the masked top-25 rows and the ranking’s weight/filter definition. Pass the slug from a shared /r/<slug> link.',
    inputSchema: {
      slug: z.string().describe('Published ranking slug from a /r/<slug> share link.'),
    },
    annotations: READ_ONLY,
  },
  async ({ slug }) => {
    try {
      return ok(await api(`/v1/public/ranking/${encodeURIComponent(slug)}`));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_resolve_tid',
  {
    title: 'Polyrank resolve masked id → wallet (API key required)',
    description:
      'Resolve an opaque masked id (tid) to the underlying proxy wallet address. Requires a Polyrank API key (pk_live_… / pk_test_…): set POLYRANK_API_KEY. The MCP sends it as a Bearer token and the API key-auth accepts it — no browser session needed. Then use the resolved wallet with polyrank_get_trader_skill / polyrank_get_trader_calibration.',
    inputSchema: {
      tid: z.string().describe('Opaque trader id (tid) from a masked row.'),
    },
    annotations: READ_ONLY,
  },
  async ({ tid }) => {
    try {
      if (!API_KEY) return fail('set POLYRANK_API_KEY to resolve tids to wallets');
      return ok(await api(`/v1/t/${encodeURIComponent(tid)}/resolve`));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_get_traders_batch',
  {
    title: 'Polyrank trader teasers (batch, by masked id)',
    description:
      'Fetch the free masked skill teaser for several traders at once by their opaque masked ids (tids). Same per-trader payload as polyrank_get_trader_by_tid, capped at 10 tids per call. No API key needed. Each result is tagged with its tid, and per-tid failures are returned inline (as an error field) rather than failing the whole batch.',
    inputSchema: {
      tids: z
        .array(z.string())
        .min(1)
        .max(10)
        .describe('Opaque trader ids (tids) from masked rows (max 10).'),
    },
    annotations: READ_ONLY,
  },
  async ({ tids }) => {
    try {
      const results = await Promise.all(
        tids.map(async (tid) => {
          try {
            return { tid, teaser: await api(`/v1/public/t/${encodeURIComponent(tid)}`) };
          } catch (e) {
            return { tid, error: (e as Error).message };
          }
        }),
      );
      return ok({ results });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

// ─── 0.4.0 — the ranking vocabulary, the Builder itself, per-window trader metrics, the Strategy Lab ───────────────

const WINDOWS = ['lifetime', '90d', '30d', '7d', '24h'] as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

server.registerTool(
  'polyrank_get_metrics_catalog',
  {
    title: 'Polyrank metric catalog (every rankable metric)',
    description:
      'The full catalog of displayable Polyrank metrics (84): id, name, description, category, direction (higher/lower is better), the windows each is available at, and whether it is advanced. This is the vocabulary for polyrank_rank_wallets weights, skill_gates and metric_filters. Free, no key.',
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(await call(AGENT_BASE, '/v1/agent/metrics/catalog', { auth: false }));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_get_metric_windows',
  {
    title: 'Polyrank metric windows + as_of coverage',
    description:
      'Which metric exists at which window (lifetime / 90d / 30d / 7d / 24h), whether it can be weighted, gated or filtered, the copy-engine and entry-timing ids (lifetime-pinned), and what a back-dated board (as_of) can answer: its metrics, the filters it honours and the reason for each it refuses. Read this before ranking at a window or as_of. Free, no key.',
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(await call(AGENT_BASE, '/v1/agent/metrics/windows', { auth: false }));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_list_ranking_templates',
  {
    title: 'Polyrank ranking templates (Builder goals + presets)',
    description:
      'The Ranking Builder\'s goals (e.g. "Copy entries", "Copy engine") as the exact request the Builder runs for each, and the site\'s preset boards with their configs. Pass a goal\'s `request` (or a preset\'s config) to polyrank_rank_wallets to reproduce that board, or edit it. A goal `banner` is a measured caveat to show with the board. Free, no key.',
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      const [goals, presets] = await Promise.all([
        call(AGENT_BASE, '/v1/agent/rankings/goals', { auth: false }),
        call(API_BASE, '/v1/rankings/presets', { auth: false }).catch((e: Error) => ({
          error: e.message,
        })),
      ]);
      return ok({ goals, presets });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

const WeightValue = z.union([
  z.number().positive(),
  z.object({ weight: z.number().positive(), window: z.enum(WINDOWS).optional() }),
]);

server.registerTool(
  'polyrank_rank_wallets',
  {
    title: 'Polyrank Ranking Builder (custom composite ranking)',
    description:
      'Rank every Polymarket wallet with your own composite — exactly what the Ranking Builder runs (POST /v1/rankings/custom). weights: metric id → weight (or {weight, window}); any of the 84 catalog metrics at any window it exists at (polyrank_get_metric_windows), plus copy-engine (sk_score_14d) and entry-timing ids at lifetime. filters: min_trades, min_resolved, min_volume_usdc, min_realized_pnl(_net_fees), min_win_rate_pct, max_roi_pct, active_within_days/hours, categories, exclude_bonders, skill_gates [{metric,min_pctile,window}], metric_filters [{metric,min,max,window}], copy_engine {sleeve}, timing {sub,bucket,window,min_n}, cluster_policy, copy_placeable, smart_money_tags_any_of, follower_count_max … (the server rejects anything it cannot apply, with the reason). as_of=YYYY-MM-DD ranks the board as it stood that day (lifetime snapshot metrics only — refused with the reason otherwise, never answered live). To reproduce a Builder goal, pass its `request` from polyrank_list_ranking_templates as `request`. Needs POLYRANK_API_KEY (a plan with the Builder).',
    inputSchema: {
      request: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "A complete POST /v1/rankings/custom body (e.g. a goal's `request`). When given, the other arguments override its fields.",
        ),
      weights: z
        .record(z.string(), WeightValue)
        .optional()
        .describe('metric id → weight, or → {weight, window}. Weights are auto-normalized.'),
      window: z
        .enum(WINDOWS)
        .optional()
        .describe('Default window for every weight given as a bare number (default lifetime).'),
      filters: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Ranking filters (see description).'),
      as_of: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe(
          'Rank the board as it stood on this day (ISO date). Lifetime snapshot metrics only.',
        ),
      na_policy: z.enum(['exclude', 'neutral_50']).optional(),
      sort_by: z
        .string()
        .optional()
        .describe(
          'composite (default), metric:<id>, pctile:<id>, engine:<id>, timing:<id>, or a board column.',
        ),
      sort_dir: z.enum(['desc', 'asc']).optional(),
      limit: z.number().int().min(1).max(500).optional().describe('Rows (default 100, max 500).'),
      offset: z.number().int().min(0).optional(),
      include_breakdown: z.boolean().optional().describe('Per-metric percentile cells per row.'),
      include_raw: z
        .boolean()
        .optional()
        .describe('Raw values beside the percentiles (dollars, hours).'),
      include_verdict: z.boolean().optional().describe('The copy verdict the trader page shows.'),
      extra_metrics: z.array(z.string()).optional().describe('More metric columns to project.'),
      extra_engine_metrics: z
        .array(z.string())
        .optional()
        .describe('Copy-engine columns to project.'),
      dedupe_clusters: z.boolean().optional().describe('Keep one wallet per wallet-farm cluster.'),
      explain: z.boolean().optional().describe('How many wallets each filter dropped.'),
    },
    annotations: READ_ONLY,
  },
  async (args) => {
    if (!API_KEY) return fail(NEEDS_KEY);
    try {
      const { request, weights, window, ...rest } = args;
      const body: Record<string, unknown> = { ...(request ?? {}) };
      if (weights !== undefined) {
        body['weights'] = Object.fromEntries(
          Object.entries(weights).map(([id, v]) => [
            id,
            typeof v === 'number'
              ? { weight: v, window: window ?? 'lifetime' }
              : { weight: v.weight, window: v.window ?? window ?? 'lifetime' },
          ]),
        );
      } else if (window !== undefined && body['weights'] && typeof body['weights'] === 'object') {
        body['weights'] = Object.fromEntries(
          Object.entries(body['weights'] as Record<string, { weight: number }>).map(([id, v]) => [
            id,
            { ...v, window },
          ]),
        );
      }
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
      if (body['weights'] === undefined)
        return fail('give weights (metric id → weight) or a template `request`.');
      return ok(await call(API_BASE, '/v1/rankings/custom', { method: 'POST', body }));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_get_trader_metrics',
  {
    title: 'Polyrank trader metrics at a window',
    description:
      "One trader's every metric displayable at a window (lifetime / 90d / 30d / 7d / 24h): the raw value and its percentile in that window's cohort — the cells a board ranked at that window scores. Give a wallet address or a masked tid. scope=combined (default) reads the multi-wallet user row as boards do. Needs POLYRANK_API_KEY.",
    inputSchema: {
      address: z.string().optional().describe('Proxy wallet address (0x + 40 hex).'),
      tid: z
        .string()
        .optional()
        .describe('Masked trader id from a public board (resolved with your key).'),
      window: z.enum(WINDOWS).optional().describe('Default lifetime.'),
      scope: z.enum(['combined', 'wallet']).optional(),
    },
    annotations: READ_ONLY,
  },
  async ({ address, tid, window, scope }) => {
    if (!API_KEY) return fail(NEEDS_KEY);
    try {
      let wallet = address;
      if (wallet === undefined) {
        if (tid === undefined) return fail('give an address or a tid');
        wallet = (await api<{ proxy_wallet: string }>(`/v1/t/${encodeURIComponent(tid)}/resolve`))
          .proxy_wallet;
      }
      const qs = new URLSearchParams({ window: window ?? 'lifetime', ...(scope ? { scope } : {}) });
      return ok(await api(`/v1/trader/${encodeURIComponent(wallet)}/metrics?${qs.toString()}`));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

// ── Strategy Lab (POLYRANK_API_KEY; plan feature strategy_lab / paper_trading). Results are SIMULATED. ──

server.registerTool(
  'polyrank_list_lab_templates',
  {
    title: 'Strategy Lab templates',
    description:
      "The Strategy Lab's templates: research strategy families as editable strategy specs, each with its as-of evidence (SIMULATED, per $10 copied) and caveats. Copy one's `spec` (or its id) into polyrank_create_strategy / polyrank_run_backtest. Needs POLYRANK_API_KEY.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    if (!API_KEY) return fail(NEEDS_KEY);
    try {
      return ok(await api('/v1/lab/templates'));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_create_strategy',
  {
    title: 'Strategy Lab: save a strategy',
    description:
      'Save a strategy to your Lab: a name plus a strategy spec (wallet source — any Builder ranking, a history ranking, a static wallet list or a copy-engine sleeve — and market, entry, sizing and exit rules), or a template_id to copy a template. The server validates the spec and answers with the reason when it refuses. Needs POLYRANK_API_KEY.',
    inputSchema: {
      name: z.string().min(1).max(120),
      spec: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('A strategy spec (see polyrank_list_lab_templates).'),
      template_id: z.string().optional(),
    },
    annotations: WRITE,
  },
  async ({ name, spec, template_id }) => {
    if (!API_KEY) return fail(NEEDS_KEY);
    try {
      return ok(
        await call(API_BASE, '/v1/lab/strategies', {
          method: 'POST',
          body: { name, ...(spec ? { spec } : {}), ...(template_id ? { template_id } : {}) },
        }),
      );
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_run_backtest',
  {
    title: 'Strategy Lab: run a backtest',
    description:
      "Queue a backtest of a saved strategy (strategy_id) or an unsaved spec over [from, to) (ISO dates, at most 366 days), optionally with explicit re-rank cuts. Answers with the queued run; poll polyrank_get_backtest. Results are SIMULATED (each report names its fill model and measured optimism). Counts against your plan's daily backtests. Needs POLYRANK_API_KEY.",
    inputSchema: {
      strategy_id: z.string().uuid().optional(),
      spec: z.record(z.string(), z.unknown()).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      cuts: z
        .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
        .max(60)
        .optional(),
    },
    annotations: WRITE,
  },
  async (args) => {
    if (!API_KEY) return fail(NEEDS_KEY);
    try {
      const body = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
      return ok(await call(API_BASE, '/v1/lab/backtests', { method: 'POST', body }));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_get_backtest',
  {
    title: 'Strategy Lab: a backtest and its report',
    description:
      'A backtest by id: its status (queued / running / done / failed) and, when done, the full SIMULATED report (per-$10 P&L, copies, the no-selection control, without-best-wallet, capacity, funnel, per wallet, daily). Needs POLYRANK_API_KEY.',
    inputSchema: { id: z.string().uuid() },
    annotations: READ_ONLY,
  },
  async ({ id }) => {
    if (!API_KEY) return fail(NEEDS_KEY);
    try {
      return ok(await api(`/v1/lab/backtests/${encodeURIComponent(id)}`));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_start_paper',
  {
    title: 'Strategy Lab: start paper trading',
    description:
      'Start paper trading a saved strategy: from now on every signal of its wallets is scored against the real order book (no orders, no keys, no money). One active run per strategy. Needs POLYRANK_API_KEY (plan feature paper_trading).',
    inputSchema: { strategy_id: z.string().uuid() },
    annotations: WRITE,
  },
  async ({ strategy_id }) => {
    if (!API_KEY) return fail(NEEDS_KEY);
    try {
      return ok(
        await call(API_BASE, `/v1/lab/strategies/${encodeURIComponent(strategy_id)}/paper`, {
          method: 'POST',
        }),
      );
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  'polyrank_get_paper_run',
  {
    title: 'Strategy Lab: a paper run',
    description:
      "A paper run by id with the grader's stats (copies, resolved, P&L per $10, entry vs the leader, the paper gate) and its copies, each with its fate (copied / no_fill / leader_sold / capped / skipped + reason). Needs POLYRANK_API_KEY.",
    inputSchema: {
      id: z.string().uuid(),
      outcome: z.enum(['copied', 'no_fill', 'leader_sold', 'capped', 'skipped']).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    },
    annotations: READ_ONLY,
  },
  async ({ id, outcome, limit, offset }) => {
    if (!API_KEY) return fail(NEEDS_KEY);
    try {
      const qs = new URLSearchParams();
      if (outcome) qs.set('outcome', outcome);
      if (limit !== undefined) qs.set('limit', String(limit));
      if (offset !== undefined) qs.set('offset', String(offset));
      const q = qs.toString();
      return ok(await api(`/v1/lab/paper-runs/${encodeURIComponent(id)}${q ? `?${q}` : ''}`));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(
    `Polyrank MCP server ${VERSION} running (stdio) → ${API_BASE}${API_KEY ? ' (API key set)' : ''}`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Polyrank MCP server failed to start:', err);
  process.exit(1);
});
