#!/usr/bin/env node
/**
 * Polyrank MCP server: lets any LLM agent (Claude, etc.) query Polyrank's Polymarket skill analytics directly.
 *
 *   - Free tools wrap the public /v1/public/* API and the free agent manifests (metric catalog, metric windows,
 *     Builder goals). No key.
 *   - With a Polyrank API key (a pk_live_… key from polyrank.app/api-keys), the ranking, trader-metrics and
 *     Strategy Lab tools call the authenticated API with the key: the SAME POST /v1/rankings/custom the Ranking Builder
 *     runs (all metrics, weights, windows, filters, as_of), plan-gated and quota-counted like any key call. The API is
 *     the only authority on a key: this server grants nothing itself.
 *
 * Transports:
 *   - stdio (default; what ships on npm today: `npx -y @polyrank/mcp`). The key is POLYRANK_API_KEY in the process env.
 *   - Streamable HTTP (MCP_HTTP_ENABLED=1, src/http.ts): the hosted server. The key is the caller's own
 *     `Authorization: Bearer pk_live_…` header, per request; the process env key is never used there.
 *
 * Both transports build their server from createPolyrankServer() below, so the tool set, the annotations and the
 * order (read-only tools first, the 7 writes last) are the same everywhere.
 *
 * Config: POLYRANK_API_BASE (default https://api.polyrank.app), POLYRANK_AGENT_BASE (default
 * https://api-agent.polyrank.app — only its free manifests are read), POLYRANK_API_KEY (stdio only).
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { McpServer, type ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const VERSION = '0.5.0';

export const DEFAULT_API_BASE = 'https://api.polyrank.app';
/** The x402 agent host. Only its FREE manifests are called (no payment is ever signed here). */
export const DEFAULT_AGENT_BASE = 'https://api-agent.polyrank.app';

/** `all`: the 36 tools (19 of them answer only with a key). `public`: the 17 free read-only tools, no key ever used. */
export type Toolset = 'all' | 'public';

export interface PolyrankServerOptions {
  /** Where the key comes from decides the wording of the "needs a key" answer. */
  transport: 'stdio' | 'http';
  /** The caller's key (stdio: POLYRANK_API_KEY; http: the request's bearer token). Absent = anonymous. */
  apiKey?: string;
  apiBase?: string;
  agentBase?: string;
  toolset?: Toolset;
  /** Extra headers on every upstream call (http: the caller's cf-connecting-ip, so the API keys its limits per caller). */
  upstreamHeaders?: Record<string, string>;
  /** Injected in specs. */
  fetchImpl?: typeof fetch;
}

/** Per-tool access tier, in each tool's `_meta` (reverse-DNS key, as MCP asks for `_meta` keys). */
export const ACCESS_META_KEY = 'app.polyrank/access';
export type Access = 'free' | 'api_key' | 'lab';
const FREE = { [ACCESS_META_KEY]: 'free' satisfies Access };
const KEYED = { [ACCESS_META_KEY]: 'api_key' satisfies Access };
const LAB = { [ACCESS_META_KEY]: 'lab' satisfies Access };

/**
 * Every read tool: it reads Polyrank's own API and changes nothing, so a repeat call has no further effect. The domain
 * is closed (Polyrank's dataset, not the open web): openWorldHint false.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies ToolAnnotations;
/**
 * The Strategy Lab writes: each creates or changes a record in the caller's own Polyrank account (a saved strategy, a
 * queued backtest, a paper run with no money, an edited strategy, an assistant chat and its answer, which spends the
 * account's AI credits). None deletes anything or touches funds (destructiveHint false); calling twice creates a second
 * record (idempotentHint false), except start_paper (one active run per strategy, 409 on a repeat), update_strategy
 * and lab_stop (the same call again changes nothing more).
 */
export const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const satisfies ToolAnnotations;

const WINDOWS = ['lifetime', '90d', '30d', '7d', '24h'] as const;

const WeightValue = z.union([
  z.number().positive(),
  z.object({ weight: z.number().positive(), window: z.enum(WINDOWS).optional() }),
]);

