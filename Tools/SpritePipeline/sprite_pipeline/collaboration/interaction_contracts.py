"""Offline actor/object exchange. Observations are not animation edit permission."""
from __future__ import annotations

import base64
import hashlib
import io
from typing import Literal

from PIL import Image
from pydantic import Field, model_validator

from .contracts import Contract

ID = r'^[A-Za-z0-9_-]{1,80}$'
SHA = r'^[0-9a-f]{64}$'


class Point(Contract):
    x: float = Field(allow_inf_nan=False, ge=-16384, le=16384)
    y: float = Field(allow_inf_nan=False, ge=-16384, le=16384)


class Placement(Contract):
    position: Point
    origin: Point
    scale: float = Field(gt=0, le=16, allow_inf_nan=False)
    flip_x: bool = False
    facing: Literal['left', 'right', 'unknown'] = 'unknown'
    depth: int = Field(ge=-100, le=100)


class AnchorSample(Contract):
    frame: int = Field(ge=0, le=255)
    state: Literal['visible', 'inferred', 'occluded', 'unknown']
    point: Point | None = None

    @model_validator(mode='after')
    def position_matches_evidence(self):
        if (self.state in ('visible', 'inferred')) != (self.point is not None):
            raise ValueError('可见或推断点需坐标；未知和遮挡点不能带确定坐标')
        return self


class Anchor(Contract):
    id: str = Field(pattern=ID)
    name: str = Field(min_length=1, max_length=100)
    part: str = Field(min_length=1, max_length=100)
    # Imported structure observations retain their source; manual annotations are
    # never presented as successful automatic recognition.
    provenance: Literal['manual', 'confirmed_structure']
    evidence: str = Field(min_length=4, max_length=400)
    samples: list[AnchorSample] = Field(min_length=1, max_length=256)

    @model_validator(mode='after')
    def distinct_frames(self):
        if len({s.frame for s in self.samples}) != len(self.samples):
            raise ValueError('同一锚点每帧只能有一份观察')
        return self


class Region(Contract):
    x: int = Field(ge=0, le=1023)
    y: int = Field(ge=0, le=1023)
    width: int = Field(ge=1, le=1024)
    height: int = Field(ge=1, le=1024)


class ObjectFrame(Contract):
    raw_index: int = Field(ge=0, le=9999)
    sha256: str = Field(pattern=SHA)
    png_base64: str = Field(min_length=20, max_length=1_000_000)
    duration: float = Field(ge=0.25, le=120, allow_inf_nan=False)
    width: int = Field(ge=1, le=1024)
    height: int = Field(ge=1, le=1024)
    region: Region | None = None

    def pixels(self):
        try:
            data = base64.b64decode(self.png_base64, validate=True)
            if hashlib.sha256(data).hexdigest() != self.sha256:
                raise ValueError('物件图片与登记哈希不符')
            with Image.open(io.BytesIO(data)) as image:
                if image.format != 'PNG' or image.width > 1024 or image.height > 1024:
                    raise ValueError('联合预览仅接收不大于 1024 像素的 PNG')
                image.load()
                if image.size != (self.width, self.height):
                    raise ValueError('物件原图登记尺寸不符')
                if self.region:
                    r = self.region
                    if r.x + r.width > image.width or r.y + r.height > image.height:
                        raise ValueError('物件帧裁切范围超出原图')
                    return r.width, r.height
                return image.size
        except (OSError, ValueError) as error:
            raise ValueError('物件 PNG 校验失败') from error


class Surface(Contract):
    id: str = Field(pattern=ID)
    name: str = Field(min_length=1, max_length=100)
    start: Point
    end: Point
    provenance: Literal['manual', 'scene_geometry']
    evidence: str = Field(min_length=4, max_length=400)

    @model_validator(mode='after')
    def nonempty(self):
        if self.start == self.end:
            raise ValueError('接触表面不能是零长度线段')
        return self


class ObjectState(Contract):
    id: str = Field(pattern=ID)
    name: str = Field(min_length=1, max_length=100)
    fps: float = Field(gt=0, le=120, allow_inf_nan=False)
    loop: bool
    width: int = Field(ge=1, le=1024)
    height: int = Field(ge=1, le=1024)
    frames: list[ObjectFrame] = Field(min_length=1, max_length=128)
    anchors: list[Anchor] = Field(default_factory=list, max_length=16)
    surfaces: list[Surface] = Field(default_factory=list, max_length=16)
    visible: bool = True
    tint: str = Field(default='#ffffff', pattern=r'^#[0-9a-fA-F]{6}$')


class ObjectRendering(Contract):
    # This is the source editor's pixel-to-display mapping, separate from the
    # actor/object placement explicitly chosen for the joint preview.
    width: float = Field(gt=0, le=8192, allow_inf_nan=False)
    height: float = Field(gt=0, le=8192, allow_inf_nan=False)
    offset: Point
    scale: float = Field(ge=.01, le=100, allow_inf_nan=False)
    flip_x: bool = False
    flip_y: bool = False


class ObjectSource(Contract):
    asset_id: str = Field(min_length=1, max_length=300)
    revision: str = Field(min_length=1, max_length=128)
    sha256: str = Field(pattern=SHA)
    label: str = Field(min_length=1, max_length=150)
    scope: Literal['frozen_import'] = 'frozen_import'


