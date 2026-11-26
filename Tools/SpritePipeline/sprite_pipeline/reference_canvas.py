"""Local, versioned reference editing. No generation jobs or provider calls."""
from __future__ import annotations

import base64
import re
import uuid
from pathlib import Path
from typing import Any

from PIL import Image

from .errors import ConflictError, NotFoundError, ValidationHarnessError
from .jsonio import atomic_write_json, read_json, sha256_file
from .models import CharacterPreset
from .processing._common import atomic_save_png


class ReferenceCanvas:
    def __init__(self, service: Any) -> None:
        self.service = service
        self.root = service.settings.data_root / "reference-edits"

    def directory(self, edit_id: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{32}", edit_id):
            raise ValidationHarnessError("原图画布编号无效")
        directory = self.root / edit_id
        if not (directory / "edit.json").is_file():
            raise NotFoundError("原图画布不存在，请重新打开原图")
        return directory

    def start_character(self, character_id: str) -> dict[str, Any]:
        character, path = self.service.presets.load_character(character_id)
        with Image.open(path.parent / character.reference_frame) as image:
            return self.start(image, character)

    def start(self, image: Image.Image, character: CharacterPreset) -> dict[str, Any]:
        if image.size not in ((64, 64), (128, 128)) or image.size != (character.cell_width, character.cell_height):
            raise ValidationHarnessError("像素画布需要一张 64×64 或 128×128 的角色参考帧")
        rgba = image.convert("RGBA")
        if rgba.getchannel("A").getbbox() is None:
            raise ValidationHarnessError("角色原图不能完全透明")
        edit_id = uuid.uuid4().hex
        directory = self.root / edit_id
        directory.mkdir(parents=True, exist_ok=False)
        atomic_save_png(rgba, directory / "v0000.png")
        record = {
            "schema_version": 1, "edit_id": edit_id, "version": 0,
            "sha256": sha256_file(directory / "v0000.png"),
            "character": character.model_dump(mode="json"), "transfers": {},
        }
        atomic_write_json(directory / "edit.json", record)
        return record

    def _read(self, edit_id: str) -> tuple[Path, dict[str, Any], Path]:
        directory = self.directory(edit_id)
        record = read_json(directory / "edit.json")
        version = int(record["version"])
        if version < 0:
            raise ValidationHarnessError("原图版本无效")
        path = directory / f"v{version:04d}.png"
        if not path.is_file() or sha256_file(path) != record["sha256"]:
            raise ConflictError("原图文件发生变化，请重新打开画布")
        return directory, record, path

    def session(self, edit_id: str) -> dict[str, Any]:
        with self.service.store.global_lock(f"reference_edit_{edit_id}"):
            _directory, record, path = self._read(edit_id)
            with Image.open(path) as image:
                rgba = image.convert("RGBA")
                return {
                    "mode": "reference", "edit_id": edit_id,
                    "display_name": record["character"]["display_name"],
                    "width": rgba.width, "height": rgba.height,
                    "rgba_base64": base64.b64encode(rgba.tobytes()).decode("ascii"),
                    "base_sha256": record["sha256"], "manual_edit_versions": record["version"],
                    "external_repair_attempts": 0, "frame_count": 1, "loop": False,
                    "neighbors": {}, "can_edit": True,
                }

    def save(self, edit_id: str, *, width: int, height: int, rgba: bytes, base_sha256: str) -> dict[str, Any]:
        with self.service.store.global_lock(f"reference_edit_{edit_id}"):
            directory, record, path = self._read(edit_id)
            if record["sha256"] != base_sha256:
                raise ConflictError("原图已在其他窗口修改，请重新读取后再保存", details={"reason": "stale_frame_version"})
            character = record["character"]
            if (width, height) != (character["cell_width"], character["cell_height"]) or len(rgba) != width * height * 4:
                raise ValidationHarnessError("原图像素尺寸或长度不匹配")
            with Image.open(path) as current:
                if current.convert("RGBA").tobytes() == rgba:
                    raise ValidationHarnessError("没有新的像素修改")
            version = record["version"] + 1
            destination = directory / f"v{version:04d}.png"
            atomic_save_png(Image.frombytes("RGBA", (width, height), rgba), destination)
            with Image.open(destination) as saved:
                if saved.convert("RGBA").tobytes() != rgba:
                    raise ConflictError("原图保存后的像素校验失败")
            record.update(version=version, sha256=sha256_file(destination))
            atomic_write_json(directory / "edit.json", record)
            return {"sha256": record["sha256"], "manual_edit_versions": version}

    def transfer(self, edit_id: str, base_sha256: str) -> CharacterPreset:
        with self.service.store.global_lock(f"reference_edit_{edit_id}"):
            _directory, record, path = self._read(edit_id)
            if record["sha256"] != base_sha256:
                raise ConflictError("原图版本已变化，请重新读取已保存的版本")
            if record["version"] < 1:
                raise ValidationHarnessError("请先修改并保存原图")
            with Image.open(path) as image:
                if image.convert("RGBA").getchannel("A").getbbox() is None:
                    raise ValidationHarnessError("原图不能完全透明，请保留角色像素后再移送")
            # One saved version always resolves to one new asset, even after an
            # interrupted response or repeated transfer click. All source paths
            # are replaced; the new character owns its reference independently.
            character_id = f"edited_{edit_id}_v{record['version']}"
            original = CharacterPreset.model_validate(record["character"])
            character = original.model_copy(update={
                "object_id": character_id,
                "display_name": f"{original.display_name[:170]} · 修改版 {record['version']}",
                "reference_frame": "idle_reference.png", "master": None,
                "palette": None, "silhouette": None,
            })
            destination = self.service.settings.user_characters_dir / character_id
            if self.service.presets.character_exists(character_id):
                existing, existing_path = self.service.presets.load_character(character_id)
                if existing != character or sha256_file(existing_path.parent / existing.reference_frame) != record["sha256"]:
                    raise ConflictError("这份修改版原图已发生变化，请保存新版本后移送")
                return existing
            destination.mkdir(parents=True, exist_ok=True)
            # Publishing the preset JSON last keeps incomplete copies out of the library.
            with Image.open(path) as image:
                atomic_save_png(image.convert("RGBA"), destination / "idle_reference.png")
            if sha256_file(destination / "idle_reference.png") != record["sha256"]:
                raise ConflictError("原图副本校验失败")
            atomic_write_json(destination / "character.json", character.model_dump(mode="json"))
            record["transfers"][str(record["version"])] = character_id
            atomic_write_json(_directory / "edit.json", record)
            return character
