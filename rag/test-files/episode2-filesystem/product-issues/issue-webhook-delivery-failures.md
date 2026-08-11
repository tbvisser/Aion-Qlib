# ISSUE: Webhook Delivery Failures to Customer Endpoints

| Field | Value |
|-------|-------|
| **Issue ID** | PROD-3042 |
| **Severity** | High |
| **Status** | Open |
| **Reported Date** | 2025-02-03 |
| **Last Updated** | 2025-02-20 |

## Description

Webhook deliveries to customer-configured endpoints are failing at an elevated rate, with the overall delivery success rate dropping from 99.2% to approximately 91% over the past three weeks. Failed deliveries span multiple event types including subscription changes, usage threshold alerts, and data export completions. Customers relying on webhooks for real-time integrations with their internal systems are experiencing data synchronization gaps and missed automation triggers. The failures are not concentrated on specific customer endpoints; rather, they are distributed across the customer base, suggesting a platform-side issue rather than individual endpoint problems. The webhook delivery logs show a mix of timeout errors (HTTP 504), connection refused errors, and TLS handshake failures, with timeout errors accounting for approximately 65% of all failures.

## Root Cause

Investigation has identified two contributing factors. First, the webhook delivery service was recently migrated from a single-region deployment to a multi-region architecture for redundancy. The new deployment routes outbound webhook requests through a NAT gateway with a different set of IP addresses than the previous deployment. Customers who have IP allowlisting configured on their webhook endpoints are rejecting requests from the new IP addresses. Second, the webhook delivery timeout was reduced from 30 seconds to 10 seconds during the migration to improve throughput, but many customer endpoints (particularly those behind CDNs or corporate firewalls) have response times between 10 and 25 seconds, causing premature timeout failures.

## Affected Systems/Users

- **Users Impacted:** Approximately 580 organizations with active webhook configurations (34% of webhook-enabled accounts)
- **Systems Affected:** Webhook delivery service, NAT gateway, webhook retry queue, event notification pipeline
- **Business Impact:** 67 support tickets opened; 8 enterprise customers escalated through account management; potential SLA violation for 3 contractual webhook delivery guarantees

## Workaround

Customers experiencing failures due to IP allowlisting have been provided with the updated list of NAT gateway IP addresses to add to their firewall rules. For timeout-related failures, customers can implement a lightweight acknowledgment pattern where their endpoint returns HTTP 200 immediately and processes the webhook payload asynchronously. The webhook dashboard now displays delivery status with detailed error messages to help customers self-diagnose.

## Resolution (Planned)

- **Immediate:** Increase webhook delivery timeout back to 30 seconds (scheduled for 2025-02-22)
- **Short-term:** Publish static IP ranges in API documentation and send proactive notifications before any future IP changes
- **Medium-term:** Implement webhook delivery with configurable timeout per endpoint (ETA: 2025-03-15)
- **Long-term:** Add webhook signature verification and mutual TLS support to reduce dependency on IP allowlisting

## Related Issues

- [PROD-2955: API Rate Limiting](#) - webhook retries contribute to elevated API traffic during delivery failure periods
- [PROD-2934: Email Notifications Delayed](#) - shares the asynchronous delivery infrastructure pattern
- [PROD-2910: Billing Sync Failure](#) - billing webhooks from Stripe use similar delivery patterns
