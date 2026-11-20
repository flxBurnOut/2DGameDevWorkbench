/**
 * Built-in pixel sprites for the home page tool cards, shown until the asset
 * library holds a real piece of the matching kind. Colours are part of the
 * artwork, so they stay fixed in both themes.
 */
const palette: Record<string, string> = {
  h: '#3b2a20',
  s: '#f2c39b',
  e: '#1d2433',
  c: '#3f8f4e',
  d: '#2e6b3a',
  p: '#4a5468',
  b: '#6b4a2f',
  o: '#3a2a1e',
  w: '#a0672f',
  y: '#e8b84a',
  k: '#f6dc7a',
};

const body = [
  '...hhhh...',
  '..hhhhhh..',
  '..hsssss..',
  '..sesses..',
  '..ssssss..',
  '...ssss...',
  '..cccccc..',
  '.ccdccdcc.',
  '.s.cccc.s.',
  '...cccc...',
  '...dccd...',
];
const legs = {
  stand: ['...p..p...', '...p..p...', '..bb..bb..'],
  stride: ['..p....p..', '.p......p.', 'bb......bb'],
  pass: ['....pp....', '....pp....', '...bbbb...'],
};

const chest = [
  '..oooooooo..',
  '.owwwwwwwwo.',
  '.owwwwwwwwo.',
  '.oyyyyyyyyo.',
  '.owwwkkwwwo.',
  '.owwwkkwwwo.',
  '.owwwwwwwwo.',
  '.owwwwwwwwo.',
  '.oooooooooo.',
];

function Sprite({ rows, scale }: { rows: string[]; scale: number }) {
  const width = Math.max(...rows.map((row) => row.length));
  return (
    <svg
      width={width * scale}
      height={rows.length * scale}
      viewBox={`0 0 ${width} ${rows.length}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {rows.flatMap((row, y) =>
        row.split('').map((cell, x) =>
          palette[cell] ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={palette[cell]} /> : null,
        ),
      )}
    </svg>
  );
}

export function SampleCharacter() {
  return <Sprite rows={[...body, ...legs.stand]} scale={7} />;
}

export function SampleAnimation() {
  return (
    <span className="wb-sample-strip">
      {[legs.stand, legs.stride, legs.pass].map((frame, i) => (
        <span className="wb-sample-frame" key={i}>
          <Sprite rows={[...body, ...frame]} scale={5} />
        </span>
      ))}
    </span>
  );
}

export function SampleInteractable() {
  return <Sprite rows={chest} scale={8} />;
}

/** A real generated clip stored as a horizontal 128 px frame strip under public/home-samples. */
export type SampleClipSource = { src: string; frames: number; fps: number; label: string };

export const interactableClips: SampleClipSource[] = [
  // Archived PixelLab clips from examples/n2-pilot-*; first and last frames are repeated so each state reads.
  { src: '/home-samples/lamp.png', frames: 28, fps: 12, label: '指示灯点亮' },
  { src: '/home-samples/chest.png', frames: 28, fps: 12, label: '宝箱打开' },
  { src: '/home-samples/lever.png', frames: 20, fps: 10, label: '拉杆扳起' },
];

export function SampleClip({ clip, size = 128 }: { clip: SampleClipSource; size?: number }) {
  return (
    <span
      className="wb-clip"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${clip.src})`,
        backgroundSize: `${clip.frames * size}px ${size}px`,
        animationDuration: `${clip.frames / clip.fps}s`,
        animationTimingFunction: `steps(${clip.frames})`,
        ['--clip-frames' as string]: clip.frames,
        ['--clip-size' as string]: `${size}px`,
      }}
    />
  );
}
