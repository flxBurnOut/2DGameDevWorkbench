from __future__ import annotations

import hashlib
import io
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TYPE_CHECKING

from PIL import Image

from .errors import NotFoundError, ValidationHarnessError
from .jsonio import atomic_write_json, inside, read_json

if TYPE_CHECKING:
    from .service import SpritePipelineService

KIND_LABELS = {"character": "角色原图", "animation": "动画", "map": "地图"}
ACTION_LABELS = {"edit_reference": "编辑原图", "generate": "制作动作", "edit": "继续编辑", "review": "检查动画", "export": "导出", "download": "导出原图"}


def animation_title(character: str, action: str) -> str:
    character, action = character.strip(), action.strip()
    return action if character.casefold() in action.casefold() else f"{character} · {action}"


def animation_actions(material: dict[str, Any], qa_version: str) -> tuple[str, list[str]]:
    """Offer only operations supported by the durable candidate state."""
    current = material.get("qa_ready") and material.get("qa_algorithm_version") == qa_version
    if material.get("exported"):
        return "已导出", ["export", "review"]
    status = material.get("status")
    if status == "approved":
        if current and not material.get("hard_failure_count"):
            return "可导出", ["export", "review"]
        return "需要重新检查", ["review"]
    if status in {"rejected", "failed"}:
        return "已保留画面 · 查看记录", ["review"]
    if status in {"submitting", "submission_unknown", "provider_pending", "saving", "created"}:
        return "处理中 · 查看记录", []
    if material.get("hard_failure_count") or material.get("repair_frame_count"):
        return "待修补", ["edit", "review"]
    if material.get("modified"):
        return "已修改 · 待检查", ["edit", "review"]
    return "待检查", ["review", "edit"]


