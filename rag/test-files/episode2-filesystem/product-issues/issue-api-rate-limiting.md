# ISSUE: API Rate Limiting Incorrectly Throttling Valid Requests

| Field | Value |
|-------|-------|
| **Issue ID** | PROD-2955 |
| **Severity** | High |
| **Status** | Resolved |
| **Reported Date** | 2025-01-20 |
| **Last Updated** | 2025-02-05 |

## Description

Several enterprise customers reported receiving HTTP 429 (Too Many Requests) responses despite operating well within their contracted API rate limits. Investigation revealed that the rate limiting middleware was incorrectly counting requests across multiple API keys belonging to the same organization, effectively treating the organization's aggregate traffic as a single client. Customers with multiple integrations or microservices each using separate API keys were hitting the per-key rate limit at a fraction of their expected capacity. The issue was most pronounced for customers on the Enterprise plan who typically operate 5-10 distinct API keys for different internal services. Some customers experienced up to 40% request rejection rates during business hours, causing downstream failures in their automated workflows and data pipelines.

## Root Cause

A deployment on January 18, 2025 introduced a change to the Redis-based rate limiter that replaced the API key-based rate limiting key with an organization ID-based key. This change was intended to simplify rate limit tracking for billing purposes but inadvertently consolidated all rate limit counters for API keys under the same organization into a single sliding window counter. The per-key limit of 1,000 requests per minute was applied to the organization-level counter instead of being distributed across individual keys. The change passed code review but lacked integration tests covering multi-key scenarios.

## Affected Systems/Users

- **Users Impacted:** 47 organizations with multiple API keys, predominantly Enterprise and Business plan customers
- **Systems Affected:** API gateway rate limiting middleware, Redis rate limit counters, API key management service
- **Business Impact:** 12 enterprise customers escalated through their account managers; 3 customers temporarily reverted to backup manual processes

## Workaround

As a temporary measure, the operations team doubled the per-organization rate limit while the fix was being developed. Affected customers were also provided with guidance on request batching to reduce call volume.

## Resolution

- Reverted the rate limit key to use individual API key identifiers rather than organization IDs
- Added a separate organization-level aggregate counter for billing analytics (read-only, does not enforce limits)
- Created integration test suite covering multi-key rate limiting scenarios
- Deployed canary release process for rate limiting configuration changes
- Published incident report to affected customers with SLA credit details

## Related Issues

- [PROD-3042: Webhook Delivery Failures](#) - webhook retries contributed to elevated API request counts during the incident
- [PROD-2847: Login Timeout](#) - rate limiting changes were part of the same deployment cycle
