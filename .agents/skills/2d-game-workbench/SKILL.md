---
name: 2d-game-workbench
description: Create, edit, inspect and deliver Forge artwork, animations and interactables through the project tools. Use forge-game-engineering for Godot project code and asset integration.
---

# Forge asset production

Complete the requested asset workflow through the shared workbench runtime. Load only the topic needed for the current task. For ambiguous requests and delegation rules, see [conversation guidance](../../../workbench/conversation-guide.md).

## Choose an entry

| Task | Route | Topic / Guide |
| --- | --- | --- |
| Character image or PNG import | `reference-art` generate / import → transfer for animation | `reference-art` · [Reference art](../../../docs/reference-art.md) |
| New or continuing animation | `sprite-generator` `plan-motion` and saved work/checkpoints | `motion` · [Motion workflow](../../../workbench/guides/motion.md) |
| Interactable state animation | 128 px prop reference → transfer → `plan-motion` (optional `interactable_skeleton`) → `review-motion-stage` → `import-motion-asset`; use `/tools/interactable-motion` for derived assets | `motion` · [Motion workflow](../../../workbench/guides/motion.md); `interactables` · [Interactables](../../../docs/interactable-editor.md) |
| Edit selected animation frames | `get-motion-adjustment` → `create-motion-adjustment` → inspect → `review-motion-adjustment` | `adjustments` · [Adjustments](../../../docs/motion-adjustments.md) |
| Transparent prop or whole-image edit | `image-assets` (or `reference-art` `subject=prop` for PixelLab props) | `image-generation` · [Prop art](../../../docs/prop-art.md) |
| Convert 128 px or GPT Image prop for animation | `reference-art` `import` (`subject=prop`) / `convert-prop` → inspect `compare.png` → transfer with confirmation | `image-generation` · [Prop conversion](../../../docs/prop-art.md#导入与转换为动画原图) |
| Local or AI edit on a saved image | `inspect_image_target` → `resolve_image_region` → `edit_image_region` → inspect → `apply_image_candidate` | `image-editing` · [Image editing](../../../docs/image-editing.md) |
| Interactable behavior or shared project | template / saved document → typed commands → inspect → save/export | `interactables` · [Interactables](../../../docs/interactable-editor.md) |
| Find, download or hand off existing assets | `list_assets` → `get_asset` / `get_result`; `list_tasks` for execution history | `assets` · [Asset catalog](../../../docs/asset-catalog.md) |
| Deliver to a Godot game | Match existing export and target project, then switch to the engineering Skill | `delivery` · [Delivery](../../../docs/godot-delivery.md) |

Use `workbench_get_guidance({topic})` when repository files are not directly accessible. Discover exact tool names and schemas before calling an unfamiliar operation.

## Execute the workflow

Prefer the project MCP tools and reuse discovered schemas within the session (refresh if the service version changes). When MCP is unavailable, use the equivalent CLI from the repository root:

| MCP | CLI |
| --- | --- |
| `list_capabilities` / `describe_capability` | `npm run workbench -- list` / `describe <capability-id> --json` |
| `run_task` / `get_task` | `npm run workbench -- run <capability-id> --input <json-file>` / `status <task-id> --json` |
| `get_guidance` and other agent operations | `npm run workbench -- agent guidance --input <json-file> --json` |

- Resolve character, asset, and task IDs from context or discovery tools instead of asking the user.
- Check only the services required for this task: start an offline installed service, and diagnose port or version conflicts rather than spawning duplicates.
- `prepare_task` is optional for input validation during authorized production work.

## Keep work recoverable

- **Paid or async jobs:** poll the original task/job. If a paid submission's status is unknown, recover it via its saved receipt and provider ID before submitting again within the agreed budget.
- **Shared documents and images:** always write through the Bridge with current `revision`/`hash` and a stable `commandId` (reuse on retry, re-read on conflict); never edit storage files directly.
- **Candidates:** bind edits and adoption to the exact source, candidate, and allowed range. Creating a candidate does not adopt it.
- **Visual review:** inspect animations as ordered sequences at their real FPS. Resolve technical hard errors first; record observed reasons for other warnings. See [visual criteria](../../../workbench/experts/2d-production-expert.md).
- **Reporting:** state clearly which steps actually completed (task run, adoption, export, engine validation).

## Show and deliver

Present results with the exact asset, work, or candidate links returned by the tools. Host preview rules (including WorkBuddy and `preview_required`) live in the [presentation guide](../../../docs/agent-preview-follow.md) (`presentation`).

Deliver the actual downloaded files rather than a manifest alone. Continue with [forge-game-engineering](../forge-game-engineering/SKILL.md) for Godot integration, or check the [operations manual](../../../docs/operations-manual.md) for service and setup troubleshooting.
