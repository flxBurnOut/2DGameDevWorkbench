import sharp from 'sharp';
import {
  createScene,
  replaceMap,
} from '../../features/scene-composer/model.mjs';
import { applyMapSplit } from '../../features/scene-composer/map-split.mjs';

export const image = async (width, height, color) =>
  `data:image/png;base64,${(
    await sharp({ create: { width, height, channels: 4, background: color } })
      .png()
      .toBuffer()
  ).toString('base64')}`;
export const polygon = [
  { x: 1, y: 10 },
  { x: 11, y: 10 },
  { x: 11, y: 24 },
  { x: 1, y: 24 },
];
export function element(id, source, options = {}) {
  return {
    id,
    name: '灯',
    kind: 'object',
    x: 100,
    y: 80,
    positionMode: 'relative',
    hidden: false,
    locked: false,
    included: true,
    parts: [
      {
        id: 'art',
        role: 'art',
        plane: 'back',
        x: 0,
        y: 0,
        width: 12,
        height: 24,
        source,
        enabled: true,
      },
    ],
    collision: {
      enabled: false,
      polygons: [structuredClone(polygon)],
      mapIndices: [],
    },
    ...options,
  };
}
export function split(elements, options = {}) {
  return {
    version: 1,
    candidateId: 'split_fixture',
    sourceHash: 'a'.repeat(64),
    origin: { x: -33, y: -34 },
    review: 'reviewed',
    stale: false,
    baseline: structuredClone(elements),
    elements: structuredClone(elements),
    conflicts: [],
    ...options,
  };
}
export async function splitFixture() {
  const scene = createScene('Map split engine fixture');
  scene.id = 'map_split_fixture';
  const trunk = await image(12, 24, '#ff0000');
  const canopy = await image(28, 20, '#00ff00');
  const groundBytes = Buffer.alloc(240 * 160 * 4);
  for (let y = 0; y < 160; y++)
    for (let x = 0; x < 240; x++) {
      const at = (y * 240 + x) * 4;
      groundBytes[at + 2] = 255;
      groundBytes[at + 3] = x >= 100 && x < 112 && y >= 80 && y < 104 ? 0 : 255;
    }
  const groundSource = `data:image/png;base64,${(
    await sharp(groundBytes, { raw: { width: 240, height: 160, channels: 4 } })
      .png()
      .toBuffer()
  ).toString('base64')}`;
  replaceMap(scene, {
    name: 'original',
    origin: { x: -40, y: -30 },
    offset: { x: 7, y: -4 },
    layers: [
      {
        id: 'map_overall',
        name: 'Original pixels',
        source: await image(240, 160, '#ff00ff'),
        width: 240,
        height: 160,
        hidden: false,
        locked: true,
        included: true,
      },
    ],
    collisions: [
      polygon.map((point) => ({
        x: -40 + 100 + point.x,
        y: -30 + 80 + point.y,
      })),
    ],
    source: 'data:application/zip;base64,UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==',
    warnings: [],
  });
  const ground = element('split_ground', groundSource, {
    name: '地表',
    kind: 'surface',
    x: 0,
    y: 0,
    parts: [
      {
        id: 'ground',
        role: 'art',
        plane: 'back',
        x: 0,
        y: 0,
        width: 240,
        height: 160,
        source: groundSource,
        enabled: true,
      },
    ],
    collision: { enabled: false, polygons: [], mapIndices: [] },
    sourceKey: 'ground-source',
  });
  const tree = element('split_tree', trunk, {
    name: '跨缝树',
    sourceKey: 'tree-source',
    collision: {
      enabled: true,
      polygons: [structuredClone(polygon)],
      mapIndices: [0],
    },
  });
  tree.parts.push(
    {
      id: 'canopy',
      role: 'art',
      plane: 'front',
      x: -8,
      y: -20,
      width: 28,
      height: 20,
      source: canopy,
      enabled: true,
    },
    {
      id: 'glow',
      role: 'effect',
      plane: 'front',
      x: 0,
      y: 0,
      width: 12,
      height: 24,
      source: trunk,
      enabled: false,
    },
  );
  applyMapSplit(scene, split([ground, tree]));
  return scene;
}
