# Mercer & Hartwell LLP — Liability & Indemnification Review Guide

**Document ID:** MH-STD-2024-005
**Last Updated:** October 2025
**Owner:** Commercial Contracts Practice Group
**Classification:** Internal — All Attorneys

## Purpose

Liability and indemnification clauses carry the greatest direct financial risk in any SaaS agreement. This guide defines Mercer & Hartwell's standard positions, acceptable ranges, and escalation triggers. Every review must assess these clauses against our standards and calculate actual dollar exposure where possible.

## Liability Cap Analysis

### Our Standard Position: Mutual Cap
- **General cap:** 12 months of fees paid or payable, applying equally to both parties
- **This is our baseline.** We recommend this structure for every engagement unless specific circumstances justify deviation.

### Our Standard Position: Tiered / Super Cap
For obligations warranting higher exposure, we use a two-tier structure:
- **General cap:** 12 months of fees (mutual)
- **Super cap:** 2–3x the general cap, applying to:
  - Data breaches and data protection violations
  - Confidentiality breaches
  - IP infringement
  - Willful misconduct or gross negligence

**Our recommended language (general cap):**
> "EACH PARTY'S TOTAL AGGREGATE LIABILITY ARISING OUT OF OR RELATED TO THIS AGREEMENT SHALL NOT EXCEED THE TOTAL FEES PAID OR PAYABLE BY CLIENT IN THE TWELVE (12) MONTH PERIOD IMMEDIATELY PRECEDING THE EVENT GIVING RISE TO THE CLAIM."

**Our recommended language (super cap carve-out):**
> "Notwithstanding the foregoing, each party's aggregate liability for breaches of Sections [Data Protection], [Confidentiality], and [IP Infringement] shall not exceed three (3) times the general liability cap set forth above."

### Analysis Framework

When reviewing liability caps, always perform the following analysis:

1. **Calculate the dollar value.** A "12 months of fees" cap on a $240,000/year contract means $240,000 maximum exposure. State this explicitly in the report — percentages and ratios obscure the actual risk.

2. **Check symmetry.** Are both parties subject to the same cap? If not, calculate each party's exposure separately and flag the asymmetry.

3. **Identify carve-outs.** What obligations fall outside the cap? Uncapped obligations are effectively unlimited liability for that category.

4. **Assess adequacy.** Is the cap adequate relative to the potential harm? A $240,000 cap on a contract involving millions of records of personal data may be inadequate.

### Escalation Triggers — Liability Caps

