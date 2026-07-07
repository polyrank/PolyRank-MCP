#!/usr/bin/env node
/**
 * Polyrank MCP server — lets any LLM agent (Claude, etc.) query Polyrank's
 * Polymarket skill analytics directly. Wraps the free public /v1/public/* API;
 * deep/premium signals are billed per-request via x402 (see llms.txt).
 *
 * Transport: stdio (agents launch it locally, e.g. `npx @polyrank/mcp`).
 * All tools are READ-ONLY against a public, cached API.
 *
 * Config: POLYRANK_API_BASE (default https://api.polyrank.app).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = process.env.POLYRANK_API_BASE ?? 'https://api.polyrank.app';

/** GET the public API and return parsed JSON, or throw an actionable error. */
async function api<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(
      `Could not reach Polyrank at ${API_BASE}${path}: ${(err as Error).message}. Check network or POLYRANK_API_BASE.`,
    );
  }
  if (res.status === 404)
    throw new Error(`Not found: ${path}. Check the wallet address / market id.`);
  if (res.status === 400)
    throw new Error(
      `Bad request: ${path}. Check the address (0x + 40 hex) or market id (0x + 64 hex, or a slug).`,
    );
  if (!res.ok) throw new Error(`Polyrank API ${res.status} for ${path}.`);
  return (await res.json()) as T;
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

const server = new McpServer({ name: 'polyrank', version: '0.2.0' });

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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(`Polyrank MCP server running (stdio) → ${API_BASE}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Polyrank MCP server failed to start:', err);
  process.exit(1);
});
