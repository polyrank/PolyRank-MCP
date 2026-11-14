/**
 * Founder 2026-11-06 ("also expose the chat"): the Lab assistant and the rest of the Lab API through the MCP server.
 *   - polyrank_lab_ask starts a chat with the caller's key, waits (bounded) for the answer and returns the messages
 *     since the question, with no model id, the 4.41 statement beside simulated results and what to do next;
 *   - a chat still answering when the wait ends says to poll polyrank_lab_get_chat;
 *   - polyrank_list_strategies passes the state filter; polyrank_update_strategy PATCHes; a refusal keeps the API's words;
 *   - the 4.41 text is the shared one, verbatim.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CFTC_4_41_STATEMENT_TEXT, chatView } from '../src/index.js';
import { API, VALID_KEY, baseConfig, callTool, startServer, type UpstreamCall } from './helpers.js';

const AUTH = { authorization: `Bearer ${VALID_KEY}` };
const CID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const RESULT_CARD = { kind: 'backtest_result', v: 1, id: 'c1', per10: 0.81, simulated: true };

/** A Polyrank API double for the Lab routes: the chat answers after `answerAfter` reads. */
function labUpstream(o: { answerAfter: number; busy?: boolean }) {
  const calls: UpstreamCall[] = [];
  let reads = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      headers: {},
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    });
    if (url === `${API}/v1/stats/overview`) return json(200, { metrics: 84 });
    if (url === `${API}/v1/lab/agent/conversations` && method === 'POST')
      return o.busy
        ? json(429, {
            error: 'lab_agent_busy',
            message: '2 of 2 conversations are answering; wait for one to finish.',
            running: 2,
            limit: 2,
          })
        : json(202, { id: CID, status: 'queued', model: 'claude-x' });
    if (url === `${API}/v1/lab/agent/conversations/${CID}` && method === 'GET') {
      reads += 1;
      const done = reads > o.answerAfter;
      return json(200, {
        conversation: {
          id: CID,
          title: 'T',
          status: done ? 'idle' : 'working',
          error: null,
          model: 'claude-x',
        },
        queue_position: null,
        awaiting_backtests: done ? 1 : 0,
        messages: [
          { id: '1', role: 'user', text: 'old', cards: [] },
          { id: '2', role: 'assistant', text: 'old answer', cards: [] },
          { id: '3', role: 'user', text: 'Test it', cards: [] },
          ...(done
            ? [{ id: '4', role: 'assistant', text: 'Here it is.', cards: [RESULT_CARD] }]
            : []),
        ],
      });
    }
    if (url.startsWith(`${API}/v1/lab/strategies`)) return json(200, { strategies: [] });
    if (url.startsWith(`${API}/v1/lab/backtests`))
      return method === 'POST'
        ? json(202, { id: 'b1', status: 'queued' })
        : url.endsWith('/b1') || /backtests\/[0-9a-f-]{36}$/.test(url)
          ? json(200, { id: 'b1', status: 'done', report: { pooled: { per10: 0.81 } } })
          : json(200, { backtests: [] });
    if (url.startsWith(`${API}/v1/lab/paper-runs/`))
      return json(200, { id: 'p1', stats: { per10: 0.2 } });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  return { calls, impl };
}

let running: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(running.map((s) => s.close()));
  running = [];
});
const start = async (up: ReturnType<typeof labUpstream>) => {
  const s = await startServer(baseConfig(), up);
  running.push(s);
  return s;
};

