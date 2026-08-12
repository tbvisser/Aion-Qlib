# ISSUE: SSO Redirect Loop for SAML-Based Authentication

| Field | Value |
|-------|-------|
| **Issue ID** | PROD-2901 |
| **Severity** | Critical |
| **Status** | Resolved |
| **Reported Date** | 2025-01-10 |
| **Last Updated** | 2025-01-25 |

## Description

Users authenticating via SAML-based Single Sign-On (SSO) experience an infinite redirect loop between the application and their identity provider (IdP). After entering credentials on the IdP login page, users are redirected back to the application, which immediately redirects them back to the IdP, creating an endless cycle. The browser eventually displays an "ERR_TOO_MANY_REDIRECTS" error after approximately 20 redirect cycles. The issue affects all SAML SSO configurations and is not specific to any particular identity provider. Both Okta and Azure AD-configured organizations have reported the problem. The issue began after a platform update deployed on January 9, 2025, and affects approximately 30% of SSO login attempts, making it intermittent rather than consistent, which complicated initial diagnosis.

## Root Cause

The January 9 deployment included an update to the session cookie configuration that changed the SameSite attribute from "Lax" to "Strict" as part of a security hardening initiative. With SameSite=Strict, the session cookie established during the SAML assertion consumer service (ACS) callback was not sent on the subsequent cross-origin redirect from the IdP back to the application. The application, unable to read the session cookie, treated the user as unauthenticated and initiated a new SSO flow, creating the redirect loop. The intermittent nature of the issue was caused by browser caching behavior -- users with an existing valid session cookie from before the deployment were unaffected until their session expired.

## Affected Systems/Users

- **Users Impacted:** Approximately 1,200 users across 38 organizations using SAML SSO (100% of SSO-enabled organizations)
- **Systems Affected:** SAML authentication flow, session cookie management, ACS endpoint
- **Business Impact:** Complete authentication failure for SSO users without workaround; 38 organization admins contacted support; 2 enterprise contract renewals were at risk

## Workaround

Affected users were instructed to clear their browser cookies for the application domain and then use the direct login URL (bypassing SSO) with their email/password credentials if available. Organizations with SSO-only enforcement had no workaround and were prioritized for the fix deployment.

## Resolution

- Reverted the SameSite cookie attribute from "Strict" to "Lax" for session cookies involved in the SSO flow
- Implemented a separate secure cookie specifically for SSO callback validation with SameSite=None and Secure flag
- Added automated end-to-end SSO login tests against both Okta and Azure AD sandbox environments in the CI/CD pipeline
- Created a runbook for SSO-related incidents with diagnostic steps and rollback procedures
- Deployed the fix with a hotfix release process within 4 hours of root cause identification

## Related Issues

- [PROD-2847: Login Timeout](#) - discovered during the same week; shared authentication infrastructure
- [PROD-3012: Two-Factor Auth SMS Delay](#) - 2FA step occurs after SSO, affected users encountered both issues sequentially