class ArtworkLibrary:
    """Project materials indexed independently from execution history.

    Animation metadata comes from summary.json, characters from their presets,
    and standalone maps from a small immutable import manifest. Images are only
    decoded for the visible page; full job records are opened by explicit actions.
    """

    def __init__(self, service: SpritePipelineService) -> None:
        self.service = service
        self.maps_dir = service.settings.data_root / "artworks" / "maps"

    def list_artworks(self) -> list[dict[str, Any]]:
        from .service import QA_ALGORITHM_VERSION

        result: list[dict[str, Any]] = []
        for row in self.service.presets.list_characters():
            if row["id"] == "diagnostic_dummy" or not row.get("valid"):
                continue
            try:
                character, path = self.service.presets.load_character(str(row["id"]))
                reference = inside(path.parent, path.parent / (character.master or character.reference_frame))
                result.append({
                    "id": f"character:{character.character_id}", "kind": "character",
                    "title": character.display_name, "character_id": character.character_id,
                    "subtitle": f"{character.cell_width} × {character.cell_height}",
                    "status_label": "内置角色" if row.get("source") == "bundled" else "可制作动作",
                    "actions": ["generate", "edit_reference", "download"], "source": str(reference),
                    "fallback": str(reference), "updated_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
                })
            except (OSError, ValueError, ValidationHarnessError):
                continue
        # Workbench history archiving must not hide durable artwork.
        for row in self.service.list_jobs(include_archived=True):
            if row.get("execution_only") or row.get("status") == "invalid" or row.get("provider") == "fixture" or row.get("character_id") == "diagnostic_dummy":
                continue
            for material in row.get("artworks", []):
                if material.get("diagnostic_only") or not material.get("frame_count"):
                    continue
                try:
                    fallback = self.service.store.resolve_job_path(row["job_id"], material["first_frame"])
                    preview = self.service.store.resolve_job_path(row["job_id"], material["preview"])
                    status, actions = animation_actions(material, QA_ALGORITHM_VERSION)
                    current = material.get("qa_ready") and material.get("qa_algorithm_version") == QA_ALGORITHM_VERSION
                    result.append({
                        "id": f"animation:{row['job_id']}:{material['candidate_index']}",
                        "kind": "animation", "title": animation_title(row.get('character_name') or row['character_id'], row.get('action_name') or row['action_id']),
                        "character_id": row["character_id"], "job_id": row["job_id"],
                        "candidate_index": material["candidate_index"],
                        "subtitle": f"{material['frame_count']} 帧 · 版本 {material['candidate_index']}",
                        "status_label": status, "actions": actions,
                        "source": str(preview if current else fallback), "fallback": str(fallback),
                        "updated_at": row["updated_at"],
                    })
                except (KeyError, ValueError, ValidationHarnessError):
                    continue
        for manifest in sorted(self.maps_dir.glob("*/artwork.json")):
            try:
                row = read_json(manifest)
                source = inside(self.maps_dir, manifest.parent / row["filename"])
                if row["kind"] != "map" or row["id"] != f"map:{manifest.parent.name}":
                    continue
                result.append({**row, "source": str(source), "fallback": str(source),
                               "status_label": "已保存原图", "actions": ["download"]})
            except (OSError, ValueError, KeyError, ValidationHarnessError):
                continue
        return sorted(result, key=lambda row: (row["updated_at"], row["id"]), reverse=True)

    def get(self, artwork_id: str) -> dict[str, Any]:
        # Re-resolve on every action; card state is never authorization to edit.
        for row in self.list_artworks():
            if row["id"] == artwork_id:
                return row
        raise NotFoundError("作品不存在或当前无法读取，请刷新作品库")

    @staticmethod
    def filter_page(rows: list[dict[str, Any]], kind: str, query: str, page: int, page_size: int = 12) -> tuple[list[dict[str, Any]], int, int]:
        needle = (query or "").strip().casefold()
        filtered = [row for row in rows if (kind == "all" or row["kind"] == kind)
                    and (not needle or needle in f"{row['title']} {row['subtitle']} {row['status_label']}".casefold())]
        pages = max(1, (len(filtered) + page_size - 1) // page_size)
        selected = max(1, min(int(page or 1), pages))
        return filtered[(selected - 1) * page_size:selected * page_size], selected, len(filtered)

    def preview_source(self, row: dict[str, Any]) -> Path | None:
        for value in dict.fromkeys((row["source"], row["fallback"])):
            path = Path(value)
            if path.is_file():
                return path
        return None

    def thumbnail(self, row: dict[str, Any]) -> str | None:
        """Bounded preview cache; no changes to source pixels or QA records."""
        try:
            source = self.preview_source(row)
            if source is None:
                return None
            stat = source.stat()
            key = hashlib.sha256(f"thumb-v1:{source}:{stat.st_size}:{stat.st_mtime_ns}".encode()).hexdigest()
            cache = self.service.settings.cache_dir / "artwork_thumbnails"
            cache.mkdir(parents=True, exist_ok=True)
            animated = source.suffix.lower() == ".gif"
            destination = cache / (key + (".gif" if animated else ".png"))
            if destination.is_file():
                return str(destination)
            frames: list[Image.Image] = []
            durations: list[int] = []
            with Image.open(source) as original:
                if original.width * original.height > 16_777_216:
                    return None
                for index in range(min(getattr(original, "n_frames", 1), 64)):
                    original.seek(index)
                    frame = original.convert("RGBA")
                    frame.thumbnail((256, 256), Image.Resampling.NEAREST)
                    frames.append(frame)
                    durations.append(max(20, int(original.info.get("duration", 100))))
            fd, temporary = tempfile.mkstemp(prefix=".thumb-", suffix=destination.suffix, dir=cache)
            os.close(fd)
            try:
                if animated:
                    frames[0].save(temporary, format="GIF", save_all=True, append_images=frames[1:],
                                   duration=durations, loop=0, disposal=2)
                else:
                    frames[0].save(temporary, format="PNG")
                os.replace(temporary, destination)
            finally:
                Path(temporary).unlink(missing_ok=True)
            return str(destination)
        except (OSError, ValueError, Image.DecompressionBombError):
            return None

    def import_map(self, source: str | Path, title: str = "") -> dict[str, Any]:
        path = Path(source)
        if not path.is_file() or path.stat().st_size > 32 * 1024 * 1024:
            raise ValidationHarnessError("请选择不超过 32 MB 的地图图片")
        payload = path.read_bytes()
        try:
            with Image.open(io.BytesIO(payload)) as image:
                if image.format not in {"PNG", "JPEG", "WEBP"} or getattr(image, "n_frames", 1) != 1:
                    raise ValueError("unsupported image")
                if image.width * image.height > 16_777_216:
                    raise ValueError("image too large")
                image.load()
                width, height = image.size
                suffix = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}[image.format]
        except Exception as exc:
            raise ValidationHarnessError("地图需为静态 PNG、JPEG 或 WebP，且不超过 1600 万像素") from exc
        digest = hashlib.sha256(payload).hexdigest()
        artwork_id = f"map:{digest}"
        with self.service.store.global_lock("artwork_import"):
            destination = self.maps_dir / digest
            if (destination / "artwork.json").is_file():
                return self.get(artwork_id)
            self.maps_dir.mkdir(parents=True, exist_ok=True)
            staging = Path(tempfile.mkdtemp(prefix=".import-", dir=self.maps_dir))
            try:
                filename = "original" + suffix
                (staging / filename).write_bytes(payload)
                atomic_write_json(staging / "artwork.json", {
                    "schema_version": 1, "id": artwork_id, "kind": "map",
                    "title": (title.strip() or path.stem)[:120], "filename": filename,
                    "subtitle": f"{width} × {height}", "sha256": digest,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                })
                os.replace(staging, destination)
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
        return self.get(artwork_id)
