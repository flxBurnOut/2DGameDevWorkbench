---
name: 2d-game-workbench
description: Create, edit, inspect and deliver Forge artwork, animations and interactables through the project tools. Use forge-game-engineering for Godot project code and asset integration.
---

# Forge asset production

Complete the user's requested asset workflow using the shared workbench runtime. Choose the relevant topic below; other topics can stay unloaded. [Conversation guidance](../../../workbench/conversation-guide.md) covers ambiguous requests and delegated choices.

## Choose an entry

| Task | Route | Read when needed / MCP guidance topic |
| --- | --- | --- |
| Character image or existing PNG import | reference-art generate / import, then transfer when an animation reference is needed | [Reference art](../../../docs/reference-art.md) · reference-art |
| New or continuing animation | sprite-generator plan-motion and its saved work/checkpoints | [Motion workflow](../../../workbench/guides/motion.md) · motion |
| Change selected animation frames | get-motion-adjustment → create-motion-adjustment → inspect → review-motion-adjustment | [Alternatives](../../../docs/motion-adjustments.md) · adjustments |
| Transparent prop generation or whole-image editing | image-assets; PixelLab props can use reference-art subject=prop | [Image assets](../../../docs/prop-art.md) · image-generation |
| Local or AI changes to an existing saved image | inspect_image_target → resolve_image_region → edit_image_region → inspect → apply_image_candidate | [Image editing](../../../docs/image-editing.md) · image-editing |
| Interactable behavior or shared project | template / saved document → typed commands → inspect → requested save/export | [Interactables](../../../docs/interactable-editor.md) · interactables |
| Existing artwork, downloads or handoff | list_assets → exact get_asset/get_result; list_tasks for execution history | [Asset catalog](../../../docs/asset-catalog.md) · assets |
| Delivery to a game | Exact existing export and selected project, then the engineering Skill | [Delivery](../../../docs/godot-delivery.md) · delivery |

The server exposes workbench_get_guidance({topic}) for these documents, including clients without repository file access. Tool names in the table are abbreviated; discover their current names and schema before using an unfamiliar operation.

## Execute the selected workflow

Prefer the project's MCP tools. Reuse discovered schemas during the session; refresh them when the service version or operation changes. If MCP is unavailable, the equivalent repository CLI is available:

| MCP | CLI from the repository root |
| --- | --- |
| list_capabilities / describe_capability | npm run workbench -- list / describe <capability-id> --json |
| run_task / get_task | npm run workbench -- run <capability-id> --input <json-file> / status <task-id> --json |
| get_guidance and other shared operations | npm run workbench -- agent guidance --input <json-file> --json; other operations use their discovered names |

Resolve character, asset and task IDs from context or discovery instead of asking for them. Check only the services this task needs: start an installed offline service that is down, and diagnose a port or version conflict instead of starting it again. The selected capability's schema defines what MCP/CLI supports; prepare_task is an optional validation step for authorized production work.

## Keep work recoverable

- **Paid or async tasks:** poll the original task/job. When a paid submission's outcome is unknown, find the existing request through its saved receipt and provider ID; submit again only within the agreed scope and budget.
- **Shared documents and images:** write through the canonical Bridge with the current revision/hash and a stable commandId. Reuse the ID when retrying the same request and re-read on conflict. Editing storage files directly bypasses concurrent users and recovery.
- **Candidates:** bind edits and adoption to the selected source, candidate and allowed range. Creating a candidate does not adopt it; adopt when the user asked for the adopted result.
- **Review:** view animations as a sequence at their FPS. Technical hard errors block; record other warnings with the observed reason. [Visual criteria](../../../workbench/experts/2d-production-expert.md) supplies review guidance.
- **Report:** state which of task completion, adoption, export and engine validation actually happened.

## Show and deliver

Show results with the exact asset/work/candidate links the tools return. Preview behavior for each host, including WorkBuddy and preview_required, is in the [presentation guide](../../../docs/agent-preview-follow.md) (topic presentation).

Deliver the actual downloaded files; a manifest describes textures without containing them. For game code or integration continue with [forge-game-engineering](../forge-game-engineering/SKILL.md). For service or configuration failures, read the relevant section of the [operations manual](../../../docs/operations-manual.md).
