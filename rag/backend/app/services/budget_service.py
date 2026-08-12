"""Budget compliance tools for querying team members, expenses, and budget limits."""
import logging
import ssl
import asyncpg
from app.config import get_settings
from app.services.langsmith import traceable

logger = logging.getLogger(__name__)


async def _get_connection():
    """Get an asyncpg connection using the sql_reader DSN."""
    settings = get_settings()
    if not settings.sql_reader_database_url:
        return None
    connect_kwargs = {
        "dsn": settings.sql_reader_database_url,
        "statement_cache_size": 0,
    }
    try:
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        return await asyncpg.connect(**connect_kwargs, ssl=ssl_context)
    except Exception:
        return await asyncpg.connect(**connect_kwargs)


def _format_results(rows: list[asyncpg.Record]) -> str:
    """Format query results as a readable table."""
    if not rows:
        return "Query returned 0 rows."
    headers = list(rows[0].keys())
    lines = [" | ".join(str(h) for h in headers)]
    lines.append("-" * len(lines[0]))
    for row in rows[:100]:
        values = [str(row[h]) for h in headers]
        lines.append(" | ".join(values))
    msg = f"Query returned {len(rows)} row(s)"
    if len(rows) > 100:
        msg += " (showing first 100)"
    return msg + ":\n\n" + "\n".join(lines)


@traceable(name="get_team_members", run_type="tool")
async def get_team_members(department: str, redaction_svc=None) -> str:
    """Get team members for a department."""
    conn = await _get_connection()
    if conn is None:
        return "Error: SQL agent not configured. Set SQL_READER_DATABASE_URL in environment."
    try:
        rows = await conn.fetch(
            "SELECT id, name, level, email FROM team_members WHERE department = $1",
            department,
        )
        if not rows:
            return f"No team members found in department '{department}'."
        return _format_results(rows)
    except Exception as e:
        logger.error(f"get_team_members error: {e}")
        return f"Error: {e}"
    finally:
        await conn.close()


@traceable(name="get_expenses", run_type="tool")
async def get_expenses(user_id: str, quarter: str, redaction_svc=None) -> str:
    """Get travel expense line items for a specific team member and quarter."""
    conn = await _get_connection()
    if conn is None:
        return "Error: SQL agent not configured. Set SQL_READER_DATABASE_URL in environment."
    try:
        import uuid as _uuid
        uid = _uuid.UUID(user_id)
        rows = await conn.fetch(
            "SELECT category, description, amount, expense_date FROM travel_expenses WHERE user_id = $1 AND quarter = $2",
            uid, quarter,
        )
        if not rows:
            return f"No expenses found for user_id '{user_id}' in {quarter}."
        return _format_results(rows)
    except ValueError:
        return f"Error: Invalid user_id format '{user_id}'. Expected a UUID."
    except Exception as e:
        logger.error(f"get_expenses error: {e}")
        return f"Error: {e}"
    finally:
        await conn.close()


@traceable(name="get_budget_by_level", run_type="tool")
async def get_budget_by_level(level: str, redaction_svc=None) -> str:
    """Get quarterly travel budget limits for an employee level."""
    conn = await _get_connection()
    if conn is None:
        return "Error: SQL agent not configured. Set SQL_READER_DATABASE_URL in environment."
    try:
        rows = await conn.fetch(
            "SELECT category, quarterly_limit FROM budget_limits WHERE level = $1",
            level,
        )
        if not rows:
            return f"No budget limits found for level '{level}'."
        return _format_results(rows)
    except Exception as e:
        logger.error(f"get_budget_by_level error: {e}")
        return f"Error: {e}"
    finally:
        await conn.close()
