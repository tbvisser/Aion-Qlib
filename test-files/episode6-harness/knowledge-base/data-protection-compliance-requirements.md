# Mercer & Hartwell LLP — Data Protection Compliance Standards

**Document ID:** MH-STD-2024-007
**Last Updated:** November 2025
**Owner:** Data Privacy & Cybersecurity Practice Group
**Classification:** Internal — All Attorneys

## Purpose

This document defines Mercer & Hartwell's minimum data protection requirements for vendor contracts involving personal data or confidential business data. Every SaaS, cloud, or data processing agreement must be assessed against these standards. Non-compliance with our minimum requirements must be flagged as RED in the review report with specific regulatory citations.

## Regulatory Landscape

### GDPR (General Data Protection Regulation)
- **Applies when:** Processing personal data of EU/EEA residents, regardless of where the processor is located
- **Our position:** If there is any possibility the client's data includes EU personal data, we require GDPR-compliant terms. Do not rely on the vendor's assertion that GDPR does not apply.
- **Key obligation:** Article 28 requires a written Data Processing Agreement between controller and processor

### CCPA/CPRA (California Consumer Privacy Act / California Privacy Rights Act)
- **Applies when:** Processing personal information of California residents by businesses meeting revenue or data volume thresholds
- **Our position:** Assume CCPA applies unless the client has confirmed otherwise in writing. Most enterprise clients meet the thresholds.
- **Key obligation:** Service Provider Agreement with restrictions on the vendor's use of personal information

### SOC 2 Type II
- **Our position:** We require a current SOC 2 Type II report (within the last 12 months) for any vendor processing sensitive data. A SOC 2 Type I report is insufficient — it attests to controls at a point in time, not over a sustained period.

## DPA Checklist — Required Elements

Every data processing arrangement must address the following. If any element is missing, flag it in the review.

### 1. Roles and Scope
- [ ] Clear designation: who is the controller, who is the processor
- [ ] Description of processing activities, data categories, and data subject categories
- [ ] Purpose limitation: data processed only for specified purposes
- [ ] Duration of processing aligned with contract term

**Our standard:** The client is always the controller (or "business" under CCPA). The vendor is the processor (or "service provider"). If the vendor insists on joint controller status, escalate to a partner — this has significant liability implications.

### 2. Sub-Processor Controls
- [ ] List of current sub-processors provided (or available on a published page)
- [ ] 30 days advance written notice of new sub-processors
- [ ] Client right to object to new sub-processors
- [ ] Vendor remains liable for sub-processor actions
- [ ] Sub-processors bound by equivalent data protection obligations

**Our standard:** We require advance notification and objection rights. "Notification upon request" or "published on our website" is acceptable only if combined with a subscription mechanism for change alerts.

**Flag RED:** No sub-processor transparency at all. This is a GDPR Article 28 violation.

### 3. Data Location and International Transfers
- [ ] Data storage locations specified (country/region level)
- [ ] International transfers use approved mechanisms (Standard Contractual Clauses, adequacy decisions, or Binding Corporate Rules)
- [ ] Client consent required before data is moved to new jurisdictions
- [ ] Transfer Impact Assessment available on request

**Our standard:** Data should be stored in specified regions. For EU data, processing must remain within the EEA or in countries with adequacy decisions, unless SCCs are in place. The Schrems II decision means SCCs alone may be insufficient for certain countries — assess supplementary measures.

**Flag RED:** "Data may be stored and processed in any country where Provider or its sub-processors maintain facilities." This gives zero control over data residency and makes compliance with GDPR's transfer restrictions effectively impossible to verify.

**Our recommended language:**
> "Customer Data shall be stored and processed within [US/EEA/specified regions]. Provider shall not transfer Customer Data to any other jurisdiction without Customer's prior written consent and shall ensure appropriate safeguards are in place in accordance with applicable data protection laws, including Standard Contractual Clauses where required."

