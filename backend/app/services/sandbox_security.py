"""Security policies for sandboxed code execution."""

from llm_sandbox import SecurityPolicy
from llm_sandbox.security import RestrictedModule, SecurityPattern, SecurityIssueSeverity


def _pattern(pat: str, desc: str, severity=SecurityIssueSeverity.HIGH) -> SecurityPattern:
    return SecurityPattern(pattern=pat, description=desc, severity=severity)


def _module(name: str, desc: str, severity=SecurityIssueSeverity.HIGH) -> RestrictedModule:
    return RestrictedModule(name=name, description=desc, severity=severity)


def get_python_security_policy() -> SecurityPolicy:
    """Security policy for Python sandbox containers."""
    return SecurityPolicy(
        severity_threshold=SecurityIssueSeverity.MEDIUM,
        patterns=[
            _pattern("subprocess", "Process spawning blocked"),
            _pattern(r"os\.system", "OS command execution blocked"),
            _pattern(r"os\.exec", "OS exec blocked"),
            _pattern(r"os\.popen", "OS popen blocked"),
            _pattern(r"os\.spawn", "OS spawn blocked"),
            _pattern(r"eval\(", "Eval blocked"),
            _pattern(r"exec\(", "Exec blocked"),
            _pattern("__import__", "Dynamic import blocked"),
            _pattern(r"shutil\.rmtree", "Recursive delete blocked"),
            _pattern("ctypes", "C interface blocked"),
            # socket.socket not blocked — urllib needs it for bridge HTTP calls
            # Docker network config is the real security boundary
        ],
        restricted_modules=[
            _module("subprocess", "Process spawning blocked"),
            _module("shutil", "Filesystem manipulation blocked"),
            _module("ctypes", "Low-level C interface blocked"),
            # socket not restricted — needed for bridge client HTTP calls via urllib
            _module("importlib", "Dynamic imports blocked"),
            _module("signal", "Signal handling blocked"),
            _module("multiprocessing", "Process spawning blocked"),
            _module("threading", "Thread creation blocked", SecurityIssueSeverity.MEDIUM),
        ],
    )
