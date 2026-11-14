/**
 * Drop 18 verify (2026-11-07, the founder's connector): polyrank_rank_wallets sorted by engine:inband_return_30d
 * answered +52 % simulated copy returns with only the data disclaimer — no CFTC Rule 4.41 statement, which every
 * other simulated figure on the server carries first. The rule: a result that sorts by or projects a simulated
 * copy-engine column (SIMULATED_ENGINE_METRICS), or serves a history board, leads with the statement; a plain
 * composite does not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIMULATED_ENGINE_METRICS, rankWalletsShowsSimulated } from '../src/index.js';
import { VALID_KEY, baseConfig, callTool, fakeUpstream, startServer } from './helpers.js';

const FOOTER = 'Data, not investment advice. Polyrank is not affiliated with Polymarket.';
const AUTH = { authorization: `Bearer ${VALID_KEY}` };
let srv: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  srv = await startServer(baseConfig(), fakeUpstream());
});
afterAll(async () => srv.close());

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};
const rank = async (args: Record<string, unknown>) =>
  (await callTool(`${srv.base}/mcp`, 'polyrank_rank_wallets', args, AUTH)).body
    .result as ToolResult;

describe('rank_wallets and the 4.41 statement', () => {
  it('the simulated columns are the in-band copy return and the taker in-band P&L', () => {
    expect([...SIMULATED_ENGINE_METRICS]).toEqual(['inband_return_30d', 'taker_inband_pnl_14d']);
  });

  it('decides from the body: engine sort, projected engine column, history board', () => {
    expect(rankWalletsShowsSimulated({ weights: { brier: 1 } })).toBe(false);
    expect(
      rankWalletsShowsSimulated({ weights: { brier: 1 }, sort_by: 'engine:sk_score_14d' }),
    ).toBe(false);
    expect(
      rankWalletsShowsSimulated({ weights: { brier: 1 }, sort_by: 'engine:inband_return_30d' }),
    ).toBe(true);
    expect(
      rankWalletsShowsSimulated({ weights: { brier: 1 }, extra_engine_metrics: ['inband_n_30d'] }),
    ).toBe(false);
    expect(
      rankWalletsShowsSimulated({
        weights: { brier: 1 },
        extra_engine_metrics: ['inband_n_30d', 'inband_return_30d'],
      }),
    ).toBe(true);
    expect(
      rankWalletsShowsSimulated({ filters: { history_board: { board: 'copier-consensus' } } }),
    ).toBe(true);
  });

  it('a sort by the in-band return leads with the statement, then the disclaimer, then the board', async () => {
    const r = await rank({
      weights: { brier: 1 },
      sort_by: 'engine:inband_return_30d',
      extra_engine_metrics: ['inband_return_30d', 'inband_n_30d'],
    });
    expect(r.isError).toBeUndefined();
    expect(Object.keys(r.structuredContent).slice(0, 2)).toEqual([
      'simulated_results_notice',
      'disclaimer',
    ]);
    expect(r.content[0]!.text).toMatch(/simulated or hypothetical performance/);
    expect(r.content[1]!.text).toBe(FOOTER);
  });

  it('a plain composite still leads with the disclaimer only', async () => {
    const r = await rank({ weights: { brier: 1 } });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.simulated_results_notice).toBeUndefined();
    expect(r.content[0]!.text).toBe(FOOTER);
  });
});