describe('the Lab assistant through the MCP server (founder 2026-11-06)', () => {
  it('ask: starts with the key, waits for the answer, returns it since the question, no model id, the 4.41 text', async () => {
    const up = labUpstream({ answerAfter: 1 });
    const s = await start(up);
    const r = await callTool(
      `${s.base}/mcp`,
      'polyrank_lab_ask',
      { message: 'Test it', wait_seconds: 10, confirm: true },
      AUTH,
    );
    const out = r.body.result.structuredContent;
    expect(r.body.result.isError).toBeUndefined();
    expect(up.calls.find((c) => c.method === 'POST')!.body).toEqual({ message: 'Test it' });
    expect(out.conversation).toEqual({ id: CID, title: 'T', status: 'idle', error: null });
    expect(out.messages.map((m: { text: string }) => m.text)).toEqual(['Test it', 'Here it is.']);
    expect(out.simulated_results_notice).toBe(CFTC_4_41_STATEMENT_TEXT);
    // the authed connector test (11-07): the statement leads, so a client that cuts a long result still shows it
    expect(r.body.result.content[0].text).toBe(CFTC_4_41_STATEMENT_TEXT);
    expect(Object.keys(out)[0]).toBe('simulated_results_notice');
    expect(out.awaiting_backtests).toBe(1);
    expect(out.next).toMatch(/1 backtest it started will post its result to this chat/);
    expect(JSON.stringify(out)).not.toContain('claude-');
  });

  it('a chat still answering when the wait ends says to poll polyrank_lab_get_chat', async () => {
    const s = await start(labUpstream({ answerAfter: 1_000 }));
    const r = await callTool(
      `${s.base}/mcp`,
      'polyrank_lab_ask',
      { message: 'Test it', wait_seconds: 0, confirm: true },
      AUTH,
    );
    const out = r.body.result.structuredContent;
    expect(out.conversation.status).toBe('working');
    expect(out.next).toBe(
      `Still answering: call polyrank_lab_get_chat with id ${CID} in a little while.`,
    );
    expect(out.simulated_results_notice).toBeUndefined();
  });

  it('a refusal keeps the API words: 429 lab_agent_busy names n of N', async () => {
    const s = await start(labUpstream({ answerAfter: 0, busy: true }));
    const r = await callTool(
      `${s.base}/mcp`,
      'polyrank_lab_ask',
      {
        message: 'Test it',
        confirm: true,
      },
      AUTH,
    );
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toBe(
      'Polyrank API 429 for /v1/lab/agent/conversations: lab_agent_busy: 2 of 2 conversations are answering; wait for one to finish.',
    );
  });

  it('list_strategies passes the state; update_strategy PATCHes only what is given', async () => {
    const up = labUpstream({ answerAfter: 0 });
    const s = await start(up);
    await callTool(`${s.base}/mcp`, 'polyrank_list_strategies', { status: 'paper' }, AUTH);
    expect(up.calls.at(-1)!.url).toBe(`${API}/v1/lab/strategies?status=paper`);
    await callTool(
      `${s.base}/mcp`,
      'polyrank_update_strategy',
      {
        id: SID,
        name: 'Renamed',
        confirm: true,
      },
      AUTH,
    );
    expect(up.calls.at(-1)).toMatchObject({
      url: `${API}/v1/lab/strategies/${SID}`,
      method: 'PATCH',
      body: { name: 'Renamed' },
    });
    const none = await callTool(
      `${s.base}/mcp`,
      'polyrank_update_strategy',
      {
        id: SID,
        confirm: true,
      },
      AUTH,
    );
    expect(none.body.result.content[0].text).toBe('Give a new name, a new spec, or both.');
  });

  it('get_chat keeps the last N; every answer carries the 4.41 statement, a text-only one too (Lab lead 11-07)', () => {
    const d = {
      conversation: { id: CID, status: 'queued', model: 'm' },
      queue_position: 3,
      messages: [
        { id: '1', role: 'user', text: 'a' },
        // an answer quoting an earlier backtest's figures in words, no card in the slice
        { id: '2', role: 'assistant', text: 'It made +0.81 per $10 (simulated).', cards: [] },
        { id: '3', role: 'user', text: 'and now?' },
      ],
    };
    const v = chatView(d, 2);
    expect(v['messages']).toEqual(d.messages.slice(-2));
    expect(v['simulated_results_notice']).toBe(CFTC_4_41_STATEMENT_TEXT);
    expect(v['next']).toBe(
      `Still queued (3 ahead): call polyrank_lab_get_chat with id ${CID} in a little while.`,
    );
    expect(v['conversation']).toEqual({ id: CID, status: 'queued' });
    // a slice of the person's own words only: no answer, no statement
    expect(chatView(d, 1)).not.toHaveProperty('simulated_results_notice');
  });

  it('every Lab tool that shows simulated figures carries the 4.41 statement (Lab lead 11-07)', async () => {
    const s = await start(labUpstream({ answerAfter: 0 }));
    const BID = '33333333-3333-4333-8333-333333333333';
    const calls: [string, Record<string, unknown>][] = [
      [
        'polyrank_run_backtest',
        { strategy_id: SID, from: '2026-08-01', to: '2026-09-01', confirm: true },
      ],
      ['polyrank_get_backtest', { id: BID }],
      ['polyrank_get_paper_run', { id: BID }],
      ['polyrank_list_strategies', {}],
      ['polyrank_list_backtests', {}],
    ];
    for (const [name, args] of calls) {
      const r = await callTool(`${s.base}/mcp`, name, args, AUTH);
      expect(r.body.result.isError, name).toBeUndefined();
      expect(r.body.result.structuredContent.simulated_results_notice, name).toBe(
        CFTC_4_41_STATEMENT_TEXT,
      );
      expect(r.body.result.content[0].text, name).toContain(
        'simulated or hypothetical performance',
      );
    }
    // a read with no simulated figure does not
    const plain = await callTool(`${s.base}/mcp`, 'polyrank_get_strategy', { id: SID }, AUTH);
    expect(plain.body.result.structuredContent).not.toHaveProperty('simulated_results_notice');
  });

  it('the 4.41 statement is the shared one, verbatim', () => {
    const shared = readFileSync(
      resolve(__dirname, '../../../packages/shared-types/src/cftc_4_41.ts'),
      'utf8',
    );
    const body = shared.slice(shared.indexOf('CFTC_4_41_STATEMENT_TEXT ='));
    const text = [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('');
    expect(text).toBe(CFTC_4_41_STATEMENT_TEXT);
  });
});
