/**
 * WP9 — the tool set cannot drift from what index.ts registers: the names and their order in the source, the list
 * the server answers (both endpoints), the counts the HTTP module and the docs state (26 / 17), the README tables,
 * the directory texts, and the keyed tools' access tier. Also pins the API-keys link (the 0.4.0 one, /settings/api,
 * is a 404) and glama.json.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_COUNTS } from '../src/http.js';
import { baseConfig, listTools, startServer } from './helpers.js';

const APP = resolve(__dirname, '..');
const REPO = resolve(APP, '..', '..');
const read = (p: string) => readFileSync(resolve(REPO, p), 'utf8');
const SRC = read('apps/mcp/src/index.ts');
const REGISTERED = [...SRC.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]!);
const WRITES = [
  'polyrank_create_strategy',
  'polyrank_run_backtest',
  'polyrank_start_paper',
  // founder 2026-11-06: editing a strategy and the Lab assistant's chat
  'polyrank_update_strategy',
  'polyrank_lab_ask',
  'polyrank_lab_reply',
  'polyrank_lab_stop',
];
const KEYED = ['polyrank_resolve_tid', 'polyrank_rank_wallets', 'polyrank_get_trader_metrics'];
const LAB = [
  'polyrank_list_lab_templates',
  'polyrank_get_backtest',
  'polyrank_get_paper_run',
  // founder 2026-11-06: the rest of the Lab API, read with a key
  'polyrank_list_strategies',
  'polyrank_get_strategy',
  'polyrank_list_backtests',
  'polyrank_get_lab_limits',
  'polyrank_lab_list_chats',
  'polyrank_lab_get_chat',
  ...WRITES,
];

let srv: Awaited<ReturnType<typeof startServer>>;
let all: Awaited<ReturnType<typeof listTools>>;
let pub: Awaited<ReturnType<typeof listTools>>;
beforeAll(async () => {
  srv = await startServer(baseConfig());
  all = await listTools(`${srv.base}/mcp`);
  pub = await listTools(`${srv.base}/mcp/public`);
});
afterAll(async () => srv.close());

describe('tool inventory', () => {
  it('index.ts registers 36 distinct tools, the count the HTTP module states', () => {
    expect(REGISTERED).toHaveLength(36);
    expect(new Set(REGISTERED).size).toBe(36);
    expect(TOOL_COUNTS).toEqual({ all: 36, public: 17 });
  });

  it('the server lists exactly those, in source order (read-only first, writes last)', () => {
    expect(all.map((t) => t.name)).toEqual(REGISTERED);
    expect(REGISTERED.slice(-WRITES.length)).toEqual(WRITES);
    expect(pub.map((t) => t.name)).toEqual(REGISTERED.slice(0, TOOL_COUNTS.public));
  });

  it('the access tiers are the README tables: 3 keyed, 16 Lab, the rest free', () => {
    const tier = Object.fromEntries(all.map((t) => [t.name, t._meta?.['app.polyrank/access']]));
    for (const n of KEYED) expect(tier[n], n).toBe('api_key');
    for (const n of LAB) expect(tier[n], n).toBe('lab');
    expect(Object.values(tier).filter((v) => v === 'free')).toHaveLength(17);
  });

  it('every keyed or Lab tool checks the key in its handler; no free tool does', () => {
    const body = (name: string) => {
      const start = SRC.indexOf(`'${name}'`);
      const next = SRC.indexOf('registerTool(', start);
      return SRC.slice(start, next === -1 ? undefined : next);
    };
    for (const n of [...KEYED, ...LAB])
      expect(body(n), n).toMatch(/if \(!API_KEY\) return fail\(NEEDS_KEY\)/);
    for (const n of REGISTERED.filter((x) => !KEYED.includes(x) && !LAB.includes(x)))
      expect(body(n), n).not.toMatch(/API_KEY/);
  });

  it('the README puts each tool in its tier table, with the counts', () => {
    const readme = read('apps/mcp/README.md');
    const section = (heading: RegExp) => {
      const start = readme.search(heading);
      const next = readme.indexOf('\n## ', start + 1);
      return readme.slice(start, next);
    };
    const free = section(/^## Free tools/m);
    const keyed = section(/^## Ranking \+ trader tools/m);
    const lab = section(/^## AI Lab tools/m);
    expect(free).toMatch(/— 17$/m);
    expect(keyed).toMatch(/— 3$/m);
    expect(lab).toMatch(/— 16$/m);
    for (const n of REGISTERED.slice(0, 17)) expect(free, n).toContain(`\`${n}\``);
    for (const n of KEYED) expect(keyed, n).toContain(`\`${n}\``);
    for (const n of LAB) expect(lab, n).toContain(`\`${n}\``);
  });

  it('the directory texts state 36 tools, 17 free (not the old 18) and name the public tools', () => {
    for (const f of [
      'docs/mcp/README.md',
      'docs/mcp/cursor_directory.md',
      'docs/mcp/awesome_lists.md',
    ]) {
      const doc = read(f);
      expect(doc, f).toMatch(/36 tools/);
      expect(doc, f).toMatch(/17 (free|with no key|tools work with no key)/);
      expect(doc, f).not.toMatch(/18 (free|tools work)/);
    }
    const cc = read('docs/mcp/claude_connectors_submission.md');
    for (const n of REGISTERED) expect(cc, n).toContain(`\`${n}\``);
    expect(cc).toContain('https://mcp.polyrank.app/mcp/public');
  });

  it('every "needs a key" pointer is the real API-keys page (/api-keys), never the 404 /settings/api', () => {
    for (const f of [
      'apps/mcp/src/index.ts',
      'apps/mcp/src/http.ts',
      'apps/mcp/README.md',
      'apps/mcp/server.json',
    ])
      expect(read(f), f).not.toContain('settings/api');
    expect(SRC).toContain('https://polyrank.app/api-keys');
  });

  it('glama.json matches the schema Glama publishes, with the founder as maintainer', () => {
    const glama = JSON.parse(read('apps/mcp/glama.json'));
    const schema = JSON.parse(read('apps/mcp/test/fixtures/glama.server.schema.json'));
    const validate = new Ajv({ strict: false }).compile(schema);
    expect(validate(glama), JSON.stringify(validate.errors)).toBe(true);
    expect(glama).toEqual({
      $schema: 'https://glama.ai/mcp/schemas/server.json',
      maintainers: ['hriguich'],
    });
  });
});
