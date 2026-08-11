# ISSUE: Dashboard Loading Slow for Accounts with Large Datasets

| Field | Value |
|-------|-------|
| **Issue ID** | PROD-2863 |
| **Severity** | Medium |
| **Status** | In Progress |
| **Reported Date** | 2025-01-08 |
| **Last Updated** | 2025-02-18 |

## Description

Users with large datasets (over 10,000 records) experience significantly degraded dashboard loading times. The main analytics dashboard takes between 8 and 25 seconds to fully render, compared to the target of under 3 seconds. The issue is most noticeable on the overview page, which displays summary charts, recent activity feeds, and aggregate metrics. Users report that the page appears to load partially, with chart placeholders visible for several seconds before data populates. In some cases, the browser tab becomes unresponsive during loading, triggering Chrome's "Page Unresponsive" dialog. The problem has been gradually worsening over the past two months as customer data volumes have grown, with the most severe cases reported by accounts that have been active for over 12 months.

## Root Cause

The dashboard overview endpoint performs multiple aggregate queries against the primary database without pagination or time-window constraints. For accounts with large datasets, these queries scan full table partitions, leading to sequential scan operations that bypass available indexes. The frontend compounds the issue by requesting all dashboard widgets simultaneously on page load, creating 8 concurrent API calls that compete for database connections. Additionally, the frontend chart rendering library (Recharts) re-renders the entire chart component tree on each data update rather than performing incremental updates, causing excessive DOM manipulation for large result sets.

## Affected Systems/Users

- **Users Impacted:** Approximately 850 accounts with over 10,000 records (12% of total user base), growing as accounts accumulate more data
- **Systems Affected:** Dashboard API endpoints, PostgreSQL analytics queries, frontend chart rendering pipeline
- **Business Impact:** Increased churn risk for power users; 34 support tickets in January specifically mentioning dashboard performance

## Workaround

Users can apply date range filters to reduce the dataset size loaded by the dashboard. Setting the view to "Last 30 Days" instead of "All Time" typically reduces load times to under 5 seconds. The support team proactively reaches out to affected high-value accounts with this guidance.

## Resolution (In Progress)

- **Completed:** Added composite indexes on commonly queried columns (reduced query time by 40%)
- **Completed:** Implemented staggered widget loading with priority ordering (critical metrics load first)
- **In Progress:** Building a materialized view refresh pipeline for dashboard aggregates (ETA: 2025-02-28)
- **Planned:** Migrate chart rendering to a virtualized approach for datasets over 5,000 points
- **Planned:** Implement server-side data downsampling for chart display

## Related Issues

- [PROD-2847: Login Timeout](#) - auth service delays compound the perceived dashboard load time
- [PROD-2990: Search Indexing Lag](#) - search results widget on the dashboard affected by indexing delays
