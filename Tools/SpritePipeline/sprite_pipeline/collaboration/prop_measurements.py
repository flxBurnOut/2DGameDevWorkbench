"""Native-pixel cues for confirmed prop parts. Frame numbers exclude the input."""
from pathlib import Path
import math

from PIL import Image, ImageChops

from ..errors import HarnessError
from ..jsonio import inside, read_json
from .contracts import digest

# Frozen against the archived 128px lever runs. Subpixel center estimates are noisy.
HINGE_RELATIVE_TOLERANCE = 0.22
HINGE_MIN_TOLERANCE_PX = 2


def mask(path):
    with Image.open(path) as image:
        return image.convert('L').point(lambda value: 255 if value else 0, mode='1')


def pixels(path):
    with Image.open(path) as image:
        return image.convert('RGBA')


def center(region):
    points = [(x, y) for x in range(region.width) for y in range(region.height) if region.getpixel((x, y))]
    if points:
        return tuple(sum(axis) / len(points) for axis in zip(*points))
    return None


def measure_parts(prop, structure, receipt, folder):
    original = pixels(receipt['reference']['path'])
    source_masks = {p['id']: mask(p['mask_path']) for p in receipt['reference_parts']}
    fixed = {part: source_masks[part] for part in prop.fixed_parts if part in source_masks}
    pivot = radius = tolerance = None
    rotation_plane = (getattr(prop.hinge, 'rotation_plane', 'in_plane')
                      if (prop.motion_type == 'hinge_rotation' and prop.hinge) else None)
    if rotation_plane == 'in_plane':
        pivot_anchor = next(a for a in structure['anchors'] if a['id'] == prop.hinge.pivot_anchor_id)
        pivot = (pivot_anchor['x'], pivot_anchor['y'])
        endpoint = center(source_masks[prop.hinge.endpoint_part_id])
        if endpoint is not None:
            radius = math.dist(pivot, endpoint)
            tolerance = max(HINGE_MIN_TOLERANCE_PX, HINGE_RELATIVE_TOLERANCE * radius)
    thresholds = {name: max(4, math.ceil(0.10 * region.histogram()[255])) for name, region in fixed.items()}
    series = []
    flags = {'fixed_parts': [], 'transition': []}
    for frame, source in zip(receipt['frames'], receipt['source_frames'], strict=True):
        number = frame['frame_index'] + 1
        native = pixels(source['path'])
        red, green, blue, alpha = ImageChops.difference(original, native).split()
        changed = ImageChops.lighter(ImageChops.lighter(red, green), ImageChops.lighter(blue, alpha))
        material = changed.point(lambda v: 255 if v >= 64 else 0).convert('1')
        changed = changed.point(lambda v: 255 if v else 0).convert('1')
        moving = Image.new('1', original.size)
        regions = {p['id']: p for p in frame['parts']}
        endpoint = None
        for name in prop.moving_parts:
            tracked = regions.get(name)
            if not tracked or tracked.get('state') in {'occluded', 'unknown', 'absent'}:
                continue
            region = mask(inside(folder, Path(folder) / tracked['file']))
            moving = ImageChops.logical_or(moving, region)
            if prop.hinge and name == prop.hinge.endpoint_part_id:
                endpoint = center(region)
        visible_changes = ImageChops.logical_and(changed, ImageChops.invert(moving))
        material_changes = ImageChops.logical_and(material, ImageChops.invert(moving))
        material_counts = {name: ImageChops.logical_and(region, material_changes).histogram()[255]
                           for name, region in fixed.items()}
        counts = {name: ImageChops.logical_and(region, visible_changes).histogram()[255]
                  for name, region in fixed.items()}
        # Report every count. Flag a material change, allowing isolated edge noise.
        if any(n >= thresholds[name] for name, n in material_counts.items()):
            flags['fixed_parts'].append(number)
        row = {'frame': number, 'fixed_changed_pixels': counts, 'fixed_material_pixels': material_counts}
        if pivot is not None:
            distance = math.dist(pivot, endpoint) if endpoint is not None else None
            row['radius_px'] = None if distance is None else round(distance, 2)
            if distance is None or radius is None or abs(distance - radius) > tolerance:
                flags['transition'].append(number)
        series.append(row)
    return {'frames': series, 'flags': flags, 'reference_radius_px': radius, 'tolerance_px': tolerance,
            'pivot_xy': pivot, 'fixed_threshold': 'channel delta >=64 on at least max(4 pixels, 10% of reference mask)',
            **({'rotation_plane': 'out_of_plane', 'radius_check_skipped': True} if rotation_plane == 'out_of_plane' else {})}


def tracked_measurements(service, job, index, stage, token):
    binding = job.request.open_plan
    if not binding.prop_structure_policy or not binding.visual_structure:
        return None
    from .tracking import TemporalStructures
    tracks = TemporalStructures(service)
    selection = binding.visual_structure['selection']
    request_key = 'prop-cues-' + digest([job.job_id, index, stage, token, selection])
    # Uses the native tracking ledger and a version-specific idempotency key.
    # First pass is local-only; a corrected revision of this analysis is reusable.
    try:
        analysis = tracks.create(job.job_id, index, selection['analysis_id'], selection['token'],
                                 request_key, stage=stage, use_semantic=False)
        if analysis['state'] in {'queued', 'tracking'}:
            tracks.run(analysis['id'])
        record = tracks.load(analysis['id'])
        doc = tracks.document(record)
        if not doc or record['state'] != 'ready' or not tracks.current(record):
            return {'unavailable': '当前帧缺少有效追踪，请人工核对', 'tracking_id': record['id']}
        directory = tracks.folder(record['id'])
        receipt_path = inside(directory, directory / doc['receipt'])
        result = measure_parts(binding.plan.quality.interactable, binding.visual_structure['data'],
                               read_json(receipt_path), receipt_path.parent)
        return {**result, 'tracking_id': record['id'], 'revision': doc['revision'], 'token': doc['token']}
    except (OSError, HarnessError) as exc:
        return {'unavailable': f'部件追踪不可用，请人工核对。{exc}'}


def guard_measurements(report, cues):
    """Preserve raw reviews. A later consensus cannot clear a measured concern."""
    if not cues or not report.get('checks'):
        return report
    labels = {
        'fixed_parts': '固定部件',
        'transition': '过渡',
        'completeness': '动作完整性',
        'equipment': '外观与装备',
        'rhythm': '运动节奏',
    }
    checks = []
    conflicts = []
    for check in report['checks']:
        dimension = check['dimension']
        frames = cues.get('flags', {}).get(dimension, [])
        missing = cues.get('unavailable') and dimension in labels
        if check['status'] == 'pass' and (frames or missing):
            message = f'{labels[dimension]}：模型判通过，' + (
                '测量有冲突（第 ' + '、'.join(map(str, frames)) + ' 帧）' if frames else str(cues['unavailable']))
            conflicts.append({'source': 'deterministic_probe', 'dimension': dimension, 'frames': frames, 'prior': check, 'reason': message})
            check = {**check, 'status': 'uncertain', 'confidence': 0, 'evidence': (message + '。' + check['evidence'])[:500]}
        checks.append(check)
    if not conflicts:
        return report
    return {**report, 'checks': checks, 'verdict': 'fail' if report['verdict'] == 'fail' else 'uncertain',
            'summary': '；'.join(c['reason'] for c in conflicts) + '。需实际画面裁决。',
            'requires_human_adjudication': [*report.get('requires_human_adjudication', []), *conflicts]}
