"""Read-only inventory of durable artwork; execution history is not an asset list."""
from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path
from typing import Any

from .artwork_library import ArtworkLibrary
from .errors import NotFoundError, ValidationHarnessError
from .jsonio import inside


class AssetCatalog:
    def __init__(self, service):
        self.service = service
        self.library = ArtworkLibrary(service)

    def list(self):
        # Use the same durable scope as ArtworkLibrary, including archived jobs.
        summaries = {j["job_id"]: j for j in self.service.list_jobs(include_archived=True)}
        rows = []
        for row in self.library.list_artworks():
            job = summaries.get(row.get("job_id"), {})
            material = next((m for m in job.get("artworks", []) if m["candidate_index"] == row.get("candidate_index")), {})
            source = self.library.preview_source(row)
            rows.append({
                "id": row["id"], "kind": row["kind"], "title": row["title"],
                "status": "exported" if material.get("exported") else material.get("status", "saved"),
                "statusLabel": row["status_label"],
                "createdAt": job.get("created_at", row.get("created_at")), "updatedAt": row["updated_at"],
                "availability": "available" if source else "missing",
                "characterId": row.get("character_id"), "actionId": job.get("action_id"),
                "jobId": row.get("job_id"), "candidateIndex": row.get("candidate_index"),
                "candidateCount": job.get("candidate_count"), "frameCount": material.get("frame_count"),
                "previewKind": "animation" if source and source.suffix.lower() == ".gif" else "image",
                "hasArtwork": True, "engineValidated": False,
            })
        return {"assets": rows, "issues": [{"source": "sprite-pipeline", "message": "部分作业摘要损坏，作品目录可能不完整。"}] if any(j.get("status") == "invalid" for j in summaries.values()) else []}

    def paths(self, asset_id):
        row = self.library.get(asset_id)
        # Paths are obtained only from durable records and confined by their stores.
        files = {"source": Path(row["fallback"])}
        preview = self.library.preview_source(row)
        if preview:
            files["preview"] = preview
        if row["kind"] == "animation":
            job = self.service.get_job(row["job_id"])
            candidate = next(c for c in job.candidates if c.candidate_index == row["candidate_index"])
            files.update({f"frame-{frame.index}": self.service.store.resolve_job_path(job.job_id, frame.active_path) for frame in candidate.frames})
            if job.export and job.export.candidate_index == candidate.candidate_index:
                for key, field in [("sheet", "sheet_path"), ("export-preview", "preview_path"), ("recipe", "recipe_path"), ("qa", "qa_path")]:
                    files[key] = inside(self.service.settings.exports_dir, self.service.settings.resolve_record_path(getattr(job.export, field)))
                if job.export.godot_package_path:
                    files["godot"] = inside(self.service.settings.exports_dir, self.service.settings.resolve_record_path(job.export.godot_package_path))
        return row, files

    def file(self, asset_id, key):
        _row, files = self.paths(asset_id)
        value = files.get(key)
        if value is None or not value.is_file():
            raise NotFoundError("所选资产文件不存在")
        if value.stat().st_size > 64 * 1024 * 1024:
            raise ValidationHarnessError("资产文件超过 64 MB")
        return value

    def detail(self, asset_id):
        asset = next((a for a in self.list()["assets"] if a["id"] == asset_id), None)
        if asset is None:
            raise NotFoundError("所选资产不存在或无法读取")
        row, paths = self.paths(asset_id)
        files = []
        for key, file in paths.items():
            entry = {"key": key, "name": file.name, "path": str(file), "available": file.is_file()}
            if entry["available"]:
                if file.stat().st_size > 64 * 1024 * 1024:
                    entry.update(available=False, issue="文件超过 64 MB")
                else:
                    data = file.read_bytes()
                    entry.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
            files.append(entry)
        metadata: dict[str, Any] = {}
        if row["kind"] == "animation":
            job = self.service.get_job(row["job_id"])
            candidate = next(c for c in job.candidates if c.candidate_index == row["candidate_index"])
            metadata = {
                "width": job.character.cell_width, "height": job.character.cell_height,
                "facing": job.character.facing, "fps": job.action.fps, "loop": job.action.loop,
                "productionRevision": job.revision,
                "anchor": [job.character.anchor.x, job.character.anchor.ground_y],
                "animationRepresentations": [{
                    "representation": "frames", "frameKeys": [f"frame-{frame.index}" for frame in candidate.frames],
                    "fps": job.action.fps, "loop": job.action.loop,
                    "anchor": [job.character.anchor.x, job.character.anchor.ground_y],
                    "sourceFacing": job.character.facing,
                    "jobId": job.job_id, "candidateIndex": candidate.candidate_index,
                }],
            }
            # Exported playback can differ from the raw frame sequence. Preserve its
            # own contract only when it matches this exact candidate and sheet.
            godot = paths.get("godot")
            sheet = paths.get("sheet")
            if godot and godot.is_file() and sheet and sheet.is_file():
                try:
                    with zipfile.ZipFile(godot) as package:
                        names = [name for name in package.namelist() if name.endswith("/export.json")]
                        if len(names) != 1 or package.getinfo(names[0]).file_size > 1024 * 1024:
                            raise ValueError("ambiguous export contract")
                        contract = json.loads(package.read(names[0]))
                    if (contract.get("format") != "sprite-pipeline-godot" or
                            contract.get("job_id") != job.job_id or
                            contract.get("candidate_index") != candidate.candidate_index or
                            contract.get("sheet_sha256") != hashlib.sha256(sheet.read_bytes()).hexdigest()):
                        raise ValueError("export representation differs from current candidate")
                    metadata["animationRepresentations"].append({
                        "representation": "sheet", "sheetKey": "sheet", "godotKey": "godot",
                        "fps": contract.get("fps"), "loop": contract.get("loop"),
                        "regions": contract.get("source_region_px"), "anchor": contract.get("anchor"),
                        "sourceFacing": contract.get("source_facing"),
                        "sheetSha256": contract["sheet_sha256"],
                        "jobId": job.job_id, "candidateIndex": candidate.candidate_index,
                    })
                except (OSError, ValueError, KeyError, zipfile.BadZipFile):
                    # The file remains downloadable, but no unchecked relationship
                    # between an old export and the current frames is asserted.
                    pass
        elif row["kind"] == "character":
            character, _ = self.service.presets.load_character(row["character_id"])
            metadata = {"width": character.cell_width, "height": character.cell_height, "facing": character.facing}
        else:
            metadata = {key: row.get(key) for key in ("width", "height")}
        return {**asset, **metadata, "files": files}


def create_asset_router(service):
    from fastapi import APIRouter
    from fastapi.responses import FileResponse
    router = APIRouter()
    catalog = AssetCatalog(service)

    @router.get("/v1/artworks")
    def assets():
        return {"ok": True, "schema_version": 1, "data": catalog.list()}

    @router.get("/v1/artworks/file", response_model=None)
    def asset_file(asset_id: str, key: str = "preview"):
        return FileResponse(catalog.file(asset_id, key), headers={"Cache-Control": "no-store"})

    @router.get("/v1/artworks/{asset_id}")
    def asset_detail(asset_id: str):
        return {"ok": True, "schema_version": 1, "data": {"asset": catalog.detail(asset_id)}}

    return router
