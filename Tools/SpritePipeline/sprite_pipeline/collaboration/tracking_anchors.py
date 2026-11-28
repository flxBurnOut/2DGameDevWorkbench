"""Frame-bound semantic point corrections shared by V2 review and V4 exchange."""
from __future__ import annotations

import copy
from typing import Literal

from PIL import Image
from pydantic import Field, model_validator

from ..errors import ConflictError, ValidationHarnessError
from .contracts import Contract, digest


class AnchorPosition(Contract):
    x: float = Field(ge=0, le=1024, allow_inf_nan=False)
    y: float = Field(ge=0, le=1024, allow_inf_nan=False)


class TemporalAnchorCorrection(Contract):
    frame_index: int = Field(ge=0, le=127)
    source_sha256: str = Field(pattern=r'^[0-9a-f]{64}$')
    anchor_id: str = Field(pattern=r'^[a-z][a-z0-9_-]{0,63}$')
    state: Literal['visible', 'inferred', 'unknown', 'occluded']
    point: AnchorPosition | None = None

    @model_validator(mode='after')
    def position_state(self):
        if (self.state in ('visible', 'inferred')) != (self.point is not None):
            raise ValueError('可见或推断需位置；未知或遮挡不能给出确定坐标')
        return self


def part_correction_token(document, frame, part):
    return digest([c for c in document['manual_corrections'] if c['frame_index'] == frame and c['part_id'] == part])


def validate_anchor(value, document, evidence, reference):
    correction = TemporalAnchorCorrection.model_validate(value)
    index = correction.frame_index
    if index >= len(evidence.paths):
        raise ValidationHarnessError('语义点超出实际动画帧范围')
    if evidence.manifest['frames'][index]['sha256'] != correction.source_sha256:
        raise ConflictError('当前帧已改变，不能把语义点套到其他画面')
    definition = next((a for a in reference['anchors'] if a['id'] == correction.anchor_id), None)
    if not definition:
        raise ValidationHarnessError('语义点不是该角色结构中已有的身份')
    with Image.open(evidence.paths[index]) as image:
        point = correction.point
        if point and not (point.x < image.width and point.y < image.height):
            raise ValidationHarnessError('语义点超出实际原图坐标')
        if point and correction.state == 'visible' and image.convert('RGBA').getpixel((int(point.x), int(point.y)))[3] == 0:
            raise ValidationHarnessError('可见语义点落在透明区域；请重新定位或标记推断／未知')
    return {**correction.model_dump(mode='json'), 'part_id': definition['part_id'],
            'origin': 'manual_anchor_correction',
            'part_correction_token': part_correction_token(document, index, definition['part_id'])}


def effective_observations(document, reference, frames):
    """Keep original model evidence; overlay manual facts only on their exact frame.

    A later region correction invalidates earlier point assertions on that part.
    Explicit point observation can resolve a visible point while the rest of the
    material region remains uncertain; it does not turn that region into truth.
    """
    result = copy.deepcopy(document['observations'])
    manual = document.get('manual_anchor_corrections', [])
    if not manual:
        return result
    rows = {f['frame_index']: f for f in result['frames']}
    definitions = {a['id']: a for a in reference['anchors']}
    for correction in manual:
        index = correction['frame_index']
        if index >= len(frames) or correction['anchor_id'] not in definitions:
            raise ConflictError('已保存语义点的帧或身份不存在')
        if index not in rows:
            # New observation: never copy the original reference pose's known
            # coordinates or relations into a later generated frame.
            structure = copy.deepcopy(reference)
            for part in structure['parts']:
                part.update(visibility='unknown', box=None, points=[], evidence='本帧未作语义区域确认')
            for anchor in structure['anchors']:
                anchor.update(state='unknown', x=None, y=None, evidence='本帧尚无该点的观察')
            for relation in structure['relations']:
                relation.update(state='unknown', evidence='本帧未确认此关系')
            rows[index] = {'frame_index': index, 'structure': structure}
        anchor = next(a for a in rows[index]['structure']['anchors'] if a['id'] == correction['anchor_id'])
        expected = frames[index].get('source_sha256', frames[index].get('sha256'))
        valid = correction['source_sha256'] == expected and correction['part_correction_token'] == part_correction_token(document, index, correction['part_id'])
        state = correction['state'] if valid else 'unknown'
        point = correction['point'] if valid else None
        anchor.update(state=state, x=point['x'] if point else None, y=point['y'] if point else None,
                      origin='manual_anchor_correction' if valid else 'stale_manual_anchor',
                      evidence='人工在此实际帧定位的语义点；不外推到其他帧' if valid else '帧或所属部件的观察已变化，旧语义点保持未知')
    result['frames'] = [rows[i] for i in sorted(rows)]
    return result
