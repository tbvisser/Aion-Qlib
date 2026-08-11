"""Harness REST endpoints for lifecycle management."""
import logging

from fastapi import APIRouter, Depends, HTTPException, status

from app.dependencies import get_current_user, User
from app.models.schemas import HarnessRunCreate, HarnessRunResponse, HarnessPhaseInfo, HarnessPhaseStatus, HarnessPhaseToolCall
from app.services.harness_engine import (
    create_harness_run,
    get_harness_run,
    get_harness_run_any,
    fail_harness_run,
    format_phase_result,
)
from app.services.harnesses import get_harness, list_harnesses

logger = logging.getLogger(__name__)

router = APIRouter(tags=["harness"])


def _compute_phases(harness_type: str, current_phase: int, phase_results: dict, run_status: str) -> list[HarnessPhaseInfo]:
    """Compute phase info list from harness definition + run state."""
    try:
        harness_def = get_harness(harness_type)
    except ValueError:
        return []

    phases = []
    for i, phase_def in enumerate(harness_def.phases):
        if run_status == "completed":
            phase_status = HarnessPhaseStatus.completed
        elif run_status == "failed" and i == current_phase:
            phase_status = HarnessPhaseStatus.failed
        elif str(i) in phase_results:
            phase_status = HarnessPhaseStatus.completed
        elif i == current_phase and run_status == "running":
            phase_status = HarnessPhaseStatus.running
        else:
            phase_status = HarnessPhaseStatus.pending

        # Generate result markdown from stored phase result if available
        result_md = None
        phase_tool_calls: list[HarnessPhaseToolCall] = []
        phase_result_data = phase_results.get(str(i))
        if phase_result_data:
            result_md = format_phase_result(phase_def.name, phase_result_data) or None
            # Extract persisted tool calls from agent phases
            raw_tcs = phase_result_data.get("_tool_calls", []) if isinstance(phase_result_data, dict) else []
            phase_tool_calls = [
                HarnessPhaseToolCall(
                    tool_name=tc.get("tool_name", ""),
                    arguments=tc.get("arguments", ""),
                    result=tc.get("result"),
                )
                for tc in raw_tcs
            ]

        phases.append(HarnessPhaseInfo(
            index=i,
            name=phase_def.name,
            description=phase_def.description,
            status=phase_status,
            result_markdown=result_md,
            tool_calls=phase_tool_calls,
            phase_type=phase_def.phase_type.value,
        ))
    return phases


def _to_response(run: dict) -> HarnessRunResponse:
    """Convert DB row to response model."""
    phases = _compute_phases(
        run["harness_type"],
        run["current_phase"],
        run.get("phase_results", {}),
        run["status"],
    )
    return HarnessRunResponse(
        id=run["id"],
        thread_id=run["thread_id"],
        harness_type=run["harness_type"],
        status=run["status"],
        current_phase=run["current_phase"],
        phases=phases,
        created_at=run["created_at"],
        updated_at=run["updated_at"],
    )


@router.post("/threads/{thread_id}/harness", response_model=HarnessRunResponse, status_code=status.HTTP_201_CREATED)
async def create_harness(
    thread_id: str,
    body: HarnessRunCreate,
    current_user: User = Depends(get_current_user),
):
    """Create a new harness run for a thread."""
    # Validate harness type
    try:
        get_harness(body.harness_type)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Unknown harness type: {body.harness_type}")

    # Check for existing active run
    existing = await get_harness_run(thread_id, current_user.id)
    if existing:
        raise HTTPException(status_code=409, detail="A harness run is already active on this thread")

    try:
        run = await create_harness_run(
            thread_id=thread_id,
            harness_type=body.harness_type,
            input_file_ids=[str(fid) for fid in body.input_file_ids],
            config=body.config,
            user_id=current_user.id,
        )
        return _to_response(run)
    except Exception as e:
        logger.error(f"Error creating harness run: {e}")
        raise HTTPException(status_code=500, detail="Failed to create harness run")


@router.get("/threads/{thread_id}/harness", response_model=HarnessRunResponse | None)
async def get_harness_status(
    thread_id: str,
    current_user: User = Depends(get_current_user),
):
    """Get active harness run with computed phase info."""
    run = await get_harness_run_any(thread_id, current_user.id)
    if not run:
        return None
    return _to_response(run)


@router.delete("/threads/{thread_id}/harness", status_code=status.HTTP_200_OK)
async def cancel_harness(
    thread_id: str,
    current_user: User = Depends(get_current_user),
):
    """Cancel the active harness run."""
    run = await get_harness_run(thread_id, current_user.id)
    if not run:
        raise HTTPException(status_code=404, detail="No active harness run found")

    try:
        await fail_harness_run(run["id"], "Cancelled by user", current_user.id)
        return {"status": "cancelled"}
    except Exception as e:
        logger.error(f"Error cancelling harness run: {e}")
        raise HTTPException(status_code=500, detail="Failed to cancel harness run")


@router.get("/harness/types")  # No conflict — different prefix from /threads/{id}/harness (F4)
async def list_harness_types(current_user: User = Depends(get_current_user)):
    """List available harness types."""
    return list_harnesses()