### 4. Security Measures
- [ ] Technical and organizational measures (TOMs) described or referenced
- [ ] Encryption at rest (AES-256 or equivalent)
- [ ] Encryption in transit (TLS 1.2+)
- [ ] Access controls (role-based, principle of least privilege)
- [ ] Audit logging with tamper protection
- [ ] Annual penetration testing by independent third party
- [ ] Vulnerability management program with defined SLAs for patching
- [ ] Employee background checks and security training

**Our standard:** At minimum, the contract must reference a security exhibit, security policy, or SOC 2 report that describes the vendor's controls. Vague statements like "commercially reasonable security measures" without specifics are insufficient for regulated clients.

### 5. Breach Notification
- [ ] Notification timeline specified (our standard: 48 hours)
- [ ] Notification must include: nature of breach, categories and approximate volume of records affected, likely consequences, measures taken or proposed
- [ ] Vendor must cooperate with client's own regulatory notification obligations
- [ ] Vendor must preserve forensic evidence
- [ ] Vendor bears its own costs of breach response (not passed to client)

**Our standard position on timelines:**
- **Preferred:** 24 hours for suspected breaches, 48 hours for confirmed breaches
- **Acceptable:** 72 hours (GDPR Article 33 minimum)
- **Flag RED:** Any timeline exceeding 72 hours, or no notification obligation at all

**Important:** The notification obligation should cover "suspected" breaches, not just "confirmed" breaches. A vendor that waits for full confirmation before notifying may delay the client's ability to meet its own regulatory deadlines.

### 6. Data Subject Rights Assistance
- [ ] Vendor assists client in responding to data subject requests (access, deletion, rectification, portability)
- [ ] Response timeline: vendor responds to client's requests within 5–10 business days
- [ ] No additional fees for routine data subject request assistance
- [ ] Technical capability to identify, export, and delete individual data subject records

**Our standard:** The vendor must have the technical capability to support data subject rights. If the vendor cannot isolate and delete individual records, this creates a compliance gap that must be disclosed to the client.

### 7. Data Retention and Deletion
- [ ] Data retained only for the duration of the contract plus a defined transition period
- [ ] Post-termination data export in standard, machine-readable formats (CSV, JSON, XML, or API)
- [ ] Data deletion certification available on request
- [ ] Deletion timeline specified

**Our standard position on post-termination:**
- **Preferred:** 90-day export window in standard formats, followed by certified deletion
- **Acceptable:** 60-day export window
- **Minimum:** 30-day export window with clearly specified formats
- **Flag RED:** Export window under 30 days, proprietary-only formats, or provider may delete immediately upon termination

**Our recommended language:**
> "Upon termination or expiration, Provider shall make all Customer Data available for export in [CSV/JSON/standard format] via [secure download/API] for a period of ninety (90) days. Following the export period, Provider shall permanently delete all Customer Data and certify such deletion in writing within thirty (30) days of Client's request."

### 8. Audit Rights
- [ ] Client has right to audit vendor's compliance with DPA
- [ ] Audits may be conducted by client or independent third-party auditor
- [ ] Vendor provides reasonable cooperation and access
- [ ] Frequency: at least annually, and following any security incident

**Our standard:** We accept provision of a current SOC 2 Type II report as an alternative to direct audit rights for most engagements. However, for high-sensitivity data (healthcare, financial, government), we require direct audit rights in addition to SOC 2.

## Common Deficiencies We See

These are the patterns we encounter most frequently in vendor-drafted contracts. Flag each one when identified:

| Pattern | Issue | Rating |
|---|---|---|
| "Provider's Privacy Policy as updated from time to time" | Vendor can unilaterally change data handling terms | RED |
| "In accordance with applicable data protection laws" (without DPA) | Too vague — no specific commitments | YELLOW |
| No mention of sub-processors | GDPR non-compliance; no visibility into data sharing | RED |
| "Commercially reasonable security measures" | Undefined standard, unenforceable | YELLOW |
| "Confirmed data breach" (not "suspected") | Delays notification during investigation | YELLOW |
| 30-day export, provider deletes after | Tight window, especially for large datasets | YELLOW |
| No data deletion certification | Cannot verify data is actually removed | YELLOW |
| No audit rights, no SOC 2 commitment | No assurance mechanism at all | RED |
