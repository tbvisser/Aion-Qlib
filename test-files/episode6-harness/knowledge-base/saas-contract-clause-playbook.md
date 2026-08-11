# Mercer & Hartwell LLP — SaaS Contract Clause Negotiation Playbook

**Document ID:** MH-PLY-2024-001
**Last Updated:** January 2026
**Owner:** Commercial Contracts Practice Group
**Classification:** Internal — All Attorneys

## Purpose

This playbook provides clause-by-clause negotiation strategies for SaaS agreements. It defines our firm's standard counter-positions and recommended replacement language. When a clause is flagged YELLOW or RED during risk analysis, refer to this playbook for the recommended response.

**Important:** Always use the recommended language from this playbook as the starting point for redlines. Attorneys may adapt the language to specific circumstances, but deviations from our standard positions must be documented with justification.

## 1. Termination and Exit Clauses

### Our Position
Every SaaS agreement we review must include a workable exit path for our client. Contracts that trap clients in indefinite commitments are unacceptable.

### What We Look For
- Termination for convenience rights (at minimum during renewal terms)
- Reasonable non-renewal notice periods (60–90 days)
- Pro-rata refund of prepaid fees upon early termination
- Transition assistance period (90–180 days)

### Vendor Tactics We Commonly See
1. **No-exit clause:** No termination for convenience, combined with auto-renewal and short non-renewal windows. The client is effectively locked in indefinitely.
2. **Liquidated damages disguised as early termination:** "Early termination requires payment of all remaining fees." This makes the termination right economically worthless.
3. **Data hostage:** Short data export windows (under 30 days) that make it practically difficult to migrate away.

### Our Counter-Language

**For no-exit clauses:**
> "Either party may terminate this Agreement for convenience upon ninety (90) days' prior written notice. In the event of early termination by Client, Provider shall refund any prepaid fees for the unused portion of the then-current term on a pro-rata basis."

**For aggressive auto-renewal:**
> "This Agreement shall not automatically renew. At least ninety (90) days prior to the end of the then-current term, the parties shall discuss renewal terms in good faith. Renewal requires mutual written agreement."

**If the client accepts no termination for convenience during the initial term (our fallback):**
> "Client may not terminate for convenience during the Initial Term. During any Renewal Term, either party may terminate for convenience upon sixty (60) days' prior written notice. Upon such termination, Provider shall refund prepaid fees for the unused portion of the Renewal Term on a pro-rata basis."

## 2. Price Escalation Clauses

### Our Position
Price increases must be predictable and capped. Our clients need budget certainty, and compounding uncapped increases create significant long-term financial risk.

### What We Look For
- Annual cap on increases (CPI or 3–5%)
- Adequate advance notice (90 days minimum)
- Client right to terminate if increase exceeds cap
- Transparency in pricing methodology

### Our Compounding Impact Analysis
Always calculate and report the compounding effect:
- 5% annual: +15.8% after 3 years, +27.6% after 5 years
- 8% annual: +25.9% after 3 years, +46.9% after 5 years
- 10% annual: +33.1% after 3 years, +61.1% after 5 years
- 15% annual: +52.1% after 3 years, +101.1% after 5 years (doubles the price)

### Our Counter-Language
> "Provider may increase Subscription Fees upon each Renewal Term by no more than the greater of (a) five percent (5%) or (b) the percentage increase in the Consumer Price Index (CPI-U) for the twelve (12) month period preceding the renewal date. Provider shall provide at least ninety (90) days' prior written notice of any fee increase. If the proposed increase exceeds this cap, Client may terminate this Agreement without penalty upon thirty (30) days' written notice."

## 3. Intellectual Property — Feedback Assignment

### Our Position
**Firm-wide policy: We never accept full IP assignment of client feedback.** A non-exclusive license is the maximum we concede. No exceptions without partner approval from the Technology Transactions practice group.

### Why We Take a Hard Line
Full IP assignment means:
- The client permanently loses ownership of their own ideas and suggestions
- The client cannot implement the same idea in their own internal systems
- The client cannot share the idea with competing vendors for competitive bidding
- The vendor can patent the client's idea — and potentially enforce that patent against the client
- The assignment survives termination, so the client loses these rights permanently even after the relationship ends

### Vendor Tactics We Commonly See
1. **Buried assignment:** Full IP assignment buried in a "Provider IP" or "Intellectual Property" section where it may not receive scrutiny. Look for the word "assigns" versus "licenses."
2. **Broad definition of "Feedback":** Includes not just feature suggestions but also bug reports, workflow descriptions, and business process information.
3. **"Hereby assigns":** Present-tense assignment language that transfers rights immediately, not upon some future event.

### Our Counter-Language
> "Client grants Provider a non-exclusive, royalty-free, perpetual, irrevocable license to use, reproduce, modify, and incorporate Feedback into the Service and Provider's products and services. Client retains all right, title, and interest in and to Feedback, including all intellectual property rights therein. Nothing in this Agreement shall restrict Client's right to use, disclose, or implement Feedback, or similar ideas independently developed, for any purpose."

## 4. Unilateral Amendment Clauses

### Our Position
**Firm-wide non-negotiable: Contracts must require mutual written agreement for amendments.** We do not accept unilateral modification clauses under any circumstances. This is fundamental to contract law — a contract that one party can change at will is not a binding agreement.

