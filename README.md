# @polyrank/mcp

MCP server that gives AI agents (Claude, etc.) direct access to **Polyrank** —
the skill-analytics layer for Polymarket. It ranks millions of Polymarket
wallets by genuine forecasting skill (calibration / Brier, alpha-vs-mid,
risk-adjusted return) — not vanity P&L or win rate. _Follow the skilled, not the
lucky._ (Live coverage + the exact skill-metric count: `polyrank_get_platform_stats`.)

The public tools wrap Polyrank's free API — no key. With a Polyrank API key
(`POLYRANK_API_KEY`, from polyrank.app/settings/api on a plan with the Ranking
Builder / Strategy Lab), the ranking, trader-metrics and Strategy Lab tools call the
authenticated API: **the same `POST /v1/rankings/custom` the Ranking Builder runs** —
any of the 84 metrics at any window it exists at, every filter, `as_of` boards —
plus per-window trader metrics and backtests / paper trading. Agents that pay per
call instead of holding a key use the x402 agent API — see <https://polyrank.app/llms.txt>.

## Public tools (read-only, no key)

| Tool                                     | What it does                                                   |
| ---------------------------------------- | -------------------------------------------------------------- |
| `polyrank_get_leaderboard`               | Top traders ranked by composite skill                          |
| `polyrank_get_trader_skill`              | A wallet's P&L / win-rate / volume / percentiles               |
| `polyrank_get_trader_calibration`        | A wallet's 10-bin reliability diagram                          |
| `polyrank_get_market_consensus`          | Smart-money consensus vs market mid + top holders              |
| `polyrank_get_pulse`                     | Live activity: big wins, sharp moves, trending, divergence     |
| `polyrank_get_platform_stats`            | Live coverage + skill-metric count (wallets/trades/markets)    |
| `polyrank_get_top_roi_trades`            | Biggest return-on-cost resolved trades (filter by category)    |
| `polyrank_get_movers`                    | Traders climbing / falling fastest in skill rank               |
| `polyrank_get_smart_money_reports`       | Weekly Smart-Money Report archive                              |
| `polyrank_get_smart_money_report`        | One weekly Smart-Money Report in full                          |
| `polyrank_get_trader_by_tid`             | Follow a masked trader by its `tid`                            |
| `polyrank_get_trader_calibration_by_tid` | A masked trader's 10-bin reliability diagram by `tid`          |
| `polyrank_get_custom_ranking`            | A published Builder ranking: masked top-25 + weight/filter def |
| `polyrank_get_traders_batch`             | Masked teasers for up to 10 `tid`s in one call                 |
| `polyrank_resolve_tid`                   | Resolve a `tid` → wallet (needs `POLYRANK_API_KEY`)            |
| `polyrank_get_metrics_catalog`           | The 84 rankable metrics: id, meaning, direction, windows       |
| `polyrank_get_metric_windows`            | Which metric exists at which window; what `as_of` can answer   |
| `polyrank_list_ranking_templates`        | The Builder's goals ("Copy entries", …) as ready requests + presets |

## Ranking + trader tools (need `POLYRANK_API_KEY`)

| Tool                          | What it does                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `polyrank_rank_wallets`       | The Ranking Builder: weights × windows × filters, `as_of`, explain, any sort    |
| `polyrank_get_trader_metrics` | One trader's every metric at a window: value + percentile (address or `tid`)  |

## Strategy Lab tools (need `POLYRANK_API_KEY`; results are SIMULATED)

| Tool                          | What it does                                                         |
| ----------------------------- | -------------------------------------------------------------------- |
| `polyrank_list_lab_templates` | Strategy templates (editable specs) with their as-of evidence        |
| `polyrank_create_strategy`    | Save a strategy (spec or template)                                    |
| `polyrank_run_backtest`       | Queue a backtest of a strategy or spec over a date range             |
| `polyrank_get_backtest`       | A backtest's status and report                                        |
| `polyrank_start_paper`        | Start paper trading a strategy against real order books (no money)   |
| `polyrank_get_paper_run`      | A paper run's stats and its copies                                    |

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

Not affiliated with Polymarket · not investment advice · not custodial.
