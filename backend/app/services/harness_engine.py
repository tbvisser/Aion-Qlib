"""Harness engine — backend state machine for domain-specific workflows."""
import asyncio
import json
import logging
from dataclasses import dataclass, field
from enum import Enum
from string import Template
from typing import Any, AsyncGenerator, Callable

from pydantic import BaseModel

from app.db.supabase import get_supabase_client
from app.services.langsmith import traceable

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Phase / Harness definition types
# ---------------------------------------------------------------------------

class PhaseType(str, Enum):
    llm_single = "llm_single"
    llm_agent = "llm_agent"
    programmatic = "programmatic"
    llm_batch_agents = "llm_batch_agents"
    llm_human_input = "llm_human_input"


@dataclass
class PhaseDefinition:
    name: str
    description: str
    phase_type: PhaseType
    system_prompt_template: str
    tools: list[str] | None = None
    output_schema: type[BaseModel] | None = None
    validator: Callable | None = None
    executor: Callable | None = None  # For programmatic phases
    max_rounds: int = 15
    timeout_seconds: int = 120  # 120 for llm_single, 300 for llm_agent
    batch_size: int = 5
    batch_items_file: str = ""
    batch_item_filter: Callable | None = None  # Optional filter for batch items
    workspace_inputs: list[str] = field(default_factory=list)
    workspace_output: str = ""
    sub_agent_prompt: str = ""
    sub_agent_tools: list[str] | None = None  # None = use all default tools
    # Async generator: (run_id, thread_id, user_id, prior_results) -> AsyncGenerator[dict, None]
    post_execute: Callable[..., AsyncGenerator[dict, None]] | None = None


@dataclass
class HarnessPrerequisites:
    requires_upload: bool = False
    upload_description: str = ""
    harness_intro: str = ""


@dataclass
class HarnessDefinition:
    harness_type: str
    display_name: str
    phases: list[PhaseDefinition] = field(default_factory=list)
    prerequisites: HarnessPrerequisites | None = None


# ---------------------------------------------------------------------------
# Harness engine
# ---------------------------------------------------------------------------

