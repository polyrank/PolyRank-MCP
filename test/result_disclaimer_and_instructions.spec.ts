/**
 * Three fixes from a live Claude-connector test on https://mcp.polyrank.app/mcp/public (2026-11-07, 18:08–18:12Z):
 *   1. every tool result carries the disclaimer (a `disclaimer` field + a text block), simulated or not — the
 *      non-simulated results had none; simulated ones keep the 4.41 statement as well. Both lead the result (the
 *      authed test saw a client cut a long result at ~4 KB): [4.41 statement,] disclaimer, then the JSON;
 *   2. the server `instructions` spell the brand "Polyrank (polyrank.app)" (the model wrote "PolyRank" throughout)
 *      and, on /mcp/public, name the 19 tools that exist on /mcp with an API key;
 *   3. no /mcp/public tool text points at a tool /mcp/public does not list, unless it says where that tool is.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATA_DISCLAIMER, LAB_TOOLS, serverInstructions } from '../src/index.js';
import { MCP_FREE_TOOLS, MCP_KEY_TOOLS } from '../src/server_card.js';
import {
  API,
  INIT,
  VALID_KEY,
  baseConfig,
  callTool,
  fakeUpstream,
  listTools,
  rpc,
  startServer,
} from './helpers.js';

const FOOTER = 'Data, not investment advice. Polyrank is not affiliated with Polymarket.';
const AUTH = { authorization: `Bearer ${VALID_KEY}` };

// The shared fake upstream, plus one simulated Lab read (a backtest) answering 200.
const base = fakeUpstream();
const upstream = {
  calls: base.calls,
  impl: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`${API}/v1/lab/backtests/0b7f3c1e-2d4a-4b5c-9e8f-1a2b3c4d5e6f`)) {
      await base.impl(input, init);
      return new Response(
        JSON.stringify({
          id: '0b7f3c1e-2d4a-4b5c-9e8f-1a2b3c4d5e6f',
          status: 'done',
          total_return_pct: 4.2,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    return base.impl(input, init);
  }) as typeof fetch,
};

let srv: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  srv = await startServer(baseConfig(), upstream);
});
afterAll(async () => srv.close());

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};
const result = async (path: string, name: string, args = {}, headers = {}) =>
  (await callTool(`${srv.base}${path}`, name, args, headers)).body.result as ToolResult;

describe('1. every tool result carries the disclaimer', () => {
  it('the wording', () => {
    expect(DATA_DISCLAIMER).toBe(FOOTER);
  });

  it.each(['/mcp', '/mcp/public'])(
    'a free read on %s: structured field (first key) + text block, then the JSON',
    async (p) => {
      const r = await result(p, 'polyrank_get_platform_stats');
      expect(r.isError).toBeUndefined();
      expect(r.structuredContent.disclaimer).toBe(FOOTER);
      expect(r.structuredContent.wallets).toBe(3);
      expect(Object.keys(r.structuredContent)[0]).toBe('disclaimer');
      expect(r.content).toHaveLength(2);
      expect(r.content[0]).toEqual({ type: 'text', text: FOOTER });
      expect(JSON.parse(r.content[1]!.text)).toMatchObject({ wallets: 3 });
    },
  );

  it('a keyed read carries it too', async () => {
    const r = await result('/mcp', 'polyrank_rank_wallets', { weights: { brier: 1 } }, AUTH);
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.disclaimer).toBe(FOOTER);
    expect(r.content[0]!.text).toBe(FOOTER);
  });

  it('a simulated result keeps the 4.41 statement AND carries the disclaimer', async () => {
    const r = await result(
      '/mcp',
      'polyrank_get_backtest',
      { id: '0b7f3c1e-2d4a-4b5c-9e8f-1a2b3c4d5e6f' },
      AUTH,
    );
    expect(r.isError).toBeUndefined();
    expect(String(r.structuredContent.simulated_results_notice)).toMatch(/simulated/i);
    expect(r.structuredContent.disclaimer).toBe(FOOTER);
    expect(Object.keys(r.structuredContent).slice(0, 2)).toEqual([
      'simulated_results_notice',
      'disclaimer',
    ]);
    expect(r.content[0]!.text).toMatch(/simulated or hypothetical performance/);
    expect(r.content[1]!.text).toBe(FOOTER);
    expect(JSON.parse(r.content[2]!.text)).toMatchObject({ status: 'done' });
  });
});

describe('2. server instructions', () => {
  const instructionsOf = async (p: string) =>
    (await rpc(`${srv.base}${p}`, INIT)).body.result.instructions as string;

  it.each(['/mcp', '/mcp/public'])(
    '%s spells the brand "Polyrank (polyrank.app)", never "PolyRank"',
    async (p) => {
      const i = await instructionsOf(p);
      expect(i).toContain('Polyrank (polyrank.app)');
      expect(i).not.toMatch(/PolyRank/);
      expect(i).toContain(FOOTER);
    },
  );

  it('/mcp/public names every one of the 19 keyed tools, where they are and how to get a key', async () => {
    const i = await instructionsOf('/mcp/public');
    expect(MCP_KEY_TOOLS).toHaveLength(19);
    expect(i).toContain('19 more tools are on https://mcp.polyrank.app/mcp');
    for (const t of MCP_KEY_TOOLS) expect(i, t).toContain(t);
    expect(i).toContain('pk_live_');
    expect(i).toContain('https://polyrank.app/api-keys');
    expect(i).toMatch(/Free included/);
  });

  it('/mcp says which 19 tools need a key, without pointing elsewhere', async () => {
    const i = await instructionsOf('/mcp');
    expect(i).toContain('19 tools need a Polyrank API key (Authorization: Bearer pk_live_…)');
    expect(i).not.toContain('/mcp/public');
  });

  it('the Lab list is the 16 keyed tools after resolve_tid, rank_wallets, get_trader_metrics', () => {
    expect(MCP_KEY_TOOLS.slice(0, 3)).toEqual([
      'polyrank_resolve_tid',
      'polyrank_rank_wallets',
      'polyrank_get_trader_metrics',
    ]);
    expect(LAB_TOOLS).toHaveLength(16);
  });

  it('stdio names the env var instead of the header', () => {
    expect(serverInstructions('all', 'stdio')).toContain('POLYRANK_API_KEY');
  });
});

describe('3. no dangling tool names on /mcp/public', () => {
  it('every polyrank_* a public tool text names is listed on /mcp/public, or says it is on the full server', async () => {
    const pub = await listTools(`${srv.base}/mcp/public`);
    const listed = new Set(pub.map((t) => t.name));
    expect([...listed].sort()).toEqual([...MCP_FREE_TOOLS].sort());
    for (const t of pub) {
      const text = `${t.title ?? ''} ${t.description ?? ''}`;
      for (const m of text.matchAll(/polyrank_[a-z_]+/g)) {
        if (listed.has(m[0])) continue;
        expect(text.slice(m.index!, m.index! + m[0].length + 60), `${t.name} → ${m[0]}`).toContain(
          `${m[0]} (available on the full server with an API key)`,
        );
      }
    }
  });

  it('the full server names polyrank_rank_wallets plainly (it is listed there)', async () => {
    const all = await listTools(`${srv.base}/mcp`);
    const cat = all.find((t) => t.name === 'polyrank_get_metrics_catalog')!;
    expect(cat.description).toContain('metric_filters of polyrank_rank_wallets. Free');
  });
});
