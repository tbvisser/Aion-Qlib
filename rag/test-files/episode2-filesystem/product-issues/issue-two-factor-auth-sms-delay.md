# ISSUE: Two-Factor Authentication SMS Codes Delayed

| Field | Value |
|-------|-------|
| **Issue ID** | PROD-3012 |
| **Severity** | High |
| **Status** | In Progress |
| **Reported Date** | 2025-01-30 |
| **Last Updated** | 2025-02-17 |

## Description

Users with SMS-based two-factor authentication (2FA) enabled are experiencing significant delays in receiving their one-time verification codes. Under normal conditions, SMS codes are delivered within 15 seconds of the authentication request. Currently, delivery times range from 2 minutes to over 10 minutes, with some codes never being delivered at all. The issue predominantly affects users with phone numbers on specific carriers (T-Mobile, AT&T) within the United States, though intermittent delays have also been reported by international users. When codes arrive after the 5-minute expiration window, users are forced to request a new code, which compounds the delivery backlog. Users who have configured authenticator app-based 2FA (TOTP) are not affected. The issue has resulted in a noticeable increase in users disabling 2FA entirely, raising security concerns.

## Root Cause

The SMS delivery pipeline uses Twilio as the primary provider with a fallback to AWS SNS. A recent Twilio pricing tier migration (from Standard to a volume-discounted plan) inadvertently changed the message throughput rate from 100 messages per second to 10 messages per second due to a provisioning error on the new plan. During authentication peaks, the outbound message queue grows faster than the delivery rate, creating an expanding backlog. The fallback to AWS SNS is not triggering because the health check for Twilio reports the service as available (messages are being accepted into the queue, just not delivered promptly). Additionally, T-Mobile and AT&T have recently tightened their spam filtering algorithms for short-code SMS, causing approximately 8% of verification codes to be silently dropped rather than delivered.

## Affected Systems/Users

- **Users Impacted:** Approximately 1,800 users with SMS-based 2FA enabled (15% of 2FA-enabled users); concentrated among T-Mobile (42%) and AT&T (31%) subscribers
- **Systems Affected:** Twilio SMS delivery, AWS SNS fallback pathway, 2FA code generation service, carrier filtering/spam detection
- **Business Impact:** 94 support tickets in the past 3 weeks; 127 users disabled 2FA during the affected period; security compliance risk for SOC 2 audit scheduled for Q2 2025

## Workaround

Users are encouraged to switch from SMS-based 2FA to authenticator app-based 2FA (Google Authenticator, Authy, or 1Password) through the security settings page. A simplified migration flow has been deployed that allows users to switch 2FA methods without first disabling and re-enabling 2FA. For users unable to receive SMS codes during login, the support team can issue a temporary bypass code with a 24-hour expiration after identity verification.

## Resolution (In Progress)

- **Completed:** Contacted Twilio support to correct the throughput provisioning on the new pricing plan (restored to 100 msg/sec)
- **Completed:** Implemented queue depth-based health check for Twilio that triggers SNS fallback when queue exceeds 50 messages
- **In Progress:** Registering for carrier-approved 10DLC (10-Digit Long Code) campaign with T-Mobile and AT&T to reduce spam filtering (ETA: 2025-03-01)
- **In Progress:** Adding push notification as a third delivery channel for 2FA codes via the mobile app
- **Planned:** Promoting authenticator app-based 2FA as the default method for new users during onboarding

## Related Issues

- [PROD-2847: Login Timeout](#) - authentication delays compound the perceived time to complete login when 2FA codes are also delayed
- [PROD-2901: SSO Redirect Loop](#) - users encountering SSO issues who fall back to email/password auth then also hit the 2FA delay
- [PROD-2934: Email Notifications Delayed](#) - similar queuing architecture and delivery pipeline patterns
