"""Service half of the scalability agent: config, Postgres queue access,
Supabase Storage access, the poll-loop workers, and the process entrypoint.

The analysis itself lives in ``scalability_agent.engine`` and is deliberately
free of service imports; this package is the only place that talks to the
database and Storage.
"""