class StateEvent(Contract):
    time: float = Field(ge=0, le=120, allow_inf_nan=False)
    from_state: str = Field(pattern=ID)
    to_state: str = Field(pattern=ID)


class Window(Contract):
    start: float = Field(ge=0, le=120, allow_inf_nan=False)
    end: float = Field(ge=0, le=120, allow_inf_nan=False)

    @model_validator(mode='after')
    def ordered(self):
        if self.end < self.start:
            raise ValueError('时间窗口结束不能早于开始')
        return self


class Relation(Contract):
    id: str = Field(pattern=ID)
    name: str = Field(min_length=1, max_length=120)
    kind: Literal['contact', 'attached', 'separated', 'surface_contact']
    actor_anchor: str = Field(pattern=ID)
    object_anchor: str = Field(pattern=ID)
    window: Window
    tolerance_px: float = Field(gt=0, le=1024, allow_inf_nan=False)
    tolerance_reason: str = Field(min_length=4, max_length=400)
    # Expected response is an independently declared requirement, not inferred
    # from the animation schedule being evaluated.
    response_state: str | None = Field(default=None, pattern=ID)
    response_window: Window | None = None

    @model_validator(mode='after')
    def paired_response(self):
        if (self.response_state is None) != (self.response_window is None):
            raise ValueError('状态响应需同时指定目标状态和允许时间窗口')
        return self


def check_anchors(anchors, sizes):
    if len({a.id for a in anchors}) != len(anchors):
        raise ValueError('锚点标识不能重复')
    for anchor in anchors:
        for sample in anchor.samples:
            if sample.frame >= len(sizes):
                raise ValueError('锚点引用了不存在的播放帧')
            width, height = sizes[sample.frame]
            if sample.point and not (0 <= sample.point.x < width and 0 <= sample.point.y < height):
                raise ValueError('锚点超出对应原图坐标')


class StructureBinding(Contract):
    analysis_id: str = Field(pattern=r'^[0-9a-f]{32}$')
    revision: int = Field(ge=1)
    token: str = Field(pattern=SHA)


class InteractionContext(Contract):
    version: Literal[1] = 1
    title: str = Field(min_length=1, max_length=150)
    actor: Placement
    actor_anchors: list[Anchor] = Field(default_factory=list, max_length=32)
    structure_binding: StructureBinding | None = None
    object: Placement
    object_rendering: ObjectRendering | None = None
    object_source: ObjectSource
    object_states: list[ObjectState] = Field(min_length=1, max_length=16)
    initial_state: str = Field(pattern=ID)
    events: list[StateEvent] = Field(default_factory=list, max_length=32)
    relations: list[Relation] = Field(default_factory=list, max_length=32)
    interruption: Literal['reset_on_restart'] = 'reset_on_restart'
    permissions: Literal['preview_only'] = 'preview_only'

    @model_validator(mode='after')
    def references(self):
        if any(a.provenance == 'confirmed_structure' for a in self.actor_anchors) and not self.structure_binding:
            raise ValueError('结构锚点必须绑定实际分析版本，不能只修改来源标签')
        states = {s.id: s for s in self.object_states}
        if len(states) != len(self.object_states) or self.initial_state not in states:
            raise ValueError('物件状态标识重复或初始状态不存在')
        total = 0
        for state in self.object_states:
            sizes = []
            for frame in state.frames:
                total += len(frame.png_base64)
                if total > 1_700_000:
                    raise ValueError('联合预览素材超过本次保存上限')
                sizes.append(frame.pixels())
            if len(set(sizes)) != 1:
                raise ValueError('同一状态的帧需使用相同原图尺寸')
            if sizes[0] != (state.width, state.height):
                raise ValueError('物件登记尺寸与实际 PNG 不符')
            check_anchors(state.anchors, sizes)
            if len({s.id for s in state.surfaces}) != len(state.surfaces):
                raise ValueError('同一状态的表面标识重复')
            for surface in state.surfaces:
                if any(not (0 <= p.x <= state.width and 0 <= p.y <= state.height) for p in (surface.start,surface.end)):
                    raise ValueError('接触表面超出物件实际坐标')
        previous, state = -1, self.initial_state
        for event in self.events:
            if event.time <= previous or event.from_state != state or event.to_state not in states:
                raise ValueError('状态响应顺序或前置状态不匹配')
            previous, state = event.time, event.to_state
        if len({r.id for r in self.relations}) != len(self.relations):
            raise ValueError('关系标识重复')
        for relation in self.relations:
            if relation.actor_anchor not in {a.id for a in self.actor_anchors}:
                raise ValueError('关系引用的角色作用点不存在')
            if not any(relation.object_anchor in {a.id for a in (s.surfaces if relation.kind=='surface_contact' else s.anchors)} for s in self.object_states):
                raise ValueError('关系引用的物件作用点不存在')
            if relation.response_state and relation.response_state not in states:
                raise ValueError('响应目标状态不存在')
        return self


class SaveInteraction(Contract):
    expected_revision: int = Field(ge=1)
    candidate_index: int = Field(ge=1, le=8)
    stage_index: int | None = Field(default=None, ge=0, le=3)
    source_token: str = Field(pattern=SHA)
    expected_context_version: int = Field(ge=0, le=9999)
    request_key: str = Field(min_length=8, max_length=128, pattern=r'^[A-Za-z0-9._:-]+$')
    context: InteractionContext
