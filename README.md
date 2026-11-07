# @polyrank/mcp

MCP server that gives AI agents (Claude, etc.) direct access to **Polyrank** —
the skill-analytics layer for Polymarket. It ranks millions of Polymarket
wallets by genuine forecasting skill (calibration / Brier, alpha-vs-mid,
risk-adjusted return) — not vanity P&L or win rate. _Follow the skilled, not the
lucky._ (Live coverage + the exact skill-metric count: `polyrank_get_platform_stats`.)

The public tools wrap Polyrank's free API — no key. With a Polyrank API key
(`POLYRANK_API_KEY`, from polyrank.app/api-keys on a plan with the Ranking
Builder / Strategy Lab), the ranking, trader-metrics and Strategy Lab tools call the
authenticated API: **the same `POST /v1/rankings/custom` the Ranking Builder runs** —
any of the 84 metrics at any window it exists at, every filter, `as_of` boards —
plus per-window trader metrics and backtests / paper trading. Agents that pay per
call instead of holding a key use the x402 agent API — see <https://polyrank.app/llms.txt>.

Every tool carries a `title` and the MCP annotations `readOnlyHint`, `destructiveHint`, `idempotentHint` and
`openWorldHint`: 29 tools are read-only; the 7 Strategy Lab writes (`polyrank_create_strategy`,
`polyrank_run_backtest`, `polyrank_start_paper`, `polyrank_update_strategy`, `polyrank_lab_ask`, `polyrank_lab_reply`,
`polyrank_lab_stop`) each create or change a record in your own Polyrank account and are marked
`destructiveHint: false` (none deletes anything, none touches funds; the chat tools spend your plan's AI credits).
Read-only tools are listed first.

## Free tools (read-only, no key) — 17

| Tool                                     | What it does                                                        |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `polyrank_get_leaderboard`               | Top traders ranked by composite skill                               |
| `polyrank_get_trader_skill`              | A wallet's P&L / win-rate / volume / percentiles                    |
| `polyrank_get_trader_calibration`        | A wallet's 10-bin reliability diagram                               |
| `polyrank_get_market_consensus`          | Skill-weighted holder consensus vs market mid + top holders         |
| `polyrank_get_pulse`                     | Live activity: big wins, sharp moves, trending, divergence          |
| `polyrank_get_platform_stats`            | Live coverage + skill-metric count (wallets/trades/markets)         |
| `polyrank_get_top_roi_trades`            | Biggest return-on-cost resolved trades (filter by category)         |
| `polyrank_get_movers`                    | Traders climbing / falling fastest in skill rank                    |
| `polyrank_get_smart_money_reports`       | Weekly Skill Report archive                                         |
| `polyrank_get_smart_money_report`        | One weekly Skill Report in full                                     |
| `polyrank_get_trader_by_tid`             | Follow a masked trader by its `tid`                                 |
| `polyrank_get_trader_calibration_by_tid` | A masked trader's 10-bin reliability diagram by `tid`               |
| `polyrank_get_custom_ranking`            | A published Builder ranking: masked top-25 + weight/filter def      |
| `polyrank_get_traders_batch`             | Masked teasers for up to 10 `tid`s in one call                      |
| `polyrank_get_metrics_catalog`           | The 84 rankable metrics: id, meaning, direction, windows            |
| `polyrank_get_metric_windows`            | Which metric exists at which window; what `as_of` can answer        |
| `polyrank_list_ranking_templates`        | The Builder's goals ("Copy entries", …) as ready requests + presets |

## Ranking + trader tools (need `POLYRANK_API_KEY`) — 3

| Tool                          | What it does                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `polyrank_resolve_tid`        | Resolve a masked `tid` → wallet                                              |
| `polyrank_rank_wallets`       | The Ranking Builder: weights × windows × filters, `as_of`, explain, any sort |
| `polyrank_get_trader_metrics` | One trader's every metric at a window: value + percentile (address or `tid`) |

## Strategy Lab tools (need `POLYRANK_API_KEY` on a paid plan with the Lab; results are SIMULATED) — 16

| Tool                          | What it does                                                       |
| ----------------------------- | ------------------------------------------------------------------ |
| `polyrank_list_lab_templates` | Strategy templates (editable specs) with their as-of evidence      |
| `polyrank_create_strategy`    | Save a strategy (spec or template)                                 |
| `polyrank_run_backtest`       | Queue a backtest of a strategy or spec over a date range           |
| `polyrank_get_backtest`       | A backtest's status and report                                     |
| `polyrank_start_paper`        | Start paper trading a strategy against real order books (no money) |
| `polyrank_get_paper_run`      | A paper run's stats and its copies                                 |
| `polyrank_list_strategies`    | Your strategies, filtered by state (draft, tested, paper…)         |
| `polyrank_get_strategy`       | One strategy with its full spec                                    |
| `polyrank_list_backtests`     | Your recent backtests, all or one strategy's                       |
| `polyrank_get_lab_limits`     | Your plan's Lab limits and what is used, incl. chats at once       |
| `polyrank_lab_list_chats`     | Your Lab assistant chats                                           |
| `polyrank_lab_get_chat`       | One chat: answers, result cards, queue position                    |
| `polyrank_update_strategy`    | Rename a strategy or replace its spec                              |
| `polyrank_lab_ask`            | Ask the Lab assistant in a new chat (spends AI credits)            |
| `polyrank_lab_reply`          | Reply in a chat (spends AI credits)                                |
| `polyrank_lab_stop`           | Stop an answer                                                     |

The Strategy Lab tools act as your own Polyrank account: a plan with the Lab (Pro Trader and up; a strategy that copies
no wallet needs Lab Pro and up), each backtest counting against the plan's backtests a day, with `queue_position` and
`eta_s` on a queued run. Plans and limits: <https://docs.polyrank.app/lab>.

**The Lab assistant** (`polyrank_lab_ask`, `polyrank_lab_reply`): the same assistant as polyrank.app/lab, acting in
your account (research only; it never places orders). Each question spends your plan's AI credits (25 needed to start,
a typical one about 13; `deep: true` about twice) and your plan answers a number of chats at once (Pro Trader 2, Lab
Pro 3, Quant 4, Quant Max 6, Desk 6, Enterprise 8; one more answers 429 `lab_agent_busy`). The tool waits up to
`wait_seconds` (default 45, at most 55) for the answer, then returns what is there; poll `polyrank_lab_get_chat` while
`next` says it is still answering. A backtest the assistant starts that takes longer than a few seconds runs on:
`awaiting_backtests` counts them, and each result is posted to the chat when it finishes. Every answer, and every Lab
result with simulated figures (`polyrank_run_backtest`, `polyrank_get_backtest`, `polyrank_get_paper_run`,
`polyrank_list_strategies`, `polyrank_list_backtests`), comes with the CFTC Rule 4.41 statement
(`simulated_results_notice`).

