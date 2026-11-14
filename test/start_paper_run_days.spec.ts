/**
 * How long a paper run lasts (founder 2026-11-09): polyrank_start_paper takes an optional run_days.
 *   - omitted: the POST carries no body, as before, and the API applies its default (10 days) — backwards compatible;
 *   - a whole number of days from 1 to 90, or null for a run with no end: sent to the API as { run_days };
 *   - anything else is refused by the tool's own schema and calls nothing;
 *   - the result shows ends_at; a refusal keeps the API's words;
 *   - the numbers are the API's own (packages/shared-types/src/lab_paper.ts), repeated here because this package is
 *     published without workspace dependencies.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PAPER_DEFAULT_DAYS, PAPER_MAX_DAYS, PAPER_MIN_DAYS } from '../src/index.js';
import {
  LAB_PAPER_DEFAULT_DAYS,
  LAB_PAPER_MAX_DAYS,
  LAB_PAPER_MIN_DAYS,
} from '../../../packages/shared-types/src/lab_paper.js';
import {
  API,
  VALID_KEY,
  baseConfig,
  callTool,
  listTools,
  startServer,
  type UpstreamCall,
} from './helpers.js';

const AUTH = { authorization: `Bearer ${VALID_KEY}` };
const SID = '22222222-2222-4222-8222-222222222222';
const STARTED = '2026-11-09T12:00:00.000Z';

/** A Polyrank API double for the start route: it answers as the API does for the run_days it was sent. */
function paperUpstream(o: { refuse?: boolean } = {}) {
  const calls: UpstreamCall[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, headers, ...(body === undefined ? {} : { body }) });
    if (url === `${API}/v1/stats/overview`) return json(200, { metrics: 84 });
    if (url === `${API}/v1/lab/strategies/${SID}/paper` && method === 'POST') {
      if (o.refuse)
        return json(400, {
          error: 'invalid_run_days',
          message: 'A paper run lasts a whole number of days from 1 to 90, or has no end.',
        });
      const days = body === undefined ? 10 : (body as { run_days: number | null }).run_days;
      return json(201, {
        id: 'p1',
        strategy_id: SID,
        status: 'active',
        started_at: STARTED,
        ends_at:
          days === null ? null : new Date(Date.parse(STARTED) + days * 86_400_000).toISOString(),
        stop_reason: null,
        resolved_copies: 0,
      });
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  return { calls, impl };
}

let running: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(running.map((s) => s.close()));
  running = [];
});
const start = async (up = paperUpstream()) => {
  const s = await startServer(baseConfig(), up);
  running.push(s);
  return { s, up };
};
const paperCalls = (up: ReturnType<typeof paperUpstream>) =>
  up.calls.filter((c) => c.url === `${API}/v1/lab/strategies/${SID}/paper`);

