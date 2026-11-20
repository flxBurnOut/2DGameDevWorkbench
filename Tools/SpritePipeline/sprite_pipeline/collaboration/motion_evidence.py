"""Transparent motion cues. Pixel change is not a verdict on anatomy or force."""
import io
from PIL import Image,ImageChops,ImageStat


def alpha_changes(images, regions, reference):
    """Report changes of at least half the alpha range on reference-opaque pixels."""
    cues = []
    with Image.open(reference) as source:
        original = source.convert('RGBA').getchannel('A')
    for region in regions:
        box = tuple(region['box'])
        opaque = original.crop(box).point(lambda a: 255 if a == 255 else 0)
        previous = original.crop(box)
        for frame, (_, alpha) in enumerate(images, 1):
            current = alpha.crop(box)
            lost = ImageChops.multiply(ImageChops.subtract(previous, current), opaque)
            gained = ImageChops.multiply(ImageChops.subtract(current, previous), opaque)
            loss = sum(lost.histogram()[128:])
            gain = sum(gained.histogram()[128:])
            if loss or gain:
                cues.append({'region': region['name'], 'box': list(box), 'frame': frame,
                             'compared_to': frame - 1 or 'reference', 'lost_pixels': loss,
                             'gained_pixels': gain})
            previous = current
    return cues


def measurements(frames,fps,interactable=None,reference=None):
    images=[]
    for data in frames:
        with Image.open(io.BytesIO(data)) as source:
            rgba=source.convert('RGBA');bg=Image.new('RGBA',rgba.size,(0,0,0,255));bg.alpha_composite(rgba)
            images.append((bg.convert('RGB'),rgba.getchannel('A')))
    changes=[]
    for i,((a,aa),(b,ba)) in enumerate(zip(images,images[1:])):
        union=ImageChops.lighter(aa,ba)
        area=sum(union.histogram()[1:])
        colour=sum(ImageStat.Stat(ImageChops.difference(a,b)).sum)
        alpha=sum(ImageStat.Stat(ImageChops.difference(aa,ba)).sum)
        ratio=(colour+alpha)/(max(1,area)*4*255)
        changes.append({'from_frame':i+1,'to_frame':i+2,'visible_change':round(ratio,6),'seconds':1/fps})
    cues = {}
    if interactable:
        cues['alpha_changes'] = alpha_changes(images, interactable.get('opaque_regions', []), reference)
        cues['alpha_note'] = '1-based actual frames. Native alpha delta >=128 on reference-opaque pixels in the planned regions. Evidence only; inspect motion and occlusion.'
    return {**cues, 'adjacent_changes':changes,'possible_hold_pairs':[[x['from_frame'],x['to_frame']] for x in changes if x['visible_change']<.012],
            'interpretation':'Near-static pixel cue only. Effects and texture can change without body motion; intentional holds may be correct. Never an automatic pass, rejection, frame deletion or physics judgment.'}
