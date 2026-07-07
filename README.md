# @polyrank/mcp

MCP server that gives AI agents (Claude, etc.) direct access to **Polyrank** —
the skill-analytics layer for Polymarket. It ranks millions of Polymarket
wallets by genuine forecasting skill (calibration / Brier, alpha-vs-mid,
risk-adjusted return) — not vanity P&L or win rate. _Follow the skilled, not the
lucky._ (Live coverage + the exact skill-metric count: `polyrank_get_platform_stats`.)

It wraps Polyrank's free public API. Deep / premium data (full Brier
decomposition, alpha, smart-money positioning) is billed per-request via
**x402** (USDC on Base) — see <https://polyrank.app/llms.txt>.

## Tools (all read-only)

| Tool                              | What it does                                               |
| --------------------------------- | ---------------------------------------------------------- |
| `polyrank_get_leaderboard`        | Top traders ranked by composite skill                      |
| `polyrank_get_trader_skill`       | A wallet's P&L / win-rate / volume / percentiles           |
| `polyrank_get_trader_calibration` | A wallet's 10-bin reliability diagram                      |
| `polyrank_get_market_consensus`   | Smart-money consensus vs market mid + top holders          |
| `polyrank_get_pulse`              | Live activity: big wins, sharp moves, trending, divergence |
| `polyrank_get_platform_stats`     | Live coverage + skill-metric count (wallets/trades/markets) |
| `polyrank_get_top_roi_trades`     | Biggest return-on-cost resolved trades (filter by category) |
| `polyrank_get_movers`             | Traders climbing / falling fastest in skill rank           |
| `polyrank_get_smart_money_reports`| Weekly Smart-Money Report archive                          |
| `polyrank_get_smart_money_report` | One weekly Smart-Money Report in full                      |
| `polyrank_get_trader_by_tid`      | Follow a masked trader by its `tid`                        |

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

Config: `POLYRANK_API_BASE` (default `https://api.polyrank.app`).

Not affiliated with Polymarket · not investment advice · not custodial.
