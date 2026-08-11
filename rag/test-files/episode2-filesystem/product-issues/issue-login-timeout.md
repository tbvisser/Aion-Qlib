# ISSUE: Login Timeout During Peak Hours

| Field | Value |
|-------|-------|
| **Issue ID** | PROD-2847 |
| **Severity** | Critical |
| **Status** | Resolved |
| **Reported Date** | 2025-01-06 |
| **Last Updated** | 2025-01-20 |

## Description

Users experience login timeouts when attempting to authenticate during peak usage hours, typically between 9:00 AM and 11:00 AM EST. The login request hangs for approximately 30 seconds before returning a 504 Gateway Timeout error. Users see a generic "Something went wrong" message and are unable to access the platform. The issue disproportionately affects users authenticating via email/password rather than SSO, and is most severe on Monday mornings when concurrent login volume spikes by approximately 340% compared to off-peak periods. Internal monitoring indicates that the authentication service response time degrades from a baseline of 200ms to over 30 seconds during these windows. Approximately 15% of login attempts fail outright during peak periods.

## Root Cause

The authentication service was configured with a connection pool maximum of 20 database connections, which became exhausted during peak login volume. Each authentication request held a connection for the duration of password hashing (bcrypt with cost factor 12), creating a bottleneck. Additionally, the session token generation step performed a synchronous write to the sessions table with a row-level lock, further compounding connection wait times under load. The database connection pooler (PgBouncer) was operating in session mode rather than transaction mode, preventing connection reuse between requests.

## Affected Systems/Users

- **Users Impacted:** Approximately 2,400 users during peak windows (18% of total active user base)
- **Systems Affected:** Authentication service, session management, PgBouncer connection pooler
- **Business Impact:** Support ticket volume increased by 280% during affected periods; estimated revenue impact from delayed customer onboarding calls

## Workaround

During the active incident period, users were advised to retry login after a 60-second wait or use SSO authentication if available on their plan. The operations team temporarily increased the PgBouncer connection limit to 50 as an interim measure while the permanent fix was developed.

## Resolution

- Switched PgBouncer from session mode to transaction mode
- Increased connection pool maximum from 20 to 100
- Reduced bcrypt cost factor from 12 to 10 (still within security guidelines)
- Added connection timeout and retry logic to the authentication service
- Deployed horizontal auto-scaling for the auth service with a minimum of 3 replicas during business hours

## Related Issues

- [PROD-2901: SSO Redirect Loop](#) - discovered during investigation of this issue
- [PROD-2863: Dashboard Loading Slow After Login](#) - cascading effect from auth service delays
- [PROD-3012: Two-Factor Auth SMS Delay](#) - shared dependency on auth service throughput
