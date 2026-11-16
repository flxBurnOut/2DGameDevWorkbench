"""Stable weighted median cut, OKLab mapping, and optional error diffusion."""
from collections import Counter
from functools import lru_cache
from PIL import Image


@lru_cache(maxsize=65536)
def oklab(rgb):
    r, g, b = (v / 255 / 12.92 if v / 255 <= .04045 else ((v / 255 + .055) / 1.055) ** 2.4 for v in rgb)
    l = (.4122214708*r + .5363325363*g + .0514459929*b) ** (1/3)
    m = (.2119034982*r + .6806995451*g + .1073969566*b) ** (1/3)
    s = (.0883024619*r + .2817188376*g + .6299787005*b) ** (1/3)
    return (.2104542553*l + .793617785*m - .0040720468*s,
            1.9779984951*l - 2.428592205*m + .4505937099*s,
            .0259040371*l + .7827717662*m - .808675766*s)


def median_palette(pixels, count):
    histogram = Counter(p[:3] for p in pixels if p[3])
    boxes = [sorted(histogram)]
    def extent(box):
        ranges = [max(c[a] for c in box) - min(c[a] for c in box) for a in range(3)]
        axis = max(range(3), key=lambda a: (ranges[a], -a))
        return ranges[axis], sum(histogram[c] for c in box), axis
    while len(boxes) < count:
        candidates = [i for i, box in enumerate(boxes) if len(box) > 1]
        if not candidates:
            break
        index = max(candidates, key=lambda i: (*extent(boxes[i])[:2], -i))
        box = boxes.pop(index)
        _, total, axis = extent(box)
        box.sort(key=lambda c: (c[axis], c))
        cumulative = 0
        split = 1
        for split in range(1, len(box)):
            cumulative += histogram[box[split-1]]
            if cumulative * 2 >= total:
                break
        boxes[index:index] = [box[:split], box[split:]]
    return sorted(set(tuple((sum(c[a] * histogram[c] for c in box) + sum(histogram[c] for c in box)//2)
                            // sum(histogram[c] for c in box) for a in range(3)) for box in boxes))


def palette_search(labs):
    """Exact 3D nearest neighbor with original palette index as the tie breaker."""
    def build(indices, depth=0):
        if not indices: return None
        axis = depth % 3
        indices.sort(key=lambda i: (labs[i][axis], i))
        middle = len(indices)//2
        return indices[middle], axis, build(indices[:middle], depth+1), build(indices[middle+1:], depth+1)
    tree = build(list(range(len(labs))))
    def nearest(lab):
        best = (float('inf'), len(labs))
        def visit(node):
            nonlocal best
            if node is None: return
            index, axis, left, right = node
            best = min(best, (sum((lab[a]-labs[index][a])**2 for a in range(3)), index))
            delta = lab[axis]-labs[index][axis]
            near, far = (left, right) if delta < 0 else (right, left)
            visit(near)
            if delta*delta <= best[0]: visit(far)
        visit(tree)
        return best[1]
    return nearest


def quantize(image, recipe):
    pixels = list(image.getdata())
    if recipe['palette'] is not None:
        palette = [tuple(bytes.fromhex(c[1:])) for c in recipe['palette']]
    elif recipe['colors']:
        palette = median_palette(pixels, recipe['colors'])
    else:
        return image
    labs = [oklab(c) for c in palette]
    search = palette_search(labs) if len(palette) > 64 else None
    cache = {}
    def nearest(rgb):
        if rgb not in cache:
            lab = oklab(rgb)
            index = search(lab) if search else min(range(len(palette)), key=lambda i: sum((lab[a]-labs[i][a])**2 for a in range(3)))
            cache[rgb] = palette[index]
        return cache[rgb]
    width, height = image.size
    errors = [[0., 0., 0.] for _ in pixels] if recipe['dither'] else None
    result = []
    for i, p in enumerate(pixels):
        if not p[3]:
            result.append((0, 0, 0, 0)); continue
        rgb = tuple(max(0, min(255, int(p[a] + (errors[i][a] if errors else 0) + .5))) for a in range(3))
        mapped = nearest(rgb)
        result.append((*mapped, 255))
        if errors is not None:
            x, y = i % width, i // width
            for dx, dy, weight in [(1, 0, 7/16), (-1, 1, 3/16), (0, 1, 5/16), (1, 1, 1/16)]:
                if 0 <= x+dx < width and y+dy < height:
                    target = (y+dy)*width+x+dx
                    if pixels[target][3]:
                        for a in range(3): errors[target][a] += (rgb[a]-mapped[a])*weight
    output = Image.new('RGBA', image.size)
    output.putdata(result)
    return output
