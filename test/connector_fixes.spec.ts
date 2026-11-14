/**
 * Four fixes from the authed connector test (36 tools, the founder's key, 2026-11-07 18:2xZ):
 *   1. polyrank_rank_wallets could not rank a history board: the tool demanded weights, the API refuses weights on a
 *      history board AND refuses filters.history_board on POST /v1/rankings/custom (preset-only). The tool now serves
 *      it from GET /v1/rankings/preset/<board>, and says which keys a history board takes.
 *   2. the 4.41 statement never reached the user (last key of a long JSON, cut at ~4 KB): it is the FIRST text block
 *      and the first structured key of every simulated result (also pinned in lab_chat_tools.spec.ts), and the
 *      instructions say to show it and the disclaimer verbatim.
 *   3. polyrank_lab_ask ran with no confirmation: the tools that spend AI credits, use a daily backtest or write to the
 *      account require confirm: true, and their descriptions say to ask the user first.
 *   4. polyrank_get_lab_limits printed dollars ("agent_daily_usd") and no balance: it answers in credits.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HISTORY_BOARDS,
  historyBoardCall,
  labLimitsView,
  serverInstructions,
} from '../src/index.js';
import { API, VALID_KEY, baseConfig, callTool, fakeUpstream, rpc, startServer } from './helpers.js';

const AUTH = { authorization: `Bearer ${VALID_KEY}` };
const SID = '11111111-1111-4111-8111-111111111111';
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const LIMITS = {
  strategy_lab: true,
  paper_trading: true,
  lab_strategies_max: 20,
  lab_backtests_per_day: 30,
  lab_paper_runs_max: 3,
  agent_daily_usd: 20,
  lab_own_rules: true,
  credits_monthly: 2000,
  agent_model: 'claude-sonnet-5-5',
  agent_deep_mode: true,
  lab_agent_concurrent: 2,
  used: {
    strategies: 2,
    backtests_today: 1,
    pending_backtests: 0,
    active_paper_runs: 1,
    agent_conversations: 0,
  },
};
const CREDITS = {
  allowance: 1500,
  topup: 250,
  total: 1750,
  period_end: '2026-12-01T00:00:00Z',
  resets_label: 'resets 1 Dec',
  allowance_granted: 2000,
  typical_turn_credits: 13,
  reserve: 25,
  daily_ceiling: 500,
  spent_today: 40,
  blocked: null,
  blocked_message: null,
  plan_id: 'lab',
  model: 'claude-sonnet-5-5',
  deep_mode: true,
  deep_model: 'claude-opus-5-5',
  deep_mode_multiplier: 2,
  packs: [{ id: 'p1', usd: 10, credits: 500 }],
  price_line: '$1 = 50 credits',
  modes: [],
  custom_topup: { min_usd: 5, max_usd: 500, preset_usd: 20 },
  last_mode: null,
  start_mode: 'standard',
};

const base = fakeUpstream();
const upstream = {
  calls: base.calls,
  impl: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`${API}/v1/rankings/preset/`)) {
      await base.impl(input, init);
      return json({ rows: [{ rank: 1, proxy_wallet: '0xabc' }], total_rows: 1 });
    }
    if (url === `${API}/v1/lab/limits`) {
      await base.impl(input, init);
      return json(LIMITS);
    }
    if (url === `${API}/v1/lab/credits`) {
      await base.impl(input, init);
      return json(CREDITS);
    }
    return base.impl(input, init);
  }) as typeof fetch,
};

let srv: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  srv = await startServer(baseConfig(), upstream);
});
afterAll(async () => srv.close());

const call = (name: string, args: Record<string, unknown>) =>
  callTool(`${srv.base}/mcp`, name, args, AUTH).then((r) => r.body.result);

describe('1. history boards', () => {
  it('the four keys are the billing list', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../packages/billing/src/history_board_keys.ts'),
      'utf8',
    );
    const keys = [...src.matchAll(/^\s+'([a-z-]+)',$/gm)].map((m) => m[1]);
    expect([...HISTORY_BOARDS]).toEqual(keys);
  });

  it('a history-board call is served from the preset board, with no weights and its query', async () => {
    const before = upstream.calls.length;
    const r = await call('polyrank_rank_wallets', {
      filters: { history_board: { board: 'copier-consensus' }, active_within_days: 7 },
      limit: 10,
      include_verdict: true,
      extra_metrics: ['brier', 'roi_pct'],
    });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.rows).toHaveLength(1);
    // the hosted server also verifies the key upstream; the ranking itself is ONE call
    const sent = upstream.calls.slice(before).filter((c) => c.url.startsWith(`${API}/v1/rankings`));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('GET');
    expect(sent[0]!.url).toBe(
      `${API}/v1/rankings/preset/copier-consensus?active_within_days=7&limit=10&include_verdict=true&extra_metrics=brier%2Croi_pct`,
    );
    expect(sent[0]!.headers['authorization']).toBe(`Bearer ${VALID_KEY}`);
  });

  it('a template request carrying the board works the same way', () => {
    expect(
      historyBoardCall({
        weights: {},
        filters: { history_board: { board: 'sports-closing-line' } },
      }),
    ).toEqual({ path: '/v1/rankings/preset/sports-closing-line' });
  });

  it.each([
    [
      { filters: { history_board: { board: 'nope' } } },
      /board one of: underdog-specialists, copier-consensus/,
    ],
    [
      { filters: { history_board: { board: 'copier-consensus', window_days: 30 } } },
      /not accepted: window_days/,
    ],
    [
      { filters: { history_board: { board: 'copier-consensus' }, score: 'x', min_positions: 3 } },
      /not accepted: score, min_positions/,
    ],
    [
      {
        filters: { history_board: { board: 'copier-consensus' } },
        weights: { brier: { weight: 1 } },
      },
      /carries no weights/,
    ],
    [
      { filters: { history_board: { board: 'copier-consensus' } }, as_of: '2026-10-01' },
      /no as_of/,
    ],
  ])('refuses %j with the reason, before any call', (body, msg) => {
    const r = historyBoardCall(body as Record<string, unknown>);
    expect(r).not.toBeNull();
    expect((r as { error: string }).error).toMatch(msg);
  });

  it('a body without history_board is not a history board', () => {
    expect(historyBoardCall({ weights: { brier: 1 }, filters: { min_trades: 5 } })).toBeNull();
    expect(historyBoardCall({ weights: { brier: 1 } })).toBeNull();
  });

  it('the description says what a history board takes', async () => {
    const tools = (await rpc(`${srv.base}/mcp`, { jsonrpc: '2.0', id: 9, method: 'tools/list' }))
      .body.result.tools as Array<{ name: string; description: string }>;
    const d = tools.find((t) => t.name === 'polyrank_rank_wallets')!.description;
    expect(d).toContain(
      'board one of underdog-specialists | copier-consensus | predictors-early-underdog | sports-closing-line and NO weights',
    );
    expect(d).toContain(
      'window_days, score, min_positions, one_per_operator and other keys are not accepted there',
    );
  });
});

describe('2. the 4.41 statement leads every simulated result', () => {
  it('the instructions say to show it and the disclaimer verbatim', () => {
    for (const i of [serverInstructions('all', 'http'), serverInstructions('public', 'http')])
      expect(i).toContain(
        'Always show simulated_results_notice and disclaimer to the user verbatim.',
      );
  });
});

describe('3. confirm: true on credit-spending and account-writing tools', () => {
  const CONFIRMED = [
    'polyrank_create_strategy',
    'polyrank_run_backtest',
    'polyrank_start_paper',
    'polyrank_update_strategy',
    'polyrank_lab_ask',
    'polyrank_lab_reply',
  ];
  let tools: Array<{ name: string; description: string; inputSchema: any }>;
  beforeAll(async () => {
    tools = (await rpc(`${srv.base}/mcp`, { jsonrpc: '2.0', id: 9, method: 'tools/list' })).body
      .result.tools;
  });

  it.each(CONFIRMED)('%s requires confirm: true and says to ask the user first', (name) => {
    const t = tools.find((x) => x.name === name)!;
    expect(t.inputSchema.required).toContain('confirm');
    expect(
      t.inputSchema.properties.confirm.const ?? t.inputSchema.properties.confirm.enum?.[0],
    ).toBe(true);
    expect(t.description).toMatch(/ask the user before calling, then pass confirm: true\./);
  });

  it('the two AI-credit tools say so first', () => {
    for (const n of ['polyrank_lab_ask', 'polyrank_lab_reply'])
      expect(tools.find((x) => x.name === n)!.description).toMatch(
        /^Spends the account's AI credits: ask the user before calling/,
      );
  });

  it.each([
    ['polyrank_lab_ask', { message: 'hi' }],
    ['polyrank_lab_reply', { id: SID, message: 'hi' }],
    ['polyrank_run_backtest', { strategy_id: SID, from: '2026-08-01', to: '2026-09-01' }],
    ['polyrank_start_paper', { strategy_id: SID }],
    ['polyrank_create_strategy', { name: 'x', template_id: 't' }],
    ['polyrank_update_strategy', { id: SID, name: 'y' }],
  ])('%s without confirm is refused and calls nothing', async (name, args) => {
    const before = upstream.calls.length;
    const r = await call(name, args);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/confirm/);
    expect(upstream.calls.slice(before).filter((c) => c.url.startsWith(`${API}/v1/lab`))).toEqual(
      [],
    );
  });

  it('read tools take no confirm', () => {
    for (const n of [
      'polyrank_get_lab_limits',
      'polyrank_get_backtest',
      'polyrank_lab_get_chat',
      'polyrank_lab_stop',
    ])
      expect(tools.find((x) => x.name === n)!.inputSchema.properties?.confirm, n).toBeUndefined();
  });
});

describe('4. lab limits in credits, never dollars', () => {
  it('the tool answers the balance, today and the ceiling in credits, and no dollar field or sign', async () => {
    const r = await call('polyrank_get_lab_limits', {});
    expect(r.isError).toBeUndefined();
    const out = r.structuredContent;
    expect(out).toMatchObject({
      credits_balance: 1750,
      credits_used_today: 40,
      daily_ceiling_credits: 500,
      credits_allowance_left: 1500,
      credits_topup: 250,
      credits_resets: 'resets 1 Dec',
      typical_question_credits: 13,
      lab_backtests_per_day: 30,
      used: LIMITS.used,
    });
    expect(out).not.toHaveProperty('agent_daily_usd');
    const all = r.content.map((c: { text: string }) => c.text).join('\n') + JSON.stringify(out);
    expect(all).not.toMatch(/usd/i);
    expect(all).not.toContain('$');
  });

  it('a credits read that fails leaves the limits and says so', () => {
    const v = labLimitsView(LIMITS, { error: 'Polyrank API 404' });
    expect(v).not.toHaveProperty('agent_daily_usd');
    expect(v).toMatchObject({
      credits: null,
      credits_error: 'Polyrank API 404',
      lab_paper_runs_max: 3,
    });
  });
});
