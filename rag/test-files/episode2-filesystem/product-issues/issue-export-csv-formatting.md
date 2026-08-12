# ISSUE: CSV Export Formatting Errors in Reports Module

| Field | Value |
|-------|-------|
| **Issue ID** | PROD-2978 |
| **Severity** | Low |
| **Status** | In Progress |
| **Reported Date** | 2025-01-22 |
| **Last Updated** | 2025-02-15 |

## Description

Users exporting data from the Reports module in CSV format encounter various formatting issues that prevent the exported files from being correctly parsed by spreadsheet applications. The most common problems include: currency values losing their decimal precision (e.g., "$1,234.50" exported as "1234.5"), date fields rendered in inconsistent formats across different columns, special characters in text fields (such as commas and quotation marks) breaking CSV column alignment, and Unicode characters in customer names being replaced with garbled text. The issue affects all report types (usage, billing, activity, and audit logs) but is most frequently reported for billing exports, where financial accuracy is critical. Approximately 60% of exported CSV files require manual correction before they can be used for downstream processing or accounting imports.

## Root Cause

The CSV export service uses a custom serialization function that does not properly handle RFC 4180 compliance. Specifically, text fields containing commas, double quotes, or newline characters are not enclosed in double quotes, and embedded double quotes are not escaped by doubling them. The currency formatting issue stems from the export function applying JavaScript's `parseFloat()` to formatted currency strings, which strips trailing zeros. Date formatting inconsistency is caused by different database columns storing dates in different formats (ISO 8601 vs. Unix timestamps), with the export service performing no normalization. The Unicode issue is caused by the export endpoint returning content with `charset=ascii` instead of `charset=utf-8` in the Content-Type header.

## Affected Systems/Users

- **Users Impacted:** Approximately 420 users who regularly export reports (6% of active user base), with highest impact on finance and operations teams
- **Systems Affected:** Report export service, CSV serialization module, report API endpoints
- **Business Impact:** Manual correction time estimated at 15-30 minutes per export; 28 support tickets in January; 3 customers requested direct database access as an alternative

## Workaround

Users can export reports in JSON format, which preserves all data types and formatting correctly, and then convert to CSV using their preferred spreadsheet application's import wizard. A knowledge base article with step-by-step instructions for the JSON-to-CSV conversion in Excel and Google Sheets has been published.

## Resolution (In Progress)

- **Completed:** Fixed Content-Type header to specify UTF-8 encoding for CSV responses
- **Completed:** Implemented proper RFC 4180 quoting and escaping for text fields
- **In Progress:** Standardizing date format output to ISO 8601 across all report types (ETA: 2025-02-25)
- **Planned:** Adding currency format preservation with configurable decimal precision
- **Planned:** Adding CSV preview functionality before download to catch formatting issues

## Related Issues

- [PROD-2910: Billing Sync Failure](#) - billing discrepancies compound CSV export inaccuracies when sync is out of date
