from __future__ import annotations

import base64
import binascii
import hashlib
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .errors import (
    ConflictError,
    ExportBlockedError,
    HarnessError,
    NotFoundError,
    ProviderConfigurationError,
    ValidationHarnessError,
)
from .motion_constraints import Phase
from .jsonio import read_json
from .models import ExportOptions, FrameReviewRequest, GenerationRequest, JobRecord
from .service import QA_ALGORITHM_VERSION, SpritePipelineService


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AttackPlanBody(_Body):
    character_id: str
    keyframes_base64: list[str] = Field(min_length=5, max_length=5)
    max_submissions: int = Field(default=7, ge=5, le=7)
    keyframes_confirmed: bool = False


class AttackSubmitBody(_Body):
    retry: bool = False
    reason: str = Field(default="", max_length=2000)


class AttackAcceptBody(_Body):
    token: str = Field(pattern=r"^[0-9a-f]{64}$")
    points: list[list[float]] = Field(min_length=4, max_length=4)
    phase_confirmed: bool = False
    reviewer: str = Field(default="api", min_length=1, max_length=100)


class MotionRepairBody(_Body):
    base_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    note: str = Field(default="", max_length=500)
    phase: Phase | Literal["auto"] = "auto"
    retry: bool = False
    wait: bool = False


class GenerateBody(_Body):
    wait: bool = False
    candidate_index: int | None = Field(default=None, ge=1)


class FramesBody(_Body):
    frames: list[str] = Field(min_length=1, max_length=64)


class ApproveBody(_Body):
    reviewer: str = Field(default="api", min_length=1, max_length=100)
    acknowledge_warnings: bool = False
    review_note: str = Field(default='', max_length=2000)


class RejectBody(_Body):
    reviewer: str = Field(default="api", min_length=1, max_length=100)
    note: str = Field(default="", max_length=2000)


class ReplacementBody(_Body):
    png_base64: str
    base_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class PixelEditBody(_Body):
    width: int = Field(ge=1, le=512)
    height: int = Field(ge=1, le=512)
    rgba_base64: str = Field(min_length=4, max_length=2_000_000)
    base_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    reviewer: str = Field(default="web_pixel_editor", min_length=1, max_length=100)


class AttachProviderJobBody(_Body):
    provider_job_id: str = Field(min_length=6, max_length=200)


def _job(job: Any) -> dict[str, Any]:
    return job.model_dump(mode="json")