**Reproduce a Builder board** (e.g. "Copy entries", top 20): call
`polyrank_list_ranking_templates`, then `polyrank_rank_wallets` with that goal's `request`.

## Install

**Claude Code**

```bash
claude mcp add polyrank -- npx -y @polyrank/mcp
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "polyrank": { "command": "npx", "args": ["-y", "@polyrank/mcp"] }
  }
}
```

**Cursor** — add to `.cursor/mcp.json` (same block as above), or use the one-click deep link:

[![Add to Cursor](https://img.shields.io/badge/Add%20to-Cursor-00d4ff?style=flat)](cursor://anysphere.cursor-deeplink/mcp/install?name=polyrank&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBwb2x5cmFuay9tY3AiXX0=)

**VS Code**

```bash
code --add-mcp '{"name":"polyrank","command":"npx","args":["-y","@polyrank/mcp"]}'
```

Config: `POLYRANK_API_BASE` (default `https://api.polyrank.app`),
`POLYRANK_AGENT_BASE` (default `https://api-agent.polyrank.app`; only its free
manifests are read), and optional `POLYRANK_API_KEY`, which unlocks the ranking,
trader-metrics, Strategy Lab and `tid`-resolve tools. With a key:

```bash
claude mcp add polyrank -e POLYRANK_API_KEY=pk_live_… -- npx -y @polyrank/mcp
```

## Hosted (Streamable HTTP)

Polyrank hosts this server at **`https://mcp.polyrank.app`** (Streamable HTTP), so nothing needs installing:

| Endpoint                                   | Tools                                                                                                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST https://mcp.polyrank.app/mcp`        | all **36**. The 17 free tools work with no header; the other 19 need `Authorization: Bearer pk_live_…` (your own key, your plan's limits) and otherwise answer that they need a key |
| `POST https://mcp.polyrank.app/mcp/public` | the **17** free read-only tools only; any Authorization header is ignored                                                                                                           |
| `GET https://mcp.polyrank.app/healthz`     | status and version                                                                                                                                                                  |

```bash
claude mcp add --transport http polyrank https://mcp.polyrank.app/mcp --header "Authorization: Bearer pk_live_…"
```

```bash
claude mcp add --transport http polyrank-free https://mcp.polyrank.app/mcp/public
```

It is for MCP clients and agent backends, not for pages in a browser: a request that carries a browser `Origin` header
is refused (403). Limits: 100 requests a minute per address without a key, 600 a minute with a key, and your plan's
API limits behind them. The 6 Strategy Lab tools need a paid plan with the Lab; their results are simulated.

The package also runs this server itself (`MCP_HTTP_ENABLED=1`); with no flag it is the stdio server above.

Run it yourself: `MCP_HTTP_ENABLED=1 MCP_HTTP_PORT=3005 npx -y @polyrank/mcp`, then
`curl -s localhost:3005/healthz`. Options (env): `MCP_HTTP_HOST` (default `127.0.0.1`), `MCP_HTTP_PORT` (`3005`),
`MCP_HTTP_ALLOWED_HOSTS` (Host header allow-list, default `mcp.polyrank.app,localhost,127.0.0.1,[::1]`),
`MCP_HTTP_ALLOWED_ORIGINS` (browser Origin allow-list, default none), `MCP_HTTP_ANON_PER_MIN` (`100`),
`MCP_HTTP_KEY_PER_MIN` (`600`), `MCP_HTTP_VERIFY_KEYS` (`1`), `MCP_HTTP_MAX_BODY_BYTES` (`1048576`),
`MCP_FORWARD_CLIENT_IP` (`0`). In HTTP mode `POLYRANK_API_KEY` is ignored: every caller sends their own key.
Details: `src/http.ts`.

Not affiliated with Polymarket · not investment advice · not custodial.
