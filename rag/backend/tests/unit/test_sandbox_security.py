"""Unit tests for the sandbox Python security policy contents.

The runtime enforcement (sandbox_service calls session.is_safe before run) is
verified end-to-end against Docker; these tests guard the policy from being
silently weakened (regression guard for the security fix).
"""
from app.services.sandbox_security import get_python_security_policy


def _pattern_blob(policy):
    return " ".join(p.pattern for p in policy.patterns).lower()


def _module_names(policy):
    return {m.name.lower() for m in policy.restricted_modules}


def test_policy_blocks_dangerous_call_patterns():
    blob = _pattern_blob(get_python_security_policy())
    for needle in ("subprocess", "os\\.system", "os\\.popen", "eval\\(", "exec\\(", "__import__", "ctypes"):
        assert needle in blob, f"security policy missing pattern for {needle!r}"


def test_policy_restricts_dangerous_modules():
    mods = _module_names(get_python_security_policy())
    for needle in ("subprocess", "ctypes", "multiprocessing"):
        assert needle in mods, f"security policy should restrict module {needle!r}"


def test_policy_has_nonempty_patterns_and_threshold():
    policy = get_python_security_policy()
    assert policy.patterns, "expected at least one security pattern"
    assert policy.severity_threshold is not None
