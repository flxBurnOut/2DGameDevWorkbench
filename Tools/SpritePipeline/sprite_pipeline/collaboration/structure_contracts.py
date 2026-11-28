"""Visible structure proposals; target poses and facts must never be conflated."""
from __future__ import annotations

import math
from typing import Literal
from pydantic import Field, model_validator
from .contracts import Contract

IDENTIFIER = r'^[a-z][a-z0-9_-]{0,63}$'


class StructurePoint(Contract):
    x: float = Field(ge=0, le=1024, allow_inf_nan=False)
    y: float = Field(ge=0, le=1024, allow_inf_nan=False)
    label: Literal[0, 1]


class StructurePart(Contract):
    id: str = Field(pattern=IDENTIFIER)
    name: str = Field(min_length=1, max_length=120)
    kind: Literal['body', 'head', 'limb', 'hand', 'foot', 'equipment', 'clothing', 'other']
    parent_id: str | None = Field(default=None, pattern=IDENTIFIER)
    box: list[float] | None = Field(default=None, min_length=4, max_length=4)
    points: list[StructurePoint] = Field(default_factory=list, max_length=12)
    visibility: Literal['visible', 'occluded', 'unknown'] = 'visible'
    evidence: str = Field(default='', max_length=500)

    @model_validator(mode='after')
    def finite_box(self):
        if self.box and any(not math.isfinite(v) for v in self.box):
            raise ValueError('区域坐标必须是有限数值')
        return self


class StructureAnchor(Contract):
    id: str = Field(pattern=IDENTIFIER)
    part_id: str = Field(pattern=IDENTIFIER)
    name: str = Field(min_length=1, max_length=120)
    x: float | None = Field(default=None, ge=0, le=1024, allow_inf_nan=False)
    y: float | None = Field(default=None, ge=0, le=1024, allow_inf_nan=False)
    state: Literal['visible', 'inferred', 'occluded', 'unknown']
    evidence: str = Field(default='', max_length=500)

    @model_validator(mode='after')
    def coordinates(self):
        if (self.x is None) != (self.y is None):
            raise ValueError('锚点坐标必须成对提供')
        if self.state in {'unknown', 'occluded'} and self.x is not None:
            raise ValueError('不可见锚点不能伪装成已观察坐标；推断须明确标记')
        if self.state in {'visible', 'inferred'} and self.x is None:
            raise ValueError('已观察或推断的锚点需要坐标')
        return self


class StructureRelation(Contract):
    id: str = Field(pattern=IDENTIFIER)
    type: Literal['connected', 'holds', 'supports', 'part_of', 'axis', 'contact']
    source: str = Field(pattern=IDENTIFIER)
    target: str = Field(pattern=IDENTIFIER)
    state: Literal['visible', 'inferred', 'unknown']
    evidence: str = Field(default='', max_length=500)


class StructureProposal(Contract):
    summary: str = Field(max_length=1000)
    parts: list[StructurePart] = Field(min_length=1, max_length=24)
    anchors: list[StructureAnchor] = Field(default_factory=list, max_length=32)
    relations: list[StructureRelation] = Field(default_factory=list, max_length=48)
    uncertainties: list[str] = Field(default_factory=list, max_length=24)

    @model_validator(mode='after')
    def references(self):
        parts = {p.id: p for p in self.parts}
        ids = [p.id for p in self.parts] + [a.id for a in self.anchors]
        if len(ids) != len(set(ids)) or len({r.id for r in self.relations}) != len(self.relations):
            raise ValueError('部件、锚点或关系标识重复')
        for part in self.parts:
            seen = {part.id}; parent = part.parent_id
            while parent:
                if parent not in parts or parent in seen:
                    raise ValueError('部件层级有循环或引用不存在的部件')
                seen.add(parent); parent = parts[parent].parent_id
        if any(a.part_id not in parts for a in self.anchors):
            raise ValueError('锚点所属部件不存在')
        if any(r.source not in ids or r.target not in ids or r.source == r.target for r in self.relations):
            raise ValueError('关系引用不存在或指向自身')
        return self


def coordinate_issues(proposal, image):
    """Deterministic validity cues, never anatomy or quality verdicts."""
    import math
    width, height = image.size
    alpha = image.convert('RGBA').getchannel('A')
    issues = []
    def issue(subject, message):
        issues.append({'id': subject, 'message': message, 'severity': 'needs_correction'})
    def within(x, y):
        return math.isfinite(x) and math.isfinite(y) and 0 <= x < width and 0 <= y < height
    for p in proposal.parts:
        if p.box:
            left, top, right, bottom = p.box
            if not all(math.isfinite(v) for v in p.box) or not (0 <= left < right <= width and 0 <= top < bottom <= height):
                issue(p.id, '区域超出原图或尺寸无效')
        if p.visibility == 'visible' and not p.box and not any(v.label == 1 for v in p.points):
            issue(p.id, '可见部件缺少区域或保留点')
        for point in p.points:
            if not within(point.x, point.y): issue(p.id, '提示点超出原图')
            elif point.label == 1 and alpha.getpixel((int(point.x), int(point.y))) == 0:
                issue(p.id, '保留点落在透明背景，请移动或标记未知')
    for a in proposal.anchors:
        if a.x is None: continue
        if not within(a.x, a.y): issue(a.id, '锚点超出原图')
        elif a.state == 'visible' and alpha.getpixel((int(a.x), int(a.y))) == 0:
            issue(a.id, '可见锚点落在透明背景，请核对或标记推断')
    return issues
