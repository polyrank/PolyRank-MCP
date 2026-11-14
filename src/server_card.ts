/**
 * The MCP Server Card this server serves at /.well-known/mcp/server-card.json and /.well-known/mcp.json (SEP-1649 / MCP
 * PR 2127, a draft; SEO + AI visibility head, 2026-11-07). polyrank.app serves the same card from
 * apps/web/lib/mcp_server_card.ts (the same builder, called with production's switches): test/server_card.spec.ts
 * requires the two to match, both tool lists to be what this server lists on /mcp and /mcp/public, and the version to
 * be VERSION. Kept dependency-free like its twin.
 *
 * The card follows the server's OAuth switches (mcpServerCard below): keys only with OAuth off; OAuth 2.1 sign-in next
 * to the key with it on, and whether /mcp asks at connect. polyrank.app's copy is the variant production runs.
 */

export const MCP_CARD_VERSION = '0.5.1';
export const MCP_ORIGIN = 'https://mcp.polyrank.app';

/** The 17 read-only tools that need no key: what /mcp/public lists, in the server's registration order. */
export const MCP_FREE_TOOLS = [
  'polyrank_get_leaderboard',
  'polyrank_get_trader_skill',
  'polyrank_get_trader_calibration',
  'polyrank_get_market_consensus',
  'polyrank_get_pulse',
  'polyrank_get_platform_stats',
  'polyrank_get_top_roi_trades',
  'polyrank_get_movers',
  'polyrank_get_smart_money_reports',
  'polyrank_get_smart_money_report',
  'polyrank_get_trader_by_tid',
  'polyrank_get_trader_calibration_by_tid',
  'polyrank_get_custom_ranking',
  'polyrank_get_traders_batch',
  'polyrank_get_metrics_catalog',
  'polyrank_get_metric_windows',
  'polyrank_list_ranking_templates',
] as const;

/** The 19 tools that need `Authorization: Bearer pk_live_…` (the AI Lab ones: a plan with the Lab). */
export const MCP_KEY_TOOLS = [
  'polyrank_resolve_tid',
  'polyrank_rank_wallets',
  'polyrank_get_trader_metrics',
  'polyrank_list_lab_templates',
  'polyrank_create_strategy',
  'polyrank_run_backtest',
  'polyrank_get_backtest',
  'polyrank_start_paper',
  'polyrank_get_paper_run',
  'polyrank_list_strategies',
  'polyrank_get_strategy',
  'polyrank_list_backtests',
  'polyrank_get_lab_limits',
  'polyrank_lab_list_chats',
  'polyrank_lab_get_chat',
  'polyrank_update_strategy',
  'polyrank_lab_ask',
  'polyrank_lab_reply',
  'polyrank_lab_stop',
] as const;

const DESCRIPTION =
  'Polymarket trader analytics for AI agents: rank wallets, read trader metrics, backtest strategies.';

const BEARER_HEADER = {
  name: 'Authorization',
  description:
    'Optional. Your Polyrank API key as a bearer token (pk_live_…, from https://polyrank.app/api-keys). Without it the 17 free read-only tools work; the Ranking Builder, per-window trader metrics and the AI Lab tools need it (they also need a plan with the AI Lab; results are simulated).',
  isRequired: false,
  isSecret: true,
  value: 'Bearer {api_key}',
};

/** The OAuth side of the card, as http.ts passes it (MCP_OAUTH_ENABLED=1; docs/mcp/OAUTH.md). */
export interface CardOAuth {
  issuer: string;
  resourceMetadata: string;
  /** MCP_OAUTH_REQUIRE_ON_CONNECT=1: /mcp asks for sign-in (or a key) at connect. */
  requireOnConnect: boolean;
}

const KEY_INSTEAD_HEADER = {
  name: 'Authorization',
  description:
    "Optional instead of OAuth sign-in: your Polyrank API key as a bearer token (pk_live_…, from https://polyrank.app/api-keys), with your plan's limits. The AI Lab tools need a plan with the AI Lab; results are simulated.",
  isRequired: false,
  isSecret: true,
  value: 'Bearer {api_key}',
};

