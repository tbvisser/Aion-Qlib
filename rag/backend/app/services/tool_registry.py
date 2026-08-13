"""Unified tool registry for native, skill, and MCP tools."""
import logging
from enum import Enum
from typing import Any, Callable, Optional, Union

from pydantic import BaseModel

from app.services.langsmith import traceable

logger = logging.getLogger(__name__)


class ToolSource(str, Enum):
    native = "native"
    skill = "skill"
    mcp = "mcp"


class ToolLoading(str, Enum):
    immediate = "immediate"
    deferred = "deferred"


class ToolDefinition(BaseModel):
    name: str
    description: str
    source: ToolSource
    loading: ToolLoading
    openai_schema: dict[str, Any]
    catalog_entry: str
    executor: Optional[Callable] = None

    model_config = {"arbitrary_types_allowed": True}


class ToolRegistry:
    def __init__(self):
        self._tools: dict[str, ToolDefinition] = {}

    @traceable(name="tool_registry.register", run_type="tool")
    def register(self, tool: ToolDefinition) -> None:
        self._tools[tool.name] = tool
        logger.info(f"Registered tool: {tool.name} (source={tool.source.value}, loading={tool.loading.value})")

    def unregister(self, name: str) -> None:
        if name in self._tools:
            del self._tools[name]
            logger.info(f"Unregistered tool: {name}")

    @traceable(name="tool_registry.search", run_type="tool")
    def search(self, query: str, category: str | None = None) -> list[ToolDefinition]:
        results = []
        # Use case-insensitive keyword matching (not raw regex) to avoid ReDoS
        keywords = query.lower().split()

        for tool in self._tools.values():
            if category and tool.source.value != category:
                continue
            searchable = f"{tool.name} {tool.description}".lower()
            if any(kw in searchable for kw in keywords):
                results.append(tool)

        return results

    def get(self, name: str) -> ToolDefinition | None:
        return self._tools.get(name)

    def get_immediate_tools(self) -> list[dict[str, Any]]:
        return [
            tool.openai_schema
            for tool in self._tools.values()
            if tool.loading == ToolLoading.immediate
        ]

    def get_active_tools(self, active_names: set[str]) -> list[dict[str, Any]]:
        result = []
        for name in active_names:
            tool = self._tools.get(name)
            if tool and tool.loading == ToolLoading.deferred:
                result.append(tool.openai_schema)
        return result

    def get_catalog(self, max_tools: int = 50) -> str:
        entries = []
        for tool in list(self._tools.values())[:max_tools]:
            safe_entry = tool.catalog_entry.replace("|", "\\|")
            entries.append(f"| {tool.name} | {safe_entry} |")

        if not entries:
            return ""

        header = "| Tool | Description |\n|------|-------------|"
        return header + "\n" + "\n".join(entries)

    @property
    def tool_count(self) -> int:
        return len(self._tools)

    @property
    def tool_names(self) -> list[str]:
        return list(self._tools.keys())

    def all_tools(self) -> list[ToolDefinition]:
        """Every registered tool, name-sorted.

        Sorted rather than in registration order so a caller diffing two
        responses sees real changes. Added for `routers/registry.py`, which
        needs the definitions themselves — `tool_names` loses the descriptions
        and `get_catalog` renders a markdown table rather than data.
        """
        return sorted(self._tools.values(), key=lambda t: t.name)


# Module-level singleton
_registry = ToolRegistry()


def get_tool_registry() -> ToolRegistry:
    return _registry
