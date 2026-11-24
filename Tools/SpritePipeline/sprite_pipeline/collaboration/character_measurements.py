"""Deterministic character-domain pixel/geometry probes for guarded checkpoints.

Reuses the calibrated heuristics from ``processing.frame_checks`` without
reimplementing image metrics or modifying the VLM prompt contract.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ..processing import run_qa
from .contracts import CHARACTER_DIMENSIONS

_EQUIPMENT_CODES = {
    'area_change',
    'palette_deviation',
    'blank_frame',
    'missing_alpha',
    'corrupt_frame',
    'frame_size_mismatch',
}
_RHYTHM_CODES = {
    'frame_position_jump',
    'centroid_jump',
    'centroid_velocity_jump',
    'ground_baseline_drift',
}
_COMPLETENESS_CODES = {
    'loop_endpoint_difference',
}


def _default_thresholds(job: Any) -> dict[str, int | float | None]:
    qa = job.character.qa
    return {
        'duplicate_min_run': qa.duplicate_run_length,
        'area_change_ratio': qa.area_change_ratio,
        'centroid_jump_pixels': (
            job.action.centroid_shift_px
            if job.action.centroid_shift_px is not None
            else qa.centroid_shift_px
        ),
        'palette_deviation_ratio': qa.palette_mismatch_ratio,
        'palette_color_distance': qa.palette_distance,
        'loop_difference_ratio': qa.loop_difference_ratio,
        'ground_baseline_tolerance': qa.ground_y_tolerance_px,
        'rigid_translation_tolerance_px': qa.rigid_translation_tolerance_px,
        'alpha_threshold': max(0, qa.alpha_visible_threshold - 1),
    }


def character_measurements(
    service: Any,
    job: Any,
    frame_paths: list[Path],
    reference_path: Path,
    *,
    stage: int | None = None,
) -> dict[str, Any] | None:
    """Measure deterministic character invariants and map flags to review dimensions."""
    binding = getattr(job.request, 'open_plan', None)
    if not binding or binding.spec.object_type != 'character' or not frame_paths:
        return None
    if not reference_path.is_file():
        return {'unavailable': '参考图缺失，请人工核对角色不变量'}

    thresholds = dict(service._qa_thresholds(job)) if hasattr(service, '_qa_thresholds') else _default_thresholds(job)
    thresholds.pop('ground_y', None)
    palette_candidates = sorted(reference_path.parent.glob('palette.*'))
    palette_path = palette_candidates[0] if palette_candidates else reference_path
    report = run_qa(
        frame_paths,
        len(frame_paths),
        job.character.cell_width,
        job.character.cell_height,
        reference_path=reference_path,
        palette_path=palette_path,
        safe_margin=job.character.safe_margin,
        grounded=bool(job.action.grounded),
        anchor_ground_y=None,
        loop=bool(job.action.loop) if stage is None else False,
        thresholds=thresholds,
    )

    flags: dict[str, set[int]] = {dim: set() for dim in CHARACTER_DIMENSIONS}
    frame_rows: list[dict[str, Any]] = []
    for idx, frame in enumerate(report.get('frames', [])):
        number = idx + 1
        codes: list[str] = []
        for group_key in ('hard_failures', 'warnings'):
            for item in frame.get(group_key, []):
                code = item['code'] if isinstance(item, dict) else str(item)
                codes.append(code)
                if code in _EQUIPMENT_CODES:
                    flags['equipment'].add(number)
                elif code in _RHYTHM_CODES:
                    flags['rhythm'].add(number)
                elif code in _COMPLETENESS_CODES:
                    flags['completeness'].add(number)
        metrics = frame.get('metrics', {})
        frame_rows.append(
            {
                'frame': number,
                'ground_y': metrics.get('ground_y'),
                'ground_delta': metrics.get('ground_delta'),
                'area_change_ratio': metrics.get('area_change_ratio'),
                'palette_deviation_ratio': metrics.get('palette_deviation_ratio'),
                'codes': codes,
            }
        )

    for issue in (*report.get('hard_failures', []), *report.get('warnings', [])):
        if not isinstance(issue, dict) or 'frame' in issue:
            continue
        code = issue.get('code')
        target_dim = (
            'equipment' if code in _EQUIPMENT_CODES
            else 'rhythm' if code in _RHYTHM_CODES
            else 'completeness' if code in _COMPLETENESS_CODES
            else None
        )
        if target_dim is not None and not flags[target_dim]:
            indices = [int(i) + 1 for i in issue.get('frame_indices', []) if 0 <= int(i) < len(frame_paths)]
            flags[target_dim].update(indices or [1, len(frame_paths)])

    return {
        'flags': {dim: sorted(numbers) for dim, numbers in flags.items()},
        'ground_reference_y': report['sequence_metrics'].get('ground_y'),
        'frames': frame_rows,
    }
