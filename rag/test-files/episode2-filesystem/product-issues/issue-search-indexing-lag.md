# ISSUE: Search Indexing Lag Causing Stale Results

| Field | Value |
|-------|-------|
| **Issue ID** | PROD-2990 |
| **Severity** | Medium |
| **Status** | In Progress |
| **Reported Date** | 2025-01-27 |
| **Last Updated** | 2025-02-12 |

## Description

The platform's full-text search functionality is returning stale or incomplete results due to a growing lag between data creation and search index updates. Under normal operation, newly created or updated records should appear in search results within 30 seconds. Currently, the indexing lag ranges from 5 minutes to over 2 hours depending on system load. Users report that recently created documents, updated contact records, and new project entries do not appear in search results for an extended period after creation. This is particularly disruptive for workflows that involve creating a record and immediately searching for it to link or reference it in another context. Power users who rely heavily on search for navigation and record discovery are most affected, with several reporting that they have reverted to manual browsing of record lists as a workaround.

## Root Cause

The search indexing pipeline uses an Elasticsearch cluster with a change data capture (CDC) stream from PostgreSQL via Debezium. The CDC connector has been experiencing increased lag due to a combination of factors: the PostgreSQL write-ahead log (WAL) retention has grown significantly as data volume increased, causing the Debezium connector to fall behind during catch-up operations after routine restarts. Additionally, the Elasticsearch cluster's indexing throughput has degraded because the index mapping was not updated to account for new fields added in recent product releases, resulting in dynamic field mapping that triggers frequent index mapping updates and slows bulk indexing operations. The Elasticsearch cluster's heap usage consistently runs above 85%, further degrading indexing performance.

## Affected Systems/Users

- **Users Impacted:** All users performing searches are potentially affected; most noticeable for approximately 2,100 users who create or update records and search for them within a 30-minute window
- **Systems Affected:** Elasticsearch cluster, Debezium CDC connector, PostgreSQL WAL, search API endpoints
- **Business Impact:** 41 support tickets mentioning search issues; user satisfaction survey scores for search functionality dropped from 4.1/5 to 2.8/5 in January

## Workaround

Users can access recently created records through direct navigation (e.g., activity feed, recent items list, or direct URL). The engineering team has also deployed a temporary "Recent Records" widget on the dashboard that queries the primary database directly for records created in the last 2 hours, bypassing the search index.

## Resolution (In Progress)

- **Completed:** Upgraded Elasticsearch cluster heap from 8GB to 16GB per node
- **Completed:** Defined explicit index mappings for all current fields to prevent dynamic mapping overhead
- **In Progress:** Optimizing Debezium connector configuration for higher throughput (batch size, poll interval tuning)
- **In Progress:** Implementing a dual-write strategy for search-critical record types to reduce dependency on CDC lag
- **Planned:** Evaluating migration from Elasticsearch to OpenSearch with native PostgreSQL integration (ETA: Q2 2025 decision)

## Related Issues

- [PROD-2863: Dashboard Loading Slow](#) - dashboard search widget contributes to perceived slowness
- [PROD-2978: Export CSV Formatting](#) - search-based report generation affected by stale index data
