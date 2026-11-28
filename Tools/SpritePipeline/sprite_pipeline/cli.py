from __future__ import annotations

import argparse
from importlib.util import find_spec
import json
import sys
from pathlib import Path
from typing import Any, Sequence

from pydantic import ValidationError

from .errors import HarnessError, ValidationHarnessError
from .jsonio import read_json
from .models import (
    CommandResult,
    ExportOptions,
    FrameReviewRequest,
    GenerationRequest,
    IssueType,
    ReviewStatus,
)
from .service import SpritePipelineService


class _ArgumentParseError(Exception):
    pass


class _JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise _ArgumentParseError(message)


def _parser() -> argparse.ArgumentParser:
    parser = _JsonArgumentParser(
        prog="sprite-harness",
        description="Pixel sprite generation, QA, review, and deterministic export harness.",
    )
    parser.add_argument(
        "--root",
        help="Explicit portable/test root. Omit for separated per-user application data.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list-presets", help="List character and action presets.")
    sub.add_parser("list-jobs", help="List lightweight saved-job summaries.")

    create = sub.add_parser("create", help="Create a durable generation/import job.")
    create.add_argument("--request", type=Path, help="GenerationRequest JSON file.")
    create.add_argument("--character")
    create.add_argument("--action")
    create.add_argument("--provider", choices=("pixellab", "fixture", "import"), default="pixellab")
    create.add_argument("--candidates", type=int, default=1)
    create.add_argument("--seed", type=int)
    create.add_argument("--frames", type=int)
    create.add_argument("--action-description")
    create.add_argument("--loop", action=argparse.BooleanOptionalAction, default=None)
    create.add_argument(
        "--request-key",
        help="Stable idempotency key; repeating it returns the original job instead of creating another.",
    )

    generate = sub.add_parser("generate", help="Submit/poll provider candidates serially.")
    generate.add_argument("--job", required=True)
    generate.add_argument("--candidate", type=int)
    generate.add_argument("--no-wait", action="store_true", help="Advance one submit/poll step and return.")

    recover = sub.add_parser(
        "recover",
        help="Poll an existing PixelLab candidate without submitting a new generation.",
    )
    recover.add_argument("--job", required=True)
    recover.add_argument("--candidate", type=int, required=True)

    recover_all = sub.add_parser(
        "recover-all",
        help="Safely poll/resume every durable job without repeating a chargeable submission.",
    )

    attach = sub.add_parser(
        "attach-provider-job",
        help="Attach a known PixelLab job ID after an ambiguous submission; never submits.",
    )
    attach.add_argument("--job", required=True)
    attach.add_argument("--candidate", type=int, required=True)
    attach.add_argument("--provider-job-id", required=True)

    sub.add_parser("balance", help="Refresh and persist the PixelLab account balance.")
    estimate = sub.add_parser(
        "estimate",
        help="Estimate PixelLab generation units without submitting.",
    )
    estimate.add_argument("--character", required=True)
    estimate.add_argument("--action", required=True)
    estimate.add_argument("--candidates", type=int, default=1)
    sub.add_parser("storage-status", help="Show separated data paths and migration status.")

    status = sub.add_parser("status", help="Return the complete durable job record.")
    status.add_argument("--job", required=True)

    safety = sub.add_parser(
        "safety",
        help="Return compact submission and result-integrity status for one candidate.",
    )
    safety.add_argument("--job", required=True)
    safety.add_argument("--candidate", type=int, required=True)

    ingest = sub.add_parser("ingest", help="Import a PNG directory, GIF, or sprite sheet candidate.")
    ingest.add_argument("--job", required=True)
    ingest.add_argument("--candidate", type=int, required=True)
    ingest.add_argument("--source", type=Path, required=True)
    ingest.add_argument("--kind", choices=("auto", "png_dir", "directory", "gif", "sheet"), default="auto")
    ingest.add_argument("--columns", type=int)

    check = sub.add_parser("check", help="Re-run deterministic QA and previews.")
    check.add_argument("--job", required=True)
    check.add_argument("--candidate", type=int, required=True)

    review = sub.add_parser("review-frame", help="Approve, reject, or request repair for one frame.")
    review.add_argument("--job", required=True)
    review.add_argument("--candidate", type=int, required=True)
    review.add_argument("--frame", type=int, required=True)
    review.add_argument(
        "--status",
        required=True,
        choices=(ReviewStatus.approved.value, ReviewStatus.repair_requested.value, ReviewStatus.rejected.value),
    )
    review.add_argument("--issue", choices=tuple(item.value for item in IssueType))
    review.add_argument("--note", default="")
    review.add_argument("--reviewer", default="codex")

    approve = sub.add_parser("approve", help="Approve every frame after QA.")
    approve.add_argument("--job", required=True)
    approve.add_argument("--candidate", type=int, required=True)
    approve.add_argument("--reviewer", default="codex")
    approve.add_argument("--acknowledge-warnings", action="store_true")

    reject = sub.add_parser("reject", help="Reject one candidate.")
    reject.add_argument("--job", required=True)
    reject.add_argument("--candidate", type=int, required=True)
    reject.add_argument("--reviewer", default="codex")
    reject.add_argument("--note", default="")

    replace = sub.add_parser("replace-frame", help="Add a repaired frame version and re-run QA.")
    replace.add_argument("--job", required=True)
    replace.add_argument("--candidate", type=int, required=True)
    replace.add_argument("--frame", type=int, required=True)
    replace.add_argument("--source", type=Path, required=True)
    replace.add_argument(
        "--base-sha256",
        required=True,
        help="SHA-256 returned when the source frame was selected; prevents stale overwrites.",
    )

    pixel_edit = sub.add_parser(
        "pixel-edit-frame",
        help="Commit a lossless local PNG as an unlimited manual pixel-edit version.",
    )
    pixel_edit.add_argument("--job", required=True)
    pixel_edit.add_argument("--candidate", type=int, required=True)
    pixel_edit.add_argument("--frame", type=int, required=True)
    pixel_edit.add_argument("--source", type=Path, required=True)
    pixel_edit.add_argument(
        "--base-sha256",
        required=True,
        help="SHA-256 returned when the source frame was read; prevents stale overwrites.",
    )
    pixel_edit.add_argument("--reviewer", default="codex")

    export = sub.add_parser("export", help="Export an explicitly approved candidate.")
    export.add_argument("--job", required=True)
    export.add_argument("--candidate", type=int, required=True)
    export.add_argument("--columns", type=int)
    export.add_argument("--filename", help="Plain .png filename for the exported sprite sheet.")
    export.add_argument("--overwrite", action="store_true")

    api = sub.add_parser("serve-api", help="Run the local REST API on loopback by default.")
    api.add_argument("--host", default="127.0.0.1")
    api.add_argument("--port", type=int, default=8765)

    ui = sub.add_parser("serve-ui", help="Run the project-guided Gradio operator UI.")
    ui.add_argument("--host", default="127.0.0.1")
    ui.add_argument("--port", type=int, default=7860)
    auto = sub.add_parser("serve", help="Start the installed service with the operator UI when available.")
    auto.add_argument("--host", default="127.0.0.1")
    auto.add_argument("--port", type=int, default=7860)
    return parser


