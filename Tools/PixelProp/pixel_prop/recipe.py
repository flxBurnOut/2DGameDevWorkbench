"""Versioned, canonical conversion recipes. No workstation state is consulted."""
from dataclasses import asdict, dataclass
import hashlib
import json
from pathlib import Path
import re

ALGORITHM_VERSION = 1


def color(value):
    if not isinstance(value, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', value):
        raise ValueError('Colors must use #RRGGBB')
    return value.lower()


@dataclass(frozen=True)
class Recipe:
    size: int = 128
    padding: int = 4
    fit: str = 'contain'
    anchor: str = 'bottom'
    resample: str = 'area'
    alphaThreshold: int = 128
    colors: int = 24
    palette: list[str] | str | None = None
    dither: bool = False
    removeIsolated: bool = True
    outline: str = 'none'
    background: str = 'alpha'

    def normalized(self):
        data = asdict(self)
        for name, low, high in [('size', 64, 128), ('padding', 0, 16), ('alphaThreshold', 1, 254), ('colors', 0, 64)]:
            value = data[name]
            if type(value) is not int or not low <= value <= high:
                raise ValueError(f'{name} must be an integer in {low}..{high}')
        if self.size not in (64, 128) or self.colors == 1:
            raise ValueError('size must be 64 or 128; colors must be 0 or 2..64')
        for name, choices in [('fit', ('contain',)), ('anchor', ('bottom', 'center')),
                              ('resample', ('area', 'dominant', 'nearest'))]:
            if data[name] not in choices:
                raise ValueError(f'{name} must be one of {choices}')
        for name in ('dither', 'removeIsolated'):
            if type(data[name]) is not bool:
                raise ValueError(f'{name} must be boolean')
        if self.outline not in ('none', 'dark'):
            data['outline'] = color(self.outline)
        if self.background != 'alpha':
            if not isinstance(self.background, str) or not self.background.startswith('key:'):
                raise ValueError('background must be alpha or key:#RRGGBB')
            data['background'] = 'key:' + color(self.background[4:])
        palette = self.palette
        if isinstance(palette, str):
            # object: palettes are resolved by the host before entering this standalone tool.
            if palette.startswith('object:'):
                raise ValueError('object: palettes require the workbench; pass a color list here')
            palette = json.loads(Path(palette).read_text(encoding='utf-8'))
        if palette is not None:
            if not isinstance(palette, list) or not 1 <= len(palette) <= 16384:
                raise ValueError('palette must contain 1..16384 #RRGGBB colors')
            data['palette'] = list(dict.fromkeys(color(c) for c in palette))
        return data

    @classmethod
    def from_dict(cls, data):
        if not isinstance(data, dict):
            raise ValueError('recipe must be an object')
        try:
            recipe = cls(**data)
            return cls(**recipe.normalized())
        except TypeError as exc:
            raise ValueError('Unknown recipe field or invalid value') from exc

    @property
    def sha256(self):
        return hashlib.sha256(canonical(self.normalized())).hexdigest()


def canonical(data):
    return json.dumps(data, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
