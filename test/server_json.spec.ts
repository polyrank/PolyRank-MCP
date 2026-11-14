/**
 * WP9 — apps/mcp/server.json is what `mcp-publisher publish` sends to the official MCP Registry. It validates against
 * the registry's published schema (vendored: test/fixtures/server.schema.2025-12-11.json, fetched 2026-11-05 from
 * https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json) and meets the registry's own extra
 * rules (docs/reference/server-json/official-registry-requirements.md, read 2026-11-05): the 100-character
 * description (the 0.4.0 publish failed with 422 at 101+), the npm package's mcpName equal to the server name, an
 * npm package only from registry.npmjs.org, _meta only under the publisher-provided key. The live check is
 * `mcp-publisher validate` (docs/mcp/REGISTRY_RUNBOOK.md).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const APP = resolve(__dirname, '..');
const read = (p: string) => JSON.parse(readFileSync(resolve(APP, p), 'utf8'));
const server = read('server.json');
const pkg = read('package.json');
const schema = read('test/fixtures/server.schema.2025-12-11.json');

describe('server.json (official MCP Registry)', () => {
  it('validates against the registry schema it names', () => {
    expect(server.$schema).toBe(schema.$id);
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const ok = validate(server);
    expect(validate.errors ?? [], JSON.stringify(validate.errors, null, 2)).toEqual([]);
    expect(ok).toBe(true);
  });

  it('the schema still refuses what the registry refuses (the validator is not vacuous)', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate({ ...server, remotes: [{ type: 'streamable-http', url: 'ftp://x' }] })).toBe(
      false,
    );
    expect(validate({ ...server, name: 'no-namespace' })).toBe(false);
  });

  it('description ≤ 100 characters (WP8 DIRECTORIES.md §1 text, kept)', () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.description).toBe(
      'Polymarket trader analytics for AI agents: rank wallets, read trader metrics, backtest strategies.',
    );
  });

  it('name = package.json mcpName, in the polyrank GitHub org namespace', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.name).toMatch(/^io\.github\.polyrank\//);
    expect(server.repository).toEqual({
      url: 'https://github.com/polyrank/PolyRank-MCP',
      source: 'github',
    });
  });

  it('the npm package is @polyrank/mcp at the package.json version, stdio, from registry.npmjs.org', () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({
      registryType: 'npm',
      registryBaseUrl: 'https://registry.npmjs.org',
      identifier: pkg.name,
      version: pkg.version,
      transport: { type: 'stdio' },
    });
    const key = server.packages[0].environmentVariables.find(
      (e: { name: string }) => e.name === 'POLYRANK_API_KEY',
    );
    expect(key).toMatchObject({ isRequired: false, isSecret: true });
  });

  it('the remote is the live hosted endpoint, Streamable HTTP, with an optional secret bearer header', () => {
    expect(server.remotes).toEqual([
      expect.objectContaining({ type: 'streamable-http', url: 'https://mcp.polyrank.app/mcp' }),
    ]);
    const [h] = server.remotes[0].headers;
    expect(h).toMatchObject({
      name: 'Authorization',
      isRequired: false,
      isSecret: true,
      value: 'Bearer {api_key}',
    });
    expect(h.variables.api_key).toMatchObject({ isSecret: true });
    expect(h.description).toMatch(/17 free read-only tools/);
  });

  it('carries no _meta outside the publisher-provided key (the registry drops the rest)', () => {
    for (const k of Object.keys(server._meta ?? {}))
      expect(k).toBe('io.modelcontextprotocol.registry/publisher-provided');
  });
});