def create_api(
    root: str | Path | None = None,
    *,
    service: SpritePipelineService | None = None,
) -> Any:
    """Create the FastAPI app lazily so CLI/offline processing needs no FastAPI."""

    try:
        from fastapi import FastAPI, Header, Query, Request
        from fastapi.exceptions import RequestValidationError
        from fastapi.responses import FileResponse, JSONResponse, Response
        from fastapi.staticfiles import StaticFiles
    except ImportError as exc:  # pragma: no cover - depends on optional install
        raise ProviderConfigurationError(
            "REST API requires FastAPI; install requirements.txt",
            details={"dependency": "fastapi"},
        ) from exc

    service = service or SpritePipelineService(root)
    from .recovery import RecoveryWorker

    recovery_worker = RecoveryWorker(service)

    @asynccontextmanager
    async def lifespan(_app: Any) -> Any:
        recovery_worker.start()
        try:
            yield
        finally:
            recovery_worker.stop()

    app = FastAPI(
        title="Sprite Generation Harness API",
        version="0.1.0",
        description="Local API for the same durable workflow used by Codex and Gradio.",
        lifespan=lifespan,
    )
    app.state.sprite_pipeline_service = service
    app.state.sprite_pipeline_recovery = recovery_worker
    from .reference_art import create_reference_router

    app.include_router(create_reference_router(service, recovery_worker.reference_queue))
    from .canvas_api import create_canvas_router

    app.include_router(create_canvas_router(service))
    from .asset_catalog import create_asset_router

    app.include_router(create_asset_router(service))
    from .collaboration.api import create_router as create_open_motion_router
    app.include_router(create_open_motion_router(service))
    static_dir = Path(__file__).resolve().parent / "static"

    class _NoStoreStaticFiles(StaticFiles):
        async def get_response(self, path: str, scope: dict[str, Any]) -> Any:
            response = await super().get_response(path, scope)
            # The editor is developed and served locally. Reusing an old HTML/JS
            # combination can stop the module before it clears the loading mask,
            # so correctness is more important than browser asset caching here.
            response.headers["Cache-Control"] = "no-store, max-age=0"
            response.headers["Pragma"] = "no-cache"
            return response

    app.mount(
        "/pixel-editor-assets",
        _NoStoreStaticFiles(directory=static_dir),
        name="pixel-editor-assets",
    )

    @app.get("/pixel-editor", include_in_schema=False, response_model=None)
    def pixel_editor_page() -> FileResponse:
        return FileResponse(
            static_dir / "pixel_editor.html",
            media_type="text/html",
            headers={"Cache-Control": "no-store"},
        )

    @app.exception_handler(HarnessError)
    async def harness_error_handler(_request: Request, exc: HarnessError) -> JSONResponse:
        if isinstance(exc, NotFoundError):
            status = 404
        elif isinstance(exc, (ConflictError, ExportBlockedError)):
            status = 409
        elif isinstance(exc, (ValidationHarnessError, ProviderConfigurationError)):
            status = 422
        else:
            status = 502
        return JSONResponse(
            status_code=status,
            content={"schema_version": 1, "ok": False, "error": exc.as_dict()},
        )

    @app.exception_handler(RequestValidationError)
    async def request_validation_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {"location": list(item.get("loc", ())), "message": item.get("msg", "invalid input"), "type": item.get("type")}
            for item in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={
                "schema_version": 1,
                "ok": False,
                "error": {"code": "validation_error", "message": "request validation failed", "details": {"errors": errors}},
            },
        )

    @app.exception_handler(Exception)
    async def unexpected_error_handler(_request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={
                "schema_version": 1,
                "ok": False,
                "error": {
                    "code": "internal_error",
                    "message": "unexpected harness failure",
                    "details": {"type": type(exc).__name__},
                },
            },
        )

    from .attack_plans import AttackPlans
    attack_plans = AttackPlans(service)

    @app.post("/jobs/{job_id}/candidates/{candidate_index}/frames/{frame_index}/ai-repair")
    def motion_repair(job_id: str, candidate_index: int, frame_index: int, body: MotionRepairBody):
        from .motion_correction import MotionCorrection
        return MotionCorrection(service).manual(job_id,candidate_index,frame_index,body.base_sha256,body.note,phase=body.phase,retry=body.retry,wait=body.wait)

    @app.post("/jobs/{job_id}/motion-review/resume")
    def resume_motion_review(job_id: str):
        from .motion_correction import MotionCorrection
        return _job(MotionCorrection(service).resume(job_id))

    @app.post("/jobs/{job_id}/motion-repairs/{attempt_id}/refresh")
    def refresh_motion_repair(job_id: str, attempt_id: str):
        from .motion_correction import MotionCorrection
        controller=MotionCorrection(service)
        with service.store.operation_lock(job_id,"motion",timeout_seconds=2):
            attempt=controller._attempt(service.get_job(job_id),attempt_id)
            if attempt["mode"]!="manual":
                raise ValidationHarnessError("自动补做由后台处理")
            if attempt["state"]=="reserved":
                controller._advance_attempt(job_id,attempt_id,False)
            return controller._attempt(service.get_job(job_id),attempt_id)

    @app.post("/jobs/{job_id}/motion-repairs/{attempt_id}/adopt")
    def adopt_motion_repair(job_id: str, attempt_id: str):
        from .motion_correction import MotionCorrection
        return _job(MotionCorrection(service).adopt(job_id,attempt_id,manual=True))

    @app.get("/attack-plans")
    def list_attack_plans() -> dict[str, Any]:
        return {"plans": attack_plans.list_plans()}

    @app.post("/attack-plans")
    def create_attack_plan(body: AttackPlanBody) -> dict[str, Any]:
        if not body.keyframes_confirmed:
            raise ValidationHarnessError("请先确认五张关键姿势")
        with tempfile.TemporaryDirectory(prefix="attack-keys-") as directory:
            paths = []
            for index, encoded in enumerate(body.keyframes_base64):
                if len(encoded) > 28 * 1024 * 1024:
                    raise ValidationHarnessError("关键姿势图片过大")
                try:
                    payload = base64.b64decode(encoded, validate=True)
                except (ValueError, binascii.Error) as exc:
                    raise ValidationHarnessError("关键姿势不是有效 base64 图片") from exc
                path = Path(directory) / f"anchor_{index}.png"
                path.write_bytes(payload)
                paths.append(path)
            return attack_plans.create(body.character_id, paths, max_submissions=body.max_submissions)

    @app.get("/attack-plans/{plan_id}")
    def get_attack_plan(plan_id: str) -> dict[str, Any]:
        return attack_plans.load(plan_id)

    @app.post("/attack-plans/{plan_id}/segments/{segment}/generate")
    def submit_attack_segment(plan_id: str, segment: int, body: AttackSubmitBody) -> dict[str, Any]:
        return attack_plans.submit(plan_id, segment, retry=body.retry, reason=body.reason)

    @app.post("/attack-plans/{plan_id}/segments/{segment}/refresh")
    def refresh_attack_segment(plan_id: str, segment: int) -> dict[str, Any]:
        return attack_plans.refresh(plan_id, segment)

    @app.get("/attack-plans/{plan_id}/segments/{segment}/review")
    def get_attack_review(plan_id: str, segment: int) -> dict[str, Any]:
        plan = attack_plans.load(plan_id)
        job_id, paths = attack_plans.frames(plan, segment)
        return {"job_id": job_id, "token": attack_plans.review_token(plan, segment),
                "frames_base64": [base64.b64encode(p.read_bytes()).decode("ascii") for p in paths]}

    @app.post("/attack-plans/{plan_id}/segments/{segment}/accept")
    def accept_attack_segment(plan_id: str, segment: int, body: AttackAcceptBody) -> dict[str, Any]:
        return attack_plans.accept(plan_id, segment, **body.model_dump())

    @app.post("/attack-plans/{plan_id}/assemble")
    def assemble_attack_plan(plan_id: str) -> dict[str, Any]:
        return attack_plans.assemble(plan_id)

    @app.post("/attack-plans/{plan_id}/stop")
    def stop_attack_plan(plan_id: str) -> dict[str, Any]:
        return attack_plans.stop(plan_id)

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {
            "schema_version": 1,
            "ok": True,
            "version": "0.1.0",
            "workbench_api_version": 1,
            "pixellab_configured": bool(service.settings.pixellab_api_key),
            "attack_extra_generation_limit": 2,
            "data_root": str(service.settings.data_root),
            "recovery_worker": recovery_worker.snapshot(),
        }

    @app.get("/v1/system/storage")
    def storage_status() -> dict[str, Any]:
        return {"schema_version": 1, "ok": True, "data": service.storage_status()}

    @app.get("/v1/account/balance")
    def account_balance(refresh: bool = True) -> dict[str, Any]:
        snapshot = (
            service.refresh_pixellab_balance()
            if refresh
            else service.get_cached_balance()
        )
        return {"schema_version": 1, "ok": True, "data": {"balance": snapshot}}

    @app.get("/v1/account/estimate")
    def account_estimate(
        character_id: str,
        action_id: str,
        candidate_count: int = 1,
    ) -> dict[str, Any]:
        estimate = service.estimate_pixellab_generation_units(
            character_id,
            action_id,
            candidate_count=candidate_count,
        )
        return {"schema_version": 1, "ok": True, "data": {"estimate": estimate}}

    @app.post("/v1/recovery/run")
    def run_recovery() -> dict[str, Any]:
        return {
            "schema_version": 1,
            "ok": True,
            "data": {"recovery": service.recover_pending_jobs()},
        }

    @app.get("/v1/recovery/status")
    def recovery_status() -> dict[str, Any]:
        return {
            "schema_version": 1,
            "ok": True,
            "data": {"worker": recovery_worker.snapshot()},
        }

    @app.get("/v1/presets")
    def list_presets() -> dict[str, Any]:
        return {"schema_version": 1, "ok": True, "data": service.list_presets()}

    @app.get("/v1/jobs")
    def list_jobs() -> dict[str, Any]:
        return {"schema_version": 1, "ok": True, "data": {"jobs": service.list_jobs()}}

    @app.delete("/v1/history")
    def clear_history(check: bool = False):
        return service.archive_history(check_only=check)

    @app.post("/v1/jobs", status_code=201)
    def create_job(
        body: GenerationRequest,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> dict[str, Any]:
        if idempotency_key is not None:
            normalized_key = idempotency_key.strip()
            if not normalized_key:
                raise ValidationHarnessError("Idempotency-Key cannot be blank")
            if body.request_key and body.request_key != normalized_key:
                raise ConflictError(
                    "body request_key and Idempotency-Key header do not match"
                )
            body = GenerationRequest.model_validate(
                {
                    **body.model_dump(mode="python"),
                    "request_key": normalized_key,
                }
            )
        return {"schema_version": 1, "ok": True, "data": {"job": _job(service.create_job(body))}}

    @app.get("/v1/jobs/{job_id}")
    def get_job(job_id: str) -> dict[str, Any]:
        return {"schema_version": 1, "ok": True, "data": {"job": _job(service.get_job(job_id))}}

    def job_at_revision(job_id: str, revision: int | None) -> JobRecord:
        current = service.get_job(job_id)
        if revision is None or current.revision == revision:
            return current
        history = service.store.resolve_job_path(job_id, f"history/job_{revision:08d}.json")
        if not history.is_file():
            raise NotFoundError("requested job revision not found", details={"job_id": job_id, "revision": revision})
        previous = JobRecord.model_validate(read_json(history))
        if previous.job_id != job_id or previous.revision != revision:
            raise ConflictError("job revision identity does not match its record")
        return previous

    def bound_artifact(artifact: Path, media_type: str, digest: str | None, expected: str | None):
        if expected is not None and expected != digest:
            raise ConflictError("artifact SHA-256 does not match the selected job revision")
        try:
            content = artifact.read_bytes()
        except FileNotFoundError as exc:
            raise NotFoundError("artifact for the selected job revision is unavailable") from exc
        if digest is not None and hashlib.sha256(content).hexdigest() != digest:
            raise ConflictError("artifact bytes differ from the selected job revision")
        return Response(content, media_type=media_type, headers={"Cache-Control": "no-store"})

    @app.get("/v1/jobs/{job_id}/candidates/{candidate_index}/frames/{frame_index}/image", response_model=None)
    def frame_image(job_id: str, candidate_index: int, frame_index: int,
                    revision: int | None = Query(None, ge=0),
                    expected_sha256: str | None = Query(None, pattern=r"^[0-9a-f]{64}$")):
        job = job_at_revision(job_id, revision)
        candidate = next(
            (item for item in job.candidates if item.candidate_index == candidate_index),
            None,
        )
        if candidate is None:
            raise NotFoundError(
                "candidate not found",
                details={"job_id": job_id, "candidate_index": candidate_index},
            )
        frame = next((item for item in candidate.frames if item.index == frame_index), None)
        if frame is None:
            raise NotFoundError(
                "frame not found",
                details={
                    "job_id": job_id,
                    "candidate_index": candidate_index,
                    "frame_index": frame_index,
                },
            )
        artifact = service.store.resolve_job_path(job_id, frame.active_path)
        if revision is not None or expected_sha256 is not None:
            return bound_artifact(artifact, "image/png", frame.sha256, expected_sha256)
        if not artifact.is_file():
            raise NotFoundError("frame artifact not found", details={"path": frame.active_path})
        return FileResponse(
            artifact,
            media_type="image/png",
            filename=f"{job_id}_candidate_{candidate_index:02d}_frame_{frame_index:03d}.png",
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/v1/jobs/{job_id}/exports/{artifact_name}", response_model=None)
    def export_artifact(job_id: str, artifact_name: str,
                        revision: int | None = Query(None, ge=0),
                        expected_sha256: str | None = Query(None, pattern=r"^[0-9a-f]{64}$")):
        job = job_at_revision(job_id, revision)
        if job.export is None:
            raise NotFoundError("job has not been exported", details={"job_id": job_id})
        fields = {
            "sheet": ("sheet_path", "image/png"),
            "preview": ("preview_path", "image/gif"),
            "recipe": ("recipe_path", "application/json"),
            "qa": ("qa_path", "application/json"),
            "godot": ("godot_package_path", "application/zip"),
        }
        field = fields.get(artifact_name)
        if field is None:
            raise NotFoundError(
                "export artifact not found",
                details={"job_id": job_id, "artifact": artifact_name},
            )
        recorded_path = getattr(job.export, field[0])
        if not recorded_path:
            raise NotFoundError("this historical export has no Godot package", details={"artifact": artifact_name})
        if revision is not None or expected_sha256 is not None:
            digest = {"sheet": job.export.sha256, "preview": job.export.preview_sha256,
                      "godot": job.export.godot_sha256}.get(artifact_name)
            immutable = job.export.immutable_artifacts.get(artifact_name)
            if immutable:
                return bound_artifact(service.store.resolve_job_path(job_id, immutable), field[1], digest, expected_sha256)
            # Old export receipts used shared destination names and did not
            # record a preview hash. Only the current export can serve such bytes.
            if digest is None and service.get_job(job_id).export != job.export:
                raise ConflictError("unhashed historical export artifact has been superseded")
        artifact = service.settings.resolve_record_path(recorded_path)
        exports_root = service.settings.exports_dir.resolve()
        try:
            artifact.relative_to(exports_root)
        except ValueError as exc:
            raise ValidationHarnessError(
                "export artifact escaped the configured exports directory",
                details={"artifact": artifact_name},
            ) from exc
        if revision is not None or expected_sha256 is not None:
            return bound_artifact(artifact, field[1], digest, expected_sha256)
        if not artifact.is_file():
            raise NotFoundError(
                "export artifact file not found",
                details={"artifact": artifact_name},
            )
        return FileResponse(
            artifact,
            media_type=field[1],
            filename=artifact.name,
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/v1/jobs/{job_id}/candidates/{candidate_index}/safety")
    def candidate_safety(job_id: str, candidate_index: int) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "ok": True,
            "data": {"safety": service.candidate_safety(job_id, candidate_index)},
        }

    @app.post("/v1/jobs/{job_id}/generate")
    def generate(job_id: str, body: GenerateBody) -> dict[str, Any]:
        try:
            job = service.generate_job(job_id, wait=body.wait, candidate_index=body.candidate_index)
        except ValidationHarnessError:
            job = service.get_job(job_id)
            if job.status.value != "not_submitted":
                raise
        return {"schema_version": 1, "ok": True, "data": {"job": _job(job)}}

    @app.post("/v1/jobs/{job_id}/candidates/{candidate_index}/recover")
    def recover(job_id: str, candidate_index: int) -> dict[str, Any]:
        job = service.recover_completed_candidate(job_id, candidate_index)
        return {"schema_version": 1, "ok": True, "data": {"job": _job(job)}}

    @app.post("/v1/jobs/{job_id}/candidates/{candidate_index}/attach-provider-job")
    def attach_provider_job(
        job_id: str,
        candidate_index: int,
        body: AttachProviderJobBody,
    ) -> dict[str, Any]:
        job = service.attach_provider_job_id(
            job_id,
            candidate_index,
            body.provider_job_id,
        )
        return {"schema_version": 1, "ok": True, "data": {"job": _job(job)}}

    @app.post("/v1/jobs/{job_id}/candidates/{candidate_index}/frames")
    def ingest_frames(job_id: str, candidate_index: int, body: FramesBody) -> dict[str, Any]:
        job = service.ingest_candidate_base64(job_id, candidate_index, body.frames)
        return {"schema_version": 1, "ok": True, "data": {"job": _job(job)}}

    @app.post("/v1/jobs/{job_id}/candidates/{candidate_index}/check")
    def check(job_id: str, candidate_index: int) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "ok": True,
            "data": {"job": _job(service.check_candidate(job_id, candidate_index))},
        }

    @app.post("/v1/jobs/{job_id}/candidates/{candidate_index}/reviews/frame")
    def review_frame(job_id: str, candidate_index: int, body: FrameReviewRequest) -> dict[str, Any]:
        job = service.review_frame(job_id, candidate_index, body)
        return {"schema_version": 1, "ok": True, "data": {"job": _job(job)}}

    @app.post("/v1/jobs/{job_id}/candidates/{candidate_index}/approve")
    def approve(job_id: str, candidate_index: int, body: ApproveBody) -> dict[str, Any]:
        job = service.approve_candidate(
            job_id,
            candidate_index,
            reviewer=body.reviewer,
            acknowledge_warnings=body.acknowledge_warnings,
            review_note=body.review_note,
        )
        return {"schema_version": 1, "ok": True, "data": {"job": _job(job)}}

    @app.post("/v1/jobs/{job_id}/candidates/{candidate_index}/reject")
    def reject(job_id: str, candidate_index: int, body: RejectBody) -> dict[str, Any]:
        job = service.reject_candidate(job_id, candidate_index, reviewer=body.reviewer, note=body.note)
        return {"schema_version": 1, "ok": True, "data": {"job": _job(job)}}

    @app.post("/v1/jobs/{job_id}/candidates/{candidate_index}/frames/{frame_index}/replace")
    def replace_frame(
        job_id: str,
        candidate_index: int,
        frame_index: int,
        body: ReplacementBody,
    ) -> dict[str, Any]:
        encoded = body.png_base64.split(",", 1)[1] if body.png_base64.startswith("data:") and "," in body.png_base64 else body.png_base64
        max_encoded = ((service.settings.max_download_bytes + 2) // 3) * 4 + 16
        if len(encoded) > max_encoded:
            raise ValidationHarnessError("replacement base64 exceeds configured size limit")
        try:
            payload = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValidationHarnessError("invalid replacement base64") from exc
        if len(payload) > service.settings.max_download_bytes or not payload.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValidationHarnessError("replacement must be a bounded PNG")
        with tempfile.TemporaryDirectory(prefix="replacement_", dir=service.store.job_dir(job_id) / "input") as temp_name:
            path = Path(temp_name) / "replacement.png"
            path.write_bytes(payload)
            job = service.replace_frame(
                job_id,
                candidate_index,
                frame_index,
                path,
                base_sha256=body.base_sha256,
            )
        return {"schema_version": 1, "ok": True, "data": {"job": _job(job)}}

    @app.get("/v1/jobs/{job_id}/candidates/{candidate_index}/frames/{frame_index}/pixel-edit")
    def get_pixel_edit_session(
        job_id: str,
        candidate_index: int,
        frame_index: int,
    ) -> dict[str, Any]:
        session = service.get_frame_edit_session(job_id, candidate_index, frame_index)
        rgba = session.pop("rgba")
        session["rgba_base64"] = base64.b64encode(rgba).decode("ascii")
        for neighbour in session["neighbors"].values():
            if neighbour is None:
                continue
            neighbour_rgba = neighbour.pop("rgba")
            neighbour["rgba_base64"] = base64.b64encode(neighbour_rgba).decode("ascii")
        return {"schema_version": 1, "ok": True, "data": {"session": session}}

    @app.post("/v1/jobs/{job_id}/candidates/{candidate_index}/frames/{frame_index}/pixel-edit")
    def save_pixel_edit(
        job_id: str,
        candidate_index: int,
        frame_index: int,
        body: PixelEditBody,
    ) -> dict[str, Any]:
        try:
            rgba = base64.b64decode(body.rgba_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValidationHarnessError("invalid pixel edit RGBA base64") from exc
        expected_bytes = body.width * body.height * 4
        if len(rgba) != expected_bytes:
            raise ValidationHarnessError(
                "pixel edit RGBA byte count is invalid",
                details={"actual": len(rgba), "expected": expected_bytes},
            )
        job = service.edit_frame_pixels(
            job_id,
            candidate_index,
            frame_index,
            rgba=rgba,
            width=body.width,
            height=body.height,
            base_sha256=body.base_sha256,
            reviewer=body.reviewer,
        )
        candidate = next(item for item in job.candidates if item.candidate_index == candidate_index)
        frame = next(item for item in candidate.frames if item.index == frame_index)
        qa_error = candidate.error
        qa_completed = bool(
            candidate.qa_completed_at is not None
            and candidate.qa_input_sha256
            and candidate.qa_algorithm_version == QA_ALGORITHM_VERSION
            and qa_error is None
        )
        return {
            "schema_version": 1,
            "ok": True,
            "data": {
                "job": _job(job),
                "edit": {
                    "saved": True,
                    "frame_index": frame.index,
                    "sha256": frame.sha256,
                    "manual_edit_versions": frame.manual_edit_versions,
                    "review_status": frame.review_status.value,
                    "qa": {
                        "ok": qa_completed,
                        "completed": qa_completed,
                        "candidate_status": candidate.status.value,
                        "hard_failure_count": len(candidate.hard_failures),
                        "warning_count": len(candidate.warnings),
                        "error": qa_error,
                    },
                },
            },
        }

    @app.post("/v1/jobs/{job_id}/candidates/{candidate_index}/export")
    def export(job_id: str, candidate_index: int, body: ExportOptions) -> dict[str, Any]:
        job = service.export_candidate(job_id, candidate_index, body)
        return {"schema_version": 1, "ok": True, "data": {"job": _job(job)}}

    return app


def run_api(
    *,
    root: str | Path | None = None,
    host: str = "127.0.0.1",
    port: int = 8765,
) -> None:
    try:
        import uvicorn
    except ImportError as exc:  # pragma: no cover - depends on optional install
        raise ProviderConfigurationError(
            "REST API server requires uvicorn; install requirements.txt",
            details={"dependency": "uvicorn"},
        ) from exc
    uvicorn.run(create_api(root), host=host, port=port)