def _job_data(job: Any) -> dict[str, Any]:
    return job.model_dump(mode="json")


def _execute(args: argparse.Namespace) -> CommandResult | None:
    command = args.command
    if command == "serve":
        command = "serve-ui" if find_spec("gradio") is not None else "serve-api"
    if command == "serve-api":
        from .api_app import run_api

        run_api(root=args.root, host=args.host, port=args.port)
        return None
    if command == "serve-ui":
        from .ui import run_ui

        run_ui(root=args.root, host=args.host, port=args.port)
        return None
    service = SpritePipelineService(args.root)
    if command == "list-presets":
        return CommandResult(operation=command, data=service.list_presets())
    if command == "list-jobs":
        return CommandResult(operation=command, data={"jobs": service.list_jobs()})
    if command == "create":
        if args.request:
            request = GenerationRequest.model_validate(read_json(args.request.resolve()))
            if args.request_key:
                request = GenerationRequest.model_validate(
                    {
                        **request.model_dump(mode="python"),
                        "request_key": args.request_key,
                    }
                )
        else:
            if not args.character or not args.action:
                raise ValidationHarnessError("create requires --character and --action unless --request is used")
            request = GenerationRequest(
                character_id=args.character,
                action_id=args.action,
                provider=args.provider,
                candidate_count=args.candidates,
                seed=args.seed,
                frame_count=args.frames,
                action_description=args.action_description,
                loop=args.loop,
                request_key=args.request_key,
            )
        job = service.create_job(request)
        return CommandResult(operation=command, data={"job": _job_data(job)})
    if command == "generate":
        job = service.generate_job(args.job, wait=not args.no_wait, candidate_index=args.candidate)
        return CommandResult(operation=command, data={"job": _job_data(job)})
    if command == "recover":
        job = service.recover_completed_candidate(args.job, args.candidate)
        return CommandResult(operation=command, data={"job": _job_data(job)})
    if command == "recover-all":
        return CommandResult(operation=command, data={"recovery": service.recover_pending_jobs()})
    if command == "attach-provider-job":
        job = service.attach_provider_job_id(
            args.job,
            args.candidate,
            args.provider_job_id,
        )
        return CommandResult(operation=command, data={"job": _job_data(job)})
    if command == "balance":
        return CommandResult(operation=command, data={"balance": service.refresh_pixellab_balance()})
    if command == "estimate":
        return CommandResult(
            operation=command,
            data={
                "estimate": service.estimate_pixellab_generation_units(
                    args.character,
                    args.action,
                    candidate_count=args.candidates,
                )
            },
        )
    if command == "storage-status":
        return CommandResult(operation=command, data=service.storage_status())
    if command == "status":
        return CommandResult(operation=command, data={"job": _job_data(service.get_job(args.job))})
    if command == "safety":
        return CommandResult(
            operation=command,
            data={"safety": service.candidate_safety(args.job, args.candidate)},
        )
    if command == "ingest":
        job = service.ingest_candidate(
            args.job,
            args.candidate,
            args.source,
            source_kind=args.kind,
            columns=args.columns,
        )
        return CommandResult(operation=command, data={"job": _job_data(job)})
    if command == "check":
        job = service.check_candidate(args.job, args.candidate)
        return CommandResult(operation=command, data={"job": _job_data(job)})
    if command == "review-frame":
        review = FrameReviewRequest(
            frame_index=args.frame,
            status=args.status,
            issue_type=args.issue,
            note=args.note,
            reviewer=args.reviewer,
        )
        job = service.review_frame(args.job, args.candidate, review)
        return CommandResult(operation=command, data={"job": _job_data(job)})
    if command == "approve":
        job = service.approve_candidate(
            args.job,
            args.candidate,
            reviewer=args.reviewer,
            acknowledge_warnings=args.acknowledge_warnings,
        )
        return CommandResult(operation=command, data={"job": _job_data(job)})
    if command == "reject":
        job = service.reject_candidate(args.job, args.candidate, reviewer=args.reviewer, note=args.note)
        return CommandResult(operation=command, data={"job": _job_data(job)})
    if command == "replace-frame":
        job = service.replace_frame(
            args.job,
            args.candidate,
            args.frame,
            args.source,
            base_sha256=args.base_sha256,
        )
        return CommandResult(operation=command, data={"job": _job_data(job)})
    if command == "pixel-edit-frame":
        job = service.edit_frame_png(
            args.job,
            args.candidate,
            args.frame,
            args.source,
            base_sha256=args.base_sha256,
            reviewer=args.reviewer,
        )
        return CommandResult(operation=command, data={"job": _job_data(job)})
    if command == "export":
        job = service.export_candidate(
            args.job,
            args.candidate,
            ExportOptions(columns=args.columns, filename=args.filename, overwrite=args.overwrite),
        )
        return CommandResult(operation=command, data={"job": _job_data(job)})
    raise ValidationHarnessError("unknown command", details={"command": command})