/**
 * The card follows the OAuth switch: without `oauth` it is the keys-only card (OAuth off); with it, OAuth 2.1 next to
 * the key, the issuer and the RFC 9728 metadata URL, and whether /mcp asks for sign-in at connect. polyrank.app's static
 * copy (apps/web/lib/mcp_server_card.ts, the same builder) is called with production's switches (MCP_OAUTH_ARMED in
 * apps/web/lib/agent_discovery.ts: OAuth on, MCP_OAUTH_REQUIRE_ON_CONNECT=0, founder 2026-11-07); server_card.spec.ts
 * pins it equal to what this server serves with those switches.
 */
export function mcpServerCard(oauth?: CardOAuth): Record<string, unknown> {
  const authentication =
    oauth === undefined
      ? {
          required: false,
          schemes: ['bearer'],
          description:
            'No OAuth. /mcp/public needs nothing; /mcp takes an optional Polyrank API key as a bearer token (created by a signed-in person at https://polyrank.app/api-keys). See https://polyrank.app/auth.md.',
        }
      : {
          required: oauth.requireOnConnect,
          schemes: ['oauth2', 'bearer'],
          authorizationServers: [oauth.issuer],
          resourceMetadata: oauth.resourceMetadata,
          description: `OAuth 2.1 (authorization code + PKCE S256; Dynamic Client Registration or a Client ID Metadata Document): ${
            oauth.requireOnConnect
              ? `/mcp asks the client to sign the user in to Polyrank at connect, or takes a Polyrank API key as a bearer token instead. The ${MCP_FREE_TOOLS.length} free read-only tools need no sign-in at /mcp/public.`
              : `/mcp serves the ${MCP_FREE_TOOLS.length} free read-only tools without sign-in; a tool that needs an account answers 401 with the protected-resource metadata and the client signs the user in to Polyrank (in Claude's add dialog, "Sign in now" connects with an account up front), or send a Polyrank API key as a bearer token instead. /mcp/public needs nothing.`
          } See https://polyrank.app/auth.md.`,
        };
  const mainRemote =
    oauth === undefined
      ? {
          type: 'streamable-http',
          url: `${MCP_ORIGIN}/mcp`,
          description: `All ${MCP_FREE_TOOLS.length + MCP_KEY_TOOLS.length} tools; ${MCP_KEY_TOOLS.length} of them need a bearer key.`,
          headers: [BEARER_HEADER],
        }
      : {
          type: 'streamable-http',
          url: `${MCP_ORIGIN}/mcp`,
          description: oauth.requireOnConnect
            ? `All ${MCP_FREE_TOOLS.length + MCP_KEY_TOOLS.length} tools, after OAuth sign-in or with an API key (asked at connect).`
            : `All ${MCP_FREE_TOOLS.length + MCP_KEY_TOOLS.length} tools: the ${MCP_FREE_TOOLS.length} free ones without sign-in, the ${MCP_KEY_TOOLS.length} that need an account after OAuth sign-in or with an API key.`,
          headers: [KEY_INSTEAD_HEADER],
        };
  return {
    name: 'io.github.polyrank/polyrank-mcp',
    title: 'Polyrank',
    description: DESCRIPTION,
    version: MCP_CARD_VERSION,
    websiteUrl: 'https://docs.polyrank.app/mcp',
    repository: { url: 'https://github.com/polyrank/PolyRank-MCP', source: 'github' },
    icons: [{ src: 'https://polyrank.app/icon.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    serverInfo: { name: 'polyrank', title: 'Polyrank', version: MCP_CARD_VERSION },
    transport: { type: 'streamable-http', endpoint: `${MCP_ORIGIN}/mcp` },
    capabilities: { tools: { listChanged: false } },
    authentication,
    remotes: [
      mainRemote,
      {
        type: 'streamable-http',
        url: `${MCP_ORIGIN}/mcp/public`,
        description: `The ${MCP_FREE_TOOLS.length} free read-only tools; no key, any Authorization header is ignored.`,
      },
    ],
    packages: [
      {
        registryType: 'npm',
        registryBaseUrl: 'https://registry.npmjs.org',
        identifier: '@polyrank/mcp',
        version: MCP_CARD_VERSION,
        transport: { type: 'stdio' },
      },
    ],
    tools: [
      ...MCP_FREE_TOOLS.map((name) => ({
        name,
        access: 'free',
        endpoints: ['/mcp', '/mcp/public'],
      })),
      ...MCP_KEY_TOOLS.map((name) => ({ name, access: 'api_key', endpoints: ['/mcp'] })),
    ],
    status: `${MCP_ORIGIN}/healthz`,
    documentationUrl: 'https://docs.polyrank.app/mcp',
  };
}