| Pattern | Rating | Our Position |
|---|---|---|
| Mutual cap at 12–24 months of fees | GREEN | Our standard. Accept. |
| Tiered cap with 2–3x super cap | GREEN | Preferred structure for data-sensitive agreements. |
| Asymmetric caps (one party's cap is materially lower) | YELLOW | Calculate dollar exposure for each party. Recommend equalizing. |
| Cap below 12 months of fees | YELLOW | Below our minimum. Negotiate to 12 months. |
| No cap specified (agreement is silent on liability) | YELLOW | Absence of a cap may default to unlimited liability under governing law. Add explicit mutual cap. |
| Unlimited liability for either party | RED | Always escalate. Unlimited liability creates unpredictable, potentially catastrophic exposure regardless of the party's financial strength. Our position: we never recommend a client accept unlimited liability, and we counsel against imposing it on vendors (it creates perverse incentives and may not survive judicial review). |
| One party has a cap, the other does not | RED | Fundamentally inequitable. Escalate immediately. |

### Consequential Damages

**Our standard position:** Mutual exclusion of indirect, incidental, special, consequential, and punitive damages.

**Our standard carve-outs:** The following may be carved out from the consequential damages exclusion (meaning consequential damages apply), but should still be subject to the super cap:
- Data breaches and data protection violations
- Confidentiality breaches
- IP infringement indemnification

**Our recommended language:**
> "IN NO EVENT SHALL EITHER PARTY BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING LOST PROFITS, LOST REVENUE, OR COST OF SUBSTITUTE SERVICES, REGARDLESS OF THE THEORY OF LIABILITY, EXCEPT WITH RESPECT TO BREACHES OF [DATA PROTECTION], [CONFIDENTIALITY], AND INDEMNIFICATION OBLIGATIONS, WHICH SHALL BE SUBJECT TO THE SUPER CAP."

### Escalation Triggers — Consequential Damages

| Pattern | Rating | Our Position |
|---|---|---|
| Mutual exclusion with appropriate carve-outs | GREEN | Our standard. Accept. |
| Mutual exclusion with no carve-outs | GREEN | Acceptable, though less protective in data breach scenarios. |
| No consequential damages exclusion (silent) | YELLOW | Add mutual exclusion. Absence means both parties exposed to indirect damages claims. |
| One party excludes, the other does not | RED | Fundamentally inequitable. One party can claim lost profits while the other cannot. Always reject. |
| No exclusion AND no liability cap | RED | Worst-case exposure — either party can claim unlimited indirect damages. Highest priority escalation. |

## Indemnification Analysis

### Our Standard Position: Mutual and Balanced

**Vendor indemnifies client for:**
- Third-party claims that the service infringes intellectual property rights (patents, copyrights, trademarks, trade secrets)
- Vendor's breach of data protection obligations resulting in third-party claims
- Vendor's gross negligence or willful misconduct

**Client indemnifies vendor for:**
- Client's use of the service in material violation of the agreement
- Third-party claims arising from client data content (e.g., client uploaded infringing material)
- Client's material breach of the agreement

**Critical: All indemnification obligations must be subject to the agreement's liability cap.** Uncapped indemnification is unlimited liability under a different name.

### Indemnification Procedures — Required Elements

Every indemnification clause must include procedures. If missing, flag as YELLOW and recommend adding:

1. **Prompt written notice** — Indemnified party must notify indemnifying party within a reasonable time (our standard: 30 days of becoming aware of the claim, but delayed notice only reduces indemnification to the extent the delay prejudiced the defense)
2. **Defense control** — Indemnifying party has the right (not obligation) to assume defense with competent counsel
3. **Cooperation** — Indemnified party must cooperate reasonably, at indemnifying party's expense
4. **Settlement** — Indemnifying party may not settle without indemnified party's consent if settlement imposes non-monetary obligations on the indemnified party
5. **Sole remedy** — For IP indemnification, specify that it is the exclusive remedy for IP claims

### IP Indemnification — Remediation Path

Provider's IP indemnification should include a remediation path if infringement is found:

1. **First:** Modify the service to become non-infringing while maintaining material functionality
2. **Second:** Obtain a license for the client's continued use
3. **Third:** If neither is commercially feasible, terminate the agreement with a pro-rata refund of prepaid fees

**Flag YELLOW** if no remediation path is specified — the client may be left without a usable service and no refund.

### Escalation Triggers — Indemnification

| Pattern | Rating | Our Position |
|---|---|---|
| Mutual, defined scope, subject to liability cap | GREEN | Our standard. Accept. |
| Mutual but asymmetric scope (one party has more obligations) | YELLOW | Analyze whether the asymmetry is proportionate. Minor asymmetry may be acceptable; major asymmetry is not. |
| No indemnification procedures | YELLOW | Add our standard procedures language. |
| No IP remediation path | YELLOW | Provider should commit to modify, license, or refund. |
| "Any and all claims arising from Client's use" | RED | Overbroad — captures claims caused by the vendor's own failures. Narrow to claims arising from client's breach or misuse. |
| Uncapped indemnification ("without limitation") | RED | Our firm-wide policy: we never accept uncapped indemnification for our clients. This is unlimited liability. Negotiate to bring it within the general or super cap. |
| Client indemnifies for Authorized Users' actions "without limitation" | RED | Client cannot fully control third-party behavior. Must be scoped and capped. |
| Provider indemnification limited to IP only, client indemnification covers everything | RED | Grossly asymmetric. Provider should also indemnify for data protection breaches at minimum. |

## Reporting Requirements

When preparing the risk analysis for liability and indemnification clauses, always include:

1. **Dollar values** — Convert caps, fees, and exposure to actual dollar amounts
2. **Symmetry analysis** — Side-by-side comparison of each party's obligations and caps
3. **Gap analysis** — Identify what's missing versus our standard position
4. **Worst-case scenario** — For RED items, describe the realistic worst-case financial exposure
5. **Recommended counter-language** — For YELLOW and RED items, include our standard alternative language
