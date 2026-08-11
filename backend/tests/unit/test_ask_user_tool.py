"""Unit tests for the ask_user deep-mode tool (schema presence + sub-agent exclusion)."""
from app.services.llm_service import build_planning_tools, build_delegation_tools
from app.services.deep_agent_service import _filter_tools


def _names(tools):
    return {t["function"]["name"] for t in tools}


def test_ask_user_is_a_deep_mode_planning_tool():
    names = _names(build_planning_tools())
    assert "ask_user" in names


def test_ask_user_schema_requires_question():
    tool = next(t for t in build_planning_tools() if t["function"]["name"] == "ask_user")
    params = tool["function"]["parameters"]
    assert "question" in params["properties"]
    assert params["required"] == ["question"]


def test_ask_user_excluded_from_sub_agents():
    # Sub-agents run in isolation and must NOT be able to prompt the user.
    parent = build_planning_tools() + build_delegation_tools()
    filtered = _names(_filter_tools(parent))
    assert "ask_user" not in filtered
    # task is also excluded; sanity check the filter actually removed deep-mode tools
    assert "task" not in filtered
