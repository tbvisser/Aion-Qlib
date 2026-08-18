"""What sub-agents exist, as data rather than as three `if` branches.

`tool_executor.py` dispatches these by name — `analyze_document` runs the
document analyst, `explore_knowledge_base` runs the explorer, `task` runs the
deep-mode worker — and nothing anywhere says so in a form another process can
read. `list_harnesses()` next door has exactly this shape for harnesses; this is
its counterpart, and the two are served together by `routers/registry.py`.

**A manifest is a second source of truth, so keep it thin.** It records what a
caller outside this process cannot otherwise learn: the trigger tool, the
purpose, the tool scope and when the agent is even offered. It deliberately does
*not* copy the system prompts — those live in their service modules and would
rot here within a release.

Tool scope is described rather than enumerated for `task`, because it genuinely
is not a list: the deep agent inherits its parent's tools minus a fixed
exclusion set, then optionally intersects with whatever a harness phase allows.
Writing a number there would be a guess.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass(frozen=True)
class SubAgentDefinition:
    #: The tool name that triggers it. This is the identity a caller sees --
    #: the Python function is `run_explorer_agent`, but nothing outside this
    #: process can address that.
    tool_name: str
    display_name: str
    description: str
    #: Tools it may call. Empty means it makes no tool calls at all.
    tools: list[str] = field(default_factory=list)
    #: Set when the tool list is computed at call time rather than fixed.
    tool_scope: str | None = None
    #: What has to be true for the tool to be offered.
    availability: str = ""
    max_rounds: int | None = None


SUB_AGENTS: tuple[SubAgentDefinition, ...] = (
    SubAgentDefinition(
        tool_name="analyze_document",
        display_name="Document Analyst",
        description=(
            "Reads one document in full and answers a question about it. Used when a "
            "chunk-level search would miss the answer because it spans the whole text."
        ),
        tools=[],
        tool_scope="No tool calls — the document is placed in the prompt and answered in one pass.",
        availability="Offered when document analysis is enabled and a thread is open.",
    ),
    SubAgentDefinition(
        tool_name="explore_knowledge_base",
        display_name="Knowledge Base Explorer",
        description=(
            "Navigates the folder tree and document structure to answer a research "
            "question, rather than retrieving by similarity. Used when the question is "
            "about where something lives, not what it says."
        ),
        tools=[
            "ls", "tree", "grep", "glob", "read",
            "get_document_sections", "get_document_structure",
        ],
        availability="Offered when a thread is open.",
        max_rounds=8,
    ),
    SubAgentDefinition(
        tool_name="task",
        display_name="Task Agent",
        description=(
            "Runs a focused sub-task with its own context so the parent's stays clean. "
            "Also the worker behind a harness phase that fans out over a batch."
        ),
        tool_scope=(
            "Inherits the parent's tools, minus analyze_document, explore_knowledge_base, "
            "task, write_todos, read_todos and ask_user — a sub-agent may not delegate "
            "further. A harness phase can narrow it again."
        ),
        availability="Deep mode only, or from a harness phase.",
    ),
)


def list_sub_agents() -> list[dict]:
    """Serialisable form, matching `list_harnesses()`'s posture."""
    return [asdict(agent) for agent in SUB_AGENTS]
