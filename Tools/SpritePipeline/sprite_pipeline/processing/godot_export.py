"""Export reviewed sheet geometry as ready-to-use Godot 4 SpriteFrames resources."""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import tempfile
from typing import Any
import zipfile
from PIL import Image


def _quoted(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _slug(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", value)[:60].strip("_") or "sprite"


def build_godot_package(sheet_path: str | Path, destination: str | Path, recipe: dict[str, Any], *, anchor_x: int, ground_y: int, facing: str | None) -> dict[str, Any]:
    """Use exact exported regions; the caller publishes ZIP and sheet together.

    No original frame or game is edited. No Godot installation is required.
    """
    sheet_path, destination = Path(sheet_path), Path(destination)
    if sheet_path.resolve() == destination.resolve():
        raise ValueError("Godot package cannot overwrite the source sheet")
    sheet = sheet_path.read_bytes()
    sheet_sha = hashlib.sha256(sheet).hexdigest()
    if sheet_sha != recipe["sheet_sha256"]:
        raise ValueError("Godot export sheet does not match the verified recipe")
    with Image.open(io.BytesIO(sheet)) as image:
        image.load()
        if image.format != "PNG" or "A" not in image.getbands():
            raise ValueError("Godot export requires a transparent PNG sheet")
        width, height = image.size
    regions = recipe["source_region_px"]
    count = recipe["frame_count"]
    if not regions or len(regions) != count:
        raise ValueError("Godot frame regions must match the exact playback count")
    cell_width, cell_height = recipe["cell_width"], recipe["cell_height"]
    for region in regions:
        if len(region) != 4 or any(isinstance(v, bool) or not isinstance(v, int) for v in region):
            raise ValueError("Godot frame regions must be integer pixel rectangles")
        x, y, w, h = region
        if x < 0 or y < 0 or (w, h) != (cell_width, cell_height) or x + w > width or y + h > height:
            raise ValueError("Godot frame region violates the exported sheet geometry")
    fps = recipe["runtime_fps"]
    if isinstance(fps, bool) or not isinstance(fps, (int, float)) or not math.isfinite(fps) or fps <= 0:
        raise ValueError("Godot playback FPS must be positive and finite")
    if not isinstance(recipe["loop"], bool):
        raise ValueError("Godot loop must be an explicit boolean")
    object_type = recipe.get("object_type", "character")
    valid_facing = (object_type == "character" and facing in ("left", "right")) or (object_type == "interactable" and facing is None)
    if not 0 <= anchor_x < cell_width or not 0 <= ground_y < cell_height or not valid_facing:
        raise ValueError("Godot visual anchor/facing does not match the character contract")
    animation = recipe.get("manifest_action_name") or recipe["action_id"]
    if not isinstance(animation, str) or not animation.strip() or any(ord(c) < 32 for c in animation):
        raise ValueError("Godot animation name is invalid")
    offset = [cell_width / 2 - anchor_x, cell_height / 2 - ground_y]
    contract = {
        "format": "sprite-pipeline-godot", "version": 1, "godot": "4.7.x",
        "job_id": recipe["job_id"], "candidate_index": recipe["candidate_index"],
        "character_id": recipe["character_id"], "action_id": recipe["action_id"],
        "animation": animation, "frame_count": count, "fps": fps, "loop": recipe["loop"],
        "cell_size": [cell_width, cell_height], "source_region_px": regions,
        **({"source_facing": facing} if facing is not None else {}),
        **({key: recipe[key] for key in ("object_id", "object_type")} if "object_id" in recipe else {}),
        "anchor": [anchor_x, ground_y], "visual_offset": offset,
        "sheet_sha256": sheet_sha, "diagnostic_only": recipe.get("diagnostic_only", False),
    }
    identity = hashlib.sha256(json.dumps(contract, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:12]
    folder = f'forge_sprites/{_slug(recipe["character_id"])}/{_slug(recipe["job_id"])}_c{recipe["candidate_index"]:02d}_{identity}'
    resource_path = f"res://{folder}/sprite_frames.tres"
    scene_path = f"res://{folder}/animated_sprite.tscn"
    ext = f'[ext_resource type="Texture2D" path={_quoted("res://" + folder + "/sprite-sheet.png")} id="sheet"]'
    atlases, frames = [], []
    for index, (x, y, w, h) in enumerate(regions):
        atlases.append(f'[sub_resource type="AtlasTexture" id="frame_{index}"]\natlas = ExtResource("sheet")\nregion = Rect2({x}, {y}, {w}, {h})\nfilter_clip = true')
        frames.append('{"duration": 1.0, "texture": SubResource("frame_%d")}' % index)
    resource = '[gd_resource type="SpriteFrames" load_steps=%d format=3]\n\n%s\n\n%s\n\n[resource]\nanimations = [{"frames": [%s], "loop": %s, "name": &%s, "speed": %s}]\n' % (
        count + 2, ext, "\n\n".join(atlases), ",\n".join(frames), str(recipe["loop"]).lower(), _quoted(animation), fps,
    )
    scene = '\n'.join([
        '[gd_scene load_steps=2 format=3]',
        f'[ext_resource type="SpriteFrames" path={_quoted(resource_path)} id="frames"]',
        '[node name="Sprite" type="AnimatedSprite2D"]', 'texture_filter = 1', 'centered = true',
        f'offset = Vector2({offset[0]}, {offset[1]})', 'sprite_frames = ExtResource("frames")',
        f'animation = &{_quoted(animation)}', f'autoplay = {_quoted(animation)}', '',
    ])
    contract.update(sprite_frames=resource_path, scene=scene_path, engine_validated=False)
    instructions = f"""# Godot 序列帧资源包

1. 将 ZIP 中的整个 `forge_sprites` 文件夹复制到 Godot 4.7.x 项目根目录，保持目录层级。
2. 已有 AnimatedSprite2D：把 `{resource_path}` 拖到它的 Sprite Frames 属性，帧已经排列好，无需逐帧添加。
3. 新建角色画面：将 `{scene_path}` 拖入场景，运行后自动播放 `{animation}`。

本包包含当前候选的一个动作：{count} 帧，{fps} FPS，循环：{recipe['loop']}。非循环动画播放一次后保留末帧。脚本使用 `sprite.play({json.dumps(animation, ensure_ascii=False)})`，需要明确重播时将 frame / frame_progress 归零；不要在每个物理帧重新归零。

已有角色若需要保留其他动作，请合并此动作到原 SpriteFrames 的副本，不要用单动作资源直接替换整套动画。Forge 工程 Skill 提供单动作合并方法。请核对包内动作名与现有控制器的映射。

纹理保持原始画布、透明像素和图像方向（{facing if facing is not None else "以参考图为准"}），不逐帧裁切或自动居中。示例 Sprite 的脚底原点依据预设锚点 ({anchor_x}, {ground_y}) 设置；只替换 SpriteFrames 时不改变原节点的偏移或碰撞。使用 nearest 过滤以保持像素清晰。

包目录按作业、候选与内容区分，多个候选可共存。请保留资源路径；重命名或移动时使用 Godot 文件系统面板，让引擎更新引用。本包不含 project.godot，不修改项目配置，不附带战斗控制器或伤害触发逻辑。
"""
    files = {
        f"{folder}/sprite-sheet.png": sheet,
        f"{folder}/sprite_frames.tres": resource.encode("utf-8"),
        f"{folder}/animated_sprite.tscn": scene.encode("utf-8"),
        f"{folder}/export.json": (json.dumps(contract, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
        f"{folder}/IMPORT.md": instructions.encode("utf-8"),
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent, delete=False) as handle:
        temporary = Path(handle.name)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in sorted(files.items()):
                entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.external_attr = 0o100644 << 16
                archive.writestr(entry, data)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return {"resource_path": resource_path, "scene_path": scene_path, "animation": animation,
            "frame_count": count, "fps": fps, "loop": recipe["loop"],
            "package_sha256": hashlib.sha256(destination.read_bytes()).hexdigest()}
