from __future__ import annotations

from pathlib import Path
import hashlib

from pydantic import ValidationError

from .errors import NotFoundError, ValidationHarnessError
from .jsonio import inside, read_json
from .models import ActionPreset, CharacterPreset, ObjectPreset, validate_object_preset
from .settings import HarnessSettings


class PresetRepository:
    """Read bundled presets and user characters without mixing their storage."""

    def __init__(self, settings: HarnessSettings) -> None:
        self.settings = settings

    @staticmethod
    def _safe_id(value: str, field: str) -> str:
        if not value or not all(ch.islower() or ch.isdigit() or ch == "_" for ch in value):
            raise ValidationHarnessError(f"invalid {field}", details={field: value})
        return value

    def _character_roots(self) -> list[tuple[str, Path]]:
        roots = [
            ("user", self.settings.user_characters_dir),
            ("bundled", self.settings.bundled_presets_dir / "characters"),
        ]
        unique: list[tuple[str, Path]] = []
        seen: set[Path] = set()
        for source, root in roots:
            resolved = root.resolve()
            if resolved not in seen:
                unique.append((source, resolved))
                seen.add(resolved)
        return unique

    def user_character_path(self, character_id: str) -> Path:
        safe = self._safe_id(character_id, "character_id")
        return inside(
            self.settings.user_characters_dir,
            self.settings.user_characters_dir / safe / "character.json",
        )

    def character_path(self, character_id: str) -> Path:
        safe = self._safe_id(character_id, "character_id")
        for _source, root in self._character_roots():
            path = inside(root, root / safe / "character.json")
            if path.is_file():
                return path
        return self.user_character_path(safe)

    def character_exists(self, character_id: str) -> bool:
        return self.character_path(character_id).is_file()

    def action_path(self, action_id: str) -> Path:
        safe = self._safe_id(action_id, "action_id")
        actions = self.settings.bundled_presets_dir / "actions"
        return inside(actions, actions / f"{safe}.json")

    def load_character(self, character_id: str, *, verify_assets: bool = True) -> tuple[CharacterPreset, Path]:
        path = self.character_path(character_id)
        if not path.is_file():
            raise NotFoundError("character preset not found", details={"character_id": character_id})
        try:
            preset = CharacterPreset.model_validate(read_json(path))
        except (ValidationError, ValueError) as exc:
            raise ValidationHarnessError("invalid character preset", details={"path": str(path), "error": str(exc)}) from exc
        if preset.character_id != character_id:
            raise ValidationHarnessError("character directory and character_id differ", details={"path": str(path)})
        if verify_assets:
            for field, filename, required in (
                ("reference_frame", preset.reference_frame, True),
                ("master", preset.master, False),
                ("palette", preset.palette, False),
                ("silhouette", preset.silhouette, False),
            ):
                if filename is None:
                    continue
                asset = inside(path.parent, path.parent / filename)
                if not asset.is_file() and required:
                    raise ValidationHarnessError("required character asset is missing", details={"field": field, "path": str(asset)})
                if not asset.is_file() and not required:
                    raise ValidationHarnessError("configured character asset is missing", details={"field": field, "path": str(asset)})
        return preset, path

    @property
    def objects_dir(self) -> Path:
        return (self.settings.presets_dir if self.settings.portable_mode else self.settings.data_root) / "objects"

    def object_path(self, object_id: str) -> Path:
        safe = self._safe_id(object_id, "object_id")
        return inside(self.objects_dir, self.objects_dir / safe / "object.json")

    def object_exists(self, object_id: str) -> bool:
        return self.object_path(object_id).is_file() or self.character_exists(object_id)

    def load_object(self, object_id: str, *, object_type: str | None = None, verify_assets: bool = True) -> tuple[ObjectPreset, Path]:
        path = self.object_path(object_id)
        if not path.is_file():
            preset, path = self.load_character(object_id, verify_assets=verify_assets)
        else:
            if self.character_exists(object_id):
                raise ValidationHarnessError("object identity conflicts with an existing character", details={"object_id": object_id})
            try:
                preset = validate_object_preset(read_json(path))
            except (ValidationError, ValueError) as exc:
                raise ValidationHarnessError("invalid object preset", details={"path": str(path), "error": str(exc)}) from exc
            if preset.object_id != object_id:
                raise ValidationHarnessError("object directory and object_id differ", details={"path": str(path)})
            if verify_assets:
                for field in ("reference_frame", "master", "palette", "silhouette"):
                    filename = getattr(preset, field)
                    if filename is not None and not inside(path.parent, path.parent / filename).is_file():
                        raise ValidationHarnessError("configured object asset is missing", details={"field": field, "path": str(path)})
        if object_type is not None and preset.object_type != object_type:
            raise ValidationHarnessError("object type does not match its preset", details={"object_id": object_id, "object_type": object_type})
        return preset, path

    def list_objects(self) -> list[dict]:
        rows = [{**row, "object_type": "character"} for row in self.list_characters()]
        for path in sorted(self.objects_dir.glob("*/object.json")):
            object_id = path.parent.name
            try:
                preset, preset_path = self.load_object(object_id)
                row = {"id": object_id, "object_type": preset.object_type, "name": preset.display_name,
                       "path": str(preset_path), "source": "user", "valid": True,
                       "width": preset.cell_width, "height": preset.cell_height, "description": preset.identity_description}
                if preset.object_type == "character":
                    row["facing"] = preset.facing
                else:
                    row['provenance'] = self.object_provenance(object_id)
                rows.append(row)
            except Exception as exc:
                rows.append({"id": object_id, "name": "INVALID", "path": str(path), "source": "user", "valid": False, "error": str(exc)})
        return rows

    def object_provenance(self, object_id):
        preset, path = self.load_object(object_id, object_type='interactable')
        record = inside(path.parent, path.parent / 'provenance.json')
        if not record.is_file():
            return {'type': 'pixellab'}
        data = read_json(record)
        if (data.get('version') != 1 or data.get('type') not in ('pixellab', 'import', 'convert-prop')
                or data.get('referenceSha256') != hashlib.sha256((path.parent / preset.reference_frame).read_bytes()).hexdigest()):
            raise ValidationHarnessError('物品来源记录与原图不一致')
        return data

    def object_snapshot(self, preset):
        data = preset.model_dump(mode='json')
        if preset.object_type == 'interactable':
            origin = self.object_provenance(preset.object_id)
            data['provenance'] = {key: origin[key] for key in ('type', 'referenceSha256', 'conversion') if key in origin}
            if 'referenceSha256' not in data['provenance']:
                _, path = self.load_object(preset.object_id)
                data['provenance']['referenceSha256'] = hashlib.sha256((path.parent / preset.reference_frame).read_bytes()).hexdigest()
        return data

    def load_action(self, action_id: str) -> tuple[ActionPreset, Path]:
        path = self.action_path(action_id)
        if not path.is_file():
            raise NotFoundError("action preset not found", details={"action_id": action_id})
        try:
            preset = ActionPreset.model_validate(read_json(path))
        except (ValidationError, ValueError) as exc:
            raise ValidationHarnessError("invalid action preset", details={"path": str(path), "error": str(exc)}) from exc
        if preset.action_id != action_id:
            raise ValidationHarnessError("action filename and action_id differ", details={"path": str(path)})
        return preset, path

    def list_characters(self) -> list[dict[str, str | bool]]:
        rows: list[dict[str, str | bool]] = []
        seen: set[str] = set()
        for source, base in self._character_roots():
            for path in sorted(base.glob("*/character.json")):
                character_id = path.parent.name
                if character_id in seen:
                    continue
                seen.add(character_id)
                try:
                    preset, preset_path = self.load_character(character_id, verify_assets=True)
                    rows.append(
                        {
                            "id": preset.character_id,
                            "name": preset.display_name,
                            "path": str(preset_path),
                            "source": source,
                            "valid": True,
                            "width": preset.cell_width,
                            "height": preset.cell_height,
                            "facing": preset.facing,
                            "description": preset.identity_description,
                        }
                    )
                except Exception as exc:
                    rows.append(
                        {
                            "id": character_id,
                            "name": "INVALID",
                            "path": str(path),
                            "source": source,
                            "valid": False,
                            "error": str(exc),
                        }
                    )
        return rows

    def list_actions(self) -> list[dict[str, str]]:
        rows: list[dict[str, str]] = []
        base = self.settings.bundled_presets_dir / "actions"
        for path in sorted(base.glob("*.json")):
            try:
                preset = ActionPreset.model_validate(read_json(path))
                rows.append({"id": preset.action_id, "name": preset.display_name or preset.action_id, "path": str(path),
                             "frameCount": preset.frame_count, "fps": preset.fps, "loop": preset.loop,
                             "description": preset.action_description})
            except Exception:
                rows.append({"id": path.stem, "name": "INVALID", "path": str(path)})
        return rows
