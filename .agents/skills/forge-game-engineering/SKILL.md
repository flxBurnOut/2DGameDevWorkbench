---
name: forge-game-engineering
description: Integrate ready Forge assets and implement Godot game code in the selected target project. Use for animation imports, interactable integration, interaction wiring and project-specific architecture.
---

# Forge game engineering

Complete the requested integration or playable slice using the target project's own code and instructions. A planning request ends with a design; an implementation request continues through file changes and validation, with resource names, paths and wiring decided from the actual files.

## Route the task

| Work | Read |
| --- | --- |
| One animation or a character's visual resources | [Frames and actions](references/frames.md) · topic engineering-frames |
| A Forge delivery selected for an existing game | [Delivery](../../../docs/godot-delivery.md) · topic delivery |
| Producing or adjusting art | [Asset production Skill](../2d-game-workbench/SKILL.md), then return with the chosen result |

MCP-only readers load these with workbench_get_guidance({topic}).

## Establish the target and inputs

Locate project.godot, the target's own instructions, the affected scenes/scripts/resources and its engine version. For an existing project, start from its current scene and ownership model; for a new one, choose the smallest structure that supports the requested slice.

- **Tracked Forge delivery:** list_game_exports / get_game_export, match the exact package and target, then install_game_export with its current hashes.
- **Directly supplied ZIP:** inspect and integrate that package as given.
- **Production replacement:** use the adopted/exported asset. Importing another candidate is a test; label and isolate it.

Take frame order, regions, FPS, loop and source identity from the package. Checkpoints, context images and repair previews are intermediate files, not clips.

## Implement the requested slice

- **Animation:** follow [Frames and actions](references/frames.md). Merge the selected actions into the actor's existing SpriteFrames and keep its controller, timing, facing, anchor and collision.
- **Interactables:** install the exported profile with one shared interaction runtime per level, then connect its signals to the target's existing systems.
- **New game code:** build the minimum architecture for the agreed slice.

Keep custom integration code outside replaceable generated-resource directories. Check shared resources and installation conflicts before updating a target, and merge existing user changes instead of deleting them.

## Validate and finish

Run the target project's own Godot executable and report its version. Forge's export/helper baseline is 4.7.x; check compatibility for other versions instead of upgrading the target.

| Change | Check |
| --- | --- |
| A clip | Resource loads and plays with the intended order, FPS and loop |
| Controller behavior | Repeated actions, interruption and switching |
| Interactables | Interaction signals and resulting state changes |

A headless import proves parsing only. Report visual playback or gameplay as unverified when the engine or media is missing. After changing the Skill's helpers, run npm run test:engineering (GODOT_47_BIN selects the 4.7.x engine).

For a tracked delivery, complete_game_export records the modified files and engine evidence. Otherwise report the changed target files and the observed result.
