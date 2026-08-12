# Data Handling Policy

**Version:** 1.0
**Effective Date:** January 15, 2025
**Last Reviewed:** January 10, 2025
**Owner:** Information Security & Legal
**Status:** Active

## 1. Purpose

This policy establishes requirements for the secure handling, storage, processing, and disposal of customer data within Acme Corporation. It ensures compliance with applicable data protection regulations including GDPR, CCPA, and SOC 2 requirements.

## 2. Scope

This policy applies to all employees, contractors, and third-party processors who access, handle, or store customer data in any form (digital or physical) as part of their work for Acme Corporation.

## 3. Data Classification

All customer data must be classified into one of the following categories:

| Classification | Description | Examples |
|---------------|-------------|----------|
| Public | Non-sensitive, publicly available | Company name, public profile |
| Internal | Business data, not sensitive | Usage statistics, feature preferences |
| Confidential | Sensitive business or personal data | Email addresses, billing history, support tickets |
| Restricted | Highly sensitive, regulated data | Payment card numbers, passwords, government IDs |

## 4. Data Handling Requirements

### 4.1 Collection

- Collect only the minimum data necessary for the stated purpose (data minimization principle).
- Inform customers of what data is collected and why, through the Privacy Policy.
- Obtain explicit consent where required by law before collecting personal data.

### 4.2 Storage

- All Confidential and Restricted data must be encrypted at rest using AES-256 or equivalent.
- Data must be stored in approved systems only (see the Approved Systems Registry maintained by IT Security).
- Customer data must not be stored on local workstations, personal devices, or unapproved cloud services.
- Backups must be encrypted and tested quarterly for integrity.

### 4.3 Transmission

- All data in transit must be encrypted using TLS 1.2 or higher.
- Restricted data must not be transmitted via email without additional encryption (e.g., PGP or secure file transfer).
- Internal APIs must use mutual TLS authentication for services handling Confidential or Restricted data.

### 4.4 Access Control

- Access to customer data follows the principle of least privilege.
- All access to Confidential and Restricted data must be logged and auditable.
- Access reviews are conducted quarterly by department managers.
- Multi-factor authentication is required for all systems containing Confidential or Restricted data.

### 4.5 Retention and Disposal

- Customer data is retained only as long as necessary for the stated purpose or as required by law.
- Default retention periods:
  - Account data: duration of active subscription plus 90 days
  - Support tickets: 2 years after resolution
  - Billing records: 7 years (regulatory requirement)
  - Usage logs: 1 year
- Disposal must use approved methods: secure deletion for digital data, cross-cut shredding for physical documents.

## 5. Data Subject Rights

Acme Corporation supports the following customer rights in accordance with applicable regulations:

- **Right of Access:** Customers may request a copy of their data.
- **Right to Rectification:** Customers may request correction of inaccurate data.
- **Right to Erasure:** Customers may request deletion of their data, subject to legal retention requirements.
- **Right to Portability:** Customers may request their data in a machine-readable format.

All data subject requests must be fulfilled within 30 days of receipt.

## 6. Breach Response

In the event of a suspected data breach:

1. Report immediately to the Information Security team via the incident hotline.
2. Do not attempt to investigate or contain the breach independently.
3. The Security Incident Response Team (SIRT) will assess the scope and impact.
4. Affected customers will be notified within 72 hours as required by GDPR.
5. A post-incident report will be completed within 14 days.

## 7. Training

All employees must complete data handling training within 30 days of hire and annually thereafter. Additional role-specific training is required for personnel with access to Restricted data.

## 8. Compliance and Enforcement

Violations of this policy may result in disciplinary action up to and including termination. Intentional mishandling of Restricted data may also result in legal action. Questions about this policy should be directed to the Data Protection Officer at dpo@acmecorp.com.

---

*Document Control: Next scheduled review: July 2025.*
