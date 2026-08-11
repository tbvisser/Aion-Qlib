# Backend Tests (pytest)

## Setup

```bash
cd backend
source venv/Scripts/activate  # Windows Git Bash
pip install pytest pytest-asyncio httpx
```

## Running Tests

```bash
# Run all tests
pytest

# Run by marker
pytest -m unit          # Unit tests only (no external deps)
pytest -m api           # API endpoint tests (requires running backend)
pytest -m auth          # Auth and authorization tests
pytest -m isolation     # Data isolation / RLS tests
pytest -m "not slow"    # Skip slow tests

# Run a specific file or directory
pytest tests/api/
pytest tests/unit/
pytest tests/api/test_threads.py

# Verbose output
pytest -v

# Stop on first failure
pytest -x
```

## Architecture

```
tests/
├── conftest.py                     # ROOT — auth tokens, httpx clients
├── __init__.py
├── unit/                           # Service-level unit tests
│   └── __init__.py
├── api/                            # API endpoint tests
│   ├── __init__.py
│   ├── test_health.py              # Health + auth checks
│   └── test_threads.py             # Thread CRUD + data isolation
├── test_redaction_service.py       # Redaction unit tests
├── test_redaction_e2e.py           # Redaction E2E tests
├── test_thread_redaction.py        # Thread redaction tests
└── test_algorithmic_resolution.py  # Algorithmic resolution tests
```

### Fixtures (conftest.py)

| Fixture | Scope | Description |
|---------|-------|-------------|
| `token1` | session | JWT for test@test.com (admin) |
| `token2` | session | JWT for test2@test.com (non-admin) |
| `auth_headers_1` | function | `Authorization: Bearer <token1>` |
| `auth_headers_2` | function | `Authorization: Bearer <token2>` |
| `api` | function | Unauthenticated httpx.AsyncClient |
| `api1` | function | Authenticated client for user 1 |
| `api2` | function | Authenticated client for user 2 |

### Markers (pytest.ini)

- `@pytest.mark.unit` — No external dependencies
- `@pytest.mark.api` — Requires running backend at localhost:8001
- `@pytest.mark.slow` — Long-running tests
- `@pytest.mark.auth` — Authentication tests
- `@pytest.mark.isolation` — RLS / data isolation tests

## Best Practices

- **Async by default**: `asyncio_mode = auto` — no need for `@pytest.mark.asyncio`
- **Two-user isolation**: Always test with both `api1` and `api2` to verify RLS
- **Clean up**: Delete test data created during tests
- **Descriptive names**: `test_create_thread_returns_201` not `test_thread_1`
- **Mark everything**: Use markers so tests can be filtered in CI

## CI Integration

```bash
# Fast CI check (skip slow tests)
pytest -m "not slow" --tb=short

# Full suite with JUnit output
pytest --junitxml=test-results/results.xml
```

## Troubleshooting

**Auth fixture fails**: Ensure Supabase is running and test users exist.

**Connection refused on localhost:8001**: Start backend with `powershell -File scripts/start-backend.ps1`

**Import errors**: Activate venv first: `source venv/Scripts/activate`