describe('polyrank_start_paper: run_days (founder 2026-11-09)', () => {
  it('the numbers are the API’s own', () => {
    expect([PAPER_DEFAULT_DAYS, PAPER_MIN_DAYS, PAPER_MAX_DAYS]).toEqual([
      LAB_PAPER_DEFAULT_DAYS,
      LAB_PAPER_MIN_DAYS,
      LAB_PAPER_MAX_DAYS,
    ]);
  });

  it('the tool: run_days is optional (an integer 1–90 or null); strategy_id and confirm stay required; the description says the default and where to change it', async () => {
    const { s } = await start();
    const tool = (await listTools(`${s.base}/mcp`, AUTH)).find(
      (t) => t.name === 'polyrank_start_paper',
    ) as unknown as {
      description: string;
      inputSchema: { required: string[]; properties: Record<string, any> };
    };
    expect([...tool.inputSchema.required].sort()).toEqual(['confirm', 'strategy_id']);
    const rd = tool.inputSchema.properties['run_days'];
    expect(rd).toBeDefined();
    const variants = JSON.stringify(rd);
    expect(variants).toContain('"integer"');
    expect(variants).toContain('"null"');
    expect(variants).toContain(`"minimum":${PAPER_MIN_DAYS}`);
    expect(variants).toContain(`"maximum":${PAPER_MAX_DAYS}`);
    expect(variants).toContain(`default ${PAPER_DEFAULT_DAYS}`);
    expect(tool.description).toMatch(/ask the user before calling, then pass confirm: true\./);
    expect(tool.description).toContain(
      `The run lasts ${PAPER_DEFAULT_DAYS} days unless run_days says otherwise`,
    );
    expect(tool.description).toContain('null = no end, it runs until stopped');
    expect(tool.description).toContain('ends_at is when it stops by itself');
    expect(tool.description).toContain("they can change it on the run's page at polyrank.app");
    expect(tool.description).not.toMatch(/smart money|insider/i);
  });

  it('without run_days: no body, as before; the API’s default comes back as ends_at', async () => {
    const { s, up } = await start();
    const r = await callTool(
      `${s.base}/mcp`,
      'polyrank_start_paper',
      { strategy_id: SID, confirm: true },
      AUTH,
    );
    expect(r.body.result.isError).toBeUndefined();
    const sent = paperCalls(up);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.body).toBeUndefined();
    expect(sent[0]!.headers['content-type']).toBeUndefined();
    expect(r.body.result.structuredContent).toMatchObject({
      id: 'p1',
      status: 'active',
      started_at: STARTED,
      ends_at: '2026-11-19T12:00:00.000Z',
      stop_reason: null,
    });
  });

  it('a length, or null for no end: sent as { run_days }, never the confirm flag; the result shows ends_at', async () => {
    const { s, up } = await start();
    for (const [days, endsAt] of [
      [30, '2026-12-09T12:00:00.000Z'],
      [PAPER_MIN_DAYS, '2026-11-10T12:00:00.000Z'],
      [PAPER_MAX_DAYS, '2027-02-07T12:00:00.000Z'],
      [null, null],
    ] as const) {
      const r = await callTool(
        `${s.base}/mcp`,
        'polyrank_start_paper',
        { strategy_id: SID, run_days: days, confirm: true },
        AUTH,
      );
      expect(r.body.result.isError).toBeUndefined();
      expect(paperCalls(up).at(-1)!.body).toEqual({ run_days: days });
      expect(r.body.result.structuredContent.ends_at).toBe(endsAt);
      // the text block a client shows carries it too
      expect(JSON.stringify(r.body.result.content)).toContain('ends_at');
    }
  });

  it('a length outside the bounds, a fraction or a string is refused by the tool and calls nothing', async () => {
    const { s, up } = await start();
    for (const bad of [0, 91, 2.5, -1, '10']) {
      const r = await callTool(
        `${s.base}/mcp`,
        'polyrank_start_paper',
        { strategy_id: SID, run_days: bad, confirm: true },
        AUTH,
      );
      expect([bad, r.body.result?.isError ?? r.body.error !== undefined]).toEqual([bad, true]);
    }
    expect(paperCalls(up)).toEqual([]);
  });

  it('still needs confirm: true, with or without a length', async () => {
    const { s, up } = await start();
    const r = await callTool(
      `${s.base}/mcp`,
      'polyrank_start_paper',
      { strategy_id: SID, run_days: 30 },
      AUTH,
    );
    expect(r.body.result?.isError ?? r.body.error !== undefined).toBe(true);
    expect(paperCalls(up)).toEqual([]);
  });

  it('a refusal keeps the API’s words', async () => {
    const { s } = await start(paperUpstream({ refuse: true }));
    const r = await callTool(
      `${s.base}/mcp`,
      'polyrank_start_paper',
      { strategy_id: SID, run_days: 30, confirm: true },
      AUTH,
    );
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toContain(
      'invalid_run_days: A paper run lasts a whole number of days from 1 to 90, or has no end.',
    );
  });
});
