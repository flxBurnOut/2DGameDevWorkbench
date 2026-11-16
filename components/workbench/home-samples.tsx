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