### Why This Is Always RED
- Combined with no termination for convenience, the client has zero recourse — they cannot reject the changes and cannot leave
- "Continued use constitutes acceptance" eliminates informed consent
- The vendor could change pricing, SLAs, liability terms, data handling practices, or any other material term
- Courts in some jurisdictions have found such clauses unenforceable, but litigating enforceability is expensive and uncertain

### Vendor Tactics We Commonly See
1. **"With notice":** "Provider may modify terms upon 30 days' written notice." The notice period creates an illusion of fairness, but the client has no right to reject.
2. **Deemed acceptance:** "Continued use of the Service after the notice period constitutes acceptance." This is passive consent, not affirmative agreement.
3. **Policy incorporation:** Agreement references a privacy policy, acceptable use policy, or terms of service hosted on the vendor's website — which can change at any time without notice.

### Our Counter-Language

**For the amendment clause itself:**
> "This Agreement may be amended, modified, or supplemented only by a written instrument duly executed by authorized representatives of both parties. No amendment shall be effective unless signed by both parties. No course of dealing, usage of trade, or course of performance shall operate as an amendment."

**For policy references:**
> "To the extent this Agreement references any Provider policy (including any Privacy Policy, Acceptable Use Policy, or Terms of Service), the version in effect as of the Effective Date of this Agreement shall govern. Any subsequent changes to such policies shall not be binding on Client unless agreed in writing."

## 5. Assignment Clauses

### Our Position
Assignment rights should be mutual and balanced. Both parties should be able to assign in connection with M&A activity; neither should be able to unilaterally assign to unrelated third parties.

### What We Look For
- Mutual consent requirement, "not to be unreasonably withheld"
- Carve-outs for affiliates and M&A transactions (both parties)
- Anti-assignment protections (assignee must assume all obligations)
- Change of control provisions (what happens if the vendor is acquired by a competitor?)

### The "Sole Discretion" Problem
"Consent may be withheld in Provider's sole discretion" is an effective veto power over the client's corporate transactions. If the client is acquired, merges, or restructures, the vendor can block assignment — or use the leverage to extract concessions (higher fees, extended terms).

### Our Counter-Language
> "Neither party may assign this Agreement or any rights or obligations hereunder without the other party's prior written consent, which shall not be unreasonably withheld, conditioned, or delayed. Notwithstanding the foregoing, either party may assign this Agreement without the other party's consent (a) to an affiliate that is capable of performing the assigning party's obligations, or (b) in connection with a merger, acquisition, corporate reorganization, or sale of all or substantially all of the assigning party's assets, provided that the assignee agrees in writing to be bound by all terms and conditions of this Agreement. Any purported assignment in violation of this Section shall be void."

## 6. SLA and Remedies

### Our Position
An uptime commitment without remedies is not an SLA — it is a marketing statement. We require both the commitment and enforceable consequences for failure.

### What We Look For
- 99.9% uptime minimum for business-critical SaaS
- Clearly defined measurement methodology
- Limited, defined maintenance exclusion windows
- Automatic service credits (not claim-based)
- Termination right for persistent failures (3+ consecutive months below SLA)

### Vendor Tactics We Commonly See
1. **Broad exclusions:** Force majeure, "third-party services," "factors beyond Provider's reasonable control" — these can gut the effective SLA.
2. **Claim-based credits:** Client must submit a request with evidence within 7–15 days. In practice, many clients miss the window or lack monitoring data.
3. **Credit caps:** "Total credits shall not exceed 15% of monthly fees." This limits the financial incentive for the vendor to maintain uptime.
4. **No termination trigger:** Client receives credits for persistent outages but cannot exit the contract.

### Our Standard Credit Schedule
| Monthly Uptime | Credit | Additional Rights |
|---|---|---|
| 99.5% – 99.9% | 10% of monthly fees | — |
| 99.0% – 99.5% | 25% of monthly fees | — |
| 95.0% – 99.0% | 50% of monthly fees | Right to terminate |
| Below 95.0% | 100% of monthly fees | Right to terminate + pro-rata refund |

### Our Counter-Language
> "Provider warrants that the Service shall maintain at least 99.9% uptime during each calendar month, measured as the total minutes in the month minus minutes of unplanned downtime, divided by total minutes in the month. Scheduled maintenance shall not exceed four (4) hours per month, performed during weekends between 12:00 AM and 6:00 AM ET, with at least 48 hours' advance notice. If uptime falls below the committed level, Provider shall automatically apply service credits to Client's account as set forth in the SLA Credit Schedule. If uptime falls below 99.0% in any three (3) consecutive months, Client may terminate this Agreement upon written notice and receive a pro-rata refund of prepaid fees."

## Quick Reference — Firm-Wide Non-Negotiables

These positions may not be conceded without partner approval:

1. **No full IP assignment of client feedback.** License only.
2. **No unilateral amendment clauses.** Mutual written agreement required.
3. **No uncapped indemnification for our clients.** Must be subject to a defined cap.
4. **No unlimited liability for our clients.** Mutual cap required.
5. **Data protection terms must include a DPA** (or equivalent provisions) for any agreement involving personal data.
6. **Post-termination data export must be at least 30 days** in standard formats.
