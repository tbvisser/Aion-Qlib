# ISSUE: Email Notifications Delayed by Up to 6 Hours

| Field | Value |
|-------|-------|
| **Issue ID** | PROD-2934 |
| **Severity** | Medium |
| **Status** | Resolved |
| **Reported Date** | 2025-01-15 |
| **Last Updated** | 2025-01-30 |

## Description

Transactional email notifications, including password reset links, invoice receipts, collaboration invitations, and usage alerts, are being delivered with delays ranging from 30 minutes to 6 hours. Under normal operation, emails are delivered within 60 seconds of the triggering event. The delay affects all email categories but is most impactful for time-sensitive notifications such as password resets and security alerts. Users attempting password resets often give up and contact support before the email arrives, while collaboration invitations lose context when delivered hours after being sent. The issue began gradually around January 10, 2025, and escalated to noticeable levels by January 15 when support ticket volume regarding missing emails tripled compared to the prior week.

## Root Cause

The email notification service uses a message queue (Amazon SQS) to decouple email generation from delivery. A misconfiguration in the SQS visibility timeout, introduced during a routine infrastructure update on January 9, reduced the timeout from 300 seconds to 30 seconds. When the email rendering service took longer than 30 seconds to process a message (common for emails with dynamic content and template rendering), the message became visible again in the queue and was picked up by another worker. This created a cascade of duplicate processing attempts that consumed worker capacity, effectively creating a backlog. The dead-letter queue was also misconfigured with a maximum receive count of 1, causing messages to be moved to the DLQ after a single failed attempt rather than being retried.

## Affected Systems/Users

- **Users Impacted:** All users receiving transactional emails during the affected period (estimated 8,500 unique recipients)
- **Systems Affected:** SQS email queue, email rendering service, SendGrid delivery pipeline, dead-letter queue
- **Business Impact:** 156 support tickets related to missing or delayed emails; estimated 45 abandoned password reset flows; 12 collaboration workflows delayed

## Workaround

During the incident, the support team manually triggered re-sends for password reset and security-related emails on request. A temporary batch job was deployed to process the dead-letter queue backlog every 15 minutes.

## Resolution

- Restored SQS visibility timeout to 300 seconds
- Increased dead-letter queue maximum receive count from 1 to 5
- Added CloudWatch alarms for queue depth exceeding 100 messages and DLQ message count exceeding 10
- Implemented email delivery latency monitoring with PagerDuty alerting for p95 latency over 120 seconds
- Added infrastructure-as-code validation checks to prevent configuration drift on queue settings

## Related Issues

- [PROD-3012: Two-Factor Auth SMS Delay](#) - similar queuing architecture, audited as part of this investigation
- [PROD-3042: Webhook Delivery Failures](#) - shares the message queue infrastructure pattern
