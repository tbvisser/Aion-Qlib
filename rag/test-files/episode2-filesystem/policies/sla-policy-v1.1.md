# Service Level Agreement (SLA) Policy

**Version:** 1.1
**Effective Date:** April 1, 2025
**Last Reviewed:** March 25, 2025
**Owner:** Operations & Customer Support
**Status:** Active
**Change Summary:** Updated response times for Professional and Enterprise tiers, added dedicated support channel for Enterprise, clarified credit claim process.

## 1. Purpose

This policy defines the service level commitments that Acme Corporation provides to its customers. It establishes measurable performance targets for platform availability, support responsiveness, and issue resolution to ensure consistent, reliable service delivery.

## 2. Scope

This SLA applies to all customers on paid subscription plans (Starter, Professional, and Enterprise). Free-tier users receive best-effort support without guaranteed response times.

## 3. Platform Availability

Acme Corporation commits to the following uptime guarantees for its cloud platform:

| Plan | Monthly Uptime Target | Measurement Window |
|------|----------------------|-------------------|
| Starter | 99.5% | Calendar month |
| Professional | 99.9% | Calendar month |
| Enterprise | 99.99% | Calendar month |

Scheduled maintenance windows (announced 72 hours in advance) are excluded from uptime calculations. Maintenance is performed during low-traffic periods, typically Sundays between 2:00 AM and 6:00 AM UTC.

## 4. Support Response Times

Response times are measured from the moment a support request is received and logged in the ticketing system to the first substantive response from a support representative.

| Priority | Starter | Professional | Enterprise |
|----------|---------|-------------|------------|
| Critical (P1) | 4 hours | 1 hour | 30 minutes |
| High (P2) | 8 hours | 2 hours | 1 hour |
| Medium (P3) | 24 hours | 8 hours | 4 hours |
| Low (P4) | 48 hours | 24 hours | 8 hours |

Response times apply during business hours only (Monday-Friday, 8:00 AM - 6:00 PM UTC) for Starter and Professional plans. Enterprise plans receive 24/7 support with a dedicated support channel and named account engineer.

### 4.1 Enterprise Dedicated Support

Enterprise customers are assigned a dedicated Account Engineer who serves as the primary technical contact. This engineer:

- Participates in quarterly business reviews
- Provides proactive monitoring alerts for the customer's environment
- Has direct access to the Engineering team for expedited issue resolution
- Is available via a dedicated Slack channel or phone line during business hours

## 5. Issue Resolution Targets

Resolution times represent targets, not guarantees, as complex issues may require extended investigation.

| Priority | Target Resolution |
|----------|------------------|
| Critical (P1) | 4 hours |
| High (P2) | 16 hours |
| Medium (P3) | 48 hours |
| Low (P4) | 5 business days |

## 6. SLA Credits

If Acme Corporation fails to meet the uptime commitment in a given month, affected customers are eligible for service credits:

| Uptime Achieved | Credit (% of monthly fee) |
|----------------|--------------------------|
| 99.0% - 99.49% | 10% |
| 98.0% - 98.99% | 25% |
| 95.0% - 97.99% | 40% |
| Below 95.0% | 50% |

### 6.1 Credit Claim Process

1. Submit a credit request via the support portal or email to sla-credits@acmecorp.com within 30 days of the affected month.
2. Include the dates and times of the experienced outage.
3. Acme will validate the claim against internal monitoring data within 5 business days.
4. Approved credits are applied to the next invoice. If the customer has cancelled, a refund check is issued within 30 days.

## 7. Exclusions

This SLA does not apply to:

- Outages caused by factors outside Acme's reasonable control (force majeure)
- Issues resulting from customer's misuse of the platform
- Beta or preview features
- Third-party integrations not managed by Acme
- Connectivity issues between the customer's network and Acme's infrastructure

## 8. Reporting

Customers may request monthly SLA performance reports through their account manager or via the support portal. Enterprise customers receive automated monthly reports with detailed uptime metrics, incident summaries, and trend analysis.

---

*Document Control: This policy supersedes Version 1.0 dated January 15, 2025. Next scheduled review: October 2025.*
