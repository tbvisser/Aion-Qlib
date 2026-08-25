# Aion Platform Context

You are operating alongside the **Aion-Qlib** quantitative research stack.

## What Aion provides

| Surface | URL (host dev) | Purpose |
|---|---|---|
| Aion UI | http://localhost:5274 | Strategies, backtests, Markov lab, Agents & Skills |
| qlib API | http://localhost:8770 | REST + chat assistant |
| Aion MCP | http://aion-mcp:8910/mcp (docker) | Read-only qlib tools for MCP hosts |
| Vibe MCP | http://vibe-mcp:8900/mcp (docker) | Alpha Zoo, market data, shadow tools |

## MCP tool guidance

**Aion MCP (read-only v1):** `get_data_status`, `search_instruments`,
`get_price_summary`, `evaluate_factor`, `get_markov_signal`, `get_run_status`,
`list_runs`, `get_scalability_report`.

**Not exposed via Aion MCP:** starting backtests, queueing scalability analysis,
booking venue consultations — send the user to the UI for those.

**Vibe MCP:** use for Alpha Zoo factor search, market screens, and shadow-account
workflows. Live order placement is blocked at the Aion proxy layer.

## Conventions

- US EODHD qlib store is the default dataset; call `get_data_status` before
  assuming universe or date range.
- Backtests take minutes; report run ids and point users to the Runs page.
- IC near zero means no signal — say so plainly.

## Do not

- Place live trades or bypass paper/shadow gates.
- Guess prices, Sharpe ratios, or IC when a tool can measure them.
- Paste secrets (API keys, tokens) into chat.
