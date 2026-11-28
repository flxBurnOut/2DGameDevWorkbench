"""Validate explicit frame-local observation corrections without editing art."""
from __future__ import annotations
from PIL import Image
from pydantic import Field
from typing import Literal
from .contracts import Contract
from .structure_contracts import StructurePoint, StructurePart, StructureProposal, coordinate_issues
from ..errors import ValidationHarnessError


class TrackingCorrection(Contract):
    frame_index: int = Field(ge=0,le=127)
    part_id: str = Field(pattern=r'^[a-z][a-z0-9_-]{0,63}$')
    state: Literal['visible','unknown','occluded']
    box: list[float] | None = Field(default=None,min_length=4,max_length=4)
    points: list[StructurePoint] = Field(default_factory=list,max_length=12)


def validate_correction(value, document, evidence, reference):
    correction=TrackingCorrection.model_validate(value)
    if correction.frame_index>=len(evidence.paths):raise ValidationHarnessError('纠正帧超出实际动画')
    part=next((p for p in reference['parts'] if p['id']==correction.part_id),None)
    if not part:raise ValidationHarnessError('纠正部件身份不存在')
    if correction.state!='visible' and (correction.points or correction.box):
        raise ValidationHarnessError('未知或遮挡区域不能同时给出确定位置')
    item=StructurePart.model_validate({**part,'parent_id':None,'visibility':correction.state,
        'box':correction.box,'points':[p.model_dump(mode='json') for p in correction.points]})
    proposal=StructureProposal(summary='用户观察纠正',parts=[item])
    with Image.open(evidence.paths[correction.frame_index]) as im:issues=coordinate_issues(proposal,im)
    if issues:raise ValidationHarnessError('纠正未通过实际像素校验：'+issues[0]['message'])
    return {'frame_index':correction.frame_index,'part_id':correction.part_id,'state':correction.state,
            'box':correction.box,'points':[[p.x,p.y] for p in correction.points],
            'labels':[p.label for p in correction.points],'origin':'user_correction'}
