"""Version-bound structural context for the existing independent reviewers.

Actual images and the two frozen baseline calls remain unchanged. A structure
snapshot is supplementary, uncertain evidence; it is not a quality label.
"""
from __future__ import annotations

import copy
from pathlib import Path
from ..errors import ConflictError
from ..jsonio import read_json, sha256_file
from .contracts import digest
from .tracking_data import validate_receipt, tracking_cues

STRUCTURE_REVIEW_VERSION=3

# Applies only to the optional structural supplement. The saved baseline and
# ordinary experts_v1 requests retain their original prompts and behavior.
STRUCTURE_REVIEW_RULES=(
    'Treat observations and interpretation separately. Unknown/occluded regions have no usable location; '
    'absence of an observed region cannot establish absence of an object. Equally, an unknown or much smaller region '
    'does not prove harmless occlusion or unchanged object shape: cite a visible occluder or credible ordered projection '
    'change, and otherwise keep disappearance versus foreshortening uncertain rather than declaring equipment satisfied. '
    'Mask centers are not joints, '
    'undirected axes are not body facing, and sparse contacts cannot fill unobserved frames. '
    'Measurements do not add acceptance criteria. Distinguish the original user instruction from planner-proposed '
    'realization details: a different pose path or timing from a proposed plan is not a material defect unless actual '
    'ordered images show the requested outcome or physical continuity is broken. '
    'For a hold, locate it within the event and compare its actual duration with preparation, motion and release. '
    'A still pose followed by settling can be expressive timing; numerical stillness alone is neither a failure nor a pass. '
    'For an alleged repeated event, identify both complete event transitions; lifting or returning alone is not a second event. '
    'For every fail cite the visible contradiction and its source requirement, and consider the strongest plausible '
    'perspective, occlusion, effect or expressive-timing explanation. If images cannot distinguish it, report uncertainty '
    'or preference rather than inventing certainty. Preserve clear defects; do not excuse visible duplication or discontinuity. '
)


class StructuredReviewEvidence:
    def __init__(self, base, *, job_path, receipt_path, reference_structure_path, observations_path=None, intent_path=None, current_guard=None):
        self.base=base;self.folder=base.folder;self.manifest=base.manifest;self.token=base.token
        self.job_path=Path(job_path);self.receipt_path=Path(receipt_path)
        self.reference_structure_path=Path(reference_structure_path)
        self.observations_path=Path(observations_path) if observations_path else None
        self.intent_path=Path(intent_path) if intent_path else None
        self.current_guard=current_guard
        self.files=[self.job_path,self.receipt_path,self.reference_structure_path,*([self.observations_path] if self.observations_path else []),*([self.intent_path] if self.intent_path else [])]
        self.hashes=[sha256_file(path) for path in self.files]
        self.structure_binding={'version':STRUCTURE_REVIEW_VERSION,'source_token':self.token,
            'job_sha256':self.hashes[0],'receipt_sha256':self.hashes[1],'reference_structure_sha256':self.hashes[2],
            'observations_sha256':sha256_file(self.observations_path) if self.observations_path else None,
            'intent_sha256':sha256_file(self.intent_path) if self.intent_path else None}
        self.structure_binding['token']=digest(self.structure_binding)
        self.verify()

    @property
    def paths(self):return self.base.paths

    def verify(self):
        self.base.verify()
        if self.current_guard and not self.current_guard():
            raise ConflictError('复核期间原动画或结构版本已改变')
        if [sha256_file(path) for path in self.files]!=self.hashes:
            raise ConflictError('结构观察或其版本改变，不能沿用旧复核')
        job=read_json(self.job_path);receipt=read_json(self.receipt_path)
        validate_receipt(receipt,self.receipt_path.parent,job)
        if ([f['sha256'] for f in job['frames']]!=[f['sha256'] for f in self.manifest['frames']]
                or job['reference']['sha256']!=self.manifest['reference']['sha256'] or job['fps']!=self.manifest['fps']):
            raise ConflictError('结构观察与当前复核动画的实际帧或时间不同')

    def pictures(self):return self.base.pictures()

    def context(self):
        # Preserve the old context for the two baseline calls. Only the
        # independent expert/dispute builders request structure_context().
        return self.base.context()

    def explicit_requirements(self):
        values=[self.base.context().get('user_request',''),self.manifest.get('target_note','')]
        if self.intent_path:
            values+=read_json(self.intent_path)['explicit_user_text']
        return [v for v in values if isinstance(v,str) and v.strip()]

    def structure_context(self):
        self.verify()
        reference=read_json(self.reference_structure_path)
        if 'data' in reference:reference=reference['data']
        receipt=read_json(self.receipt_path)
        cues=tracking_cues(receipt,self.receipt_path.parent,reference)
        keyframes=[]
        if self.observations_path:
            observations=read_json(self.observations_path)
            for frame in observations.get('frames',[]):
                structure=frame['structure']
                keyframes.append({'frame':frame['frame_index']+1,
                    'anchors':[{k:a[k] for k in ('id','part_id','x','y','state')} for a in structure['anchors']],
                    'relations':[{k:r[k] for k in ('id','type','source','target','state')} for r in structure['relations']]})
        series=[]
        for row in cues['series']:
            series.append({'frame':row['frame_index']+1,'time_seconds':row['time_seconds'],
                           'parts':[{k:p.get(k) for k in ('id','state','area','box','axis_degrees_mod_180')} for p in row['parts']]})
        return {'binding':self.structure_binding,'parts':[{k:p[k] for k in ('id','name','kind','parent_id')} for p in reference['parts']],
            'requirement_provenance':{'explicit_user_text':self.explicit_requirements(),
                'planning_details':'Other plan/quality descriptions are proposed implementation details unless independently traced to the explicit user text; their deviation must not alone become a material defect.'},
            'material_region_estimates':series,'sparse_semantic_observations':keyframes,
            'measurement_cues_not_defects':[{'frame':c['frame_index']+1,'parts':c['parts'],'reason':c['reason']} for c in cues['cues']],
            'limits':receipt.get('limitations',[]),
            'warning':'这些是可能出错的辅助观察，不是缺陷标签或人体物理真值。结构与实际图片冲突时，以图片为准并说明结构不可靠；不要把缺测、区域扩大、二维投影变化或长轴反转直接判为动画错误。'}


def structure_context(evidence):
    builder=getattr(evidence,'structure_context',None)
    return builder() if builder else None
