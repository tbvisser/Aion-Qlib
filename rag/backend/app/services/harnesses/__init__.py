"""Harness registry — maps harness_type strings to HarnessDefinition instances."""
from app.services.harness_engine import HarnessDefinition

HARNESS_REGISTRY: dict[str, HarnessDefinition] = {}


def register_harness(definition: HarnessDefinition):
    HARNESS_REGISTRY[definition.harness_type] = definition


def get_harness(harness_type: str) -> HarnessDefinition:
    if harness_type not in HARNESS_REGISTRY:
        raise ValueError(f"Unknown harness type: {harness_type}")
    return HARNESS_REGISTRY[harness_type]


def list_harnesses() -> list[dict]:
    return [
        {"harness_type": h.harness_type, "display_name": h.display_name, "phase_count": len(h.phases)}
        for h in HARNESS_REGISTRY.values()
    ]


# Auto-register all harnesses on import
from app.services.harnesses import contract_review  # noqa: E402, F401
