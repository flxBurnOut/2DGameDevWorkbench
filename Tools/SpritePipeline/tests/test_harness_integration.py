from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import contextmanager
from unittest.mock import Mock, patch
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from sprite_pipeline.errors import ConflictError, ExportBlockedError, ValidationHarnessError
from sprite_pipeline.models import (
    ActionPreset,
    CandidateStatus,
    CharacterPreset,
    IssueSeverity,
    IssueType,
    JobStatus,
    QAIssue,
    ReviewStatus,
)
from sprite_pipeline.prompts import compose_generation_prompt
from sprite_pipeline.processing import build_overlay, run_frame_qa
from sprite_pipeline.providers.base import (
    PollResult,
    PollStatus,
    ProviderRequest,
    Submission,
    redact_provider_payload,
)
from sprite_pipeline.providers.pixellab import PixelLabProvider
from sprite_pipeline.service import QA_ALGORITHM_VERSION, SpritePipelineService
from sprite_pipeline.store import JobStore


class FakeResponse:
    def __init__(self, payload: dict[str, Any], status_code: int = 200) -> None:
        self.payload = payload
        self.status_code = status_code
        self.content = json.dumps(payload).encode("utf-8")
        self.headers = {"content-type": "application/json"}

    def json(self) -> dict[str, Any]:
        return self.payload


class FakePixelLabClient:
    """Tiny httpx-shaped seam; it never imports httpx or touches the network."""

    def __init__(self, post_response: FakeResponse, get_response: FakeResponse) -> None:
        self.post_response = post_response
        self.get_response = get_response
        self.post_calls: list[tuple[str, dict[str, Any]]] = []
        self.get_calls: list[str] = []

    def post(self, url: str, *, json: dict[str, Any]) -> FakeResponse:
        self.post_calls.append((url, json))
        return self.post_response

    def get(self, url: str) -> FakeResponse:
        self.get_calls.append(url)
        return self.get_response


class BlockingSubmissionProvider:
    """Provider seam that records whether two submissions overlap."""

    name = "pixellab"
    diagnostic_only = False

    def __init__(self) -> None:
        self.release = threading.Event()
        self.first_entered = threading.Event()
        self.parallel_entered = threading.Event()
        self._lock = threading.Lock()
        self._active_submissions = 0
        self.max_active_submissions = 0

    def submit(self, request: ProviderRequest) -> Submission:
        with self._lock:
            self._active_submissions += 1
            self.max_active_submissions = max(
                self.max_active_submissions,
                self._active_submissions,
            )
            self.first_entered.set()
            if self._active_submissions > 1:
                self.parallel_entered.set()
        try:
            if not self.release.wait(timeout=5):
                raise TimeoutError("test did not release the blocked submission")
            provider_job_id = f"blocking-{request.seed}"
            return Submission(
                provider=self.name,
                provider_job_id=provider_job_id,
                status="processing",
                expected_frame_count=request.frame_count,
                expected_size=(64, 64),
                request_record={"provider": self.name, "seed": request.seed},
                raw_response={"background_job_id": provider_job_id, "status": "processing"},
            )
        finally:
            with self._lock:
                self._active_submissions -= 1

    def poll(self, provider_job_id: str) -> PollResult:
        return PollResult(
            provider=self.name,
            provider_job_id=provider_job_id,
            status=PollStatus.pending,
            provider_status="processing",
            raw_response={"status": "processing"},
        )


class CompletingThenFailingPollProvider:
    """Complete the first poll; a duplicate poll deliberately returns failure."""

    name = "pixellab"
    diagnostic_only = False

    def __init__(self, images: list[bytes]) -> None:
        self.images = images
        self.release_first = threading.Event()
        self.first_entered = threading.Event()
        self._lock = threading.Lock()
        self.poll_count = 0

    def poll(self, provider_job_id: str) -> PollResult:
        with self._lock:
            self.poll_count += 1
            poll_number = self.poll_count
        if poll_number == 1:
            self.first_entered.set()
            if not self.release_first.wait(timeout=5):
                raise TimeoutError("test did not release the first poll")
            return PollResult(
                provider=self.name,
                provider_job_id=provider_job_id,
                status=PollStatus.completed,
                provider_status="completed",
                images=self.images,
                raw_response={"status": "completed", "poll_number": poll_number},
            )
        return PollResult(
            provider=self.name,
            provider_job_id=provider_job_id,
            status=PollStatus.failed,
            provider_status="failed",
            raw_response={"status": "failed", "poll_number": poll_number},
            error={
                "code": "duplicate_poll_failure",
                "message": "a duplicate poll must never run",
                "details": {"retryable": False},
            },
        )


class TemporaryHarness:
    """Build the smallest complete 64x64 harness data root used by tests."""

    character_id = "test_hero"
    action_id = "test_move"

    def __init__(self, root: Path) -> None:
        self.root = root
        self.character_dir = root / "presets" / "characters" / self.character_id
        self.action_dir = root / "presets" / "actions"
        self.character_dir.mkdir(parents=True)
        self.action_dir.mkdir(parents=True)
        self.reference_path = self.character_dir / "reference.png"
        self.write_frame(self.reference_path, shift_x=0)
        self._write_json(
            self.character_dir / "character.json",
            {
                "schema_version": 1,
                "character_id": self.character_id,
                "display_name": "Integration Test Hero",
                "cell_width": 64,
                "cell_height": 64,
                "facing": "right",
                "reference_frame": self.reference_path.name,
                "identity_description": "A compact cyan and navy pixel-art test hero.",
                "anchor": {"x": 32, "ground_y": 55},
                "safe_margin": 4,
                "sheet_columns": 4,
                "transparent_background": True,
                "qa": {
                    "duplicate_run_length": 3,
                    "area_change_ratio": 0.35,
                    "centroid_shift_px": 20.0,
                    "palette_mismatch_ratio": 0.35,
                    "palette_distance": 48.0,
                    "loop_difference_ratio": 0.35,
                    "ground_y_tolerance_px": 4,
                    "rigid_translation_tolerance_px": 4,
                    "alpha_visible_threshold": 1,
                },
            },
        )
        self._write_json(
            self.action_dir / f"{self.action_id}.json",
            {
                "schema_version": 1,
                "action_id": self.action_id,
                "display_name": "Test Move",
                "frame_count": 4,
                "fps": 8,
                "loop": False,
                "grounded": True,
                "action_description": "Move through four small, readable pixel-art poses.",
                "locked_constraints": ["Keep the canvas and character identity unchanged."],
            },
        )

    @staticmethod
    def _write_json(path: Path, payload: dict[str, Any]) -> None:
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    @staticmethod
    def write_frame(path: Path, *, shift_x: int, shift_y: int = 0) -> None:
        """Write crisp RGBA pixel art whose opaque bounds stay inside the margin."""

        path.parent.mkdir(parents=True, exist_ok=True)
        image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        x = shift_x
        y = shift_y
        draw.rectangle((27 + x, 18 + y, 36 + x, 27 + y), fill=(84, 238, 226, 255))
        draw.rectangle((25 + x, 28 + y, 38 + x, 49 + y), fill=(24, 70, 128, 255))
        draw.rectangle((23 + x, 31 + y, 24 + x, 43 + y), fill=(84, 238, 226, 255))
        draw.rectangle((39 + x, 31 + y, 40 + x, 43 + y), fill=(84, 238, 226, 255))
        draw.rectangle((27 + x, 50 + y, 30 + x, 55 + y), fill=(19, 35, 67, 255))
        draw.rectangle((33 + x, 50 + y, 36 + x, 55 + y), fill=(19, 35, 67, 255))
        image.save(path, format="PNG", optimize=False, compress_level=9)

    def write_sequence(self, directory: Path, shifts: tuple[int, ...] = (0, 1, 2, 3)) -> list[Path]:
        paths: list[Path] = []
        for index, shift in enumerate(shifts):
            path = directory / f"frame_{index:03d}.png"
            self.write_frame(path, shift_x=shift)
            paths.append(path)
        return paths

    def create_request(self, provider: str) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "character_id": self.character_id,
            "action_id": self.action_id,
            "provider": provider,
            "candidate_count": 1,
            "seed": 0,
        }


class SpritePipelineIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="sprite_harness_integration_")
        self.root = Path(self.temp_dir.name) / "像素_harness"
        self.harness = TemporaryHarness(self.root)
        self.service = SpritePipelineService(self.root)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @staticmethod
    def _candidate(job: Any) -> Any:
        return job.candidates[0]

    def _ingest_clean_candidate(self) -> Any:
        source_dir = self.root / "incoming" / "clean"
        self.harness.write_sequence(source_dir)
        job = self.service.create_job(self.harness.create_request("import"))
        return self.service.ingest_candidate(
            job.job_id,
            1,
            source_dir,
            source_kind="png_dir",
        )

    def _run_cli(self, *arguments: str) -> dict[str, Any]:
        environment = os.environ.copy()
        environment.pop("SPRITE_PIPELINE_HOME", None)
        completed = subprocess.run(
            [sys.executable, "-m", "sprite_pipeline.cli", "--root", str(self.root), *arguments],
            cwd=PROJECT_ROOT,
            env=environment,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
            check=False,
        )
        self.assertEqual(
            completed.returncode,
            0,
            msg=f"CLI failed. stdout={completed.stdout!r} stderr={completed.stderr!r}",
        )
        lines = [line for line in completed.stdout.splitlines() if line.strip()]
        self.assertEqual(len(lines), 1, msg=f"CLI must emit one JSON line: {completed.stdout!r}")
        try:
            payload = json.loads(lines[0])
        except json.JSONDecodeError as exc:
            self.fail(f"CLI output is not JSON: {completed.stdout!r}; {exc}")
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["schema_version"], 1)
        return payload

    def test_character_reference_upload_creates_a_reusable_preset(self) -> None:
        source = self.root / "incoming" / "角色基准图.png"
        self.harness.write_frame(source, shift_x=2)

        created = self.service.create_character_preset(
            display_name="蓝围巾骑士",
            reference_image=source,
            facing="left",
            identity_description="Keep the blue scarf and short sword unchanged.",
        )

        self.assertEqual(created.character_id, "character")
        self.assertEqual(created.display_name, "蓝围巾骑士")
        self.assertEqual(created.facing, "left")
        self.assertEqual((created.cell_width, created.cell_height), (64, 64))
        self.assertGreater(created.anchor.ground_y, 0)
        preset_dir = self.root / "presets" / "characters" / created.character_id
        self.assertTrue((preset_dir / "character.json").is_file())
        self.assertEqual((preset_dir / "idle_reference.png").read_bytes(), source.read_bytes())
        loaded, _path = self.service.presets.load_character(created.character_id)
        self.assertEqual(loaded, created)

        duplicate_name = self.service.create_character_preset(
            display_name="蓝围巾骑士",
            reference_image=source,
        )
        self.assertEqual(duplicate_name.character_id, "character_002")

    def test_character_reference_upload_rejects_wrong_size_and_missing_alpha(self) -> None:
        wrong_size = self.root / "incoming" / "wrong_size.png"
        wrong_size.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGBA", (32, 32), (255, 255, 255, 255)).save(wrong_size, format="PNG")
        with self.assertRaisesRegex(ValidationHarnessError, "64x64 or 128x128"):
            self.service.create_character_preset(display_name="Wrong size", reference_image=wrong_size)

        no_alpha = self.root / "incoming" / "no_alpha.png"
        Image.new("RGB", (64, 64), (255, 255, 255)).save(no_alpha, format="PNG")
        with self.assertRaisesRegex(ValidationHarnessError, "alpha channel"):
            self.service.create_character_preset(display_name="No alpha", reference_image=no_alpha)

    def test_bundled_action_prompts_fit_the_pixellab_limit(self) -> None:
        character_paths = sorted((PROJECT_ROOT / "presets" / "characters").glob("*/character.json"))
        self.assertTrue(character_paths)
        action_paths = sorted((PROJECT_ROOT / "presets" / "actions").glob("*.json"))
        self.assertEqual(len(action_paths), 11)
        for character_path in character_paths:
            character = CharacterPreset.model_validate(
                json.loads(character_path.read_text(encoding="utf-8"))
            )
            for path in action_paths:
                action = ActionPreset.model_validate(json.loads(path.read_text(encoding="utf-8")))
                with self.subTest(character=character.character_id, action=action.action_id):
                    self.assertLessEqual(len(compose_generation_prompt(character, action)), 1000)

    def test_qa_allows_small_consistent_whole_sprite_motion(self) -> None:
        paths = self.harness.write_sequence(
            self.root / "continuous_sequence",
            shifts=(0, 3, 6, 9),
        )
        report = run_frame_qa(
            paths,
            expected_count=4,
            expected_size=(64, 64),
            thresholds={"rigid_translation_tolerance_px": 2},
        )

        hard_codes = [item["code"] for item in report["hard_failures"]]
        self.assertNotIn("frame_position_jump", hard_codes)
        self.assertTrue(report["exportable"])
        self.assertEqual(report["sequence_metrics"]["position_jumps"], [])
        self.assertEqual(
            [item["dx"] for item in report["sequence_metrics"]["rigid_translations"]],
            [3, 3, 3],
        )

    def test_qa_treats_frame_count_difference_as_review_warning(self) -> None:
        paths = self.harness.write_sequence(
            self.root / "five_frame_sequence",
            shifts=(0, 1, 2, 3, 4),
        )
        report = run_frame_qa(
            paths,
            expected_count=4,
            expected_size=(64, 64),
        )

        self.assertTrue(report["exportable"])
        self.assertNotIn(
            "frame_count_mismatch",
            [item["code"] for item in report["hard_failures"]],
        )
        self.assertIn(
            "frame_count_mismatch",
            [item["code"] for item in report["warnings"]],
        )

    def test_qa_blocks_abrupt_whole_sprite_position_jump(self) -> None:
        paths = self.harness.write_sequence(
            self.root / "jumping_sequence",
            shifts=(0, 1, 2, 12),
        )
        report = run_frame_qa(
            paths,
            expected_count=4,
            expected_size=(64, 64),
            thresholds={"rigid_translation_tolerance_px": 2},
        )

        hard_codes = [item["code"] for item in report["hard_failures"]]
        self.assertIn("frame_position_jump", hard_codes)
        self.assertFalse(report["exportable"])
        jumps = report["sequence_metrics"]["position_jumps"]
        self.assertEqual(len(jumps), 1)
        self.assertEqual((jumps[0]["from"], jumps[0]["to"]), (2, 3))
        self.assertEqual((jumps[0]["dx"], jumps[0]["dy"]), (10, 0))

    def test_rigid_position_check_ignores_alpha_below_visibility_threshold(self) -> None:
        paths = self.harness.write_sequence(
            self.root / "low_alpha_noise_sequence",
            shifts=(0, 1, 2, 12),
        )
        for path in paths:
            with Image.open(path) as opened:
                frame = opened.convert("RGBA").copy()
            frame.putpixel((1, 1), (255, 0, 255, 1))
            frame.save(path, format="PNG")

        report = run_frame_qa(
            paths,
            expected_count=4,
            expected_size=(64, 64),
            thresholds={
                "alpha_threshold": 1,
                "rigid_translation_tolerance_px": 2,
                "centroid_jump_pixels": 20,
            },
        )

        self.assertIn(
            "frame_position_jump",
            [item["code"] for item in report["hard_failures"]],
        )
        self.assertTrue(report["sequence_metrics"]["rigid_translations"])
        self.assertFalse(report["exportable"])

    def test_loop_endpoint_difference_ignores_alpha_below_visibility_threshold(self) -> None:
        paths = self.harness.write_sequence(
            self.root / "loop_low_alpha_noise_sequence",
            shifts=(0, 1, 0),
        )
        with Image.open(paths[0]) as opened:
            first = opened.convert("RGBA").copy()
        first.putpixel((1, 1), (255, 0, 255, 1))
        first.save(paths[0], format="PNG")
        with Image.open(paths[-1]) as opened:
            last = opened.convert("RGBA").copy()
        last.putpixel((2, 1), (0, 255, 255, 1))
        last.save(paths[-1], format="PNG")

        report = run_frame_qa(
            paths,
            expected_count=3,
            expected_size=(64, 64),
            loop=True,
            thresholds={
                "alpha_threshold": 1,
                "loop_difference_ratio": 0,
            },
        )

        self.assertEqual(
            report["sequence_metrics"]["loop"]["different_pixels"],
            0,
        )
        self.assertNotIn(
            "loop_endpoint_difference",
            [item["code"] for item in report["warnings"]],
        )

    def test_loop_qa_checks_last_to_first_position_and_velocity(self) -> None:
        paths = self.harness.write_sequence(
            self.root / "loop_boundary_sequence",
            shifts=(0, 1, 2, 3),
        )
        report = run_frame_qa(
            paths,
            expected_count=4,
            expected_size=(64, 64),
            thresholds={
                "rigid_translation_tolerance_px": 2,
                "centroid_jump_pixels": 2,
            },
            loop=True,
        )

        rigid_pairs = [
            (item["from"], item["to"])
            for item in report["sequence_metrics"]["rigid_translations"]
        ]
        centroid_pairs = [
            (item["from"], item["to"])
            for item in report["sequence_metrics"]["centroid_pairs"]
        ]
        self.assertIn((3, 0), rigid_pairs)
        self.assertIn((3, 0), centroid_pairs)
        self.assertTrue(
            any(
                item["from"] == 3 and item["to"] == 0
                for item in report["sequence_metrics"]["position_jumps"]
            )
        )
        self.assertTrue(
            any(
                item["code"] == "centroid_jump" and item.get("previous_frame") == 3
                for item in report["warnings"]
            )
        )
        self.assertTrue(
            any(
                item["at"] == 0 and item["to"] == 1
                for item in report["sequence_metrics"]["centroid_velocity_changes"]
            )
        )
        self.assertTrue(
            any(
                item["code"] == "centroid_velocity_jump"
                and item.get("loop_boundary") is True
                for item in report["warnings"]
            )
        )
        self.assertTrue(
            any(item.get("loop_boundary") is True for item in report["hard_failures"])
        )
        self.assertFalse(report["exportable"])

    def test_overlay_compares_each_frame_with_its_immediate_predecessor(self) -> None:
        paths = self.harness.write_sequence(
            self.root / "overlay_sequence",
            shifts=(0, 1, 2, 3),
        )
        output = self.root / "adjacent_overlay.png"

        metadata = build_overlay(paths, output, scale=2, columns=2)

        self.assertEqual(metadata["comparison_mode"], "adjacent_frames")
        self.assertEqual(metadata["pairs"], [[0, 0], [0, 1], [1, 2], [2, 3]])
        self.assertFalse(metadata["loop"])
        self.assertTrue(output.is_file())

        loop_output = self.root / "adjacent_overlay_loop.png"
        loop_metadata = build_overlay(paths, loop_output, scale=2, columns=2, loop=True)
        self.assertEqual(loop_metadata["pairs"], [[3, 0], [0, 1], [1, 2], [2, 3]])
        self.assertTrue(loop_metadata["loop"])
        self.assertTrue(loop_output.is_file())

    def test_fixture_create_generate_qa_approve_and_export(self) -> None:
        created = self.service.create_job(self.harness.create_request("fixture"))
        self.assertEqual(created.status, JobStatus.created)
        self.assertEqual(self._candidate(created).status, CandidateStatus.created)

        generated = self.service.generate_job(created.job_id)
        candidate = self._candidate(generated)
        self.assertEqual(candidate.status, CandidateStatus.review_ready)
        self.assertEqual(candidate.provider_name, "fixture")
        self.assertEqual(candidate.provider_model, "diagnostic-continuity-v2")
        self.assertEqual(len(candidate.frames), 4)
        self.assertEqual(candidate.hard_failures, [])
        self.assertTrue(any(event["event"] == "candidate_checked" for event in generated.events))

        alpha_boxes: list[tuple[int, int, int, int] | None] = []
        alpha_masks: list[bytes] = []
        frame_pixels: list[bytes] = []
        for frame in candidate.frames:
            frame_path = self.service.store.resolve_job_path(generated.job_id, frame.active_path)
            with Image.open(frame_path) as opened:
                rgba = opened.convert("RGBA")
                alpha_boxes.append(rgba.getchannel("A").getbbox())
                alpha_masks.append(rgba.getchannel("A").tobytes())
                frame_pixels.append(rgba.tobytes())
        self.assertEqual(len(set(alpha_boxes)), 1)
        self.assertEqual(len(set(alpha_masks)), 1)
        self.assertEqual(len(set(frame_pixels)), 4)

        job_dir = self.service.store.job_dir(created.job_id)
        for suffix in ("sheet.png", "preview.gif", "zoom.gif", "grid.png", "baseline.png", "overlay.png"):
            self.assertTrue((job_dir / "previews" / f"candidate_01.{suffix}").is_file())
        with self.assertRaises(ExportBlockedError):
            self.service.export_candidate(created.job_id, 1)

        approved = self.service.approve_candidate(
            created.job_id,
            1,
            reviewer="integration-test",
            acknowledge_warnings=True,
        )
        self.assertEqual(approved.status, JobStatus.approved)
        self.assertTrue(
            all(frame.review_status == ReviewStatus.approved for frame in self._candidate(approved).frames)
        )

        exported = self.service.export_candidate(created.job_id, 1)
        self.assertEqual(exported.status, JobStatus.exported)
        self.assertIsNotNone(exported.export)
        assert exported.export is not None
        sheet_path = self.root / exported.export.sheet_path
        recipe_path = self.root / exported.export.recipe_path
        qa_path = self.root / exported.export.qa_path
        preview_path = self.root / exported.export.preview_path
        self.assertTrue(all(path.is_file() for path in (sheet_path, recipe_path, qa_path, preview_path)))
        with Image.open(sheet_path) as sheet:
            self.assertEqual(sheet.format, "PNG")
            self.assertEqual(sheet.mode, "RGBA")
            self.assertEqual(sheet.size, (256, 64))
        recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
        self.assertEqual(recipe["frame_order"], [0, 1, 2, 3])
        self.assertEqual(recipe["frame_count"], 4)
        self.assertEqual(recipe["cell_width"], 64)
        self.assertEqual(recipe["cell_height"], 64)

        from fastapi.testclient import TestClient

        from sprite_pipeline.api_app import create_api

        with TestClient(create_api(self.root)) as client:
            sheet_artifact = client.get(f"/v1/jobs/{created.job_id}/exports/sheet")
            preview_artifact = client.get(f"/v1/jobs/{created.job_id}/exports/preview")
            self.assertEqual(sheet_artifact.status_code, 200, sheet_artifact.text)
            self.assertEqual(sheet_artifact.headers["content-type"], "image/png")
            self.assertTrue(sheet_artifact.content.startswith(b"\x89PNG\r\n\x1a\n"))
            self.assertEqual(preview_artifact.status_code, 200, preview_artifact.text)
            self.assertEqual(preview_artifact.headers["content-type"], "image/gif")
            self.assertTrue(preview_artifact.content.startswith((b"GIF87a", b"GIF89a")))

    def test_cli_export_accepts_an_explicit_project_filename(self) -> None:
        created = self.service.create_job(self.harness.create_request("fixture"))
        generated = self.service.generate_job(created.job_id)
        self.service.approve_candidate(
            generated.job_id,
            1,
            reviewer="cli-integration-test",
            acknowledge_warnings=True,
        )

        result = self._run_cli(
            "export",
            "--job",
            generated.job_id,
            "--candidate",
            "1",
            "--filename",
            "赛博人物行走.png",
        )

        self.assertEqual(result["operation"], "export")
        export_record = result["data"]["job"]["export"]
        self.assertTrue(export_record["sheet_path"].endswith("赛博人物行走.png"))
        self.assertTrue((self.root / export_record["sheet_path"]).is_file())

    def test_reference_tampering_before_submit_blocks_generate_without_calling_provider(self) -> None:
        created = self.service.create_job(self.harness.create_request("fixture"))
        original_events = list(created.events)
        reference = self.service.store.job_dir(created.job_id) / "input" / "reference.png"
        self.harness.write_frame(reference, shift_x=8)
        provider = Mock(name="provider")
        provider.name = "fixture"
        provider.diagnostic_only = False
        provider.submit.side_effect = AssertionError("provider.submit must not be called")

        with patch("sprite_pipeline.providers.get_provider", return_value=provider):
            with self.assertRaisesRegex(ValidationHarnessError, "reference snapshot changed"):
                self.service.generate_job(created.job_id, wait=False, candidate_index=1)

        provider.submit.assert_not_called()
        persisted = self.service.get_job(created.job_id)
        candidate = self._candidate(persisted)
        self.assertEqual(persisted.status, JobStatus.created)
        self.assertEqual(persisted.events, original_events)
        self.assertEqual(candidate.status, CandidateStatus.created)
        self.assertIsNone(candidate.provider_name)
        self.assertIsNone(candidate.provider_job_id)
        self.assertEqual(candidate.frames, [])
        self.assertFalse(any((self.service.store.job_dir(created.job_id) / "provider").iterdir()))

    def test_imports_png_directory_through_normalization_and_qa(self) -> None:
        ingested = self._ingest_clean_candidate()
        candidate = self._candidate(ingested)
        self.assertEqual(candidate.status, CandidateStatus.review_ready)
        self.assertEqual(candidate.hard_failures, [])
        self.assertEqual([frame.index for frame in candidate.frames], [0, 1, 2, 3])

        job_dir = self.service.store.job_dir(ingested.job_id)
        manifest_path = job_dir / "raw" / "candidate_01" / "frames_manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["source_type"], "directory")
        self.assertEqual(manifest["frame_count"], 4)
        for frame in candidate.frames:
            normalized_path = self.service.store.resolve_job_path(ingested.job_id, frame.active_path)
            with Image.open(normalized_path) as normalized:
                self.assertEqual(normalized.mode, "RGBA")
                self.assertEqual(normalized.size, (64, 64))

    def test_import_sheet_detects_five_frames_independent_of_even_action_preset(self) -> None:
        character_path = self.harness.character_dir / "character.json"
        character_payload = json.loads(character_path.read_text(encoding="utf-8"))
        character_payload.update(
            {
                "cell_width": 128,
                "cell_height": 128,
                "anchor": {"x": 64, "ground_y": 111},
                "sheet_columns": 4,
            }
        )
        self.harness._write_json(character_path, character_payload)

        action_path = self.harness.action_dir / f"{self.harness.action_id}.json"
        action_payload = json.loads(action_path.read_text(encoding="utf-8"))
        action_payload["frame_count"] = 8
        self.harness._write_json(action_path, action_payload)

        def draw_pose(image: Image.Image, *, origin_x: int, origin_y: int, shift_x: int) -> None:
            draw = ImageDraw.Draw(image)
            draw.rectangle(
                (origin_x + 55 + shift_x, origin_y + 38, origin_x + 72 + shift_x, origin_y + 59),
                fill=(84, 238, 226, 255),
            )
            draw.rectangle(
                (origin_x + 49 + shift_x, origin_y + 60, origin_x + 78 + shift_x, origin_y + 104),
                fill=(24, 70, 128, 255),
            )
            draw.rectangle(
                (origin_x + 53 + shift_x, origin_y + 105, origin_x + 61 + shift_x, origin_y + 111),
                fill=(19, 35, 67, 255),
            )
            draw.rectangle(
                (origin_x + 66 + shift_x, origin_y + 105, origin_x + 74 + shift_x, origin_y + 111),
                fill=(19, 35, 67, 255),
            )

        reference = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
        draw_pose(reference, origin_x=0, origin_y=0, shift_x=0)
        reference.save(self.harness.reference_path, format="PNG", optimize=False, compress_level=9)

        sheet_path = self.root / "incoming" / "attack_five_frames.png"
        sheet_path.parent.mkdir(parents=True)
        sheet = Image.new("RGBA", (128 * 4, 128 * 2), (0, 0, 0, 0))
        for index in range(5):
            draw_pose(
                sheet,
                origin_x=(index % 4) * 128,
                origin_y=(index // 4) * 128,
                shift_x=index,
            )
        sheet.save(sheet_path, format="PNG", optimize=False, compress_level=9)

        job = self.service.create_job(self.harness.create_request("import"))
        self.assertEqual(job.action.frame_count, 8, "the generation preset must remain even")
        checked = self.service.ingest_candidate(job.job_id, 1, sheet_path, source_kind="sheet")
        candidate = self._candidate(checked)
        self.assertEqual(candidate.status, CandidateStatus.review_ready)
        self.assertEqual(candidate.hard_failures, [])
        self.assertEqual([frame.index for frame in candidate.frames], list(range(5)))

        manifest_path = self.service.store.job_dir(job.job_id) / "raw" / "candidate_01" / "frames_manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["frame_count"], 5)
        self.assertEqual(manifest["columns"], 4)

        approved = self.service.approve_candidate(
            job.job_id,
            1,
            reviewer="integration-test",
            acknowledge_warnings=True,
        )
        self.assertEqual(self._candidate(approved).status, CandidateStatus.approved)
        exported = self.service.export_candidate(job.job_id, 1)
        self.assertIsNotNone(exported.export)
        assert exported.export is not None
        recipe_path = self.root / exported.export.recipe_path
        recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
        self.assertEqual(recipe["frame_count"], 5)
        self.assertEqual(recipe["columns"], 4)
        sheet_export = self.root / exported.export.sheet_path
        with Image.open(sheet_export) as exported_image:
            self.assertEqual(exported_image.size, (512, 256))

    def test_uniform_sixteen_frame_action_can_inspect_a_legacy_twelve_frame_sheet(self) -> None:
        action_path = self.harness.action_dir / f"{self.harness.action_id}.json"
        action_payload = json.loads(action_path.read_text(encoding="utf-8"))
        action_payload.update(
            {
                "frame_count": 16,
                "sheet_columns": 4,
                "sheet_rows": 4,
            }
        )
        self.harness._write_json(action_path, action_payload)

        source_path = self.root / "incoming" / "legacy_twelve_frames.png"
        source_path.parent.mkdir(parents=True)
        source_sheet = Image.new("RGBA", (64 * 4, 64 * 3), (0, 0, 0, 0))
        frame_cells = [(index % 4, index // 4) for index in range(12)]
        for index, (column, row) in enumerate(frame_cells):
            frame_path = self.root / "incoming" / f"legacy_pose_{index:02d}.png"
            self.harness.write_frame(frame_path, shift_x=index)
            with Image.open(frame_path) as opened:
                source_sheet.alpha_composite(opened.convert("RGBA"), (column * 64, row * 64))
        source_sheet.save(source_path, format="PNG", optimize=False, compress_level=9)

        job = self.service.create_job(self.harness.create_request("import"))
        checked = self.service.ingest_candidate(
            job.job_id,
            1,
            source_path,
            source_kind="sheet",
            columns=4,
            frame_cells=frame_cells,
        )
        candidate = self._candidate(checked)
        self.assertEqual(len(candidate.frames), 12)
        self.assertEqual(candidate.status, CandidateStatus.review_ready)
        self.assertIn("frame_count_mismatch", {issue.code for issue in candidate.warnings})
        self.assertEqual(candidate.hard_failures, [])

        self.service.approve_candidate(
            job.job_id,
            1,
            reviewer="legacy-layout-test",
            acknowledge_warnings=True,
        )
        exported = self.service.export_candidate(job.job_id, 1)
        assert exported.export is not None
        with Image.open(self.root / exported.export.sheet_path) as exported_sheet:
            self.assertEqual(exported_sheet.size, (256, 256))
        recipe = json.loads((self.root / exported.export.recipe_path).read_text(encoding="utf-8"))
        self.assertEqual(recipe["frame_count"], 12)
        self.assertEqual(recipe["rows"], 4)
        self.assertEqual(len(recipe["unused_cells"]), 4)

    def test_import_sheet_keeps_internal_transparent_cells_and_provider_count_stays_even(self) -> None:
        sheet_path = self.root / "incoming" / "internal_gap.png"
        sheet_path.parent.mkdir(parents=True)
        sheet = Image.new("RGBA", (64 * 4, 64 * 2), (0, 0, 0, 0))
        for index, shift in ((0, 0), (1, 1), (3, 3), (4, 4)):
            self.harness.write_frame(self.root / "incoming" / f"pose_{index}.png", shift_x=shift)
            with Image.open(self.root / "incoming" / f"pose_{index}.png") as opened:
                frame = opened.convert("RGBA").copy()
            sheet.alpha_composite(frame, ((index % 4) * 64, (index // 4) * 64))
        sheet.save(sheet_path, format="PNG", optimize=False, compress_level=9)

        job = self.service.create_job(self.harness.create_request("import"))
        checked = self.service.ingest_candidate(job.job_id, 1, sheet_path, source_kind="sheet")
        candidate = self._candidate(checked)
        self.assertEqual([frame.index for frame in candidate.frames], list(range(5)))
        self.assertEqual(candidate.status, CandidateStatus.check_failed)
        blank_issues = [issue for issue in candidate.hard_failures if issue.code == "blank_frame"]
        self.assertEqual([issue.frame_index for issue in blank_issues], [2])
        blank_path = self.service.store.resolve_job_path(job.job_id, candidate.frames[2].active_path)
        with Image.open(blank_path) as blank:
            self.assertIsNone(blank.convert("RGBA").getchannel("A").getbbox())

        with self.assertRaisesRegex(ValueError, "even integer"):
            ProviderRequest(
                reference_image=self.harness.reference_path.read_bytes(),
                prompt="Five imported frames must not weaken provider generation validation.",
                frame_count=5,
                seed=0,
            )

    def test_import_sheet_defaults_to_character_sheet_columns(self) -> None:
        sheet_path = self.root / "incoming" / "wrong_column_count.png"
        sheet_path.parent.mkdir(parents=True)
        sheet = Image.new("RGBA", (64 * 5, 64), (0, 0, 0, 0))
        draw = ImageDraw.Draw(sheet)
        draw.rectangle((20, 18, 40, 55), fill=(84, 238, 226, 255))
        sheet.save(sheet_path, format="PNG", optimize=False, compress_level=9)

        job = self.service.create_job(self.harness.create_request("import"))
        with self.assertRaisesRegex(ValueError, "physical sheet columns=5"):
            self.service.ingest_candidate(job.job_id, 1, sheet_path, source_kind="sheet")
        persisted = self.service.get_job(job.job_id)
        self.assertEqual(self._candidate(persisted).status, CandidateStatus.created)
        self.assertEqual(self._candidate(persisted).frames, [])

    def test_five_frame_project_action_keeps_six_provider_sources_and_builds_sparse_preview(self) -> None:
        action_path = self.harness.action_dir / f"{self.harness.action_id}.json"
        cells = [[0, 0], [2, 0], [1, 1], [2, 1], [3, 1]]
        self.harness._write_json(
            action_path,
            {
                "schema_version": 1,
                "action_id": self.harness.action_id,
                "display_name": "Five Frame Attack",
                "frame_count": 5,
                "provider_frame_count": 6,
                "provider_frame_selection": [0, 1, 2, 3, 5],
                "fps": 12,
                "loop": False,
                "grounded": True,
                "sheet_columns": 4,
                "sheet_rows": 2,
                "sheet_frame_cells": cells,
                "centroid_shift_px": 20,
                "action_description": "Generate a smooth five-beat grounded test attack from six provider poses.",
                "locked_constraints": ["Keep all neighboring poses and root positions continuous."],
            },
        )

        created = self.service.create_job(self.harness.create_request("fixture"))
        self.assertEqual(created.action.frame_count, 5)
        self.assertEqual(created.action.generation_frame_count, 6)
        generated = self.service.generate_job(created.job_id, wait=True)
        candidate = self._candidate(generated)

        self.assertEqual(len(candidate.frames), 5)
        raw_dir = self.service.store.job_dir(generated.job_id) / "raw" / "candidate_01"
        self.assertEqual(len(list((raw_dir / "provider_source").glob("source_frame_*.png"))), 6)
        manifest = json.loads((raw_dir / "frames_manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["provider_frame_count"], 6)
        self.assertEqual(manifest["project_frame_count"], 5)
        self.assertEqual(manifest["provider_frame_selection"], [0, 1, 2, 3, 5])
        self.assertEqual(
            [frame["provider_source_index"] for frame in manifest["frames"]],
            [0, 1, 2, 3, 5],
        )

        preview = self.service.store.job_dir(generated.job_id) / "previews" / "candidate_01.sheet.png"
        with Image.open(preview) as opened:
            sheet = opened.convert("RGBA")
        self.assertEqual(sheet.size, (256, 128))
        for column, row in ((1, 0), (3, 0), (0, 1)):
            alpha = sheet.getchannel("A").crop((column * 64, row * 64, (column + 1) * 64, (row + 1) * 64))
            self.assertIsNone(alpha.getbbox(), (column, row))

    def test_sparse_project_sheet_imports_in_playback_order_and_exports_same_layout(self) -> None:
        action_path = self.harness.action_dir / f"{self.harness.action_id}.json"
        cells = [(0, 0), (2, 0), (1, 1), (2, 1), (3, 1)]
        self.harness._write_json(
            action_path,
            {
                "schema_version": 1,
                "action_id": self.harness.action_id,
                "display_name": "Sparse Project Attack",
                "frame_count": 5,
                "provider_frame_count": 6,
                "provider_frame_selection": [0, 1, 2, 3, 5],
                "fps": 12,
                "loop": False,
                "grounded": True,
                "sheet_columns": 4,
                "sheet_rows": 2,
                "sheet_frame_cells": [list(cell) for cell in cells],
                "centroid_shift_px": 20,
                "action_description": "Import and export five smooth grounded poses in the project's sparse grid.",
            },
        )
        source_path = self.root / "incoming" / "sparse_attack.png"
        source_path.parent.mkdir(parents=True, exist_ok=True)
        source_sheet = Image.new("RGBA", (256, 128), (0, 0, 0, 0))
        expected_pixels: list[bytes] = []
        for index, (column, row) in enumerate(cells):
            frame_path = self.root / "incoming" / f"sparse_pose_{index}.png"
            self.harness.write_frame(frame_path, shift_x=index)
            with Image.open(frame_path) as opened:
                frame = opened.convert("RGBA").copy()
            expected_pixels.append(frame.tobytes())
            source_sheet.alpha_composite(frame, (column * 64, row * 64))
        source_sheet.save(source_path, format="PNG", optimize=False, compress_level=9)

        created = self.service.create_job(self.harness.create_request("import"))
        checked = self.service.ingest_candidate(created.job_id, 1, source_path, source_kind="sheet")
        candidate = self._candidate(checked)
        self.assertEqual(candidate.status, CandidateStatus.review_ready)
        actual_pixels = []
        for frame in candidate.frames:
            with Image.open(self.service.store.resolve_job_path(checked.job_id, frame.active_path)) as opened:
                actual_pixels.append(opened.convert("RGBA").tobytes())
        self.assertEqual(actual_pixels, expected_pixels)

        import_manifest = json.loads(
            (self.service.store.job_dir(checked.job_id) / "raw" / "candidate_01" / "frames_manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            [(frame["sheet_column"], frame["sheet_row"]) for frame in import_manifest["frames"]],
            cells,
        )
        self.service.approve_candidate(
            checked.job_id,
            1,
            reviewer="sparse-layout-test",
            acknowledge_warnings=True,
        )
        exported = self.service.export_candidate(checked.job_id, 1)
        assert exported.export is not None
        exported_sheet = self.root / exported.export.sheet_path
        with Image.open(exported_sheet) as opened:
            sheet = opened.convert("RGBA")
        self.assertEqual(sheet.size, (256, 128))
        for column, row in ((1, 0), (3, 0), (0, 1)):
            alpha = sheet.getchannel("A").crop((column * 64, row * 64, (column + 1) * 64, (row + 1) * 64))
            self.assertIsNone(alpha.getbbox(), (column, row))
        recipe = json.loads((self.root / exported.export.recipe_path).read_text(encoding="utf-8"))
        self.assertEqual([tuple(cell) for cell in recipe["frame_cells"]], cells)
        self.assertEqual([tuple(cell) for cell in recipe["unused_cells"]], [(1, 0), (3, 0), (0, 1)])

    def test_base64_frame_ingest_accepts_17_and_64_frames(self) -> None:
        frame_path = self.root / "incoming" / "base64_boundary.png"
        self.harness.write_frame(frame_path, shift_x=0)
        encoded = base64.b64encode(frame_path.read_bytes()).decode("ascii")

        for frame_count in (17, 64):
            with self.subTest(frame_count=frame_count):
                job = self.service.create_job(self.harness.create_request("import"))
                checked = self.service.ingest_candidate_base64(
                    job.job_id,
                    1,
                    [encoded] * frame_count,
                )
                self.assertEqual(len(self._candidate(checked).frames), frame_count)

    def test_base64_frame_ingest_rejects_65_frames(self) -> None:
        job = self.service.create_job(self.harness.create_request("import"))

        with self.assertRaisesRegex(
            ValidationHarnessError,
            "frames must contain between 1 and 64 images",
        ):
            self.service.ingest_candidate_base64(job.job_id, 1, [""] * 65)

    def test_hard_failure_blocks_frame_and_candidate_approval_and_export(self) -> None:
        source_dir = self.root / "incoming" / "duplicates"
        self.harness.write_sequence(source_dir, shifts=(0, 0, 0, 0))
        job = self.service.create_job(self.harness.create_request("import"))
        checked = self.service.ingest_candidate(job.job_id, 1, source_dir, source_kind="png_dir")
        candidate = self._candidate(checked)
        self.assertEqual(candidate.status, CandidateStatus.check_failed)
        self.assertIn("consecutive_duplicate_frames", {issue.code for issue in candidate.hard_failures})
        self.assertTrue(candidate.frames[0].hard_failures)

        with self.assertRaises(ExportBlockedError):
            self.service.review_frame(
                job.job_id,
                1,
                {"frame_index": 0, "status": "approved", "reviewer": "integration-test"},
            )
        with self.assertRaises(ExportBlockedError):
            self.service.approve_candidate(
                job.job_id,
                1,
                reviewer="integration-test",
                acknowledge_warnings=True,
            )
        with self.assertRaises(ExportBlockedError):
            self.service.export_candidate(job.job_id, 1)
        persisted = self.service.get_job(job.job_id)
        self.assertIsNone(persisted.export)
        self.assertEqual(self._candidate(persisted).status, CandidateStatus.check_failed)

    def test_concurrent_candidate_submissions_never_overlap(self) -> None:
        request = self.harness.create_request("pixellab")
        request["candidate_count"] = 2
        job = self.service.create_job(request)
        provider = BlockingSubmissionProvider()
        original_load = self.service.store.load
        initial_load_barrier = threading.Barrier(2)
        coordinated_threads: set[int] = set()
        coordination_lock = threading.Lock()
        outcomes: dict[int, Any] = {}

        def coordinated_load(job_id: str) -> Any:
            snapshot = original_load(job_id)
            thread_id = threading.get_ident()
            should_wait = False
            if threading.current_thread().name.startswith("candidate-submit-"):
                with coordination_lock:
                    if thread_id not in coordinated_threads:
                        coordinated_threads.add(thread_id)
                        should_wait = True
            if should_wait:
                initial_load_barrier.wait(timeout=5)
            return snapshot

        def generate(candidate_index: int) -> None:
            try:
                outcomes[candidate_index] = self.service.generate_job(
                    job.job_id,
                    wait=False,
                    candidate_index=candidate_index,
                )
            except Exception as exc:  # Captured for assertion on the main thread.
                outcomes[candidate_index] = exc

        with (
            patch("sprite_pipeline.providers.get_provider", return_value=provider),
            patch.object(self.service.store, "load", side_effect=coordinated_load),
        ):
            workers = [
                threading.Thread(
                    target=generate,
                    args=(candidate_index,),
                    name=f"candidate-submit-{candidate_index}",
                )
                for candidate_index in (1, 2)
            ]
            for worker in workers:
                worker.start()
            self.assertTrue(provider.first_entered.wait(timeout=5), "no provider submission started")
            provider.parallel_entered.wait(timeout=0.5)
            provider.release.set()
            for worker in workers:
                worker.join(timeout=5)
                self.assertFalse(worker.is_alive(), "candidate submission worker did not finish")

        self.assertEqual(provider.max_active_submissions, 1)
        self.assertEqual(set(outcomes), {1, 2})
        for outcome in outcomes.values():
            if isinstance(outcome, Exception):
                self.assertIsInstance(outcome, ConflictError)

    def test_reject_is_blocked_during_submission_and_provider_pending(self) -> None:
        job = self.service.create_job(self.harness.create_request("pixellab"))
        provider = BlockingSubmissionProvider()
        outcome: list[Any] = []

        def generate() -> None:
            try:
                outcome.append(
                    self.service.generate_job(
                        job.job_id,
                        wait=False,
                        candidate_index=1,
                    )
                )
            except Exception as exc:  # Captured for assertion on the main thread.
                outcome.append(exc)

        with patch("sprite_pipeline.providers.get_provider", return_value=provider):
            worker = threading.Thread(target=generate, name="blocked-provider-submit")
            worker.start()
            try:
                self.assertTrue(provider.first_entered.wait(timeout=5), "provider submit did not block")
                submitting = self.service.get_job(job.job_id)
                self.assertEqual(self._candidate(submitting).status, CandidateStatus.submitting)
                submitting_events = list(submitting.events)

                with self.assertRaisesRegex(ConflictError, "only be rejected after provider receipt"):
                    self.service.reject_candidate(
                        job.job_id,
                        1,
                        reviewer="integration-test",
                        note="must not race a paid submission",
                    )
                still_submitting = self.service.get_job(job.job_id)
                self.assertEqual(self._candidate(still_submitting).status, CandidateStatus.submitting)
                self.assertEqual(still_submitting.events, submitting_events)
                self.assertFalse(any(event["event"] == "candidate_rejected" for event in still_submitting.events))
            finally:
                provider.release.set()
                worker.join(timeout=5)
                self.assertFalse(worker.is_alive(), "blocked submission worker did not finish")

        self.assertEqual(len(outcome), 1)
        self.assertNotIsInstance(outcome[0], Exception)
        pending = self.service.get_job(job.job_id)
        candidate = self._candidate(pending)
        self.assertEqual(pending.status, JobStatus.provider_pending)
        self.assertEqual(candidate.status, CandidateStatus.provider_pending)
        self.assertIsNotNone(candidate.provider_job_id)
        pending_events = list(pending.events)

        with self.assertRaisesRegex(ConflictError, "only be rejected after provider receipt"):
            self.service.reject_candidate(
                job.job_id,
                1,
                reviewer="integration-test",
                note="pending provider work cannot be rejected",
            )
        still_pending = self.service.get_job(job.job_id)
        self.assertEqual(still_pending.status, JobStatus.provider_pending)
        self.assertEqual(self._candidate(still_pending).status, CandidateStatus.provider_pending)
        self.assertEqual(still_pending.events, pending_events)

    def test_concurrent_poll_of_same_candidate_runs_once_and_preserves_success(self) -> None:
        frame_dir = self.root / "provider_fixture" / "concurrent_poll"
        images = [path.read_bytes() for path in self.harness.write_sequence(frame_dir)]
        job = self.service.create_job(self.harness.create_request("fixture"))
        provider_job_id = "shared-provider-job"
        with self.service.store.locked_job(job.job_id) as pending_job:
            candidate = self._candidate(pending_job)
            candidate.status = CandidateStatus.provider_pending
            candidate.provider_name = "pixellab"
            candidate.provider_model = "animate-with-text-v3"
            candidate.provider_job_id = provider_job_id
            candidate.provider_status = "processing"
            pending_job.status = JobStatus.provider_pending

        provider = CompletingThenFailingPollProvider(images)
        original_operation_lock = self.service.store.operation_lock
        poll_attempt_barrier = threading.Barrier(2)
        outcomes: list[Exception] = []

        @contextmanager
        def coordinated_operation_lock(
            job_id: str,
            operation: str,
            *,
            timeout_seconds: float = 30.0,
        ) -> Any:
            poll_attempt_barrier.wait(timeout=5)
            with original_operation_lock(
                job_id,
                operation,
                timeout_seconds=timeout_seconds,
            ):
                yield

        def poll() -> None:
            try:
                self.service._poll_candidate(job.job_id, 1, provider, wait=False)
            except Exception as exc:  # Captured for assertion on the main thread.
                outcomes.append(exc)

        with patch.object(
            self.service.store,
            "operation_lock",
            new=coordinated_operation_lock,
        ):
            workers = [
                threading.Thread(target=poll, name=f"candidate-poll-{index}")
                for index in (1, 2)
            ]
            for worker in workers:
                worker.start()
            self.assertTrue(provider.first_entered.wait(timeout=5), "no provider poll started")
            provider.release_first.set()
            for worker in workers:
                worker.join(timeout=5)
                self.assertFalse(worker.is_alive(), "candidate poll worker did not finish")

        self.assertEqual(outcomes, [])
        self.assertEqual(provider.poll_count, 1)
        persisted = self.service.get_job(job.job_id)
        candidate = self._candidate(persisted)
        self.assertEqual(candidate.status, CandidateStatus.review_ready)
        self.assertEqual(candidate.provider_status, "completed")
        self.assertIsNone(candidate.error)
        self.assertEqual(len(candidate.frames), 4)
        self.assertEqual(
            sum(event["event"] == "candidate_checked" for event in persisted.events),
            1,
        )

    def test_check_without_frames_does_not_mutate_created_state(self) -> None:
        created = self.service.create_job(self.harness.create_request("import"))
        original_events = list(created.events)
        self.assertEqual(self._candidate(created).status, CandidateStatus.created)
        self.assertEqual(self._candidate(created).frames, [])

        with self.assertRaises(ValidationHarnessError):
            self.service.check_candidate(created.job_id, 1)
        still_created = self.service.get_job(created.job_id)
        self.assertEqual(still_created.status, JobStatus.created)
        self.assertEqual(still_created.events, original_events)
        self.assertEqual(self._candidate(still_created).status, CandidateStatus.created)
        self.assertIsNone(self._candidate(still_created).error)

    def test_check_from_invalid_approved_state_does_not_mutate_state(self) -> None:
        checked = self._ingest_clean_candidate()
        approved = self.service.approve_candidate(
            checked.job_id,
            1,
            reviewer="integration-test",
            acknowledge_warnings=True,
        )
        approved_events = list(approved.events)
        with self.assertRaises(ConflictError):
            self.service.check_candidate(approved.job_id, 1)
        still_approved = self.service.get_job(approved.job_id)
        self.assertEqual(still_approved.status, JobStatus.approved)
        self.assertEqual(still_approved.events, approved_events)
        self.assertEqual(self._candidate(still_approved).status, CandidateStatus.approved)
        self.assertIsNone(self._candidate(still_approved).error)

    def test_old_approved_qa_can_be_rechecked_and_reapproved_before_export(self) -> None:
        checked = self._ingest_clean_candidate()
        approved = self.service.approve_candidate(
            checked.job_id,
            1,
            reviewer="integration-test",
            acknowledge_warnings=True,
        )
        with self.service.store.locked_job(approved.job_id) as legacy_job:
            self._candidate(legacy_job).qa_algorithm_version = "sprite-pipeline-qa-v2"

        rechecked = self.service.check_candidate(approved.job_id, 1)
        candidate = self._candidate(rechecked)
        self.assertEqual(candidate.qa_algorithm_version, QA_ALGORITHM_VERSION)
        self.assertEqual(candidate.status, CandidateStatus.review_ready)
        self.assertTrue(
            all(frame.review_status == ReviewStatus.approved for frame in candidate.frames)
        )
        self.assertTrue(
            any(
                event["event"] == "candidate_approval_invalidated_by_qa_upgrade"
                for event in rechecked.events
            )
        )

        reapproved = self.service.approve_candidate(
            approved.job_id,
            1,
            reviewer="integration-test",
            acknowledge_warnings=True,
        )
        exported = self.service.export_candidate(reapproved.job_id, 1)
        self.assertIsNotNone(exported.export)

    def test_exported_candidate_cannot_be_rechecked_during_qa_upgrade(self) -> None:
        checked = self._ingest_clean_candidate()
        approved = self.service.approve_candidate(
            checked.job_id,
            1,
            reviewer="integration-test",
            acknowledge_warnings=True,
        )
        exported = self.service.export_candidate(approved.job_id, 1)
        with self.service.store.locked_job(exported.job_id) as legacy_job:
            self._candidate(legacy_job).qa_algorithm_version = "sprite-pipeline-qa-v2"

        with self.assertRaises(ConflictError):
            self.service.check_candidate(exported.job_id, 1)
        persisted = self.service.get_job(exported.job_id)
        self.assertIsNotNone(persisted.export)
        self.assertEqual(self._candidate(persisted).status, CandidateStatus.approved)

    def test_reference_tampering_after_qa_blocks_approval(self) -> None:
        checked = self._ingest_clean_candidate()
        reference = self.service.store.job_dir(checked.job_id) / "input" / "reference.png"
        self.harness.write_frame(reference, shift_x=8)

        with self.assertRaises(ExportBlockedError):
            self.service.approve_candidate(
                checked.job_id,
                1,
                reviewer="integration-test",
                acknowledge_warnings=True,
            )
        persisted = self.service.get_job(checked.job_id)
        self.assertEqual(persisted.status, JobStatus.review_required)
        self.assertEqual(self._candidate(persisted).status, CandidateStatus.review_ready)
        self.assertTrue(
            all(frame.review_status == ReviewStatus.pending for frame in self._candidate(persisted).frames)
        )

    def test_reference_tampering_after_approval_blocks_export(self) -> None:
        checked = self._ingest_clean_candidate()
        approved = self.service.approve_candidate(
            checked.job_id,
            1,
            reviewer="integration-test",
            acknowledge_warnings=True,
        )
        reference = self.service.store.job_dir(approved.job_id) / "input" / "reference.png"
        self.harness.write_frame(reference, shift_x=8)

        with self.assertRaises(ExportBlockedError):
            self.service.export_candidate(approved.job_id, 1)
        persisted = self.service.get_job(approved.job_id)
        self.assertEqual(persisted.status, JobStatus.approved)
        self.assertEqual(self._candidate(persisted).status, CandidateStatus.approved)
        self.assertIsNone(persisted.export)

    def test_frame_tampering_after_first_check_blocks_export_bundle(self) -> None:
        checked = self._ingest_clean_candidate()
        approved = self.service.approve_candidate(
            checked.job_id,
            1,
            reviewer="integration-test",
            acknowledge_warnings=True,
        )
        frame = self._candidate(approved).frames[0]
        active_path = self.service.store.resolve_job_path(approved.job_id, frame.active_path)
        self.harness.write_frame(active_path, shift_x=9)

        with self.assertRaisesRegex(ExportBlockedError, "bytes changed"):
            self.service.export_candidate(approved.job_id, 1)
        persisted = self.service.get_job(approved.job_id)
        self.assertEqual(persisted.status, JobStatus.approved)
        self.assertEqual(self._candidate(persisted).status, CandidateStatus.approved)
        self.assertIsNone(persisted.export)
        export_dir = self.root / "exports" / self.harness.character_id / self.harness.action_id
        self.assertFalse(export_dir.exists())

    def test_frame_approvals_cannot_bypass_sequence_warning_acknowledgement(self) -> None:
        source_dir = self.root / "incoming" / "warning_sequence"
        self.harness.write_sequence(source_dir, shifts=(-23, -22, -21, -20))
        job = self.service.create_job(self.harness.create_request("import"))
        checked = self.service.ingest_candidate(job.job_id, 1, source_dir, source_kind="png_dir")
        candidate = self._candidate(checked)
        self.assertEqual(candidate.hard_failures, [])
        self.assertTrue(candidate.warnings)

        for frame in candidate.frames:
            self.service.review_frame(
                job.job_id,
                1,
                {"frame_index": frame.index, "status": "approved", "reviewer": "integration-test"},
            )
        reviewed = self.service.get_job(job.job_id)
        self.assertEqual(self._candidate(reviewed).status, CandidateStatus.review_ready)
        with self.assertRaises(ExportBlockedError):
            self.service.approve_candidate(job.job_id, 1, reviewer="integration-test")
        approved = self.service.approve_candidate(
            job.job_id,
            1,
            reviewer="integration-test",
            acknowledge_warnings=True,
        )
        self.assertEqual(self._candidate(approved).status, CandidateStatus.approved)

    def test_tampered_approved_frame_is_blocked_at_export(self) -> None:
        checked = self._ingest_clean_candidate()
        approved = self.service.approve_candidate(
            checked.job_id,
            1,
            reviewer="integration-test",
            acknowledge_warnings=True,
        )
        frame = self._candidate(approved).frames[0]
        active_path = self.service.store.resolve_job_path(approved.job_id, frame.active_path)
        self.harness.write_frame(active_path, shift_x=9)

        with self.assertRaisesRegex(ExportBlockedError, "bytes changed"):
            self.service.export_candidate(approved.job_id, 1)
        persisted = self.service.get_job(approved.job_id)
        self.assertIsNone(persisted.export)

    def test_qa_exception_is_persisted_and_cannot_be_approved(self) -> None:
        source_dir = self.root / "incoming" / "qa_crash"
        self.harness.write_sequence(source_dir)
        job = self.service.create_job(self.harness.create_request("import"))
        with patch("sprite_pipeline.processing.run_qa", side_effect=RuntimeError("simulated QA crash")):
            with self.assertRaisesRegex(RuntimeError, "simulated QA crash"):
                self.service.ingest_candidate(job.job_id, 1, source_dir, source_kind="png_dir")

        persisted = self.service.get_job(job.job_id)
        candidate = self._candidate(persisted)
        self.assertEqual(candidate.status, CandidateStatus.check_failed)
        self.assertIsNone(candidate.qa_completed_at)
        self.assertIsNone(candidate.qa_input_sha256)
        self.assertEqual(candidate.error["code"], "qa_execution_error")
        with self.assertRaises(ExportBlockedError):
            self.service.approve_candidate(job.job_id, 1, reviewer="integration-test", acknowledge_warnings=True)
        with self.assertRaises(ExportBlockedError):
            self.service.review_frame(
                job.job_id,
                1,
                {"frame_index": 0, "status": "approved", "reviewer": "integration-test"},
            )
        with self.assertRaises(ExportBlockedError):
            self.service.export_candidate(job.job_id, 1)

    def test_manual_ingest_is_restricted_to_import_jobs(self) -> None:
        source_dir = self.root / "incoming" / "not_import"
        self.harness.write_sequence(source_dir)
        job = self.service.create_job(self.harness.create_request("fixture"))
        with self.assertRaisesRegex(ConflictError, "only allowed for import jobs"):
            self.service.ingest_candidate(job.job_id, 1, source_dir, source_kind="png_dir")
        self.assertEqual(self._candidate(self.service.get_job(job.job_id)).status, CandidateStatus.created)

    def test_job_lock_serializes_distinct_store_instances(self) -> None:
        job = self.service.create_job(self.harness.create_request("import"))
        second_store = JobStore(self.service.settings)
        with self.service.store._process_lock(job.job_id):
            with self.assertRaisesRegex(ConflictError, "busy"):
                with second_store._process_lock(job.job_id, timeout_seconds=0.05):
                    self.fail("second process-style lock must not be acquired")

    def test_old_mtime_lock_file_cannot_be_stolen_while_os_lock_is_held(self) -> None:
        job = self.service.create_job(self.harness.create_request("import"))
        lock_path = self.service.store.job_dir(job.job_id) / ".job.lock"
        lock_path.write_bytes(b"\0")
        old_timestamp = 946684800.0  # 2000-01-01 UTC: deliberately far beyond stale-lock heuristics.
        os.utime(lock_path, (old_timestamp, old_timestamp))
        second_store = JobStore(self.service.settings)

        with self.service.store._process_lock(job.job_id):
            self.assertAlmostEqual(lock_path.stat().st_mtime, old_timestamp, delta=2.0)
            with self.assertRaisesRegex(ConflictError, "busy"):
                with second_store._process_lock(job.job_id, timeout_seconds=0.05):
                    self.fail("an old mtime must not permit stealing a live OS lock")
            self.assertTrue(lock_path.is_file())

    def test_cli_argument_errors_are_single_line_json(self) -> None:
        completed = subprocess.run(
            [sys.executable, "-m", "sprite_pipeline.cli", "--root", str(self.root), "status"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
            check=False,
        )
        self.assertEqual(completed.returncode, 2)
        lines = [line for line in completed.stdout.splitlines() if line.strip()]
        self.assertEqual(len(lines), 1)
        payload = json.loads(lines[0])
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["operation"], "parse")
        self.assertEqual(payload["error"]["code"], "argument_error")

    def test_provider_image_collections_are_fully_redacted(self) -> None:
        secret = "SECRETPIXELS" * 500
        redacted = redact_provider_payload({"last_response": {"images": [secret]}})
        serialized = json.dumps(redacted, sort_keys=True)
        self.assertNotIn("SECRETPIXELS", serialized)
        image_record = redacted["last_response"]["images"][0]
        self.assertTrue(image_record["redacted_base64"])

    def test_pixellab_rate_limit_retries_use_5_10_20_seconds(self) -> None:
        class SequencedClient:
            def __init__(self) -> None:
                self.responses = [
                    FakeResponse({"detail": "busy"}, 429),
                    FakeResponse({"detail": "busy"}, 529),
                    FakeResponse({"detail": "busy"}, 429),
                    FakeResponse({"background_job_id": "job-after-backoff", "status": "processing"}, 200),
                ]
                self.post_calls = 0

            def post(self, _url: str, *, json: dict[str, Any]) -> FakeResponse:
                self.post_calls += 1
                self.last_json = json
                return self.responses.pop(0)

        delays: list[float] = []
        client = SequencedClient()
        provider = PixelLabProvider(
            api_key="test-token",
            base_url="https://unit.invalid",
            http_client=client,
            sleep_fn=delays.append,
            max_get_retries=3,
        )
        submission = provider.submit(
            ProviderRequest(
                reference_image=self.harness.reference_path.read_bytes(),
                prompt="Move through four precise test poses.",
                frame_count=4,
                seed=42,
            )
        )
        self.assertEqual(submission.provider_job_id, "job-after-backoff")
        self.assertEqual(client.post_calls, 4)
        self.assertEqual(delays, [5.0, 10.0, 20.0])

    def test_failed_import_is_transactional_and_can_be_retried(self) -> None:
        broken_dir = self.root / "incoming" / "broken_import"
        broken_dir.mkdir(parents=True)
        (broken_dir / "frame_000.png").write_bytes(b"not-a-png")
        job = self.service.create_job(self.harness.create_request("import"))
        with self.assertRaises(Exception):
            self.service.ingest_candidate(job.job_id, 1, broken_dir, source_kind="png_dir")
        raw_dir = self.service.store.job_dir(job.job_id) / "raw" / "candidate_01"
        self.assertFalse(raw_dir.exists())
        self.assertEqual(self._candidate(self.service.get_job(job.job_id)).status, CandidateStatus.created)

        valid_dir = self.root / "incoming" / "retry_import"
        self.harness.write_sequence(valid_dir)
        retried = self.service.ingest_candidate(job.job_id, 1, valid_dir, source_kind="png_dir")
        self.assertEqual(self._candidate(retried).status, CandidateStatus.review_ready)

    def test_frame_repair_is_limited_to_two_versions_and_preserves_raw(self) -> None:
        checked = self._ingest_clean_candidate()
        original = self._candidate(checked).frames[0]
        original_raw_path = original.raw_path
        original_raw_bytes = self.service.store.resolve_job_path(checked.job_id, original_raw_path).read_bytes()
        replacements = self.root / "incoming" / "replacements"
        replacement_paths = []
        for attempt, shift in enumerate((4, 5, 6), start=1):
            path = replacements / f"replacement_{attempt}.png"
            self.harness.write_frame(path, shift_x=shift)
            replacement_paths.append(path)

        with self.assertRaisesRegex(
            ConflictError,
            "explicitly marked repair_requested",
        ):
            self.service.replace_frame(
                checked.job_id,
                1,
                0,
                replacement_paths[0],
                base_sha256=original.sha256,
            )
        still_unmarked = self._candidate(self.service.get_job(checked.job_id)).frames[0]
        self.assertEqual(still_unmarked.review_status, ReviewStatus.pending)
        self.assertEqual(still_unmarked.repair_attempts, 0)
        self.assertEqual(still_unmarked.active_path, original_raw_path)

        current = checked
        for expected_attempt, replacement in enumerate(replacement_paths[:2], start=1):
            self.service.review_frame(
                checked.job_id,
                1,
                {
                    "frame_index": 0,
                    "status": "repair_requested",
                    "issue_type": IssueType.pose_error.value,
                    "note": f"repair pass {expected_attempt}",
                    "reviewer": "integration-test",
                },
            )
            current_sha256 = self._candidate(self.service.get_job(checked.job_id)).frames[0].sha256
            current = self.service.replace_frame(
                checked.job_id,
                1,
                0,
                replacement,
                base_sha256=current_sha256,
            )
            repaired = self._candidate(current).frames[0]
            self.assertEqual(repaired.repair_attempts, expected_attempt)
            self.assertEqual(repaired.review_status, ReviewStatus.pending)
            self.assertEqual(repaired.raw_path, original_raw_path)
            self.assertIn(f"frame_000_v{expected_attempt}.png", repaired.active_path)

        with self.assertRaises(ConflictError):
            self.service.replace_frame(
                checked.job_id,
                1,
                0,
                replacement_paths[2],
                base_sha256=self._candidate(current).frames[0].sha256,
            )
        persisted = self.service.get_job(checked.job_id)
        repaired = self._candidate(persisted).frames[0]
        self.assertEqual(repaired.repair_attempts, 2)
        self.assertFalse(
            (self.service.store.job_dir(checked.job_id) / "repaired" / "candidate_01" / "frame_000_v3.png").exists()
        )
        self.assertEqual(
            self.service.store.resolve_job_path(checked.job_id, original_raw_path).read_bytes(),
            original_raw_bytes,
        )

    def test_external_replacement_rejects_stale_source_version(self) -> None:
        checked = self._ingest_clean_candidate()
        original_sha256 = self._candidate(checked).frames[0].sha256
        replacements = self.root / "incoming" / "stale_replacements"
        first = replacements / "first.png"
        stale = replacements / "stale.png"
        self.harness.write_frame(first, shift_x=4)
        self.harness.write_frame(stale, shift_x=8)
        self.service.review_frame(
            checked.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": IssueType.other.value,
                "reviewer": "stale-replacement-test",
            },
        )
        first_saved = self.service.replace_frame(
            checked.job_id,
            1,
            0,
            first,
            base_sha256=original_sha256,
        )
        first_frame = self._candidate(first_saved).frames[0]
        self.service.review_frame(
            checked.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": IssueType.other.value,
                "reviewer": "stale-replacement-test",
            },
        )
        with self.assertRaises(ConflictError) as raised:
            self.service.replace_frame(
                checked.job_id,
                1,
                0,
                stale,
                base_sha256=original_sha256,
            )
        self.assertEqual(raised.exception.details["reason"], "stale_frame_version")
        persisted = self._candidate(self.service.get_job(checked.job_id)).frames[0]
        self.assertEqual(persisted.sha256, first_frame.sha256)
        self.assertEqual(persisted.repair_attempts, 1)

    def test_external_replacement_rejects_unrecorded_active_frame_change(self) -> None:
        checked = self._ingest_clean_candidate()
        original = self._candidate(checked).frames[0]
        replacement = self.root / "incoming" / "integrity_replacement.png"
        self.harness.write_frame(replacement, shift_x=4)
        self.service.review_frame(
            checked.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": IssueType.other.value,
                "reviewer": "integrity-test",
            },
        )
        active_path = self.service.store.resolve_job_path(checked.job_id, original.active_path)
        self.harness.write_frame(active_path, shift_x=9)

        with self.assertRaises(ConflictError) as raised:
            self.service.replace_frame(
                checked.job_id,
                1,
                0,
                replacement,
                base_sha256=original.sha256,
            )

        self.assertEqual(
            raised.exception.details["reason"],
            "active_frame_integrity_mismatch",
        )
        persisted = self._candidate(self.service.get_job(checked.job_id)).frames[0]
        self.assertEqual(persisted.repair_attempts, 0)
        self.assertFalse(
            (self.service.store.job_dir(checked.job_id) / "repaired" / "candidate_01").exists()
        )

    def test_manual_pixel_edit_changes_exact_rgba_and_preserves_raw(self) -> None:
        checked = self._ingest_clean_candidate()
        original = self._candidate(checked).frames[0]
        original_raw_path = original.raw_path
        original_raw_bytes = self.service.store.resolve_job_path(
            checked.job_id,
            original_raw_path,
        ).read_bytes()
        self.service.review_frame(
            checked.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": IssueType.pose_error.value,
                "note": "one pixel needs correction",
                "reviewer": "integration-test",
            },
        )
        session = self.service.get_frame_edit_session(checked.job_id, 1, 0)
        self.assertTrue(session["can_edit"])
        self.assertEqual((session["width"], session["height"]), (64, 64))
        self.assertEqual(session["frame_count"], 4)
        self.assertFalse(session["loop"])
        self.assertEqual(
            session["alpha_visible_threshold"],
            checked.character.qa.alpha_visible_threshold,
        )
        self.assertIsNone(session["neighbors"]["previous"])
        self.assertEqual(session["neighbors"]["next"]["frame_index"], 1)
        next_frame = self._candidate(checked).frames[1]
        with Image.open(self.service.store.resolve_job_path(checked.job_id, next_frame.active_path)) as opened:
            self.assertEqual(session["neighbors"]["next"]["rgba"], opened.convert("RGBA").tobytes())
        before = session["rgba"]
        edited = bytearray(before)
        x, y = 7, 9
        offset = (y * session["width"] + x) * 4
        edited[offset : offset + 4] = bytes((17, 34, 51, 255))
        self.assertEqual(
            sum(
                before[index : index + 4] != bytes(edited[index : index + 4])
                for index in range(0, len(before), 4)
            ),
            1,
        )

        saved = self.service.edit_frame_pixels(
            checked.job_id,
            1,
            0,
            rgba=bytes(edited),
            width=session["width"],
            height=session["height"],
            base_sha256=session["base_sha256"],
            reviewer="integration-test",
        )

        frame = self._candidate(saved).frames[0]
        self.assertEqual(frame.manual_edit_versions, 1)
        self.assertEqual(frame.repair_attempts, 0)
        self.assertEqual(frame.review_status, ReviewStatus.pending)
        self.assertEqual(frame.raw_path, original_raw_path)
        self.assertIn("frame_000_manual_v001.png", frame.active_path)
        active_path = self.service.store.resolve_job_path(saved.job_id, frame.active_path)
        with Image.open(active_path) as opened:
            opened.load()
            actual = opened.convert("RGBA").tobytes()
        self.assertEqual(actual, bytes(edited))
        self.assertEqual(actual[:offset], before[:offset])
        self.assertEqual(actual[offset + 4 :], before[offset + 4 :])
        metadata = json.loads(active_path.with_suffix(".meta.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["changed_pixel_count"], 1)
        self.assertEqual(metadata["changed_bbox"], [x, y, x + 1, y + 1])
        self.assertEqual(
            self.service.store.resolve_job_path(saved.job_id, original_raw_path).read_bytes(),
            original_raw_bytes,
        )

        reloaded = self.service.get_frame_edit_session(saved.job_id, 1, 0)
        self.assertEqual(reloaded["rgba"], bytes(edited))
        self.assertTrue(reloaded["can_edit"])
        self.assertEqual(reloaded["manual_edit_versions"], 1)

    def test_manual_pixel_edit_can_start_on_an_unmarked_neighbor_frame(self) -> None:
        checked = self._ingest_clean_candidate()
        self.service.review_frame(
            checked.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": IssueType.other.value,
                "reviewer": "neighbor-edit-test",
            },
        )
        original = self._candidate(self.service.get_job(checked.job_id)).frames[1]
        self.assertEqual(original.review_status, ReviewStatus.pending)
        original_raw_path = original.raw_path
        original_raw_bytes = self.service.store.resolve_job_path(
            checked.job_id,
            original_raw_path,
        ).read_bytes()

        session = self.service.get_frame_edit_session(checked.job_id, 1, 1)
        self.assertTrue(session["can_edit"])
        edited = bytearray(session["rgba"])
        opaque_offset = next(
            offset for offset in range(0, len(edited), 4) if edited[offset + 3] > 0
        )
        edited[opaque_offset : opaque_offset + 4] = bytes((0, 0, 0, 0))

        saved = self.service.edit_frame_pixels(
            checked.job_id,
            1,
            1,
            rgba=bytes(edited),
            width=session["width"],
            height=session["height"],
            base_sha256=session["base_sha256"],
            reviewer="neighbor-edit-test",
        )

        frame = self._candidate(saved).frames[1]
        self.assertEqual(frame.manual_edit_versions, 1)
        self.assertEqual(frame.review_status, ReviewStatus.pending)
        self.assertEqual(frame.raw_path, original_raw_path)
        with Image.open(self.service.store.resolve_job_path(saved.job_id, frame.active_path)) as opened:
            saved_rgba = opened.convert("RGBA").tobytes()
        self.assertEqual(saved_rgba[opaque_offset : opaque_offset + 4], bytes((0, 0, 0, 0)))
        self.assertEqual(
            self.service.store.resolve_job_path(saved.job_id, original_raw_path).read_bytes(),
            original_raw_bytes,
        )
        self.assertTrue(self.service.get_frame_edit_session(saved.job_id, 1, 1)["can_edit"])

    def test_manual_pixel_editor_keeps_terminal_candidate_read_only(self) -> None:
        checked = self._ingest_clean_candidate()
        approved = self.service.approve_candidate(
            checked.job_id,
            1,
            reviewer="terminal-edit-test",
            acknowledge_warnings=True,
        )
        session = self.service.get_frame_edit_session(approved.job_id, 1, 1)
        self.assertFalse(session["can_edit"])
        edited = bytearray(session["rgba"])
        edited[0:4] = bytes((1, 2, 3, 255))
        with self.assertRaisesRegex(ConflictError, "terminal candidate"):
            self.service.edit_frame_pixels(
                approved.job_id,
                1,
                1,
                rgba=bytes(edited),
                width=session["width"],
                height=session["height"],
                base_sha256=session["base_sha256"],
            )

    def test_modified_frame_can_be_reapproved_and_exported(self) -> None:
        checked = self._ingest_clean_candidate()
        session = self.service.get_frame_edit_session(checked.job_id, 1, 0)
        edited = bytearray(session["rgba"])
        opaque_offset = next(
            offset for offset in range(0, len(edited), 4) if edited[offset + 3] > 0
        )
        edited[opaque_offset : opaque_offset + 4] = bytes((0, 0, 0, 0))

        saved = self.service.edit_frame_pixels(
            checked.job_id,
            1,
            0,
            rgba=bytes(edited),
            width=session["width"],
            height=session["height"],
            base_sha256=session["base_sha256"],
            reviewer="export-after-edit-test",
        )
        saved_candidate = self._candidate(saved)
        self.assertEqual(saved_candidate.status, CandidateStatus.review_ready)
        self.assertEqual(saved_candidate.frames[0].review_status, ReviewStatus.pending)

        approved = self.service.approve_candidate(
            saved.job_id,
            1,
            reviewer="export-after-edit-test",
            acknowledge_warnings=True,
        )
        self.assertEqual(self._candidate(approved).status, CandidateStatus.approved)
        exported = self.service.export_candidate(approved.job_id, 1)
        self.assertIsNotNone(exported.export)
        assert exported.export is not None
        exported_sheet = self.service.settings.resolve_record_path(exported.export.sheet_path)
        self.assertTrue(exported_sheet.is_file())
        x = (opaque_offset // 4) % session["width"]
        y = (opaque_offset // 4) // session["width"]
        with Image.open(exported_sheet) as sheet:
            self.assertEqual(sheet.convert("RGBA").getpixel((x, y)), (0, 0, 0, 0))

    def test_manual_pixel_edit_reports_real_stale_conflict_between_two_windows(self) -> None:
        checked = self._ingest_clean_candidate()
        self.service.review_frame(
            checked.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": IssueType.other.value,
                "reviewer": "window-test",
            },
        )
        first_window = self.service.get_frame_edit_session(checked.job_id, 1, 0)
        second_window = self.service.get_frame_edit_session(checked.job_id, 1, 0)
        first_pixels = bytearray(first_window["rgba"])
        first_pixels[0:4] = bytes((31, 41, 51, 255))
        saved = self.service.edit_frame_pixels(
            checked.job_id,
            1,
            0,
            rgba=bytes(first_pixels),
            width=first_window["width"],
            height=first_window["height"],
            base_sha256=first_window["base_sha256"],
        )
        self.assertEqual(self._candidate(saved).frames[0].manual_edit_versions, 1)

        second_pixels = bytearray(second_window["rgba"])
        second_pixels[4:8] = bytes((61, 71, 81, 255))
        with self.assertRaises(ConflictError) as raised:
            self.service.edit_frame_pixels(
                checked.job_id,
                1,
                0,
                rgba=bytes(second_pixels),
                width=second_window["width"],
                height=second_window["height"],
                base_sha256=second_window["base_sha256"],
            )
        self.assertEqual(raised.exception.details["reason"], "stale_frame_version")
        persisted = self.service.get_job(checked.job_id)
        self.assertEqual(self._candidate(persisted).frames[0].manual_edit_versions, 1)

    def test_pixel_edit_neighbors_wrap_only_for_looping_actions(self) -> None:
        checked = self._ingest_clean_candidate()
        non_looping = self.service.get_frame_edit_session(checked.job_id, 1, 0)
        self.assertIsNone(non_looping["neighbors"]["previous"])
        with self.service.store.locked_job(checked.job_id) as job:
            job.action.loop_constraint = "Return smoothly to the first frame."
            job.action.loop = True
        looping = self.service.get_frame_edit_session(checked.job_id, 1, 0)
        self.assertEqual(looping["neighbors"]["previous"]["frame_index"], 3)
        self.assertEqual(looping["neighbors"]["next"]["frame_index"], 1)

    def test_broken_neighbor_does_not_block_editing_current_frame(self) -> None:
        checked = self._ingest_clean_candidate()
        candidate = self._candidate(checked)
        next_path = self.service.store.resolve_job_path(checked.job_id, candidate.frames[1].active_path)
        next_path.write_bytes(b"not-a-png")

        session = self.service.get_frame_edit_session(checked.job_id, 1, 0)

        self.assertEqual(len(session["rgba"]), 64 * 64 * 4)
        self.assertIsNone(session["neighbors"]["next"])
        self.assertEqual(session["neighbor_warnings"]["next"]["frame_index"], 1)
        self.assertEqual(
            session["neighbor_warnings"]["next"]["reason"],
            "active_frame_integrity_mismatch",
        )

    def test_rejected_candidate_cannot_be_reopened_or_repaired(self) -> None:
        checked = self._ingest_clean_candidate()
        session = self.service.get_frame_edit_session(checked.job_id, 1, 0)
        self.service.review_frame(
            checked.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": IssueType.other.value,
                "reviewer": "terminal-state-test",
            },
        )
        rejected = self.service.reject_candidate(
            checked.job_id,
            1,
            reviewer="terminal-state-test",
            note="discard this result",
        )
        self.assertEqual(self._candidate(rejected).status, CandidateStatus.rejected)
        self.assertTrue(
            all(frame.review_status == ReviewStatus.rejected for frame in self._candidate(rejected).frames)
        )
        with self.assertRaises(ConflictError) as review_error:
            self.service.review_frame(
                checked.job_id,
                1,
                {
                    "frame_index": 0,
                    "status": "repair_requested",
                    "issue_type": IssueType.other.value,
                    "reviewer": "terminal-state-test",
                },
            )
        self.assertEqual(review_error.exception.details["reason"], "terminal_candidate")
        edited = bytearray(session["rgba"])
        edited[0:4] = bytes((171, 172, 173, 255))
        with self.assertRaises(ConflictError) as edit_error:
            self.service.edit_frame_pixels(
                checked.job_id,
                1,
                0,
                rgba=bytes(edited),
                width=session["width"],
                height=session["height"],
                base_sha256=session["base_sha256"],
            )
        self.assertEqual(edit_error.exception.details["reason"], "terminal_candidate")

    def test_manual_pixel_version_remains_saved_when_automatic_recheck_fails(self) -> None:
        checked = self._ingest_clean_candidate()
        self.service.review_frame(
            checked.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": IssueType.other.value,
                "reviewer": "qa-failure-test",
            },
        )
        session = self.service.get_frame_edit_session(checked.job_id, 1, 0)
        edited = bytearray(session["rgba"])
        edited[0:4] = bytes((101, 102, 103, 255))
        with patch.object(
            self.service,
            "_run_candidate_qa",
            side_effect=RuntimeError("forced QA failure"),
        ):
            saved = self.service.edit_frame_pixels(
                checked.job_id,
                1,
                0,
                rgba=bytes(edited),
                width=session["width"],
                height=session["height"],
                base_sha256=session["base_sha256"],
            )

        candidate = self._candidate(saved)
        frame = candidate.frames[0]
        self.assertEqual(frame.manual_edit_versions, 1)
        self.assertEqual(candidate.status, CandidateStatus.check_failed)
        self.assertEqual(candidate.error["code"], "qa_execution_error")
        self.assertIn("forced QA failure", candidate.error["message"])
        active_path = self.service.store.resolve_job_path(saved.job_id, frame.active_path)
        with Image.open(active_path) as opened:
            self.assertEqual(opened.convert("RGBA").tobytes(), bytes(edited))

    def test_repair_qa_summary_tracks_resolved_new_and_persisting_issues(self) -> None:
        checked = self._ingest_clean_candidate()
        with self.service.store.locked_job(checked.job_id) as job:
            candidate = self._candidate(job)
            candidate.hard_failures = [
                QAIssue(
                    code="centroid_jump",
                    severity=IssueSeverity.hard_failure,
                    message="old jump measurement",
                    frame_index=1,
                    metrics={"distance": 20.0},
                )
            ]
            candidate.warnings = [
                QAIssue(
                    code="palette_deviation",
                    severity=IssueSeverity.warning,
                    message="old palette scope",
                    frame_index=2,
                    metrics={"ratio": 0.41},
                ),
                QAIssue(
                    code="consecutive_duplicate_frames",
                    severity=IssueSeverity.warning,
                    message="old frame run",
                    metrics={"frame_indices": [1, 2, 3], "similarity": 0.99},
                ),
                QAIssue(
                    code="frame_position_jump",
                    severity=IssueSeverity.warning,
                    message="old transition",
                    metrics={"from": 0, "to": 1, "dx": 9},
                ),
            ]

        self.service.review_frame(
            checked.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": IssueType.other.value,
                "reviewer": "qa-delta-test",
            },
        )
        session = self.service.get_frame_edit_session(checked.job_id, 1, 0)
        edited = bytearray(session["rgba"])
        edited[0:4] = bytes((111, 112, 113, 255))
        post_repair_report = {
            "hard_failures": [
                {
                    "code": "centroid_jump",
                    "message": "new jump measurement",
                    "frame_index": 1,
                    "distance": 3.5,
                }
            ],
            "warnings": [
                {
                    "code": "palette_deviation",
                    "message": "same code, new frame scope",
                    "frame_index": 3,
                    "ratio": 0.12,
                },
                {
                    "code": "consecutive_duplicate_frames",
                    "message": "same run with reordered indices",
                    "frame_indices": [3, 1, 2],
                    "similarity": 0.73,
                },
                {
                    "code": "frame_position_jump",
                    "message": "same transition with a lower displacement",
                    "from": 0,
                    "to": 1,
                    "dx": 2,
                },
                {
                    "code": "touches_canvas_edge",
                    "message": "new issue",
                    "frame_index": 0,
                },
            ],
            "frames": [],
        }
        with patch("sprite_pipeline.processing.run_qa", return_value=post_repair_report):
            updated = self.service.edit_frame_pixels(
                checked.job_id,
                1,
                0,
                rgba=bytes(edited),
                width=session["width"],
                height=session["height"],
                base_sha256=session["base_sha256"],
            )

        candidate = self._candidate(updated)
        summary = candidate.qa_change_summary
        self.assertIsNotNone(summary)
        self.assertIsNone(candidate.qa_issue_baseline)
        self.assertEqual(
            {(item.code, item.frame_index) for item in summary.resolved},
            {("palette_deviation", 2)},
        )
        self.assertEqual(
            {(item.code, item.frame_index) for item in summary.new},
            {("palette_deviation", 3), ("touches_canvas_edge", 0)},
        )
        self.assertEqual(
            {item.code for item in summary.persisting},
            {"centroid_jump", "consecutive_duplicate_frames", "frame_position_jump"},
        )
        persisted = self.service.get_job(checked.job_id).candidates[0].qa_change_summary
        self.assertEqual(persisted.model_dump(mode="json"), summary.model_dump(mode="json"))

    def test_external_repair_keeps_qa_baseline_through_failure_and_retry(self) -> None:
        checked = self._ingest_clean_candidate()
        with self.service.store.locked_job(checked.job_id) as job:
            candidate = self._candidate(job)
            candidate.warnings = [
                QAIssue(
                    code="area_change",
                    severity=IssueSeverity.warning,
                    message="baseline issue",
                    frame_index=0,
                    metrics={"ratio": 0.5},
                )
            ]
        self.service.review_frame(
            checked.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": IssueType.other.value,
                "reviewer": "qa-retry-test",
            },
        )
        session = self.service.get_frame_edit_session(checked.job_id, 1, 0)
        replacement = self.root / "incoming" / "qa_retry_replacement.png"
        self.harness.write_frame(replacement, shift_x=-1)
        with patch.object(
            self.service,
            "_run_candidate_qa",
            side_effect=RuntimeError("forced repair QA failure"),
        ):
            failed = self.service.replace_frame(
                checked.job_id,
                1,
                0,
                replacement,
                base_sha256=session["base_sha256"],
            )

        failed_candidate = self._candidate(failed)
        self.assertEqual(failed_candidate.status, CandidateStatus.check_failed)
        self.assertIsNotNone(failed_candidate.qa_issue_baseline)
        self.assertIsNone(failed_candidate.qa_change_summary)
        self.assertEqual(
            [item.code for item in failed_candidate.qa_issue_baseline.issues],
            ["area_change"],
        )

        with patch(
            "sprite_pipeline.processing.run_qa",
            return_value={"hard_failures": [], "warnings": [], "frames": []},
        ):
            retried = self.service.check_candidate(checked.job_id, 1)
        retried_candidate = self._candidate(retried)
        self.assertIsNone(retried_candidate.qa_issue_baseline)
        self.assertEqual(
            [item.code for item in retried_candidate.qa_change_summary.resolved],
            ["area_change"],
        )
        self.assertEqual(retried_candidate.qa_change_summary.new, [])
        self.assertEqual(retried_candidate.qa_change_summary.persisting, [])

    def test_old_job_json_without_qa_change_fields_remains_readable(self) -> None:
        checked = self._ingest_clean_candidate()
        job_path = self.service.store.job_dir(checked.job_id) / "job.json"
        payload = json.loads(job_path.read_text(encoding="utf-8"))
        for candidate in payload["candidates"]:
            candidate.pop("qa_issue_baseline", None)
            candidate.pop("qa_change_summary", None)
        self.harness._write_json(job_path, payload)

        loaded = self.service.get_job(checked.job_id)
        self.assertIsNone(loaded.candidates[0].qa_issue_baseline)
        self.assertIsNone(loaded.candidates[0].qa_change_summary)

    def test_pixel_edit_api_reports_saved_when_automatic_recheck_fails(self) -> None:
        from fastapi.testclient import TestClient

        from sprite_pipeline.api_app import create_api

        checked = self._ingest_clean_candidate()
        self.service.review_frame(
            checked.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": IssueType.other.value,
                "reviewer": "api-qa-failure-test",
            },
        )
        session = self.service.get_frame_edit_session(checked.job_id, 1, 0)
        edited = bytearray(session["rgba"])
        edited[0:4] = bytes((151, 152, 153, 255))
        with (
            patch.object(
                self.service,
                "_run_candidate_qa",
                side_effect=RuntimeError("forced API QA failure"),
            ),
            TestClient(create_api(self.root, service=self.service)) as client,
        ):
            response = client.post(
                f"/v1/jobs/{checked.job_id}/candidates/1/frames/0/pixel-edit",
                json={
                    "width": session["width"],
                    "height": session["height"],
                    "rgba_base64": base64.b64encode(edited).decode("ascii"),
                    "base_sha256": session["base_sha256"],
                    "reviewer": "api-qa-failure-test",
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        edit = response.json()["data"]["edit"]
        self.assertTrue(edit["saved"])
        self.assertFalse(edit["qa"]["ok"])
        self.assertEqual(edit["qa"]["candidate_status"], "check_failed")
        self.assertEqual(edit["qa"]["error"]["code"], "qa_execution_error")
        self.assertEqual(
            self.service.get_job(checked.job_id).candidates[0].frames[0].manual_edit_versions,
            1,
        )

    def test_pixel_edit_api_does_not_report_qa_success_when_recheck_never_started(self) -> None:
        from fastapi.testclient import TestClient

        from sprite_pipeline.api_app import create_api

        checked = self._ingest_clean_candidate()
        self.service.review_frame(
            checked.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": IssueType.other.value,
                "reviewer": "api-precheck-failure-test",
            },
        )
        session = self.service.get_frame_edit_session(checked.job_id, 1, 0)
        edited = bytearray(session["rgba"])
        edited[0:4] = bytes((161, 162, 163, 255))
        with (
            patch.object(self.service, "check_candidate", side_effect=RuntimeError("failed before QA lock")),
            TestClient(create_api(self.root, service=self.service)) as client,
        ):
            response = client.post(
                f"/v1/jobs/{checked.job_id}/candidates/1/frames/0/pixel-edit",
                json={
                    "width": session["width"],
                    "height": session["height"],
                    "rgba_base64": base64.b64encode(edited).decode("ascii"),
                    "base_sha256": session["base_sha256"],
                    "reviewer": "api-precheck-failure-test",
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        edit = response.json()["data"]["edit"]
        self.assertTrue(edit["saved"])
        self.assertFalse(edit["qa"]["ok"])
        self.assertFalse(edit["qa"]["completed"])

    def test_manual_pixel_edits_are_unbounded_and_reject_stale_or_invalid_data(self) -> None:
        current = self._ingest_clean_candidate()
        stale_sha256 = None
        for version in range(1, 4):
            self.service.review_frame(
                current.job_id,
                1,
                {
                    "frame_index": 0,
                    "status": "repair_requested",
                    "issue_type": IssueType.other.value,
                    "note": f"manual edit {version}",
                    "reviewer": "integration-test",
                },
            )
            session = self.service.get_frame_edit_session(current.job_id, 1, 0)
            if stale_sha256 is None:
                stale_sha256 = session["base_sha256"]
            edited = bytearray(session["rgba"])
            offset = (version * session["width"] + version) * 4
            edited[offset : offset + 4] = bytes((version, version + 10, version + 20, 255))
            current = self.service.edit_frame_pixels(
                current.job_id,
                1,
                0,
                rgba=bytes(edited),
                width=session["width"],
                height=session["height"],
                base_sha256=session["base_sha256"],
            )
            self.assertEqual(self._candidate(current).frames[0].manual_edit_versions, version)

        self.service.review_frame(
            current.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": IssueType.other.value,
                "reviewer": "integration-test",
            },
        )
        latest = self.service.get_frame_edit_session(current.job_id, 1, 0)
        changed = bytearray(latest["rgba"])
        changed[0:4] = bytes((200, 100, 50, 255))
        with self.assertRaisesRegex(ConflictError, "stale"):
            self.service.edit_frame_pixels(
                current.job_id,
                1,
                0,
                rgba=bytes(changed),
                width=latest["width"],
                height=latest["height"],
                base_sha256=str(stale_sha256),
            )
        with self.assertRaisesRegex(ValidationHarnessError, "byte count"):
            self.service.edit_frame_pixels(
                current.job_id,
                1,
                0,
                rgba=b"short",
                width=latest["width"],
                height=latest["height"],
                base_sha256=latest["base_sha256"],
            )
        persisted = self.service.get_job(current.job_id)
        self.assertEqual(self._candidate(persisted).frames[0].manual_edit_versions, 3)

    def test_pixel_editor_page_and_rest_round_trip(self) -> None:
        from fastapi.testclient import TestClient

        from sprite_pipeline.api_app import create_api

        checked = self._ingest_clean_candidate()
        self.service.review_frame(
            checked.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": IssueType.other.value,
                "reviewer": "api-test",
            },
        )
        with TestClient(create_api(self.root)) as client:
            page = client.get(
                f"/pixel-editor?job_id={checked.job_id}&candidate=1&frame=0"
            )
            self.assertEqual(page.status_code, 200)
            self.assertEqual(page.headers["cache-control"], "no-store")
            self.assertIn("精确像素画布", page.text)
            self.assertIn("精确填充", page.text)
            self.assertIn("洋葱皮", page.text)
            self.assertIn("retryLoadButton", page.text)
            self.assertIn("__spritePixelEditorBoot", page.text)
            self.assertIn("pixel_editor.css?v=8", page.text)
            self.assertIn("pixel_editor.js?v=7", page.text)
            script = client.get("/pixel-editor-assets/pixel_editor.js?v=7")
            self.assertEqual(script.status_code, 200)
            self.assertEqual(script.headers["cache-control"], "no-store, max-age=0")
            self.assertIn("imageSmoothingEnabled = false", script.text)
            self.assertIn("submittedPixels", script.text)

            frame_artifact = client.get(
                f"/v1/jobs/{checked.job_id}/candidates/1/frames/0/image"
            )
            self.assertEqual(frame_artifact.status_code, 200, frame_artifact.text)
            self.assertEqual(frame_artifact.headers["content-type"], "image/png")
            self.assertTrue(frame_artifact.content.startswith(b"\x89PNG\r\n\x1a\n"))
            missing_artifact = client.get(
                f"/v1/jobs/{checked.job_id}/candidates/1/frames/999/image"
            )
            self.assertEqual(missing_artifact.status_code, 404)

            response = client.get(
                f"/v1/jobs/{checked.job_id}/candidates/1/frames/0/pixel-edit"
            )
            self.assertEqual(response.status_code, 200)
            session = response.json()["data"]["session"]
            self.assertIsNone(session["neighbors"]["previous"])
            self.assertEqual(session["neighbors"]["next"]["frame_index"], 1)
            self.assertNotIn("rgba", session["neighbors"]["next"])
            self.assertEqual(
                len(base64.b64decode(session["neighbors"]["next"]["rgba_base64"])),
                session["width"] * session["height"] * 4,
            )
            pixels = bytearray(base64.b64decode(session["rgba_base64"]))
            opaque_offset = next(
                offset for offset in range(0, len(pixels), 4) if pixels[offset + 3] > 0
            )
            original_pixel = bytes(pixels[opaque_offset : opaque_offset + 4])
            self.assertNotEqual(original_pixel, bytes((0, 0, 0, 0)))
            pixels[opaque_offset : opaque_offset + 4] = bytes((0, 0, 0, 0))
            saved = client.post(
                f"/v1/jobs/{checked.job_id}/candidates/1/frames/0/pixel-edit",
                json={
                    "width": session["width"],
                    "height": session["height"],
                    "rgba_base64": base64.b64encode(pixels).decode("ascii"),
                    "base_sha256": session["base_sha256"],
                    "reviewer": "api-test",
                },
            )
            self.assertEqual(saved.status_code, 200, saved.text)
            edit = saved.json()["data"]["edit"]
            self.assertTrue(edit["saved"])
            self.assertTrue(edit["qa"]["ok"])
            self.assertEqual(edit["manual_edit_versions"], 1)
            reloaded = client.get(
                f"/v1/jobs/{checked.job_id}/candidates/1/frames/0/pixel-edit"
            )
            self.assertEqual(reloaded.status_code, 200)
            reloaded_pixels = base64.b64decode(
                reloaded.json()["data"]["session"]["rgba_base64"]
            )
            self.assertEqual(
                reloaded_pixels[opaque_offset : opaque_offset + 4],
                bytes((0, 0, 0, 0)),
            )

    def test_codex_cli_can_commit_a_manual_pixel_edit_version(self) -> None:
        checked = self._ingest_clean_candidate()
        self.service.review_frame(
            checked.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": IssueType.other.value,
                "reviewer": "cli-test",
            },
        )
        session = self.service.get_frame_edit_session(checked.job_id, 1, 0)
        edited = bytearray(session["rgba"])
        edited[4:8] = bytes((11, 22, 33, 255))
        source = self.root / "incoming" / "codex_pixel_edit.png"
        source.parent.mkdir(parents=True, exist_ok=True)
        Image.frombytes(
            "RGBA",
            (session["width"], session["height"]),
            bytes(edited),
        ).save(source, format="PNG")

        payload = self._run_cli(
            "pixel-edit-frame",
            "--job",
            checked.job_id,
            "--candidate",
            "1",
            "--frame",
            "0",
            "--source",
            str(source),
            "--base-sha256",
            session["base_sha256"],
            "--reviewer",
            "codex",
        )

        self.assertEqual(payload["operation"], "pixel-edit-frame")
        frame = payload["data"]["job"]["candidates"][0]["frames"][0]
        self.assertEqual(frame["manual_edit_versions"], 1)
        self.assertEqual(frame["repair_attempts"], 0)

    def test_codex_cli_requires_source_frame_sha_for_pixel_edit(self) -> None:
        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "sprite_pipeline.cli",
                "--root",
                str(self.root),
                "pixel-edit-frame",
                "--job",
                "job-placeholder",
                "--candidate",
                "1",
                "--frame",
                "0",
                "--source",
                str(self.root / "missing.png"),
            ],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
            check=False,
        )
        self.assertEqual(completed.returncode, 2)
        payload = json.loads(completed.stdout.strip())
        self.assertEqual(payload["error"]["code"], "argument_error")
        self.assertIn("--base-sha256", payload["error"]["message"])

    def test_cli_list_create_status_are_single_line_json_contracts(self) -> None:
        listed = self._run_cli("list-presets")
        self.assertEqual(listed["operation"], "list-presets")
        self.assertEqual([item["id"] for item in listed["data"]["characters"]], [self.harness.character_id])
        self.assertEqual([item["id"] for item in listed["data"]["actions"]], [self.harness.action_id])

        created = self._run_cli(
            "create",
            "--character",
            self.harness.character_id,
            "--action",
            self.harness.action_id,
            "--provider",
            "import",
            "--candidates",
            "1",
            "--seed",
            "7",
        )
        self.assertEqual(created["operation"], "create")
        job_id = created["data"]["job"]["job_id"]

        status = self._run_cli("status", "--job", job_id)
        self.assertEqual(status["operation"], "status")
        self.assertEqual(status["data"]["job"]["job_id"], job_id)
        self.assertEqual(status["data"]["job"]["status"], "created")

        safety = self._run_cli(
            "safety",
            "--job",
            job_id,
            "--candidate",
            "1",
        )
        self.assertEqual(safety["operation"], "safety")
        self.assertEqual(safety["data"]["safety"]["stage"], "created")
        self.assertTrue(safety["data"]["safety"]["local_task_saved"])
        self.assertFalse(
            safety["data"]["safety"]["automatic_resubmission_allowed"]
        )

        estimate = self._run_cli(
            "estimate",
            "--character",
            self.harness.character_id,
            "--action",
            self.harness.action_id,
            "--candidates",
            "2",
        )
        self.assertEqual(estimate["operation"], "estimate")
        self.assertEqual(
            estimate["data"]["estimate"]["maximum_generation_units"],
            2,
        )

        jobs = self._run_cli("list-jobs")
        self.assertEqual(jobs["operation"], "list-jobs")
        self.assertEqual([item["job_id"] for item in jobs["data"]["jobs"]], [job_id])

    def test_provider_count_difference_preserves_frames_and_pads_sheet(self) -> None:
        frame_dir = self.root / "provider_fixture" / "five_frames"
        images = [
            path.read_bytes()
            for path in self.harness.write_sequence(frame_dir, shifts=(0, 1, 2, 3, 4))
        ]
        job = self.service.create_job(self.harness.create_request("pixellab"))
        provider_job_id = "provider-returned-five"
        with self.service.store.locked_job(job.job_id) as failed_job:
            candidate = self._candidate(failed_job)
            candidate.status = CandidateStatus.failed
            candidate.provider_name = "pixellab"
            candidate.provider_model = "animate-with-text-v3"
            candidate.provider_job_id = provider_job_id
            candidate.provider_status = "completed"
            candidate.error = {
                "code": "provider_contract_error",
                "message": "provider returned a different frame count than requested",
                "details": {"expected": 4, "actual": 5},
            }
            failed_job.status = JobStatus.failed

        provider = CompletingThenFailingPollProvider(images)
        provider.release_first.set()
        with patch("sprite_pipeline.providers.get_provider", return_value=provider):
            generated = self.service.recover_completed_candidate(
                job.job_id,
                1,
            )

        candidate = self._candidate(generated)
        self.assertEqual(candidate.status, CandidateStatus.review_ready)
        self.assertEqual(len(candidate.frames), 5)
        self.assertEqual(candidate.hard_failures, [])
        self.assertIn(
            "provider_frame_count_adjusted",
            [warning.code for warning in candidate.warnings],
        )

        raw_dir = self.service.store.job_dir(job.job_id) / "raw" / "candidate_01"
        manifest = json.loads((raw_dir / "frames_manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["requested_provider_frame_count"], 4)
        self.assertEqual(manifest["provider_frame_count"], 5)
        self.assertEqual(manifest["project_frame_count"], 5)
        self.assertEqual(manifest["frame_count_policy"], "preserve_all_returned")
        self.assertEqual(manifest["provider_frame_selection"], [0, 1, 2, 3, 4])

        preview_path = self.service.store.job_dir(job.job_id) / "previews" / "candidate_01.sheet.png"
        with Image.open(preview_path) as opened:
            preview = opened.convert("RGBA")
        self.assertEqual(preview.size, (256, 128))
        for column in (1, 2, 3):
            alpha = preview.getchannel("A").crop((column * 64, 64, (column + 1) * 64, 128))
            self.assertIsNone(alpha.getbbox(), column)

        self.service.approve_candidate(
            job.job_id,
            1,
            reviewer="frame-count-compatibility-test",
            acknowledge_warnings=True,
        )
        exported = self.service.export_candidate(job.job_id, 1)
        assert exported.export is not None
        with Image.open(self.root / exported.export.sheet_path) as opened:
            self.assertEqual(opened.size, (256, 128))
        recipe = json.loads((self.root / exported.export.recipe_path).read_text(encoding="utf-8"))
        self.assertEqual(recipe["frame_count"], 5)
        self.assertEqual(recipe["rows"], 2)
        self.assertEqual([tuple(cell) for cell in recipe["unused_cells"]], [(1, 1), (2, 1), (3, 1)])

    def test_pixellab_preserves_valid_images_when_return_count_differs(self) -> None:
        frame_payloads: list[bytes] = []
        for shift in range(5):
            frame_path = self.root / "provider_fixture" / f"extra_frame_{shift}.png"
            self.harness.write_frame(frame_path, shift_x=shift)
            frame_payloads.append(frame_path.read_bytes())
        encoded_frames = [
            {"type": "base64", "format": "png", "base64": base64.b64encode(payload).decode("ascii")}
            for payload in frame_payloads
        ]
        client = FakePixelLabClient(
            FakeResponse({"background_job_id": "job-extra", "status": "processing"}),
            FakeResponse(
                {
                    "status": "completed",
                    "last_response": {"images": encoded_frames, "frame_count": 4},
                    "usage": {"credits": 1},
                }
            ),
        )
        provider = PixelLabProvider(
            api_key="local-test-token",
            base_url="https://unit.invalid",
            http_client=client,
            max_get_retries=0,
        )
        submission = provider.submit(
            ProviderRequest(
                reference_image=self.harness.reference_path.read_bytes(),
                prompt="Move through four precise test poses.",
                frame_count=4,
                seed=123,
                transparent_background=True,
            )
        )

        completed = provider.poll(submission.provider_job_id)

        self.assertEqual(completed.status, PollStatus.completed)
        self.assertEqual(len(completed.images), 5)
        self.assertEqual(
            completed.raw_response["harness_frame_count"],
            {
                "requested": 4,
                "declared": 4,
                "returned": 5,
                "policy": "preserve_all_returned_images",
            },
        )

    def test_pixellab_contract_with_injected_client_is_offline_and_redacted(self) -> None:
        frame_payloads: list[bytes] = []
        for shift in range(4):
            frame_path = self.root / "provider_fixture" / f"frame_{shift}.png"
            self.harness.write_frame(frame_path, shift_x=shift)
            frame_payloads.append(frame_path.read_bytes())
        encoded_frames = [
            {"type": "base64", "format": "png", "base64": base64.b64encode(payload).decode("ascii")}
            for payload in frame_payloads
        ]
        client = FakePixelLabClient(
            FakeResponse({"background_job_id": "job-123", "status": "processing"}),
            FakeResponse(
                {
                    "status": "completed",
                    "last_response": {"images": encoded_frames, "frame_count": 4},
                    "usage": {"credits": 1},
                }
            ),
        )
        provider = PixelLabProvider(
            api_key="super-secret-token",
            base_url="https://unit.invalid",
            http_client=client,
            max_get_retries=0,
        )
        request = ProviderRequest(
            reference_image=self.harness.reference_path.read_bytes(),
            prompt="Move through four precise test poses.",
            frame_count=4,
            seed=123,
            transparent_background=True,
        )

        submission = provider.submit(request)
        self.assertEqual(len(client.post_calls), 1)
        post_url, post_json = client.post_calls[0]
        self.assertEqual(post_url, "https://unit.invalid/v2/animate-with-text-v3")
        self.assertEqual(
            set(post_json),
            {"first_frame", "action", "frame_count", "no_background", "seed"},
        )
        self.assertEqual(
            set(post_json["first_frame"]),
            {"type", "base64", "format"},
        )
        self.assertEqual(post_json["action"], request.prompt)
        self.assertEqual(post_json["frame_count"], 4)
        self.assertIs(post_json["no_background"], True)
        self.assertEqual(post_json["seed"], 123)
        self.assertEqual(submission.request_record["path"], "/v2/animate-with-text-v3")
        persisted_request = json.dumps(submission.request_record, sort_keys=True)
        self.assertNotIn("super-secret-token", persisted_request)
        self.assertNotIn("Authorization", persisted_request)
        self.assertNotIn(post_json["first_frame"]["base64"], persisted_request)

        completed = provider.poll(submission.provider_job_id)
        self.assertEqual(client.get_calls, ["https://unit.invalid/v2/background-jobs/job-123"])
        self.assertEqual(completed.status, PollStatus.completed)
        self.assertEqual(len(completed.images), 4)
        for normalized in completed.images:
            self.assertTrue(normalized.startswith(b"\x89PNG\r\n\x1a\n"))
            with Image.open(io.BytesIO(normalized)) as image:
                self.assertEqual(image.format, "PNG")
                self.assertEqual(image.mode, "RGBA")
                self.assertEqual(image.size, (64, 64))


if __name__ == "__main__":
    unittest.main()
