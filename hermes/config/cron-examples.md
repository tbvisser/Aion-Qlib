# Hermes cron examples for Aion (copy-paste starters)

Configure inside a Hermes CLI or gateway session with natural language, or
add jobs via `hermes cron` — see
[Hermes cron docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron).

These are **not** auto-installed. Each requires a running `hermes-gateway` with
messaging configured if you want Telegram/Discord delivery.

## Monday backtest digest

> Every Monday at 08:00 America/New_York, call the Aion MCP tool `list_runs`
> with limit 5, summarize statuses and any completed metrics, and send the
> summary to my Telegram home chat.

## SPY regime alert

> Every weekday at 09:35 America/New_York, call `get_markov_signal` for SPY.
> If the current regime changed since the last run, send me a one-line alert
> on Telegram with bull/bear/sideways probabilities.

## Scalability report ping

> When I ask you to watch report `{report_id}`, poll `get_scalability_report`
> every 10 minutes until status is completed or failed, then message me the
> headline findings.

**Note:** `list_runs` and `get_scalability_report` require `AION_MCP_SERVICE_USER_ID`
to be set on the `aion-mcp` service (see `aion_mcp/README.md`).
