# ISSUE: Mobile App Crash on iOS 17 During Document Preview

| Field | Value |
|-------|-------|
| **Issue ID** | PROD-3068 |
| **Severity** | High |
| **Status** | Open |
| **Reported Date** | 2025-02-07 |
| **Last Updated** | 2025-02-19 |

## Description

The iOS mobile application crashes when users attempt to preview PDF or image documents within the app. The crash occurs consistently when opening documents larger than 5MB and intermittently for smaller files. Users report that the app freezes for 2-3 seconds, displays a brief white screen, and then terminates without an error message. The crash is reproducible on devices running iOS 17.0 and later, across iPhone 13, 14, and 15 models. The issue does not affect iPads running iPadOS 17 or any Android devices. Crash analytics from Firebase Crashlytics show a 340% increase in crash reports attributed to the document preview module since the iOS 17.2 update in December 2024. The crash rate for the document preview feature is currently at 23%, making it the top source of app instability.

## Root Cause

The document preview component uses a WKWebView instance to render PDF and image files. iOS 17 introduced stricter memory allocation limits for WKWebView processes, reducing the per-process memory ceiling from 1.5GB to 750MB on non-Pro iPhone models. The document preview implementation loads the entire file into memory before rendering, rather than using streaming or tiled rendering. For documents exceeding 5MB, the memory allocation during decompression and rendering exceeds the new iOS 17 WKWebView process limit, triggering a jetsam termination event (the iOS out-of-memory killer). The intermittent crashes for smaller files occur when background processes or other app components are consuming memory, leaving less headroom for the document preview.

## Affected Systems/Users

- **Users Impacted:** Approximately 3,200 iOS users who access the document preview feature (28% of iOS active users)
- **Systems Affected:** iOS mobile app document preview module, WKWebView rendering pipeline, Firebase Crashlytics
- **Business Impact:** App Store rating dropped from 4.6 to 4.1 stars in the past month; 89 one-star reviews specifically mentioning crashes; potential risk to App Store featuring eligibility

## Workaround

Users can download documents to their device and open them using the native iOS Files app or a third-party PDF reader. The mobile app's share sheet includes a "Open In..." option that allows users to bypass the in-app preview. A banner notification has been added to the document preview screen informing users of the known issue and suggesting the alternative workflow.

## Resolution (Planned)

- **Immediate:** Implement file size check before preview and redirect to native document viewer for files > 5MB (ETA: 2025-02-25)
- **Short-term:** Replace WKWebView-based preview with PDFKit framework for PDF rendering, which uses tiled/streamed rendering (ETA: 2025-03-10)
- **Medium-term:** Implement progressive image loading with downsampled thumbnails for initial display
- **Long-term:** Server-side document thumbnail generation to eliminate client-side rendering for previews

## Related Issues

- [PROD-2863: Dashboard Loading Slow](#) - similar large-dataset rendering performance concerns on web
