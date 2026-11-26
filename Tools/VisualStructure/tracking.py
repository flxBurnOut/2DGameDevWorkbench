"""Local SAM video tracking over exact PNG frames, never a drawing operation.

The pinned SAM loader is adapted in this isolated process to avoid a lossy JPEG
round trip. Reference context is frame -1, not part of playback. All propagated
regions and geometric measurements are estimates, not anatomical observations.
"""
from __future__ import annotations

import math
import re
import time
from pathlib import Path

from worker import MODEL_CONFIG, sha, write_json
from compute import requested_device, select_device, synchronize, telemetry, inference_context

TRACKER_VERSION = 'sam2_png_parts_v1'
LEGACY_SEED_POLICY = 'reference_and_corrections_v1'
CORRECTION_SEED_POLICY = 'manual_first_frame_v2'


def seed_predictor(predictor, state, parts, initial_masks, corrections, policy):
    """An explicit first-frame correction supersedes that part's old context.

    Retain object ordering, other parts and later-frame semantics. In particular,
    semantic proposals and unknown regions never replace reference initialization.
    """
    if policy not in (LEGACY_SEED_POLICY, CORRECTION_SEED_POLICY):
        raise ValueError('Unknown tracking initialization policy')
    initial = ({c['part_id']: c for c in corrections
                if c['frame_index'] == 0 and c['state'] == 'visible' and c.get('origin') == 'user_correction'}
               if policy == CORRECTION_SEED_POLICY else {})

    def points(c):
        predictor.add_new_points_or_box(state, frame_idx=c['frame_index']+1, obj_id=c['part_id'],
            points=c.get('points') or None, labels=c.get('labels') or None,
            box=c.get('box'), normalize_coords=True)

    for part in parts:
        if part['id'] in initial:
            points(initial[part['id']])
        else:
            predictor.add_new_mask(state, frame_idx=0, obj_id=part['id'], mask=initial_masks[part['id']])
    for correction in corrections:
        if correction['state'] != 'visible':
            continue
        if correction['frame_index'] == 0 and correction['part_id'] in initial:
            continue
        points(correction)
    # Never predict the non-playback reference before a corrected object's first
    # conditioning frame. Reference masks of the other parts remain available.
    return 1 if initial else None


def measure(mask):
    import numpy as np
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return {'area': 0, 'box': None, 'centroid': None, 'axis_degrees_mod_180': None,
                'elongation': None, 'state': 'unknown', 'reason': 'no_visible_region'}
    axis = elongation = None
    if len(xs) > 2:
        covariance = np.cov(np.stack([xs, ys]))
        values, vectors = np.linalg.eigh(covariance)
        if values[-1] > 0:
            elongation = float(values[-1] / max(float(values[0]), .25))
            # An unoriented material axis is not facing, a joint, or a blade tip.
            if elongation >= 2:
                axis = float(math.degrees(math.atan2(vectors[1, -1], vectors[0, -1])) % 180)
    return {'area': int(len(xs)), 'box': [int(xs.min()), int(ys.min()), int(xs.max()+1), int(ys.max()+1)],
            'centroid': [float(xs.mean()), float(ys.mean())],
            'axis_degrees_mod_180': axis, 'elongation': elongation,
            'state': 'estimated', 'reason': 'propagated_material_region_not_verified_anatomy'}


