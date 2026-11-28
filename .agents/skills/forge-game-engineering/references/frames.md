# SpritePipeline → frames → SpriteFrames → actor actions

## Identify the exact artwork

Use `get_asset` / `get_result` for the selected candidate and match job ID, candidate index and source hashes. A production replacement uses the reviewed/exported delivery; importing any other candidate is a test, labeled and kept isolated.

Inspect the real export recipe from `Tools/SpritePipeline/sprite_pipeline/service.py` (`export_candidate`) and `processing/sheet_export.py`. Current recipe fields include:

| Recipe field | Engineering use |
| --- | --- |
| `job_id`, `candidate_index`, `character_id`, `action_id`, `manifest_action_name` | Provenance and explicit action alias |
| `source_frames[]` with index/path/sha256, `frame_order` | Ordered individual PNGs; match metadata, not lexicographic directory scanning |
| `source_region_px[]` | Exact atlas rectangles in playback order |
| `frame_cells`, `cell_width`, `cell_height`, `columns`, `rows` | Cross-check rectangles and dimensions; unused cells are padding |
| `sheet_sha256` | Verify the delivered sheet before slicing |
| `runtime_fps`, `fps`, `scene_fps`, `loop` | Compare intended runtime and target-scene values; record the effective choice |
| `critical_frame_indices` | QA emphasis only, not gameplay triggers |

Recipe paths can be relative to the service's configured data root; resolve them through the returned artifact paths or current service settings. Atlas order can skip cells, so read playback order from `source_region_px[]`, not from frame count.

## Prefer an existing Godot export

Current SpritePipeline exports include a `.godot.zip` beside the PNG. The workbench result exposes `godotPackage`; native export records use `godot_package_path` and download `/v1/jobs/{job_id}/exports/godot`. Inspect its `export.json`, SpriteFrames and texture references, then import its `forge_sprites` tree intact. The pack already contains the selected action's actual frames, mapped animation name, runtime FPS and loop. It includes a visual scene, not a gameplay controller. Older exports may lack this file; stage resources as below in that case.

## Stage resources

Run from the workbench root, replacing interpreter and output paths as appropriate:

```sh
python .agents/skills/forge-game-engineering/scripts/stage_assets.py sprite work/hero-input.json --output outputs/hero-handoff-v1 --resource-root Assets/Characters/hero_v1
```

Write the input JSON from the verified metadata. Paths, hashes and numbers below are placeholders:

```json
{
  "version": 1,
  "sourceFacing": "right",
  "offset": [0, -10],
  "initialAnimation": "attack",
  "animations": [{
    "name": "attack",
    "source": {"assetId": "selected asset id", "jobId": "selected job", "candidateIndex": 2, "actionId": "attack"},
    "fps": 18,
    "loop": false,
    "frames": [
      {"path": "delivery/sheet.png", "sha256": "actual sheet hash", "region": [256, 0, 128, 128]},
      {"path": "delivery/sheet.png", "sha256": "actual sheet hash", "region": [0, 128, 128, 128]}
    ]
  }]
}
```

Each frame may instead point to its individual PNG, without `region`. Preserve array order. Optional `duration` is a positive **relative** duration multiplier (default 1), not milliseconds. `frameEvents` can map an explicit zero-based frame to a visual cue, e.g. `{"1":"swing_sound"}`. Add it only for a cue the source or design specifies.

The new output contains PNGs, `frames.tres`, `visual.tscn`, the optional `character_visual.gd`, and `handoff.json` with provenance. The `.tres` contains actual Texture2D or AtlasTexture references. Copy the staged `Assets/...` subtree into the authorized target root after checking path collisions; the resource-root passed to the script must match the final path. The script writes no `project.godot` and does not merge into a game; give each new export a new directory.

## Connect to the existing actor

Find the target actor's actual animation node, state-to-clip aliases, resource sharing and scene inheritance. For one action, merge only the selected clip(s) into the existing SpriteFrames and preserve every other action. The included `assets/sprite_frames_merge.gd` exposes `merge_clips(existing, incoming)` without mutating either input. Save the result to a new resource path and update the intended actor reference. Check resource sharing and scene inheritance first if other actors use the same SpriteFrames.

Keep the controller's gameplay state, hit timing, collision and facing. Change playback when the target clip changes and restart it on a new action occurrence; restarting on every physics update freezes the animation on frame 0. Pipeline action names such as `hurt`/`death` may need explicit aliases to the target's clip names. Against the new art, check effective FPS, loop, offsets, foot placement and any logic that references exact frame indices, such as a held jump frame.

## Optional adapter for a new actor

`assets/character_visual.gd` implements just the presentation behavior, without new gameplay state or global dependencies. In the owner's existing animation update:

```gdscript
# `resolved_clip` comes from this actor's verified state/alias map.
$Sprite.show_action(resolved_clip)
$Sprite.face_right(facing_right)
# On an explicit new attack occurrence, even if still displaying attack:
$Sprite.show_action(&"attack", true)
```

Missing clips return false without changing playback. Non-loop clips hold the final frame and emit visual_finished; frame_cue carries the explicit `frameEvents` for audio and effects. Gameplay hits stay with the existing controller. When the design makes a frame authoritative for a hit, change that gameplay contract explicitly, covering interruption, replay, duplicate-hit guards and pause.

For a new standalone visual test, instantiate `visual.tscn`, call `show_action`, inspect both loop and one-shot actions. A controller change also needs input→state→clip, attack interruption/replay, damage count and pause exercised in the target project.

API references for Godot 4.7: [SpriteFrames](https://docs.godotengine.org/en/4.7/classes/class_spriteframes.html), [AnimatedSprite2D](https://docs.godotengine.org/en/4.7/classes/class_animatedsprite2d.html). `animation_finished` is not emitted for looping clips.