class HarnessEngine:
    """Orchestrates harness execution as an async generator yielding SSE events."""

    def __init__(
        self,
        harness_def: HarnessDefinition,
        run_id: str,
        thread_id: str,
        user_id: str,
        cancel_event: asyncio.Event | None = None,
    ):
        self.harness_def = harness_def
        self.run_id = run_id
        self.thread_id = thread_id
        self.user_id = user_id
        self.cancel_event = cancel_event or asyncio.Event()

    async def _load_workspace_context(self, phase: PhaseDefinition) -> dict[str, str]:
        """Read workspace files listed in phase.workspace_inputs."""
        from app.services.workspace_service import read_file

        context = {}
        for path in phase.workspace_inputs:
            try:
                content = await read_file(self.thread_id, path, self.user_id)
                context[path] = content
            except FileNotFoundError:
                logger.warning(f"[HARNESS] Workspace file not found: {path}")
                context[path] = "FILE NOT FOUND — prior phase may have failed"
        return context

    def _build_phase_prompt(
        self,
        phase: PhaseDefinition,
        prior_results: dict[str, Any],
        input_text: str = "",
        workspace_context: dict[str, str] | None = None,
    ) -> str:
        """Build focused system prompt from template + prior phase results.

        Uses string.Template ($var) instead of str.format() to avoid
        issues with curly braces in contract text or JSON (F9).

        When workspace_context is provided, creates $workspace_{name} variables
        from file paths (e.g., classification.md → $workspace_classification).
        """
        tmpl = Template(phase.system_prompt_template)
        subs = {
            "contract_text": input_text,
            "prior_results": json.dumps(prior_results, indent=2) if prior_results else "{}",
            "phase_name": phase.name,
        }

        if workspace_context:
            for path, content in workspace_context.items():
                # classification.md → workspace_classification
                var_name = path.replace(".md", "").replace("-", "_").replace("/", "_")
                subs[f"workspace_{var_name}"] = content

        return tmpl.safe_substitute(**subs)

    def _build_phase_tools(self, phase: PhaseDefinition) -> list[dict] | None:
        """Build curated OpenAI tool list for this phase."""
        if not phase.tools:
            return None

        from app.services.llm_service import build_rag_tools, build_workspace_tools

        # Collect all available tools
        all_tools = build_rag_tools(
            include_web_search=False,
            include_sql=False,
            include_code_execution=False,
        )
        all_tools.extend(build_workspace_tools())

        tool_map = {}
        for t in all_tools:
            name = t.get("function", {}).get("name")
            if name:
                tool_map[name] = t

        selected = [tool_map[name] for name in phase.tools if name in tool_map]
        return selected if selected else None

    async def _get_input_text(self, prior_results: dict[str, Any]) -> str:
        """Get the contract text — either from Phase 0 result or input files."""
        if "0" in prior_results:
            return prior_results["0"].get("full_text", "")
        return ""

    async def _run_phase_llm_single(
        self,
        phase: PhaseDefinition,
        phase_index: int,
        prior_results: dict[str, Any],
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Execute a single LLM call phase with structured output."""
        from app.services.llm_service import astream_chat_response

        input_text = await self._get_input_text(prior_results)
        workspace_context = await self._load_workspace_context(phase) if phase.workspace_inputs else None
        system_prompt = self._build_phase_prompt(phase, prior_results, input_text, workspace_context)
        tools = self._build_phase_tools(phase)

        response_format = None
        if phase.output_schema:
            schema = phase.output_schema.model_json_schema()
            response_format = {
                "type": "json_schema",
                "json_schema": {
                    "name": phase.output_schema.__name__,
                    "schema": schema,
                },
            }

        messages = [{"role": "user", "content": f"Process the input for phase: {phase.name}"}]

        full_text = ""
        tool_calls_for_msg: list[dict] = []

        async for event in astream_chat_response(
            messages=messages,
            tools=tools,
            user_id=self.user_id,
            system_prompt=system_prompt,
            response_format=response_format,
        ):
            if self.cancel_event.is_set():
                yield {"type": "harness_phase_error", "phase_index": phase_index, "phase_name": phase.name, "error": "Cancelled by user"}
                return

            if event["type"] == "text_delta":
                full_text += event["content"]
                yield event
            elif event["type"] in ("tool_call_start", "tool_call_complete"):
                yield event
            elif event["type"] == "response_complete":
                full_text = event.get("full_response", full_text)

        # Parse and validate structured output
        parsed = await self._parse_and_validate(phase, full_text, phase_index)
        if parsed is None:
            # Retry once with explicit JSON instruction
            logger.warning(f"[HARNESS] Phase {phase_index} ({phase.name}) output validation failed, retrying")
            retry_messages = [
                {"role": "user", "content": f"Process the input for phase: {phase.name}"},
                {"role": "assistant", "content": full_text},
                {"role": "user", "content": "You MUST respond with valid JSON matching the schema. No prose, no markdown fencing."},
            ]
            full_text = ""
            async for event in astream_chat_response(
                messages=retry_messages,
                tools=None,
                user_id=self.user_id,
                system_prompt=system_prompt,
                response_format=response_format,
            ):
                if event["type"] == "text_delta":
                    full_text += event["content"]
                    yield event
                elif event["type"] == "response_complete":
                    full_text = event.get("full_response", full_text)

            parsed = await self._parse_and_validate(phase, full_text, phase_index)
            if parsed is None:
                yield {
                    "type": "harness_phase_error",
                    "phase_index": phase_index,
                    "phase_name": phase.name,
                    "error": "Output validation failed after retry",
                }
                return

        # Write workspace output if configured
        if phase.workspace_output:
            from app.services.workspace_service import write_file
            output_content = json.dumps(parsed, indent=2) if isinstance(parsed, dict) else str(parsed)
            file_rec = await write_file(self.thread_id, phase.workspace_output, output_content, self.user_id)
            if file_rec:
                yield {"type": "workspace_file_written", "file": file_rec}

        # Persist phase result
        await update_harness_phase(self.run_id, phase_index, parsed, self.user_id)
        yield {
            "type": "harness_phase_result",
            "phase_index": phase_index,
            "phase_name": phase.name,
            "result": parsed,
        }

    async def _run_phase_llm_agent(
        self,
        phase: PhaseDefinition,
        phase_index: int,
        prior_results: dict[str, Any],
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Execute a multi-round agent loop phase (like task sub-agent)."""
        from app.services.llm_service import get_sub_agent_llm_settings, codex_chat_client_for
        from app.services.langsmith import get_traced_async_openai_client
        from app.services.tool_executor import execute_tool_call

        input_text = await self._get_input_text(prior_results)
        workspace_context = await self._load_workspace_context(phase) if phase.workspace_inputs else None
        system_prompt = self._build_phase_prompt(phase, prior_results, input_text, workspace_context)
        tools = self._build_phase_tools(phase)

        llm_settings = get_sub_agent_llm_settings()
        client = codex_chat_client_for("agent", llm_settings) or get_traced_async_openai_client(
            base_url=llm_settings["base_url"],
            api_key=llm_settings["api_key"],
        )

        # Structured output instruction in system prompt
        schema_instruction = ""
        if phase.output_schema:
            schema = phase.output_schema.model_json_schema()
            schema_instruction = (
                f"\n\nWhen you have completed your analysis and are ready to provide your final answer, "
                f"respond with ONLY valid JSON matching this schema (no prose, no markdown fencing):\n"
                f"```json\n{json.dumps(schema, indent=2)}\n```"
            )

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt + schema_instruction},
            {"role": "user", "content": f"Process the input for phase: {phase.name}"},
        ]

        last_text = ""
        max_rounds = phase.max_rounds
        completed_tool_calls: list[dict] = []

        for round_num in range(max_rounds):
            if self.cancel_event.is_set():
                yield {"type": "harness_phase_error", "phase_index": phase_index, "phase_name": phase.name, "error": "Cancelled by user"}
                return

            yield {"type": "agent_round", "round": round_num + 1, "max_rounds": max_rounds}

            request_kwargs: dict[str, Any] = {
                "model": llm_settings["model"],
                "messages": messages,
                "stream": True,
                "stream_options": {"include_usage": True},
            }
            if tools:
                request_kwargs["tools"] = tools

            stream = await client.chat.completions.create(**request_kwargs)

            full_response = ""
            tool_calls_buffer: dict[int, dict] = {}
            finish_reason = None

            async for chunk in stream:
                delta = chunk.choices[0].delta if chunk.choices else None
                chunk_finish = chunk.choices[0].finish_reason if chunk.choices else None
                if chunk_finish:
                    finish_reason = chunk_finish

                if delta and delta.content:
                    full_response += delta.content
                    yield {"type": "text_delta", "content": delta.content}

                if delta and delta.tool_calls:
                    for tc in delta.tool_calls:
                        idx = tc.index
                        if idx not in tool_calls_buffer:
                            tool_calls_buffer[idx] = {
                                "id": tc.id,
                                "name": tc.function.name if tc.function else None,
                                "arguments": "",
                            }
                        else:
                            if tc.id:
                                tool_calls_buffer[idx]["id"] = tc.id
                            if tc.function and tc.function.name:
                                tool_calls_buffer[idx]["name"] = tc.function.name
                        if tc.function and tc.function.arguments:
                            tool_calls_buffer[idx]["arguments"] += tc.function.arguments

            if finish_reason == "stop":
                last_text = full_response
                break

            if finish_reason == "tool_calls":
                assistant_msg: dict[str, Any] = {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": tc["id"],
                            "type": "function",
                            "function": {"name": tc["name"], "arguments": tc["arguments"]},
                        }
                        for tc in tool_calls_buffer.values()
                    ],
                }
                messages.append(assistant_msg)

                for tc in tool_calls_buffer.values():
                    tc_id = tc["id"]
                    yield {"type": "tool_call_start", "tool_call_id": tc_id, "tool_name": tc["name"], "arguments": tc["arguments"]}

                    tool_call_dict = {
                        "name": tc["name"],
                        "arguments": tc["arguments"],
                        "_thread_id": self.thread_id,
                    }
                    result = await execute_tool_call(
                        tool_call_dict, self.user_id, thread_id=self.thread_id,
                    )

                    if hasattr(result, "__anext__"):
                        nested_text = ""
                        async for nested_event in result:
                            if nested_event.get("type") in ("sub_agent_complete", "explorer_complete"):
                                nested_text = nested_event.get("result", nested_event.get("findings", ""))
                        result = nested_text

                    tool_result = result if isinstance(result, str) else str(result)
                    messages.append({"role": "tool", "tool_call_id": tc_id, "content": tool_result})
                    completed_tool_calls.append({"tool_name": tc["name"], "arguments": tc["arguments"], "result": tool_result[:500]})
                    yield {"type": "tool_call_complete", "tool_call_id": tc_id, "tool_name": tc["name"], "result": tool_result[:500]}

                if full_response:
                    last_text = full_response
                continue

            if full_response:
                last_text = full_response
            break
        else:
            # Force summarization on loop exhaustion
            messages.append({"role": "user", "content": "You have reached your iteration limit. Provide your final structured JSON output now."})
            final_stream = await client.chat.completions.create(
                model=llm_settings["model"], messages=messages, stream=True,
            )
            summary = ""
            async for chunk in final_stream:
                delta = chunk.choices[0].delta if chunk.choices else None
                if delta and delta.content:
                    summary += delta.content
                    yield {"type": "text_delta", "content": delta.content}
            last_text = summary

        # Parse and validate
        parsed = await self._parse_and_validate(phase, last_text, phase_index)
        if parsed is None:
            yield {
                "type": "harness_phase_error",
                "phase_index": phase_index,
                "phase_name": phase.name,
                "error": "Output validation failed",
            }
            return

        # Write workspace output if configured
        if phase.workspace_output:
            from app.services.workspace_service import write_file
            output_content = json.dumps(parsed, indent=2) if isinstance(parsed, dict) else str(parsed)
            file_rec = await write_file(self.thread_id, phase.workspace_output, output_content, self.user_id)
            if file_rec:
                yield {"type": "workspace_file_written", "file": file_rec}

        # Store tool calls alongside the phase result for persistence
        stored_result = {**parsed}
        if completed_tool_calls:
            stored_result["_tool_calls"] = completed_tool_calls
        await update_harness_phase(self.run_id, phase_index, stored_result, self.user_id)
        yield {
            "type": "harness_phase_result",
            "phase_index": phase_index,
            "phase_name": phase.name,
            "result": parsed,
        }

    async def _run_phase_programmatic(
        self,
        phase: PhaseDefinition,
        phase_index: int,
        prior_results: dict[str, Any],
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Execute a pure Python phase."""
        if not phase.executor:
            yield {
                "type": "harness_phase_error",
                "phase_index": phase_index,
                "phase_name": phase.name,
                "error": "No executor defined for programmatic phase",
            }
            return

        try:
            result = await phase.executor(
                run_id=self.run_id,
                thread_id=self.thread_id,
                user_id=self.user_id,
                prior_results=prior_results,
            )
        except Exception as e:
            logger.error(f"[HARNESS] Programmatic phase {phase_index} error: {e}")
            yield {
                "type": "harness_phase_error",
                "phase_index": phase_index,
                "phase_name": phase.name,
                "error": str(e),
            }
            return

        # Validate if schema provided
        if phase.output_schema and isinstance(result, dict):
            try:
                phase.output_schema.model_validate(result)
            except Exception as e:
                yield {
                    "type": "harness_phase_error",
                    "phase_index": phase_index,
                    "phase_name": phase.name,
                    "error": f"Validation failed: {e}",
                }
                return

        # Emit workspace_file_written for any workspace output the executor wrote
        if phase.workspace_output:
            from app.services.workspace_service import get_file as ws_get_file
            try:
                file_rec = await ws_get_file(self.thread_id, phase.workspace_output, self.user_id)
                if file_rec:
                    yield {"type": "workspace_file_written", "file": file_rec}
            except Exception:
                pass

        await update_harness_phase(self.run_id, phase_index, result, self.user_id)
        yield {
            "type": "harness_phase_result",
            "phase_index": phase_index,
            "phase_name": phase.name,
            "result": result,
        }

    async def _run_phase_batch_agents(
        self,
        phase: PhaseDefinition,
        phase_index: int,
        prior_results: dict[str, Any],
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Execute a batch of task agents in parallel with real-time SSE streaming."""
        from app.services.deep_agent_service import run_task_agent
        from app.services.workspace_service import read_file, append_file
        import uuid

        # 1. Read batch items from workspace
        try:
            items_content = await read_file(self.thread_id, phase.batch_items_file, self.user_id)
        except FileNotFoundError:
            yield {"type": "harness_phase_error", "phase_index": phase_index, "phase_name": phase.name,
                   "error": f"Batch items file not found: {phase.batch_items_file}"}
            return

        # Parse items as JSON array
        try:
            items = json.loads(items_content)
        except json.JSONDecodeError:
            # Try stripping markdown fencing
            cleaned = items_content.strip()
            if cleaned.startswith("```"):
                lines = cleaned.split("\n")
                lines = lines[1:]
                if lines and lines[-1].strip() == "```":
                    lines = lines[:-1]
                cleaned = "\n".join(lines).strip()
            try:
                items = json.loads(cleaned)
            except json.JSONDecodeError:
                yield {"type": "harness_phase_error", "phase_index": phase_index, "phase_name": phase.name,
                       "error": f"Failed to parse batch items from {phase.batch_items_file} — expected JSON array"}
                return

        if not isinstance(items, list) or not items:
            yield {"type": "harness_phase_error", "phase_index": phase_index, "phase_name": phase.name,
                   "error": f"Batch items file {phase.batch_items_file} contains no items"}
            return

        # Apply optional filter (e.g., YELLOW/RED only for redline generation)
        if phase.batch_item_filter:
            items = [item for item in items if phase.batch_item_filter(item)]
            if not items:
                # No items after filtering — skip with empty result
                from app.services.workspace_service import write_file as ws_write
                file_rec = await ws_write(self.thread_id, phase.workspace_output, json.dumps([], indent=2), self.user_id)
                if file_rec:
                    yield {"type": "workspace_file_written", "file": file_rec}
                result = {"redlines": [], "_summary": "No items required processing"}
                await update_harness_phase(self.run_id, phase_index, result, self.user_id)
                yield {"type": "harness_phase_result", "phase_index": phase_index, "phase_name": phase.name, "result": result}
                return

        # 2. Load shared workspace context
        workspace_context = await self._load_workspace_context(phase) if phase.workspace_inputs else None

        # 3. Build parent tools
        tools = self._build_phase_tools(phase) or []

        # 4. Check for resumability — detect already-completed items
        completed_refs: set[str] = set()
        if phase.workspace_output:
            try:
                existing_output = await read_file(self.thread_id, phase.workspace_output, self.user_id)
                try:
                    existing_results = json.loads(existing_output)
                    if isinstance(existing_results, list):
                        for entry in existing_results:
                            ref = entry.get("clause_ref") if isinstance(entry, dict) else None
                            if ref:
                                completed_refs.add(ref)
                except (json.JSONDecodeError, TypeError):
                    pass
            except FileNotFoundError:
                pass

        # Filter to remaining items
        remaining_items = []
        for item in items:
            ref = item.get("section_ref") or item.get("clause_ref", "")
            if ref and ref in completed_refs:
                continue
            remaining_items.append(item)

        if not remaining_items:
            logger.info(f"[HARNESS] Phase {phase_index}: all {len(items)} items already completed, skipping")
            # Still need to persist phase result
            try:
                existing_output = await read_file(self.thread_id, phase.workspace_output, self.user_id)
                all_results = json.loads(existing_output)
            except Exception:
                all_results = []
            await update_harness_phase(self.run_id, phase_index,
                                       {"assessments": all_results, "_summary": f"Resumed — all {len(items)} items already completed"}, self.user_id)
            yield {"type": "harness_phase_result", "phase_index": phase_index, "phase_name": phase.name,
                   "result": {"assessments": all_results}}
            return

        total_items = len(items)
        total_remaining = len(remaining_items)
        processed = total_items - total_remaining

        # 5. Chunk into batches
        batch_size = phase.batch_size
        batches = [remaining_items[i:i + batch_size] for i in range(0, len(remaining_items), batch_size)]

        all_batch_results: list[dict] = []

        for batch_num, batch in enumerate(batches):
            if self.cancel_event.is_set():
                yield {"type": "harness_phase_error", "phase_index": phase_index, "phase_name": phase.name,
                       "error": "Cancelled by user"}
                return

            yield {"type": "harness_batch_start", "phase_index": phase_index, "batch_index": batch_num,
                   "batch_size": len(batch), "total_items": total_items, "processed": processed}

            # 5b. Create agent calls and run with asyncio.Queue for real-time SSE
            event_queue: asyncio.Queue[dict | None] = asyncio.Queue()
            agent_results: dict[str, str] = {}
            agents_done = 0
            agents_total = len(batch)

            async def _consume_sub_agent(item: dict, item_index: int, b_num: int):
                nonlocal agents_done
                item_ref = item.get("section_ref") or item.get("clause_ref") or f"item-{item_index}"
                item_desc = self._build_batch_item_description(phase, item, workspace_context or {})
                # Exclude batch_items_file and clauses.md (cross-referenced in description)
                _exclude_from_context = {phase.batch_items_file, "clauses.md"}
                context_files = [p for p in phase.workspace_inputs if p not in _exclude_from_context]
                sub_agent_id = str(uuid.uuid4())

                try:
                    async for event in run_task_agent(
                        description=item_desc,
                        context_files=context_files,
                        thread_id=self.thread_id,
                        user_id=self.user_id,
                        parent_tools=tools,
                        system_prompt=phase.sub_agent_prompt if phase.sub_agent_prompt else None,
                        allowed_tools=phase.sub_agent_tools,
                    ):
                        etype = event.get("type", "")
                        # Re-map events with phase context
                        if etype == "sub_agent_start":
                            mapped = {"type": "harness_sub_agent_start", "phase_index": phase_index,
                                      "clause_ref": item_ref, "batch_index": b_num, "total_items": total_items,
                                      "sub_agent_id": event.get("sub_agent_id", sub_agent_id),
                                      "description": event.get("description", "")}
                            await event_queue.put(mapped)
                        elif etype in ("tool_call_start", "tool_call_complete"):
                            mapped = {"type": f"harness_sub_agent_{etype}",
                                      "sub_agent_id": event.get("sub_agent_id", sub_agent_id),
                                      "clause_ref": item_ref,
                                      **{k: v for k, v in event.items() if k != "type"}}
                            await event_queue.put(mapped)
                        elif etype == "sub_agent_complete":
                            result_text = event.get("result", "")
                            agent_results[item_ref] = result_text
                            mapped = {"type": "harness_sub_agent_complete",
                                      "sub_agent_id": event.get("sub_agent_id", sub_agent_id),
                                      "clause_ref": item_ref, "result": result_text[:500]}
                            await event_queue.put(mapped)
                        # Ignore text_delta and other events for batch agents
                except asyncio.CancelledError:
                    return
                except Exception as e:
                    logger.error(f"[HARNESS] Sub-agent error for {item_ref}: {e}")
                    # Mark with _error flag so the parser knows this is not a valid result
                    agent_results[item_ref] = json.dumps({"_error": True, "clause_ref": item_ref, "error": str(e)})
                finally:
                    agents_done += 1
                    if agents_done >= agents_total:
                        await event_queue.put(None)  # Sentinel

            # Launch gather as a task
            async def _run_batch():
                return await asyncio.gather(
                    *[_consume_sub_agent(item, processed + i, batch_num) for i, item in enumerate(batch)],
                    return_exceptions=True,
                )

            gather_task = asyncio.create_task(_run_batch())

            # Consumer loop — yield events from queue in real-time
            try:
                while True:
                    try:
                        event = await asyncio.wait_for(event_queue.get(), timeout=600.0)
                    except asyncio.TimeoutError:
                        logger.warning(f"[HARNESS] Batch {batch_num} event queue timeout")
                        break
                    if event is None:  # Sentinel
                        break
                    yield event
            finally:
                if not gather_task.done():
                    gather_task.cancel()
                    await asyncio.gather(gather_task, return_exceptions=True)

            # 5e. Parse results and accumulate
            batch_results = []
            for item in batch:
                item_ref = item.get("section_ref") or item.get("clause_ref") or ""
                result_text = agent_results.get(item_ref, "")
                parsed = self._extract_json(result_text, phase_index)
                if parsed and isinstance(parsed, dict) and not parsed.get("_error"):
                    # Always use canonical item_ref for consistency across phases
                    parsed["clause_ref"] = item_ref
                    parsed.pop("_error", None)
                    batch_results.append(parsed)
                elif parsed and isinstance(parsed, list):
                    for p in parsed:
                        if isinstance(p, dict) and not p.get("_error"):
                            p["clause_ref"] = item_ref
                            p.pop("_error", None)
                            batch_results.append(p)
                else:
                    logger.warning(f"[HARNESS] Could not parse result for {item_ref}, marking as failed")
                    batch_results.append({
                        "clause_ref": item_ref,
                        "category": item.get("category", "Unknown"),
                        "risk_level": "YELLOW",
                        "rationale": "[ASSESSMENT FAILED] Agent did not return parseable output — manual review required",
                        "market_comparison": "Unable to compare — assessment failed",
                    })

            all_batch_results.extend(batch_results)
            processed += len(batch)

            # 5f. Append to workspace output
            if phase.workspace_output:
                # Read existing, extend, write back as full JSON array
                try:
                    existing = await read_file(self.thread_id, phase.workspace_output, self.user_id)
                    existing_list = json.loads(existing)
                    if not isinstance(existing_list, list):
                        existing_list = []
                except (FileNotFoundError, json.JSONDecodeError):
                    existing_list = []

                existing_list.extend(batch_results)
                from app.services.workspace_service import write_file
                file_rec = await write_file(self.thread_id, phase.workspace_output,
                                            json.dumps(existing_list, indent=2), self.user_id)
                if file_rec:
                    yield {"type": "workspace_file_written", "file": file_rec}

            yield {"type": "harness_batch_complete", "phase_index": phase_index, "batch_index": batch_num,
                   "results_count": len(batch_results)}

        # 6. Build aggregated phase result
        # Read final accumulated output
        try:
            final_content = await read_file(self.thread_id, phase.workspace_output, self.user_id)
            final_results = json.loads(final_content)
        except Exception:
            final_results = all_batch_results

        # Build summary
        risk_counts = {"GREEN": 0, "YELLOW": 0, "RED": 0}
        for r in final_results:
            level = (r.get("risk_level") or "").upper()
            if level in risk_counts:
                risk_counts[level] += 1

        summary = f"Assessed {len(final_results)} clauses: {risk_counts['GREEN']} GREEN, {risk_counts['YELLOW']} YELLOW, {risk_counts['RED']} RED"
        phase_result = {"assessments": final_results, "_summary": summary}

        await update_harness_phase(self.run_id, phase_index, phase_result, self.user_id)
        yield {"type": "harness_phase_result", "phase_index": phase_index, "phase_name": phase.name,
               "result": phase_result}

    def _build_batch_item_description(
        self,
        phase: PhaseDefinition,
        item: dict,
        workspace_context: dict[str, str],
    ) -> str:
        """Build per-item description for a batch agent."""
        # Use the phase system_prompt_template as a base, substituting item fields
        tmpl = Template(phase.system_prompt_template)
        # Start with legacy named vars for backward compat
        subs = {
            "clause_text": item.get("text", ""),
            "clause_title": item.get("title", ""),
            "clause_category": item.get("category", ""),
            "clause_ref": item.get("section_ref") or item.get("clause_ref", ""),
        }
        # Pass ALL item fields through so phase templates can reference any field
        for key, value in item.items():
            subs[key] = str(value) if not isinstance(value, str) else value

        # Cross-reference: if item has clause_ref but no text, look up from clauses.md
        if not subs.get("clause_text") and subs.get("clause_ref") and "clauses.md" in workspace_context:
            try:
                clauses = json.loads(workspace_context["clauses.md"])
                if isinstance(clauses, list):
                    ref = subs["clause_ref"]
                    for clause in clauses:
                        c_ref = clause.get("section_ref") or clause.get("clause_ref", "")
                        if c_ref == ref:
                            subs["clause_text"] = clause.get("text", "")
                            subs.setdefault("clause_title", clause.get("title", ""))
                            break
            except (json.JSONDecodeError, TypeError):
                pass

        # Add workspace context as template vars
        for path, content in workspace_context.items():
            var_name = path.replace(".md", "").replace("-", "_").replace("/", "_")
            subs[f"workspace_{var_name}"] = content
        return tmpl.safe_substitute(**subs)

    async def _run_phase_human_input(
        self,
        phase: PhaseDefinition,
        phase_index: int,
        prior_results: dict[str, Any],
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Execute a human-input phase — generates a question and pauses for user response."""
        from app.services.llm_service import astream_chat_response

        workspace_context = await self._load_workspace_context(phase) if phase.workspace_inputs else None
        system_prompt = self._build_phase_prompt(phase, prior_results, "", workspace_context)

        messages = [{"role": "user", "content": f"Generate context-gathering questions for the reviewer based on the classification results."}]

        full_text = ""
        async for event in astream_chat_response(
            messages=messages,
            tools=None,
            user_id=self.user_id,
            system_prompt=system_prompt,
        ):
            if self.cancel_event.is_set():
                yield {"type": "harness_phase_error", "phase_index": phase_index, "phase_name": phase.name,
                       "error": "Cancelled by user"}
                return

            if event["type"] == "text_delta":
                full_text += event["content"]
                yield event
            elif event["type"] == "response_complete":
                full_text = event.get("full_response", full_text)

        # Pause the harness — don't yield harness_phase_result
        await pause_harness_run(self.run_id, self.user_id)
        yield {"type": "harness_human_input_required", "phase_index": phase_index, "phase_name": phase.name,
               "question": full_text}

    def _extract_json(self, text: str, phase_index: int) -> dict | list | None:
        """Extract JSON from LLM output, handling fencing, prose, and partial wrapping."""
        cleaned = text.strip()

        # Strip markdown fencing if present
        if cleaned.startswith("```"):
            lines = cleaned.split("\n")
            lines = lines[1:]  # Remove opening fence line
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            cleaned = "\n".join(lines).strip()

        # Try direct parse first
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            pass

        # LLM may have wrapped JSON in prose — find the first { or [
        for start_char, end_char in [('{', '}'), ('[', ']')]:
            start = cleaned.find(start_char)
            if start == -1:
                continue
            end = cleaned.rfind(end_char)
            if end <= start:
                continue
            candidate = cleaned[start:end + 1]
            try:
                data = json.loads(candidate)
                logger.info(f"[HARNESS] Phase {phase_index}: extracted JSON from surrounding prose")
                return data
            except json.JSONDecodeError:
                continue

        logger.warning(f"[HARNESS] Phase {phase_index} produced no parseable JSON. First 200 chars: {cleaned[:200]}")
        return None

    async def _parse_and_validate(
        self,
        phase: PhaseDefinition,
        text: str,
        phase_index: int,
    ) -> dict | None:
        """Parse LLM output as JSON, validate against schema."""
        if not phase.output_schema:
            return {"raw_text": text}

        data = self._extract_json(text, phase_index)
        if data is None:
            return None

        # If LLM returned a bare list and the schema has a single list field, wrap it
        if isinstance(data, list):
            schema_fields = phase.output_schema.model_fields
            list_fields = [
                name for name, field in schema_fields.items()
                if hasattr(field.annotation, '__origin__') and field.annotation.__origin__ is list
            ]
            if len(list_fields) == 1:
                logger.info(f"[HARNESS] Phase {phase_index}: wrapping bare list into '{list_fields[0]}'")
                data = {list_fields[0]: data}

        try:
            validated = phase.output_schema.model_validate(data)
            result = validated.model_dump()
        except Exception as e:
            logger.warning(f"[HARNESS] Phase {phase_index} schema validation failed: {e}")
            return None

        # Run custom validator if provided
        if phase.validator:
            try:
                phase.validator(result)
            except Exception as e:
                logger.warning(f"[HARNESS] Phase {phase_index} custom validation failed: {e}")
                return None

        return result

    async def run_phase(self, phase_index: int) -> AsyncGenerator[dict[str, Any], None]:
        """Execute a single phase with timeout enforcement."""
        phase = self.harness_def.phases[phase_index]
        timeout = phase.timeout_seconds

        yield {"type": "harness_phase_start", "phase_index": phase_index, "phase_name": phase.name, "phase_description": phase.description}

        try:
            prior = await self._get_prior_results()
            if phase.phase_type == PhaseType.llm_single:
                gen = self._run_phase_llm_single(phase, phase_index, prior)
            elif phase.phase_type == PhaseType.llm_agent:
                gen = self._run_phase_llm_agent(phase, phase_index, prior)
            elif phase.phase_type == PhaseType.programmatic:
                gen = self._run_phase_programmatic(phase, phase_index, prior)
            elif phase.phase_type == PhaseType.llm_batch_agents:
                gen = self._run_phase_batch_agents(phase, phase_index, prior)
            elif phase.phase_type == PhaseType.llm_human_input:
                gen = self._run_phase_human_input(phase, phase_index, prior)
            else:
                yield {"type": "harness_phase_error", "phase_index": phase_index, "phase_name": phase.name, "error": f"Unknown phase type: {phase.phase_type}"}
                return

            # Stream events progressively with timeout enforcement (F3)
            phase_failed = False
            phase_result = None
            deadline = asyncio.get_event_loop().time() + timeout

            async for event in gen:
                if asyncio.get_event_loop().time() > deadline:
                    yield {"type": "harness_phase_error", "phase_index": phase_index, "phase_name": phase.name, "error": f"Phase timed out after {timeout}s"}
                    phase_failed = True
                    break
                if event.get("type") == "harness_phase_error":
                    phase_failed = True
                elif event.get("type") == "harness_phase_result":
                    phase_result = event.get("result")
                yield event

            if not phase_failed and phase.phase_type != PhaseType.llm_human_input:
                # Include result_markdown so frontend can display details immediately
                result_md = format_phase_result(phase.name, phase_result) if phase_result else ""
                yield {"type": "harness_phase_complete", "phase_index": phase_index, "phase_name": phase.name,
                       "result_summary": f"Phase {phase.name} completed successfully",
                       "result_markdown": result_md}

        except asyncio.TimeoutError:
            yield {"type": "harness_phase_error", "phase_index": phase_index, "phase_name": phase.name, "error": f"Phase timed out after {timeout}s"}
        except Exception as e:
            logger.error(f"[HARNESS] Phase {phase_index} unexpected error: {e}")
            yield {"type": "harness_phase_error", "phase_index": phase_index, "phase_name": phase.name, "error": str(e)}

    async def _get_prior_results(self) -> dict[str, Any]:
        """Load prior phase results from DB."""
        run = await get_harness_run(self.thread_id, self.user_id)
        if run:
            return run.get("phase_results", {})
        return {}

    def _build_progress_md(
        self,
        phase_statuses: dict[int, str],
        error_msg: str | None = None,
        phase_results: dict[str, Any] | None = None,
    ) -> str:
        """Build progress.md content from current phase statuses.

        phase_statuses maps phase_index -> "completed" | "failed" | "running" | "pending" | "cancelled"
        phase_results optionally provides _summary keys for detail lines.
        """
        total = len(self.harness_def.phases)
        completed = sum(1 for s in phase_statuses.values() if s == "completed")
        failed = any(s == "failed" for s in phase_statuses.values())
        cancelled = any(s == "cancelled" for s in phase_statuses.values())

        if failed:
            overall = "Failed"
        elif cancelled:
            overall = "Cancelled"
        elif completed == total:
            overall = "Completed"
        else:
            overall = "In Progress"

        lines = [
            f"# {self.harness_def.display_name} — Progress",
            "",
            f"**Status:** {overall}  ",
            f"**Phases:** {completed}/{total} completed",
            "",
            "| # | Phase | Status | Detail |",
            "|---|-------|--------|--------|",
        ]

        status_icons = {
            "completed": "Completed",
            "failed": "Failed",
            "running": "Running...",
            "pending": "Pending",
            "cancelled": "Cancelled",
        }

        for idx, phase in enumerate(self.harness_def.phases):
            status = phase_statuses.get(idx, "pending")
            icon = status_icons.get(status, status)
            # Extract _summary from phase results
            detail = ""
            if phase_results and str(idx) in phase_results:
                pr = phase_results[str(idx)]
                if isinstance(pr, dict):
                    detail = pr.get("_summary", "")
            lines.append(f"| {idx + 1} | {phase.name} | {icon} | {detail} |")

        if error_msg:
            lines.extend(["", f"**Error:** {error_msg}"])

        lines.append("")
        return "\n".join(lines)

    async def _write_progress(
        self,
        phase_statuses: dict[int, str],
        error_msg: str | None = None,
    ) -> dict | None:
        """Write progress.md to the workspace. Returns the file record or None."""
        from app.services.workspace_service import write_file

        phase_results = await self._get_prior_results()
        content = self._build_progress_md(phase_statuses, error_msg, phase_results)
        try:
            return await write_file(self.thread_id, "progress.md", content, self.user_id)
        except Exception as e:
            logger.warning(f"[HARNESS] Failed to write progress.md: {e}")
            return None

    async def run(self, start_phase: int = 0) -> AsyncGenerator[dict[str, Any], None]:
        """Run all phases sequentially from start_phase to end."""
        phase_statuses: dict[int, str] = {
            i: "pending" for i in range(len(self.harness_def.phases))
        }
        # Mark previously completed phases
        for i in range(start_phase):
            phase_statuses[i] = "completed"

        # When resuming after human input, emit phase_complete for the human input phase
        if start_phase > 0:
            human_phase_idx = start_phase - 1
            human_phase = self.harness_def.phases[human_phase_idx]
            if human_phase.phase_type == PhaseType.llm_human_input:
                yield {"type": "harness_phase_complete", "phase_index": human_phase_idx,
                       "phase_name": human_phase.name, "result_summary": "User context received",
                       "result_markdown": ""}
                await self._write_progress(phase_statuses)

        for i in range(start_phase, len(self.harness_def.phases)):
            if self.cancel_event.is_set():
                phase_statuses[i] = "cancelled"
                file_rec = await self._write_progress(phase_statuses, "Cancelled by user")
                if file_rec:
                    yield {"type": "workspace_file_written", "file": file_rec}
                yield {"type": "harness_phase_error", "phase_index": i, "phase_name": self.harness_def.phases[i].name, "error": "Cancelled by user"}
                await fail_harness_run(self.run_id, "Cancelled by user", self.user_id)
                return

            phase_statuses[i] = "running"
            file_rec = await self._write_progress(phase_statuses)
            if file_rec:
                yield {"type": "workspace_file_written", "file": file_rec}

            phase_failed = False
            phase_error = ""
            phase_paused = False
            async for event in self.run_phase(i):
                yield event
                if event.get("type") == "harness_phase_error":
                    phase_failed = True
                    phase_error = event.get("error", "Unknown error")
                elif event.get("type") == "harness_human_input_required":
                    phase_paused = True

            if phase_paused:
                phase_statuses[i] = "running"  # Still in progress, waiting for user
                file_rec = await self._write_progress(phase_statuses)
                if file_rec:
                    yield {"type": "workspace_file_written", "file": file_rec}
                return  # Break the phase loop — harness is paused

            if phase_failed:
                phase_statuses[i] = "failed"
                file_rec = await self._write_progress(phase_statuses, phase_error)
                if file_rec:
                    yield {"type": "workspace_file_written", "file": file_rec}
                await fail_harness_run(self.run_id, f"Phase {i} failed", self.user_id)
                return

            phase_statuses[i] = "completed"
            file_rec = await self._write_progress(phase_statuses)
            if file_rec:
                yield {"type": "workspace_file_written", "file": file_rec}

            # Run post_execute hook if defined (non-fatal)
            phase_def = self.harness_def.phases[i]
            if phase_def.post_execute:
                try:
                    prior = await self._get_prior_results()
                    async for event in phase_def.post_execute(
                        run_id=self.run_id,
                        thread_id=self.thread_id,
                        user_id=self.user_id,
                        prior_results=prior,
                    ):
                        yield event
                except Exception as e:
                    logger.error(f"[HARNESS] Phase {i} post_execute failed: {e}")

        await complete_harness_run(self.run_id, self.user_id)
        yield {
            "type": "harness_complete",
            "harness_type": self.harness_def.harness_type,
            "overall_result": "All phases completed successfully",
        }


# ---------------------------------------------------------------------------
# Phase result formatting (used by chat router + harness REST endpoint)
# ---------------------------------------------------------------------------

def format_phase_result(phase_name: str, result: dict) -> str:
    """Format a harness phase result as human-readable Markdown for display."""
    if not result:
        return ""

    if phase_name == "Document Intake":
        fmt = result.get("format", "unknown")
        pages = result.get("page_count", 0)
        text_len = len(result.get("full_text", ""))
        return f"Extracted {text_len:,} characters ({pages} pages) from {fmt} document.\n\n"

    if phase_name == "Contract Classification":
        ctype = result.get("contract_type", "Unknown")
        parties = result.get("parties", [])
        eff = result.get("effective_date") or "N/A"
        exp = result.get("expiration_date") or "N/A"
        gov = result.get("governing_law") or "N/A"
        party_lines = "\n".join(f"- **{p['name']}** — {p['role']}" for p in parties)
        return (
            f"| | |\n"
            f"|---|---|\n"
            f"| **Type** | {ctype} |\n"
            f"| **Effective** | {eff} |\n"
            f"| **Expires** | {exp} |\n"
            f"| **Governing Law** | {gov} |\n\n"
            f"**Parties:**\n{party_lines}\n\n"
        )

    if phase_name == "Gather Context":
        response = result.get("user_response", "")
        if response:
            return f"User context captured: {response[:200]}{'...' if len(response) > 200 else ''}\n\n"
        return "Waiting for user input...\n\n"

    if phase_name == "Load Playbook":
        # Show playbook docs found
        raw = result.get("raw_text", "")
        docs = result.get("playbook_docs", [])
        if docs:
            items = [f"- {d.get('title', '?')} — {d.get('summary', '')[:100]}" for d in docs]
            return f"Found **{len(docs)} playbook documents**:\n" + "\n".join(items) + "\n\n"
        if raw:
            return f"Playbook research completed.\n\n"
        return f"Phase completed.\n\n"

    if phase_name == "Clause Extraction":
        clauses = result.get("clauses", [])
        categories = {}
        for c in clauses:
            cat = c.get("category", "Other")
            categories[cat] = categories.get(cat, 0) + 1
        cat_summary = ", ".join(f"{cat} ({n})" for cat, n in sorted(categories.items()))
        return f"Extracted **{len(clauses)} clauses** across categories: {cat_summary}\n\n"

    if phase_name in ("Risk Analysis & Flagging", "Risk Analysis"):
        assessments = result.get("assessments", [])
        counts = {"GREEN": 0, "YELLOW": 0, "RED": 0}
        for a in assessments:
            level = a.get("risk_level", "").upper()
            if level in counts:
                counts[level] += 1
        flags = []
        for a in assessments:
            if a.get("risk_level", "").upper() in ("YELLOW", "RED"):
                flags.append(f"- **{a.get('risk_level')}** [{a.get('clause_ref', '?')}] {a.get('category', '')}: {a.get('rationale', '')[:100]}")
        summary = f"Assessed **{len(assessments)} clauses**: {counts['GREEN']} GREEN, {counts['YELLOW']} YELLOW, {counts['RED']} RED\n\n"
        if flags:
            summary += "\n".join(flags) + "\n\n"
        return summary

    if phase_name == "Redline Generation":
        # Batch phase stores results under "assessments"; also check "redlines"
        redlines = result.get("redlines", []) or result.get("assessments", [])
        if not redlines:
            return "No redlines needed — all clauses are acceptable.\n\n"
        items = []
        for r in redlines:
            items.append(f"- **[{r.get('clause_ref', '?')}]** ({r.get('risk_level', '?')}): {r.get('rationale', '')[:100]}")
        return f"Generated **{len(redlines)} redlines**:\n" + "\n".join(items) + "\n\n"

    if phase_name in ("Executive Summary & Report", "Executive Summary"):
        risk = result.get("overall_risk", "?")
        rec = result.get("recommendation", "")
        findings = result.get("key_findings", [])
        breakdown = result.get("risk_breakdown", {})

        bd = " | ".join(f"{k}: {v}" for k, v in breakdown.items())
        findings_md = "\n".join(f"- {f}" for f in findings)

        return (
            f"### Overall Risk: **{risk}**\n"
            f"**Recommendation:** {rec}\n\n"
            f"**Risk Breakdown:** {bd}\n\n"
            f"**Key Findings:**\n{findings_md}\n\n"
        )

    # Fallback: show a compact summary
    return f"Phase completed with {len(result)} fields.\n\n"


# ---------------------------------------------------------------------------
# CRUD functions for harness_runs
# ---------------------------------------------------------------------------

@traceable(name="create_harness_run", run_type="tool")
async def create_harness_run(
    thread_id: str,
    harness_type: str,
    input_file_ids: list[str],
    config: dict,
    user_id: str,
) -> dict:
    """Create a new harness run for a thread."""
    supabase = get_supabase_client()

    # Verify thread ownership before creating run
    thread_check = (
        supabase.table("threads")
        .select("id")
        .eq("id", thread_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not thread_check.data:
        raise PermissionError(f"Thread {thread_id} not owned by user")

    data = {
        "thread_id": thread_id,
        "harness_type": harness_type,
        "status": "running",
        "current_phase": 0,
        "phase_results": {},
        "input_file_ids": input_file_ids,
        "config": config,
    }

    result = supabase.table("harness_runs").insert(data).execute()
    if not result.data:
        raise Exception("Failed to create harness run")
    return result.data[0]


@traceable(name="get_harness_run", run_type="tool")
async def get_harness_run(thread_id: str, user_id: str) -> dict | None:
    """Get the active harness run for a thread (or None)."""
    supabase = get_supabase_client()

    # Join through threads to verify user ownership
    result = (
        supabase.table("harness_runs")
        .select("*, threads!inner(user_id)")
        .eq("thread_id", thread_id)
        .eq("threads.user_id", user_id)
        .in_("status", ["pending", "running", "paused"])
        .execute()
    )

    if not result.data:
        return None
    row = result.data[0]
    row.pop("threads", None)
    return row


@traceable(name="get_harness_run_any", run_type="tool")
async def get_harness_run_any(thread_id: str, user_id: str) -> dict | None:
    """Get the most recent harness run for a thread (any status)."""
    supabase = get_supabase_client()

    result = (
        supabase.table("harness_runs")
        .select("*, threads!inner(user_id)")
        .eq("thread_id", thread_id)
        .eq("threads.user_id", user_id)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )

    if not result.data:
        return None
    row = result.data[0]
    row.pop("threads", None)
    return row


@traceable(name="update_harness_phase", run_type="tool")
async def update_harness_phase(
    run_id: str,
    phase_index: int,
    phase_result: dict,
    user_id: str,
) -> dict:
    """Update a phase result and advance current_phase atomically."""
    supabase = get_supabase_client()

    # Atomic JSONB merge via RPC to avoid read-modify-write race (F6)
    phase_key = str(phase_index)

    result = (
        supabase.rpc("update_harness_phase_atomic", {
            "p_run_id": run_id,
            "p_user_id": user_id,
            "p_phase_key": phase_key,
            "p_phase_result": phase_result,  # Supabase client serializes dict→jsonb
            "p_next_phase": phase_index + 1,
        }).execute()
    )

    if not result.data:
        raise Exception(f"Failed to update harness phase (run {run_id} not found or not owned)")
    return result.data[0]


@traceable(name="pause_harness_run", run_type="tool")
async def pause_harness_run(run_id: str, user_id: str) -> dict:
    """Pause a harness run (for human-input phases). Sets status only."""
    supabase = get_supabase_client()
    result = (
        supabase.table("harness_runs")
        .select("*, threads!inner(user_id)")
        .eq("id", run_id)
        .eq("threads.user_id", user_id)
        .execute()
    )
    if not result.data:
        raise Exception("Harness run not found or not owned by user")

    update_result = (
        supabase.table("harness_runs")
        .update({"status": "paused"})
        .eq("id", run_id)
        .execute()
    )
    if not update_result.data:
        raise Exception("Failed to pause harness run")
    logger.info(f"[HARNESS] Run {run_id} paused for human input")
    return update_result.data[0]


@traceable(name="complete_harness_run", run_type="tool")
async def complete_harness_run(run_id: str, user_id: str) -> dict:
    """Mark a harness run as completed."""
    supabase = get_supabase_client()
    result = (
        supabase.table("harness_runs")
        .select("*, threads!inner(user_id)")
        .eq("id", run_id)
        .eq("threads.user_id", user_id)
        .execute()
    )
    if not result.data:
        raise Exception("Harness run not found or not owned by user")

    update_result = (
        supabase.table("harness_runs")
        .update({"status": "completed"})
        .eq("id", run_id)
        .execute()
    )
    if not update_result.data:
        raise Exception("Failed to complete harness run")
    return update_result.data[0]


@traceable(name="fail_harness_run", run_type="tool")
async def fail_harness_run(run_id: str, error: str, user_id: str) -> dict:
    """Mark a harness run as failed."""
    supabase = get_supabase_client()
    result = (
        supabase.table("harness_runs")
        .select("*, threads!inner(user_id)")
        .eq("id", run_id)
        .eq("threads.user_id", user_id)
        .execute()
    )
    if not result.data:
        raise Exception("Harness run not found or not owned by user")

    update_result = (
        supabase.table("harness_runs")
        .update({"status": "failed"})
        .eq("id", run_id)
        .execute()
    )
    if not update_result.data:
        raise Exception("Failed to fail harness run")
    logger.error(f"[HARNESS] Run {run_id} failed: {error}")
    return update_result.data[0]