function needsKeyMessage(transport: 'stdio' | 'http'): string {
  const get =
    'This tool needs a Polyrank API key: create one at https://polyrank.app/api-keys (a plan with the Ranking Builder / Strategy Lab; the Strategy Lab tools need a paid plan with the Lab)';
  return transport === 'http'
    ? `${get}, then connect to this server with the header "Authorization: Bearer pk_live_…".`
    : `${get}, then set POLYRANK_API_KEY in this MCP server's environment.`;
}

/** A tool result: pretty JSON text + the structured object (MCP's structuredContent must be a JSON object). */
function ok(data: unknown) {
  const structured =
    data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { result: data };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: structured,
  };
}
/**
 * A result that carries SIMULATED figures (a backtest, a paper run, a strategy's backtest headline, a chat's answer):
 * the object as `ok` returns it, plus the CFTC Rule 4.41 statement verbatim (Lab lead review 2026-11-07: every Lab
 * tool that shows a simulated figure carries it, as the page does under every simulated result).
 */
function okSimulated(data: unknown) {
  const obj =
    data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { result: data };
  return ok({ ...obj, simulated_results_notice: CFTC_4_41_STATEMENT_TEXT });
}
function fail(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** Build one MCP server. stdio builds one per connection, HTTP one per request (stateless). */
export function createPolyrankServer(opts: PolyrankServerOptions): McpServer {
  const API_BASE = opts.apiBase ?? DEFAULT_API_BASE;
  const AGENT_BASE = opts.agentBase ?? DEFAULT_AGENT_BASE;
  const API_KEY = opts.apiKey !== undefined && opts.apiKey !== '' ? opts.apiKey : undefined;
  const NEEDS_KEY = needsKeyMessage(opts.transport);
  const toolset: Toolset = opts.toolset ?? 'all';
  const doFetch = opts.fetchImpl ?? fetch;
  const userAgent = `polyrank-mcp/${VERSION} (${opts.transport})`;

  /**
   * Call the API and return parsed JSON, or throw an actionable error. A non-2xx answer is reported WITH the server's
   * own message — a 400 from the ranking or Lab API names exactly which metric, window or filter was refused and why,
   * and an agent can only fix what it is told.
   */
  async function call<T>(
    base: string,
    path: string,
    init: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const method = init.method ?? 'GET';
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': userAgent,
          ...(opts.upstreamHeaders ?? {}),
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(API_KEY && init.auth !== false ? { Authorization: `Bearer ${API_KEY}` } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new Error(
        opts.transport === 'http'
          ? `Could not reach Polyrank for ${path}: ${(err as Error).message}. Try again in a moment.`
          : `Could not reach Polyrank at ${base}${path}: ${(err as Error).message}. Check network or POLYRANK_API_BASE / POLYRANK_AGENT_BASE.`,
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
      if (res.status === 409) throw new Error(`Polyrank API 409 for ${path}: ${detail}`.trim());
      if (res.status === 429) throw new Error(`Polyrank API 429 for ${path}: ${detail}`.trim());
      throw new Error(`Polyrank API ${res.status} for ${method} ${path}. ${detail}`.trim());
    }
    return (await res.json()) as T;
  }

  /** GET the main API (the original helper — the public tools use it). */
  async function api<T>(path: string): Promise<T> {
    return call<T>(API_BASE, path);
  }

  const server = new McpServer({ name: 'polyrank', version: VERSION });

  // ── Read-only, free, no key (17). Listed first. ──

  server.registerTool(
    'polyrank_get_leaderboard',
    {
      title: 'Polyrank skill leaderboard',
      description:
        'Top Polymarket traders ranked by genuine SKILL (calibration/Brier, alpha-vs-mid, risk-adjusted return) — not vanity P&L or win rate. Returns rank, composite score, identity, P&L, win-rate, volume. Use it to find traders to study.',
      inputSchema: z.object({
        preset: z
          .string()
          .optional()
          .describe(
            'Ranking preset id (default "polyrank-default", the calibration-heavy headline ranking).',
          ),
        limit: z.number().int().min(1).max(25).optional().describe('Rows to return (max 25).'),
      }),
      annotations: READ_ONLY,
      _meta: FREE,
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
      inputSchema: z.object({
        address: z.string().describe('Proxy wallet address (0x + 40 hex).'),
      }),
      annotations: READ_ONLY,
      _meta: FREE,
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
      inputSchema: z.object({
        address: z.string().describe('Proxy wallet address (0x + 40 hex).'),
      }),
      annotations: READ_ONLY,
      _meta: FREE,
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
        'Skill-weighted holder consensus on a Polymarket market vs the market mid (the Polyrank-vs-mid delta), plus 24h volume/fills, positioner counts, and top holders. Accepts a conditionId (0x + 64 hex) or a market slug.',
      inputSchema: z.object({
        market: z.string().describe('conditionId (0x + 64 hex) or market slug.'),
      }),
      annotations: READ_ONLY,
      _meta: FREE,
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
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      _meta: FREE,
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
        'Live Polyrank coverage and the canonical skill-metric count: wallets scored (`wallets`), raw fill events indexed (`trades`), markets covered, the number of skill metrics in the catalog, and the earliest market year in the data (`since_year`; on-chain order-book fills start 2022-11-21): the live source for "N wallets / N metrics" figures.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      _meta: FREE,
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
      inputSchema: z.object({
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
      }),
      annotations: READ_ONLY,
      _meta: FREE,
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
      inputSchema: z.object({
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
      }),
      annotations: READ_ONLY,
      _meta: FREE,
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
      title: 'Polyrank Skill Report archive',
      description:
        'The archive of Polyrank weekly Skill Reports (published each week): a list of report ids/weeks with summaries. Fetch one in full with polyrank_get_smart_money_report.',
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(104)
          .optional()
          .describe('How many recent reports to list (max 104, default 52).'),
      }),
      annotations: READ_ONLY,
      _meta: FREE,
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
      title: 'Polyrank Skill Report (one week)',
      description:
        'One Polyrank weekly Skill Report in full: big wins, skill-rank movers, new entrants, the calibration leader, consensus divergence, and the editorial intro. Pass the week/report id from polyrank_get_smart_money_reports.',
      inputSchema: z.object({
        week: z.string().describe('Report/week id from the archive, e.g. "2026-w26".'),
      }),
      annotations: READ_ONLY,
      _meta: FREE,
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
      inputSchema: z.object({
        tid: z.string().describe('Opaque trader id (tid) from a masked row.'),
      }),
      annotations: READ_ONLY,
      _meta: FREE,
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
      inputSchema: z.object({
        tid: z.string().describe('Opaque trader id (tid) from a masked row.'),
      }),
      annotations: READ_ONLY,
      _meta: FREE,
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
      inputSchema: z.object({
        slug: z.string().describe('Published ranking slug from a /r/<slug> share link.'),
      }),
      annotations: READ_ONLY,
      _meta: FREE,
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
    'polyrank_get_traders_batch',
    {
      title: 'Polyrank trader teasers (batch, by masked id)',
      description:
        'Fetch the free masked skill teaser for several traders at once by their opaque masked ids (tids). Same per-trader payload as polyrank_get_trader_by_tid, capped at 10 tids per call. No API key needed. Each result is tagged with its tid, and per-tid failures are returned inline (as an error field) rather than failing the whole batch.',
      inputSchema: z.object({
        tids: z
          .array(z.string())
          .min(1)
          .max(10)
          .describe('Opaque trader ids (tids) from masked rows (max 10).'),
      }),
      annotations: READ_ONLY,
      _meta: FREE,
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

  server.registerTool(
    'polyrank_get_metrics_catalog',
    {
      title: 'Polyrank metric catalog (every rankable metric)',
      description:
        'The full catalog of displayable Polyrank metrics (84): id, name, description, category, direction (higher/lower is better), the windows each is available at, and whether it is advanced. This is the vocabulary for polyrank_rank_wallets weights, skill_gates and metric_filters. Free, no key.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      _meta: FREE,
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
        'Which metric exists at which window (lifetime / 90d / 30d / 7d / 24h), whether it can be weighted, gated or filtered, the copy-engine and entry-timing ids (lifetime-pinned), and what a back-dated board (as_of) can answer: its metrics, the filters it honours and the reason for each it refuses. The reference for ranking at a window or as_of. Free, no key.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      _meta: FREE,
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
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      _meta: FREE,
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

  // The 9 tools below are scoped to a Polyrank account. The public endpoint (toolset "public") lists none of them.
  if (toolset === 'public') return server;

  // ── Read-only, with a key (3 + 3 Strategy Lab reads). ──

  server.registerTool(
    'polyrank_resolve_tid',
    {
      title: 'Polyrank resolve masked id → wallet (API key required)',
      description:
        'Resolve an opaque masked id (tid) to the underlying proxy wallet address. Requires a Polyrank API key (pk_live_… / pk_test_…): set POLYRANK_API_KEY. The MCP sends it as a Bearer token and the API key-auth accepts it — no browser session needed. Then use the resolved wallet with polyrank_get_trader_skill / polyrank_get_trader_calibration.',
      inputSchema: z.object({
        tid: z.string().describe('Opaque trader id (tid) from a masked row.'),
      }),
      annotations: READ_ONLY,
      _meta: KEYED,
    },
    async ({ tid }) => {
      try {
        if (!API_KEY) return fail(NEEDS_KEY);
        return ok(await api(`/v1/t/${encodeURIComponent(tid)}/resolve`));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'polyrank_rank_wallets',
    {
      title: 'Polyrank Ranking Builder (custom composite ranking)',
      description:
        'Rank every Polymarket wallet with your own composite — exactly what the Ranking Builder runs (POST /v1/rankings/custom). weights: metric id → weight (or {weight, window}); any of the 84 catalog metrics at any window it exists at (polyrank_get_metric_windows), plus copy-engine (sk_score_14d) and entry-timing ids at lifetime. filters: min_trades, min_resolved, min_volume_usdc, min_realized_pnl(_net_fees), min_win_rate_pct, max_roi_pct, active_within_days/hours, categories, exclude_bonders, skill_gates [{metric,min_pctile,window}], metric_filters [{metric,min,max,window}], copy_engine {sleeve}, timing {sub,bucket,window,min_n}, cluster_policy, copy_placeable, smart_money_tags_any_of, follower_count_max … (the server rejects anything it cannot apply, with the reason). as_of=YYYY-MM-DD ranks the board as it stood that day (lifetime snapshot metrics only — refused with the reason otherwise, never answered live). To reproduce a Builder goal, pass its `request` from polyrank_list_ranking_templates as `request`. Needs POLYRANK_API_KEY (a plan with the Builder).',
      inputSchema: z.object({
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
        dedupe_clusters: z
          .boolean()
          .optional()
          .describe('Keep one wallet per wallet-farm cluster.'),
        explain: z.boolean().optional().describe('How many wallets each filter dropped.'),
      }),
      annotations: READ_ONLY,
      _meta: KEYED,
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
      inputSchema: z.object({
        address: z.string().optional().describe('Proxy wallet address (0x + 40 hex).'),
        tid: z
          .string()
          .optional()
          .describe('Masked trader id from a public board (resolved with your key).'),
        window: z.enum(WINDOWS).optional().describe('Default lifetime.'),
        scope: z.enum(['combined', 'wallet']).optional(),
      }),
      annotations: READ_ONLY,
      _meta: KEYED,
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
        const qs = new URLSearchParams({
          window: window ?? 'lifetime',
          ...(scope ? { scope } : {}),
        });
        return ok(await api(`/v1/trader/${encodeURIComponent(wallet)}/metrics?${qs.toString()}`));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'polyrank_list_lab_templates',
    {
      title: 'Strategy Lab templates',
      description:
        "The Strategy Lab's templates: research strategy families as editable strategy specs, each with its as-of evidence (SIMULATED, per $10 copied) and caveats. Copy one's `spec` (or its id) into polyrank_create_strategy / polyrank_run_backtest. Needs POLYRANK_API_KEY.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      _meta: LAB,
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
    'polyrank_get_backtest',
    {
      title: 'Strategy Lab: a backtest and its report',
      description:
        'A backtest by id: its status (queued / running / done / failed) and, when done, the full SIMULATED report (per-$10 P&L, copies, the no-selection control, without-best-wallet, capacity, funnel, per wallet, daily). Needs POLYRANK_API_KEY.',
      inputSchema: z.object({ id: z.string().uuid() }),
      annotations: READ_ONLY,
      _meta: LAB,
    },
    async ({ id }) => {
      if (!API_KEY) return fail(NEEDS_KEY);
      try {
        return okSimulated(await api(`/v1/lab/backtests/${encodeURIComponent(id)}`));
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
      inputSchema: z.object({
        id: z.string().uuid(),
        outcome: z.enum(['copied', 'no_fill', 'leader_sold', 'capped', 'skipped']).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      annotations: READ_ONLY,
      _meta: LAB,
    },
    async ({ id, outcome, limit, offset }) => {
      if (!API_KEY) return fail(NEEDS_KEY);
      try {
        const qs = new URLSearchParams();
        if (outcome) qs.set('outcome', outcome);
        if (limit !== undefined) qs.set('limit', String(limit));
        if (offset !== undefined) qs.set('offset', String(offset));
        const q = qs.toString();
        return okSimulated(
          await api(`/v1/lab/paper-runs/${encodeURIComponent(id)}${q ? `?${q}` : ''}`),
        );
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'polyrank_list_strategies',
    {
      title: 'Strategy Lab: your strategies',
      description:
        "Your saved strategies, newest first, each with its state and its latest backtest's headline (per $10 copied, copies; SIMULATED). `status` lists only one state: draft, backtested (tested), paper (paper trading), promotable (passed the paper gate), live, archived. Needs POLYRANK_API_KEY.",
      inputSchema: z.object({
        status: z.enum(STRATEGY_STATES).optional(),
        include_archived: z.boolean().optional(),
      }),
      annotations: READ_ONLY,
      _meta: LAB,
    },
    async ({ status, include_archived }) => {
      if (!API_KEY) return fail(NEEDS_KEY);
      try {
        const qs = new URLSearchParams();
        if (status) qs.set('status', status);
        if (include_archived) qs.set('include_archived', 'true');
        const q = qs.toString();
        return okSimulated(await api(`/v1/lab/strategies${q ? `?${q}` : ''}`));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'polyrank_get_strategy',
    {
      title: 'Strategy Lab: one strategy',
      description:
        'One of your strategies by id: its name, state and full strategy spec (wallet source, market, entry, sizing, exit). Edit it with polyrank_update_strategy. Needs POLYRANK_API_KEY.',
      inputSchema: z.object({ id: z.string().uuid() }),
      annotations: READ_ONLY,
      _meta: LAB,
    },
    async ({ id }) => {
      if (!API_KEY) return fail(NEEDS_KEY);
      try {
        return ok(await api(`/v1/lab/strategies/${encodeURIComponent(id)}`));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'polyrank_list_backtests',
    {
      title: 'Strategy Lab: your backtests',
      description:
        "Your recent backtests (all, or one strategy's), newest first, with status and headline (SIMULATED). Read one in full with polyrank_get_backtest. Needs POLYRANK_API_KEY.",
      inputSchema: z.object({
        strategy_id: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      annotations: READ_ONLY,
      _meta: LAB,
    },
    async ({ strategy_id, limit }) => {
      if (!API_KEY) return fail(NEEDS_KEY);
      try {
        const qs = new URLSearchParams();
        if (strategy_id) qs.set('strategy_id', strategy_id);
        if (limit !== undefined) qs.set('limit', String(limit));
        const q = qs.toString();
        return okSimulated(await api(`/v1/lab/backtests${q ? `?${q}` : ''}`));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'polyrank_get_lab_limits',
    {
      title: 'Strategy Lab: your plan limits and use',
      description:
        "Your plan's Strategy Lab limits and what is used now: backtests a day and today's, backtests waiting, paper runs at once, saved strategies, and the assistant chats answering at once (lab_agent_concurrent) against those answering now. Needs POLYRANK_API_KEY.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      _meta: LAB,
    },
    async () => {
      if (!API_KEY) return fail(NEEDS_KEY);
      try {
        return ok(await api('/v1/lab/limits'));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'polyrank_lab_list_chats',
    {
      title: 'Lab assistant: your chats',
      description:
        'Your Lab assistant chats, most recent first (at most 100): id, title, status (idle / queued / working / failed). Read one with polyrank_lab_get_chat. Needs POLYRANK_API_KEY (a paid plan; the assistant is part of every paid plan).',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      _meta: LAB,
    },
    async () => {
      if (!API_KEY) return fail(NEEDS_KEY);
      try {
        const r = await api<{ conversations: Record<string, unknown>[] }>(
          '/v1/lab/agent/conversations',
        );
        return ok({ conversations: r.conversations.map(chatRow) });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'polyrank_lab_get_chat',
    {
      title: 'Lab assistant: one chat',
      description:
        "One of your Lab assistant chats: its status, the questions and the assistant's answers with their notices and result cards (backtests, shortlists, strategies, tables). While a question waits, `queue_position` says how many are ahead; `awaiting_backtests` counts backtests the assistant started whose result will be posted to the chat by itself. Backtest and paper figures are SIMULATED. Needs POLYRANK_API_KEY.",
      inputSchema: z.object({
        id: z.string().uuid(),
        last: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Only the last N messages (default all).'),
      }),
      annotations: READ_ONLY,
      _meta: LAB,
    },
    async ({ id, last }) => {
      if (!API_KEY) return fail(NEEDS_KEY);
      try {
        return ok(chatView(await api<ChatData>(chatPath(id)), last));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // ── Writes (Strategy Lab, 7). Each creates or changes a record in the caller's own account; none deletes, none
  // touches funds. The chat tools spend the account's AI credits. Listed last. ──

  server.registerTool(
    'polyrank_create_strategy',
    {
      title: 'Strategy Lab: save a strategy',
      description:
        'Save a strategy to your Lab: a name plus a strategy spec (wallet source — any Builder ranking, a history ranking, a static wallet list or a copy-engine sleeve — and market, entry, sizing and exit rules), or a template_id to copy a template. The server validates the spec and answers with the reason when it refuses. Needs POLYRANK_API_KEY.',
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        spec: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('A strategy spec (see polyrank_list_lab_templates).'),
        template_id: z.string().optional(),
      }),
      annotations: WRITE,
      _meta: LAB,
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
      inputSchema: z.object({
        strategy_id: z.string().uuid().optional(),
        spec: z.record(z.string(), z.unknown()).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        cuts: z
          .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
          .max(60)
          .optional(),
      }),
      annotations: WRITE,
      _meta: LAB,
    },
    async (args) => {
      if (!API_KEY) return fail(NEEDS_KEY);
      try {
        const body = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
        return okSimulated(await call(API_BASE, '/v1/lab/backtests', { method: 'POST', body }));
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
      inputSchema: z.object({ strategy_id: z.string().uuid() }),
      annotations: { ...WRITE, idempotentHint: true },
      _meta: LAB,
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
    'polyrank_update_strategy',
    {
      title: 'Strategy Lab: edit a strategy',
      description:
        'Rename a saved strategy and/or replace its strategy spec (a changed spec makes it a draft again: its earlier backtests stay, tested on the old rules). The server validates the spec and answers with the reason when it refuses. Needs POLYRANK_API_KEY.',
      inputSchema: z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(120).optional(),
        spec: z.record(z.string(), z.unknown()).optional(),
      }),
      annotations: { ...WRITE, idempotentHint: true },
      _meta: LAB,
    },
    async ({ id, name, spec }) => {
      if (!API_KEY) return fail(NEEDS_KEY);
      if (name === undefined && spec === undefined)
        return fail('Give a new name, a new spec, or both.');
      try {
        return ok(
          await call(API_BASE, `/v1/lab/strategies/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: {
              ...(name !== undefined ? { name } : {}),
              ...(spec !== undefined ? { spec } : {}),
            },
          }),
        );
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  /** Ask, then wait (bounded) for the turn to end: the answer when it is in time, else the chat to poll. */
  async function askAndWait(id: string, waitSeconds: number | undefined) {
    const budgetMs =
      Math.min(CHAT_WAIT_MAX_S, Math.max(0, waitSeconds ?? CHAT_WAIT_DEFAULT_S)) * 1000;
    const deadline = Date.now() + budgetMs;
    let data = await api<ChatData>(chatPath(id));
    while (isAnswering(data) && Date.now() < deadline) {
      await new Promise((r) =>
        setTimeout(r, Math.min(CHAT_POLL_MS, Math.max(0, deadline - Date.now()))),
      );
      data = await api<ChatData>(chatPath(id));
    }
    return chatView(data, undefined, { sinceLastQuestion: true });
  }

  server.registerTool(
    'polyrank_lab_ask',
    {
      title: 'Lab assistant: ask in a new chat',
      description:
        "Start a Lab assistant chat with a question (research only: it finds traders, saves, backtests and paper-trades strategies in YOUR account, never places orders). Spends your plan's AI credits (a question needs 25 to start; a typical one costs about 13; `deep: true` runs the slower, more thorough mode, about twice the credits, Lab Pro and up). Your plan answers a number of chats at once (Pro Trader 2 … Enterprise 8; one more is refused 429 lab_agent_busy). Waits up to `wait_seconds` (default 45, max 55) for the answer; if it is still working, poll polyrank_lab_get_chat with the returned id. A long backtest it starts answers at once and its result is posted to the chat later. Results are SIMULATED. Needs POLYRANK_API_KEY.",
      inputSchema: z.object({
        message: z.string().min(1).max(8000),
        deep: z.boolean().optional(),
        wait_seconds: z.number().int().min(0).max(CHAT_WAIT_MAX_S).optional(),
      }),
      annotations: WRITE,
      _meta: LAB,
    },
    async ({ message, deep, wait_seconds }) => {
      if (!API_KEY) return fail(NEEDS_KEY);
      try {
        const c = await call<{ id: string }>(API_BASE, '/v1/lab/agent/conversations', {
          method: 'POST',
          body: { message, ...(deep ? { deep: true } : {}) },
        });
        return ok(await askAndWait(c.id, wait_seconds));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'polyrank_lab_reply',
    {
      title: 'Lab assistant: reply in a chat',
      description:
        'Send the next message in one of your Lab assistant chats (409 while it is still answering). Spends AI credits like polyrank_lab_ask and waits the same way for the answer. Needs POLYRANK_API_KEY.',
      inputSchema: z.object({
        id: z.string().uuid(),
        message: z.string().min(1).max(8000),
        wait_seconds: z.number().int().min(0).max(CHAT_WAIT_MAX_S).optional(),
      }),
      annotations: WRITE,
      _meta: LAB,
    },
    async ({ id, message, wait_seconds }) => {
      if (!API_KEY) return fail(NEEDS_KEY);
      try {
        await call(API_BASE, `${chatPath(id)}/messages`, { method: 'POST', body: { message } });
        return ok(await askAndWait(id, wait_seconds));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'polyrank_lab_stop',
    {
      title: 'Lab assistant: stop an answer',
      description:
        'Stop the Lab assistant answering in one of your chats: a question still queued is withdrawn; a running answer stops within about a second and keeps what it finished. A backtest it started keeps running. Needs POLYRANK_API_KEY.',
      inputSchema: z.object({ id: z.string().uuid() }),
      annotations: { ...WRITE, idempotentHint: true },
      _meta: LAB,
    },
    async ({ id }) => {
      if (!API_KEY) return fail(NEEDS_KEY);
      try {
        return ok(await call(API_BASE, `${chatPath(id)}/stop`, { method: 'POST' }));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  return server;
}

// ── the Lab assistant's chats (founder 2026-11-06: "also expose the chat") ─────────────────────────────────────────

/** The saved strategy states (the API's lab_strategies.status). */
export const STRATEGY_STATES = [
  'draft',
  'backtested',
  'paper',
  'promotable',
  'live',
  'archived',
] as const;
/** How long polyrank_lab_ask / _reply wait for the answer: MCP clients commonly give a tool call about a minute. */
export const CHAT_WAIT_DEFAULT_S = 45;
export const CHAT_WAIT_MAX_S = 55;
const CHAT_POLL_MS = 3_000;
/**
 * 17 CFR 4.41(b)(1)(i), verbatim: packages/shared-types/src/cftc_4_41.ts CFTC_4_41_STATEMENT_TEXT (this package ships
 * on its own; test/tool_inventory.spec.ts pins the two equal). Added to every chat answer and to every Lab result with simulated figures.
 */
export const CFTC_4_41_STATEMENT_TEXT =
  'These results are based on simulated or hypothetical performance results that have certain ' +
  'inherent limitations. Unlike the results shown in an actual performance record, these results ' +
  'do not represent actual trading. Also, because these trades have not actually been executed, ' +
  'these results may have under- or over-compensated for the impact, if any, of certain market ' +
  'factors, such as lack of liquidity. Simulated or hypothetical trading programs in general are ' +
  'also subject to the fact that they are designed with the benefit of hindsight. No ' +
  'representation is being made that any account will or is likely to achieve profits or losses ' +
  'similar to these being shown.';

interface ChatData {
  conversation: Record<string, unknown> & { id: string; status: string };
  messages: (Record<string, unknown> & { role: string; cards?: unknown[] })[];
  queue_position?: number | null;
  awaiting_backtests?: number;
}
const chatPath = (id: string) => `/v1/lab/agent/conversations/${encodeURIComponent(id)}`;
const isAnswering = (d: ChatData) =>
  d.conversation.status === 'queued' || d.conversation.status === 'working';
/** A chat as the agent reads it: no model id (the product names modes, never models). */
function chatRow(c: Record<string, unknown>) {
  const { model: _model, ...rest } = c;
  return rest;
}
/**
 * The chat for the caller: its status, the messages (all, the last N, or those since the latest question), the
 * queue position, the results still to come, a note on what to do next, and the 4.41 statement whenever it holds an
 * answer of the assistant.
 */
export function chatView(
  d: ChatData,
  last?: number,
  o: { sinceLastQuestion?: boolean } = {},
): Record<string, unknown> {
  let messages = d.messages;
  if (o.sinceLastQuestion) {
    const q = messages.map((m) => m.role).lastIndexOf('user');
    if (q >= 0) messages = messages.slice(q);
  } else if (last !== undefined) messages = messages.slice(-last);
  // every answer carries the statement (the page's AnswerFooter rule, Lab lead review 2026-11-07): an answer's TEXT
  // can quote a simulated figure with no card in the slice (a reply about an earlier backtest, `last: N`)
  const simulated = messages.some((m) => m.role === 'assistant');
  const status = d.conversation.status;
  const awaiting = d.awaiting_backtests ?? 0;
  const next =
    status === 'queued' || status === 'working'
      ? `Still ${status === 'queued' ? `queued${typeof d.queue_position === 'number' ? ` (${d.queue_position} ahead)` : ''}` : 'answering'}: call polyrank_lab_get_chat with id ${d.conversation.id} in a little while.`
      : awaiting > 0
        ? `Answered. ${awaiting} backtest${awaiting === 1 ? '' : 's'} it started will post ${awaiting === 1 ? 'its result' : 'their results'} to this chat when finished: read it again with polyrank_lab_get_chat.`
        : status === 'failed'
          ? 'The answer failed; see conversation.error.'
          : 'Answered.';
  return {
    conversation: chatRow(d.conversation),
    queue_position: d.queue_position ?? null,
    awaiting_backtests: awaiting,
    next,
    messages,
    ...(simulated ? { simulated_results_notice: CFTC_4_41_STATEMENT_TEXT } : {}),
  };
}

async function main(): Promise<void> {
  if (process.env['MCP_HTTP_ENABLED'] === '1') {
    const { startHttpServer } = await import('./http.js');
    await startHttpServer();
    return;
  }
  const apiBase = process.env['POLYRANK_API_BASE'] ?? DEFAULT_API_BASE;
  const apiKey = process.env['POLYRANK_API_KEY'];
  const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
  serveStdio(() =>
    createPolyrankServer({
      transport: 'stdio',
      ...(apiKey ? { apiKey } : {}),
      apiBase,
      agentBase: process.env['POLYRANK_AGENT_BASE'] ?? DEFAULT_AGENT_BASE,
    }),
  );
  // eslint-disable-next-line no-console
  console.error(
    `Polyrank MCP server ${VERSION} running (stdio) → ${apiBase}${apiKey ? ' (API key set)' : ''}`,
  );
}

/** True when this file is the process entry (node dist/index.js, the npx bin symlink, tsx src/index.ts), not an import. */
function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Polyrank MCP server failed to start:', err);
    process.exit(1);
  });
}
