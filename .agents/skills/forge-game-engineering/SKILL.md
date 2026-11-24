---
name: forge-game-engineering
description: Integrate ready Forge assets and implement Godot game code in the selected target project. Use for animation imports, interactable integration, interaction wiring and project-specific architecture.
---

# Forge game engineering

Complete the requested integration or playable slice using the target project's own code and instructions. Planning requests end with a design; implementation requests continue through file changes and validation, deciding names, paths, and wiring from the actual project files.

## Route the task

| Work | Read |
| --- | --- |
| One animation or a character's visual resources | [Frames and actions](references/frames.md) · topic `engineering-frames` |
| A Forge delivery selected for an existing game | [Delivery](../../../docs/godot-delivery.md) · topic `delivery` |
| Producing or adjusting art | [Asset production Skill](../2d-game-workbench/SKILL.md), then return with the chosen result |

MCP-only clients load these via `workbench_get_guidance({topic})`.

## Establish target and inputs

Locate `project.godot`, the target's own instructions, the affected scenes/scripts/resources, and its engine version. Build on the existing scene and ownership model for an existing game, or use the smallest structure needed for a new slice.

- **Tracked Forge delivery:** call `list_game_exports` / `get_game_export`, match the exact package and target, then run `install_game_export` with current hashes.
- **Directly supplied ZIP:** inspect and integrate that package as provided.
- **Candidate selection:** use the adopted/exported asset for production replacement; isolate and label any other candidate imported for testing.

Read frame order, regions, FPS, loop, and provenance from the package. Intermediate checkpoints, context images, and repair previews are not animation clips.

## Implement the slice

- **Animation:** follow [Frames and actions](references/frames.md). Merge selected clips into the actor's existing `SpriteFrames` while preserving its controller, timing, facing, anchor, and collision.
- **Interactables:** install the exported profile with one shared interaction runtime per level, then wire its signals into the target's existing systems.
- **New game code:** build the minimum architecture needed for the agreed slice.

Keep custom integration code outside replaceable generated-resource directories. Check shared resources and install conflicts before updating a target, and merge existing user changes rather than overwriting them.

## Validate and finish

Run the target project's own Godot executable and report its version. Forge's export/helper baseline is Godot 4.7.x; for other versions, verify compatibility rather than upgrading the target.

| Change | Check |
| --- | --- |
| A clip | Resource loads and plays with expected order, FPS, and loop |
| Controller behavior | Repeated actions, interruption, and state switching |
| Interactables | Interaction signals and resulting state changes |

Headless import checks resource parsing only; verify visual playback and gameplay whenever the engine and media are available, and note any unverified items if they are missing. After changing this Skill's helper scripts, run `npm run test:engineering` (`GODOT_47_BIN` selects Godot 4.7.x).

For tracked deliveries, record modified files and engine evidence with `complete_game_export`; otherwise report the changed files and observed checks.
