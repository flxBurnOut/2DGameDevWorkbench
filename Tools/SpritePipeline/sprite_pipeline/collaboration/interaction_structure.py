"""Reuse verified V2 semantic points, never mask centroids or invented joints."""
import copy


def exchange_structure(analysis, source):
    if not analysis:
        return {'state': 'absent', 'binding': None, 'anchors': [], 'relations': []}
    document = analysis.get('document')
    same_identity = all(analysis.get('source', {}).get(key) == source[key]
                        for key in ('job_id', 'candidate', 'stage', 'fps'))
    if not same_identity or not analysis.get('source_current') or not document or [f['source_sha256'] for f in document['frames']] != [f['sha256'] for f in source['frames']]:
        return {'state': 'stale', 'binding': None, 'anchors': [], 'relations': []}
    if analysis['state'] != 'ready' or not document.get('confirmation'):
        return {'state': 'unconfirmed', 'binding': None, 'anchors': [], 'relations': []}
    anchors, relations, point_evidence = {}, [], []
    model_points = {(row['frame_index'], point['id'])
                    for row in document['observations']['frames'] for point in row['structure']['anchors']}
    for observed in document.get('effective_observations',document['observations'])['frames']:
        index = observed['frame_index']
        frame = source['frames'][index]
        parts = {p['id']: p for p in document['frames'][index]['parts']}
        for value in observed['structure']['anchors']:
            item = anchors.setdefault(value['id'], {'id': value['id'], 'name': value['name'], 'part': value['part_id'],
                'provenance': 'confirmed_structure', 'evidence': f"V2 {analysis['id']} version {document['revision']}; exact observed frames only", 'samples': []})
            state = value['state']
            if value.get('origin') != 'manual_anchor_correction' and parts.get(value['part_id'], {}).get('state', 'unknown') in ('unknown', 'occluded'):
                state = 'unknown'
            item['samples'].append({'frame': index, 'state': state,
                'point': {'x': value['x'], 'y': value['y']} if state in ('visible', 'inferred') else None})
            point_evidence.append({'anchor_id': value['id'], 'frame': index,
                'raw_index': frame['raw_index'], 'sha256': frame['sha256'], 'seconds': index / source['fps'],
                'origin': value.get('origin', 'model_observation' if (index, value['id']) in model_points else 'unobserved'), 'state': state,
                'evidence': value.get('evidence', 'V2 语义观察；以实际帧为准')})
            if value.get('origin')=='manual_anchor_correction':
                item['evidence'] = f"V2 {analysis['id']} version {document['revision']}; includes manual point corrections, not automatic recognition; exact observed frames only"
        relations.extend({'frame': index, **copy.deepcopy(r)} for r in observed['structure']['relations'])
    return {'state': 'available', 'binding': {'analysis_id': analysis['id'], 'revision': document['revision'], 'token': document['token']},
            'anchors': list(anchors.values()), 'relations': relations, 'point_evidence': point_evidence}
