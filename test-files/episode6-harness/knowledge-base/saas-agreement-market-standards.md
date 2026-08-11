# Mercer & Hartwell LLP — SaaS Agreement Review Standards

**Document ID:** MH-STD-2024-003
**Last Updated:** December 2025
**Owner:** Technology Transactions Practice Group
**Classification:** Internal — All Attorneys

## Purpose

This document defines Mercer & Hartwell's baseline positions and acceptable ranges for Software-as-a-Service agreements. All contract reviews must assess terms against these standards. Deviations from our standard positions require documented justification in the review report.

## Term and Renewal

### Our Standard Position
- Initial terms of 1–3 years. Terms exceeding 3 years should include pricing concessions of at least 10–15%.
- Auto-renewal for successive 1-year terms with 60–90 days non-renewal notice.
- Termination for convenience must be available to our clients, at minimum during renewal terms with 60 days notice.

### Acceptable Range
- 90-day non-renewal notice periods
- No termination for convenience during the initial term only, provided renewal terms include a convenience termination right

### Escalation Triggers
- **Flag YELLOW:** Non-renewal notice window shorter than 60 days or longer than 120 days
- **Flag RED:** No termination for convenience at all, combined with auto-renewal — this creates an evergreen lock-in. Recommend client reject or negotiate exit rights.
- **Flag RED:** Early termination requiring payment of all remaining fees. This is economically equivalent to no termination right at all.

## Pricing and Fees

### Our Standard Position
- Annual price increases capped at CPI or 5%, whichever is greater
- 90 days advance notice of any fee increase
- Client should have right to terminate without penalty if increase exceeds cap

### Acceptable Range
- Increases capped at 5–8% with at least 60 days notice
- Late payment interest at 1.0–1.5% per month (industry norm)

### Escalation Triggers
- **Flag YELLOW:** Increases capped at 8–10%, or notice periods under 60 days
- **Flag RED:** Increases exceeding 10% per renewal. Note: 15% compounded over 3 renewals equals a 52% increase — always calculate the compounding impact and include it in the report.
- **Flag RED:** Uncapped price increases with deemed-acceptance mechanisms

## Intellectual Property

### Our Standard Position — Provider IP
- Provider retains all IP in the service and underlying technology. This is universally standard and should be rated GREEN.

### Our Standard Position — Feedback/Suggestions
- Our clients grant a **non-exclusive, royalty-free license** to use feedback for product improvement. Client retains all ownership rights.
- We never accept full IP assignment of client feedback. This is a firm-wide policy — no exceptions without partner approval.

### Our Recommended Language
> "Client grants Provider a non-exclusive, royalty-free, perpetual license to use, modify, and incorporate Feedback into the Service. Client retains all ownership rights in Feedback and may use, disclose, or implement Feedback for any purpose without restriction."

### Escalation Triggers
- **Flag GREEN:** Non-exclusive license to use feedback
- **Flag YELLOW:** Exclusive license to use feedback (client loses ability to share ideas with competitors)
- **Flag RED:** Full IP assignment of all feedback to the provider. Our position: this is always unacceptable. The client loses all rights to their own ideas — cannot implement them internally, cannot share with other vendors, and the provider could patent the client's idea.

### Our Standard Position — Client Data
- Client retains all rights. Provider receives a limited license to process data solely to deliver the service, revocable upon termination.
- **Flag RED:** Any clause where the provider claims ownership or broad usage rights over client data.

## Service Level Agreements

### Our Standard Position
- 99.9% uptime for business-critical SaaS ("three nines" — 43.2 minutes downtime/month)
- Meaningful service credits applied automatically (not claim-based)
- Termination right if SLA breaches persist for 3+ consecutive months

### Our Standard Credit Schedule

| Monthly Uptime | Credit |
|---|---|
| 99.0% – 99.9% | 10% of monthly fees |
| 98.0% – 99.0% | 25% of monthly fees |
| Below 98.0% | 50% of monthly fees + termination right |

### Acceptable Range
- 99.5% uptime with basic credit structure (minimum acceptable)
- Claim-based credits with reasonable windows (30 days to file)
- Scheduled maintenance excluded if limited to defined off-hours windows with 48-hour advance notice

### Escalation Triggers
- **Flag GREEN:** 99.9%+ uptime with automatic credits and termination rights
- **Flag YELLOW:** 99.5% uptime, or credits that require filing claims, or no termination trigger for persistent failures
- **Flag YELLOW:** No SLA remedies specified (uptime promise without teeth)
- **Flag RED:** Below 99.5% uptime, or broad exclusions that gut the SLA (e.g., excluding "factors beyond Provider's control")

## Liability

### Our Standard Position
- **Mutual cap** at 12 months of fees paid or payable, applying equally to both parties
- **Super cap** at 2–3x the general cap for: data breaches, confidentiality breaches, IP infringement, willful misconduct
- **Mutual exclusion** of indirect, incidental, special, consequential, and punitive damages

