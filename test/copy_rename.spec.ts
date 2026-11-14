/**
 * Copy rename 2026-11-07 (founder ~18:05Z): no tool title or description the server answers says "smart money" or
 * "insider". The two report tools KEEP their ids (polyrank_get_smart_money_reports / _report): renaming them would
 * break the clients and paying integrations already calling them, so only their descriptions say "Skill Report", and
 * the docs page says the ids are historical.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseConfig, listTools, startServer } from './helpers.js';

const BANNED = /\bsmart[\s-]+money\b|\binsiders?\b/i;
const REPO = resolve(__dirname, '..', '..', '..');

let srv: Awaited<ReturnType<typeof startServer>>;
let all: Awaited<ReturnType<typeof listTools>>;
let pub: Awaited<ReturnType<typeof listTools>>;
beforeAll(async () => {
  srv = await startServer(baseConfig());
  all = await listTools(`${srv.base}/mcp`);
  pub = await listTools(`${srv.base}/mcp/public`);
});
afterAll(async () => srv.close());

describe('MCP copy rename', () => {
  it('no title or description on either endpoint says "smart money" or "insider"', () => {
    for (const t of [...all, ...pub]) {
      expect(`${t.title ?? ''} ${t.description ?? ''}`, t.name).not.toMatch(BANNED);
    }
  });

  it('the report tools keep their historical ids and describe the weekly Skill Report', () => {
    for (const id of ['polyrank_get_smart_money_reports', 'polyrank_get_smart_money_report']) {
      const t = all.find((x) => x.name === id);
      expect(t, id).toBeDefined();
      expect(t!.description).toMatch(/weekly Skill Report/);
    }
  });

  it('the pulse tool no longer suggests "what is smart money doing right now"', () => {
    const pulse = all.find((x) => x.name === 'polyrank_get_pulse')!;
    expect(pulse.description).toContain(
      'Good for "what are the big and sharp wallets doing right now".',
    );
  });

  it('the docs page says the report tool ids are historical', () => {
    const doc = readFileSync(resolve(REPO, 'apps/docs-site/content/docs/mcp.mdx'), 'utf8');
    expect(doc).toContain(
      'The ids `polyrank_get_smart_money_reports` and `polyrank_get_smart_money_report` are historical',
    );
  });
});