def _emit(payload: dict[str, Any], *, stream: Any = sys.stdout) -> None:
    if hasattr(stream, "reconfigure") and getattr(stream, "encoding", "").lower() not in ("utf-8", "utf8"):
        stream.reconfigure(encoding="utf-8")
    json.dump(payload, stream, ensure_ascii=False, sort_keys=True)
    stream.write("\n")
    stream.flush()


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    try:
        args = parser.parse_args(argv)
    except _ArgumentParseError as exc:
        _emit(
            {
                "schema_version": 1,
                "ok": False,
                "operation": "parse",
                "error": {"code": "argument_error", "message": str(exc), "details": {}},
            }
        )
        return 2
    try:
        result = _execute(args)
        if result is not None:
            _emit(result.model_dump(mode="json"))
        return 0
    except HarnessError as exc:
        _emit({"schema_version": 1, "ok": False, "operation": args.command, "error": exc.as_dict()})
        return 2
    except ValidationError as exc:
        _emit(
            {
                "schema_version": 1,
                "ok": False,
                "operation": args.command,
                "error": {"code": "validation_error", "message": "input validation failed", "details": {"errors": exc.errors(include_url=False)}},
            }
        )
        return 2
    except (OSError, ValueError) as exc:
        _emit(
            {
                "schema_version": 1,
                "ok": False,
                "operation": args.command,
                "error": {"code": "operation_error", "message": str(exc), "details": {"type": type(exc).__name__}},
            }
        )
        return 1
    except Exception as exc:  # Keep the Codex contract machine-readable on unexpected failures.
        _emit(
            {
                "schema_version": 1,
                "ok": False,
                "operation": args.command,
                "error": {
                    "code": "internal_error",
                    "message": "unexpected harness failure",
                    "details": {"type": type(exc).__name__, "message": str(exc)},
                },
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
