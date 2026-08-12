# Frontend E2E Tests (Playwright)

## Setup

```bash
cd frontend
npm install
npx playwright install chromium
```

## Running Tests

```bash
# Run all E2E tests (headless)
npx playwright test

# Run in headed mode (see browser)
npx playwright test --headed

# Run a specific test file
npx playwright test tests/e2e/chat.spec.ts

# Run with UI mode (interactive debugger)
npx playwright test --ui

# Run only unauthenticated tests
npx playwright test --project=unauthenticated

# Run only authenticated tests
npx playwright test --project=chromium
```

## Architecture

```
tests/
├── e2e/                          # E2E test specs
│   ├── chat.spec.ts              # Chat feature tests (authenticated)
│   └── unauthenticated.spec.ts   # Auth page & redirect tests
├── support/
│   ├── .auth/                    # Persisted auth state (gitignored)
│   │   └── user1.json            # Storage state for test@test.com
│   └── auth.setup.ts             # Auth setup project — runs first
└── folder-tree.spec.ts           # Folder tree tests
```

### Projects (playwright.config.ts)

| Project | Purpose | Auth |
|---------|---------|------|
| `setup` | Authenticates user, saves storage state | Runs first |
| `chromium` | Authenticated E2E tests | Uses saved storage state |
| `unauthenticated` | Login page, redirects, guards | No auth |

### Auth Flow

1. `setup` project runs `auth.setup.ts` which logs in as `test@test.com`
2. Storage state saved to `tests/support/.auth/user1.json`
3. `chromium` project loads this state — all tests start authenticated
4. `unauthenticated` project runs without any stored state

## Best Practices

- **Selectors**: Use `data-testid` attributes, not CSS classes or text
- **Isolation**: Each test should create its own data and clean up after
- **No hard waits**: Use `expect(locator).toBeVisible()` instead of `page.waitForTimeout()`
- **Network**: Set up route interception before `page.goto()`
- **Assertions**: Always assert expected outcomes, never just check absence of errors
- **File naming**: `*.spec.ts` for authenticated, `*unauthenticated*.spec.ts` for no-auth

## CI Integration

The `playwright.config.ts` auto-detects CI via `process.env.CI`:
- **CI mode**: 2 retries, HTML + JUnit + list reporters, trace on first retry
- **Local mode**: 0 retries, list reporter only

Artifacts (screenshots, videos, traces) are only captured on failure.

## Troubleshooting

**Tests fail with "Target closed"**: App not running. Start with `powershell -File scripts/start-all.ps1`

**Auth setup fails**: Check test credentials in `auth.setup.ts`. Ensure Supabase is running.

**Flaky timeouts**: Increase `actionTimeout` in `playwright.config.ts` (default: 15s).
