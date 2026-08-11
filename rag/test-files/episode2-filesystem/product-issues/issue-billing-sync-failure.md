# ISSUE: Billing Sync Failure Between Stripe and Internal Ledger

| Field | Value |
|-------|-------|
| **Issue ID** | PROD-2910 |
| **Severity** | High |
| **Status** | Monitoring |
| **Reported Date** | 2025-01-13 |
| **Last Updated** | 2025-02-10 |

## Description

The billing synchronization process between Stripe and the internal billing ledger intermittently fails, resulting in discrepancies between what customers are charged and what the internal system records. The issue manifests as missing subscription renewal events, duplicated one-time charges, and incorrect plan tier assignments in the internal database. Affected customers may see incorrect invoices in their billing portal, or customer success teams may reference outdated plan information when assisting users. The sync failures occur in approximately 3-5% of daily billing events, with higher failure rates observed during Stripe's scheduled maintenance windows. The discrepancies are typically detected 24-48 hours after occurrence during the daily reconciliation job, making real-time correction difficult.

## Root Cause

The billing sync relies on Stripe webhook events delivered to a single endpoint. During periods of high event volume or transient network issues, some webhook deliveries fail and are retried by Stripe with exponential backoff. The webhook handler was not idempotent -- it lacked deduplication logic based on Stripe event IDs, causing duplicate processing of retried events. Additionally, the internal ledger update and the webhook acknowledgment were not wrapped in a database transaction, leading to cases where the acknowledgment was sent but the ledger write failed due to a deadlock on the subscriptions table. Stripe's retry mechanism then re-delivered the event, but the handler treated it as a new event.

## Affected Systems/Users

- **Users Impacted:** Approximately 340 accounts with billing discrepancies identified over a 4-week period
- **Systems Affected:** Stripe webhook handler, internal billing ledger, subscription management service, invoice generation pipeline
- **Business Impact:** Finance team required 12 additional hours per week for manual reconciliation; 23 customer complaints filed regarding incorrect charges

## Workaround

The finance team runs a daily reconciliation script that compares Stripe records against the internal ledger and flags discrepancies for manual review. Customers who report incorrect charges are issued credits within 24 hours while the root cause fix is deployed.

## Resolution (In Progress)

- Implemented idempotent webhook processing using Stripe event IDs as deduplication keys (deployed)
- Wrapped ledger updates and acknowledgments in database transactions (deployed)
- Added a dead-letter queue for failed webhook events with automated retry (deployed)
- Monitoring for 30 days to confirm zero-discrepancy target before closing
- Planned: Real-time reconciliation service to detect drift within 5 minutes

## Related Issues

- [PROD-3105: Payment Gateway Timeout](#) - shares dependency on Stripe API availability
- [PROD-2978: Export CSV Formatting](#) - billing export reports include incorrect data when sync is out of date