def track(job):
    import numpy as np
    import torch
    from PIL import Image
    from sam2.build_sam import build_sam2_video_predictor
    import sam2.sam2_video_predictor as video_module

    weights, output = Path(job['weights']), Path(job['output'])
    reference = job['reference']
    frames, parts = job['frames'], job['parts']
    fps = job['fps']
    if type(fps) not in (int, float) or not math.isfinite(fps) or not 0 < fps <= 240:
        raise ValueError('Invalid playback FPS')
    if not 1 <= len(frames) <= 128 or not 1 <= len(parts) <= 32:
        raise ValueError('Tracking expects 1-128 real frames and 1-32 parts')
    if [f['frame_index'] for f in frames] != list(range(len(frames))):
        raise ValueError('Frames must be the complete ordered playback selection')
    sources = [reference, *frames]
    if sha(weights) != job['weights_sha256']:
        raise ValueError('Frozen model hash mismatch')
    rgba_frames = []
    for source in sources:
        path = Path(source['path'])
        if sha(path) != source['sha256']:
            raise ValueError('Frozen frame hash mismatch')
        with Image.open(path) as im:
            if im.format != 'PNG' or max(im.size) > 1024:
                raise ValueError('Tracking requires bounded original PNGs')
            rgba_frames.append(im.convert('RGBA'))
    sizes = {im.size for im in rgba_frames}
    if len(sizes) != 1:
        raise ValueError('Reference and frames must share the same source coordinate system')
    width, height = rgba_frames[0].size
    seen = set()
    initial_masks = {}
    for part in parts:
        name = part['id']
        if not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', name) or name in seen:
            raise ValueError('Invalid or duplicate part identity')
        seen.add(name)
        if sha(part['mask_path']) != part['mask_sha256']:
            raise ValueError('Reference mask hash mismatch')
        with Image.open(part['mask_path']) as mask:
            if mask.size != (width, height):
                raise ValueError('Mask coordinate system mismatch')
            initial_masks[name] = np.asarray(mask.convert('L')) > 0
        if not initial_masks[name].any():
            raise ValueError('Cannot track a part with an empty reference mask')
    corrections = job.get('corrections', [])
    seed_policy = job.get('tracking_policy', LEGACY_SEED_POLICY)
    if seed_policy not in (LEGACY_SEED_POLICY, CORRECTION_SEED_POLICY):
        raise ValueError('Unknown tracking initialization policy')
    if len(corrections) > 256:
        raise ValueError('Too many corrections')
    correction_ids = set()
    for correction in corrections:
        frame, name = correction['frame_index'], correction['part_id']
        if type(frame) is not int or not 0 <= frame < len(frames) or name not in seen:
            raise ValueError('Correction must identify an actual frame and known part')
        if (frame, name) in correction_ids:
            raise ValueError('Duplicate correction')
        correction_ids.add((frame, name))
        if correction['state'] not in ('visible', 'unknown', 'occluded'):
            raise ValueError('Invalid visibility correction')
        if correction['state'] == 'visible':
            points, labels = correction.get('points', []), correction.get('labels', [])
            box = correction.get('box')
            if len(points) != len(labels) or len(points) > 32 or any(v not in (0, 1) for v in labels):
                raise ValueError('Invalid correction prompts')
            if any(len(p) != 2 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in p)
                   or not (0 <= p[0] < width and 0 <= p[1] < height) for p in points):
                raise ValueError('Correction point outside source')
            if box is not None and (len(box) != 4 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in box)
                    or not (0 <= box[0] < box[2] <= width and 0 <= box[1] < box[3] <= height)):
                raise ValueError('Correction box outside source')
            if not points and box is None:
                raise ValueError('Visible correction needs actual image prompts')

    output.mkdir(parents=True, exist_ok=False)
    requested = requested_device(job)
    device = select_device(torch, requested)
    start = time.monotonic()
    if device == 'cuda':
        torch.cuda.reset_peak_memory_stats()
    predictor = build_sam2_video_predictor(MODEL_CONFIG, str(weights), device=device,
                                           apply_postprocessing=False)

    def png_loader(*, image_size, offload_video_to_cpu, compute_device, **_):
        # Allocate once; stacking and out-of-place normalization can briefly
        # triple the host memory needed by a long 1024x1024 sequence.
        tensor=torch.empty((len(rgba_frames), 3, image_size, image_size))
        for index, rgba in enumerate(rgba_frames):
            background=Image.new('RGBA', rgba.size, (127, 127, 127, 255))
            background.alpha_composite(rgba)
            values=np.array(background.convert('RGB').resize((image_size, image_size)), copy=True)
            tensor[index].copy_(torch.from_numpy(values).permute(2, 0, 1))
        tensor.div_(255)
        if not offload_video_to_cpu: tensor=tensor.to(compute_device)
        tensor.sub_(torch.tensor([.485, .456, .406], device=tensor.device)[:, None, None])
        tensor.div_(torch.tensor([.229, .224, .225], device=tensor.device)[:, None, None])
        return tensor, height, width

    old_loader=video_module.load_video_frames
    try:
        video_module.load_video_frames=png_loader
        with torch.inference_mode(), inference_context(torch, device, predictor):
            state=predictor.init_state(video_path='frozen-png-memory', offload_video_to_cpu=True)
    finally:
        video_module.load_video_frames=old_loader
    visibility={(c['frame_index'], c['part_id']):c for c in corrections}
    records=[]
    with torch.inference_mode(), inference_context(torch, device, predictor):
        propagation_start = seed_predictor(predictor, state, parts, initial_masks, corrections, seed_policy)
        arguments = {} if propagation_start is None else {'start_frame_idx': propagation_start}
        for internal_index, ids, logits in predictor.propagate_in_video(state, **arguments):
            if internal_index == 0: continue
            index=internal_index-1
            alpha=np.asarray(rgba_frames[internal_index])[:, :, 3] > 0
            folder=output/f'frame-{index:03d}'
            folder.mkdir()
            observed=[]
            for name, logit in zip(ids, logits):
                raw=logit[0].detach().float().cpu().numpy() > 0
                mask=raw & alpha
                path=folder/(str(name)+'.png')
                Image.fromarray(mask.astype(np.uint8)*255).save(path)
                geometry=measure(mask)
                correction=visibility.get((index, name))
                if correction and correction['state'] != 'visible':
                    geometry={**geometry, 'state':correction['state'], 'reason':'explicit_visibility_correction',
                              'centroid':None, 'axis_degrees_mod_180':None}
                observed.append({'id':name, 'file':str(path.relative_to(output)).replace('\\','/'),
                    'sha256':sha(path), **geometry, 'excluded_transparent_pixels':int((raw & ~alpha).sum()),
                    'prompt_corrected':bool(correction), 'semantic_identity_verified':False})
            records.append({'frame_index':index, 'source_sha256':frames[index]['sha256'],
                            'time_seconds':index/fps, 'parts':observed})
    records.sort(key=lambda r:r['frame_index'])
    if [r['frame_index'] for r in records] != list(range(len(frames))):
        raise ValueError('Tracker omitted or duplicated a playback frame')
    synchronize(torch, device)
    if any(sha(s['path']) != s['sha256'] for s in sources) or any(sha(p['mask_path']) != p['mask_sha256'] for p in parts):
        raise ValueError('Frozen source changed during tracking')
    receipt={'version':1, 'operation':'track', 'tracker_version':TRACKER_VERSION,
        'source':job.get('source'), 'reference':reference, 'context_frame_count':1,
        'context_excluded_from_playback':True, 'width':width, 'height':height, 'fps':fps,
        'source_frames':frames, 'reference_parts':parts, 'frames':records,
        'corrections':corrections, 'weights_sha256':job['weights_sha256'],
        'device':device, 'seconds':time.monotonic()-start,
        **telemetry(torch, device, requested),
        'paid_calls':0, 'source_unchanged':True,
        'limitations':['Propagated masks are estimates, not verified semantic identities',
            'Mask centroids are not joints or grip positions',
            'Material axes are undirected and do not establish facing',
            'Empty region does not distinguish occlusion from tracking failure',
            'No drawing, acceptance, timing change or edit authorization']}
    if seed_policy != LEGACY_SEED_POLICY:
        receipt['tracking_policy'] = seed_policy
    write_json(output/'receipt.json',receipt)
    return receipt