### Acceptable Range
- General cap between 12–24 months of fees
- Super cap up to 3x general cap for carved-out obligations
- Consequential damages carve-outs for data breaches and confidentiality (these should still be subject to the super cap)

### Escalation Triggers
- **Flag YELLOW:** Asymmetric caps where one party's cap is materially lower. Calculate the actual dollar exposure and include in the report.
- **Flag YELLOW:** No consequential damages exclusion (but liability cap exists)
- **Flag RED:** Unlimited liability for either party. Our position: this creates unpredictable, potentially catastrophic exposure. Even well-capitalized parties should cap liability for predictable risk management.
- **Flag RED:** One party excludes consequential damages while the other does not. This is fundamentally inequitable.
- **Flag RED:** No liability cap and no consequential damages exclusion — worst case scenario, flag immediately.

## Indemnification

### Our Standard Position
- **Mutual indemnification** with balanced, defined scope:
  - Provider indemnifies for: IP infringement, data protection breaches, provider's gross negligence
  - Client indemnifies for: misuse of service, client data content, client's breach of agreement
- All indemnification subject to the agreement's liability cap
- Indemnification procedures must be specified (notice, defense control, cooperation, settlement rights)

### Escalation Triggers
- **Flag YELLOW:** Broadly asymmetric scope (one party has materially more obligations)
- **Flag YELLOW:** No indemnification procedures specified
- **Flag RED:** Indemnification covering "any and all claims" — this is overbroad and shifts disproportionate risk
- **Flag RED:** Uncapped indemnification ("without limitation"). Our position: indemnification must always be subject to a cap. Uncapped indemnification is unlimited liability by another name.
- **Flag RED:** Client indemnifies for actions of "Authorized Users" without clear boundaries — client cannot fully control third-party behavior

## Data Protection

### Our Standard Position
- Standalone Data Processing Agreement (DPA) as an addendum, referencing GDPR and CCPA/CPRA specifically
- Data stored in specified regions (US, EU, or client-selected) with written consent required for transfers
- Sub-processor notification with 30 days advance notice and right to object
- Breach notification within 48 hours
- 90-day post-termination data export in standard formats (CSV, JSON, or API)
- Annual SOC 2 Type II report provided on request
- Audit rights (direct or via independent third-party)

### Acceptable Range
- DPA incorporated by reference (not a separate signed document)
- 72-hour breach notification (meets GDPR minimum)
- 60-day data export window
- SOC 2 report in lieu of direct audit rights

### Escalation Triggers
- **Flag YELLOW:** Vague data protection terms referencing "applicable laws" without specific DPA provisions
- **Flag YELLOW:** 72-hour breach notification (meets minimum but not our preferred standard)
- **Flag YELLOW:** 30-day data export window (tight but acceptable if format is clearly specified)
- **Flag RED:** No DPA or specific data protection terms. This is likely non-compliant with GDPR and CCPA.
- **Flag RED:** Provider's privacy policy governs data processing (and can change unilaterally)
- **Flag RED:** No restrictions on data location — "data may be stored anywhere Provider maintains facilities" with no safeguards
- **Flag RED:** Data export window under 30 days, or provider can delete data immediately upon termination

## Assignment

### Our Standard Position
- Neither party may assign without the other's consent, not to be unreasonably withheld
- Both parties may assign without consent to affiliates or in connection with mergers/acquisitions
- Assignee must assume all obligations under the agreement

### Escalation Triggers
- **Flag GREEN:** Mutual consent with standard M&A/affiliate exceptions
- **Flag YELLOW:** Asymmetric but both parties retain some assignment rights
- **Flag RED:** One party assigns freely while the other requires consent "in sole discretion." Our position: sole discretion consent is an effective veto over the restricted party's corporate transactions. Always negotiate to "not unreasonably withheld."

## Amendment

### Our Standard Position
- Amendments require mutual written agreement signed by authorized representatives of both parties
- No unilateral modification of any kind. This is a firm-wide non-negotiable.

### Escalation Triggers
- **Flag GREEN:** Mutual written agreement required for all amendments
- **Flag YELLOW:** Unilateral changes permitted for non-material terms (e.g., support procedures) with notice and termination right
- **Flag RED:** Provider can unilaterally modify terms with notice and "continued use constitutes acceptance." Our position: this renders the contract's terms non-binding. The provider can change pricing, SLAs, liability terms, or data handling at will. Combined with no termination for convenience, the client has no practical recourse. Always reject.

## Insurance

### Our Standard Position
- Commercial general liability, professional liability (E&O), and cyber liability insurance
- Cyber liability minimum: $5M for contracts with annual value over $100K
- Certificates of insurance provided annually on request

### Escalation Triggers
- **Flag GREEN:** All three insurance types with adequate minimums
- **Flag YELLOW:** Insurance required but minimums not specified, or minimums below our thresholds
- **Flag RED:** No insurance requirements at all. For SaaS agreements handling business data, insurance is essential.
