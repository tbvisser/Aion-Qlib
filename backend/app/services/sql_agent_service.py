"""SQL agent service for executing queries with a dedicated read-only database user."""
import logging
import ssl
import asyncpg
from app.config import get_settings
from app.services.langsmith import traceable

logger = logging.getLogger(__name__)

SALES_DATA_SCHEMA = """Table: sales_data
Columns:
  - id (UUID, primary key)
  - order_date (DATE)
  - customer_name (TEXT)
  - product_name (TEXT)
  - category (TEXT) - e.g., 'Electronics', 'Furniture'
  - quantity (INTEGER)
  - unit_price (DECIMAL)
  - total_amount (DECIMAL) - computed as quantity * unit_price
  - region (TEXT) - e.g., 'North', 'South', 'East', 'West'
  - status (TEXT) - one of: 'pending', 'shipped', 'delivered', 'returned'
"""


@traceable(name="execute_sql_query", run_type="tool")
async def execute_sql_query(sql: str, redaction_svc=None) -> str:
    """
    Execute a SQL query against the sales database using a read-only user.

    Security is enforced at the database level - the sql_reader user
    only has SELECT permission on the sales_data table.

    Args:
        sql: The SQL query to execute

    Returns:
        Formatted string with query results or error message
    """
    # De-anonymize SQL query (LLM generated it with fake names)
    real_sql = redaction_svc.deanonymize(sql) if redaction_svc is not None else sql

    settings = get_settings()

    if not settings.sql_reader_database_url:
        return "Error: SQL agent not configured. Set SQL_READER_DATABASE_URL in environment."

    try:
        # Connect with the read-only user
        # Supabase pooler uses PgBouncer in transaction mode, so disable prepared statements
        # Try SSL first, fall back to no SSL for local dev (Supavisor rejects SSL locally)
        connect_kwargs = {
            "dsn": settings.sql_reader_database_url,
            "statement_cache_size": 0,
        }
        try:
            ssl_context = ssl.create_default_context()
            ssl_context.check_hostname = False
            ssl_context.verify_mode = ssl.CERT_NONE
            conn = await asyncpg.connect(**connect_kwargs, ssl=ssl_context)
        except Exception:
            conn = await asyncpg.connect(**connect_kwargs)

        try:
            # Execute the query with real (de-anonymized) names
            rows = await conn.fetch(real_sql)

            if not rows:
                return "Query returned 0 rows."

            formatted = _format_results(rows)
            # NOTE: Do NOT anonymize here — chat.py's anon_msgs loop handles
            # anonymization for all messages sent to the LLM.  Anonymizing in
            # both places causes double-anonymization (BUG-3).
            return formatted

        finally:
            await conn.close()

    except asyncpg.InsufficientPrivilegeError as e:
        return f"Permission denied: {e}"
    except asyncpg.PostgresSyntaxError as e:
        return f"SQL syntax error: {e}"
    except asyncpg.UndefinedTableError as e:
        return f"Table not found: {e}"
    except asyncpg.UndefinedColumnError as e:
        return f"Column not found: {e}"
    except Exception as e:
        logger.error(f"SQL execution error: {e}")
        return f"SQL Error: {e}"


def _format_results(rows: list[asyncpg.Record]) -> str:
    """Format query results as a readable table."""
    if not rows:
        return "Query returned 0 rows."

    # Get column names from the first row
    headers = list(rows[0].keys())

    lines = [" | ".join(str(h) for h in headers)]
    lines.append("-" * len(lines[0]))

    for row in rows[:100]:  # Limit to 100 rows
        values = [str(row[h]) for h in headers]
        lines.append(" | ".join(values))

    msg = f"Query returned {len(rows)} row(s)"
    if len(rows) > 100:
        msg += " (showing first 100)"

    return msg + ":\n\n" + "\n".join(lines)


def get_sales_schema() -> str:
    """Return the schema description for the sales_data table."""
    return SALES_DATA_SCHEMA
