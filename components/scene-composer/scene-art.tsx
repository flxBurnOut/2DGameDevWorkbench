'use client';
import { documentMediaUrl } from '@/features/editor-documents/browser-media';
import { useEffect, useState } from 'react';
import type { Shape } from '@/features/interactable-editor/contract.mjs';
import {
  type SimInstance,
} from '@/features/interactable-editor/simulator.mjs';
import {
  type Instance,
  type Material,
} from '@/features/scene-composer/model.mjs';
import { objectRenderState } from '@/features/scene-composer/render-model.mjs';
export { instanceRect } from '@/features/scene-composer/render-model.mjs';

export function ShapeOutline({
  shape,
  color,
}: {
  shape: Shape;
  color: string;
}) {
  const common = {
    fill: color,
    fillOpacity: 0.095,
    stroke: color,
    strokeWidth: 1,
    vectorEffect: 'non-scaling-stroke' as const,
  };
  return shape.type === 'circle' ? (
    <circle
      {...common}
      cx={shape.offset.x}
      cy={shape.offset.y}
      r={shape.radius}
    />
  ) : (
    <rect
      {...common}
      x={shape.offset.x - shape.width / 2}
      y={
        shape.offset.y -
        Math.max(shape.height, shape.type === 'capsule' ? shape.width : 0) / 2
      }
      width={shape.width}
      height={Math.max(
        shape.height,
        shape.type === 'capsule' ? shape.width : 0,
      )}
      rx={shape.type === 'capsule' ? shape.width / 2 : 0}
    />
  );
}
export function ObjectArt({
  instance: i,
  material,
  time = 0,
  simulated,
  shapes = false,
  preview = false,
  art = true,
}: {
  instance: Instance;
  material: Material;
  time?: number;
  simulated?: SimInstance;
  shapes?: boolean;
  preview?: boolean;
  art?: boolean;
}) {
  const render = objectRenderState(i, material, { time, simulated, preview });
  const { object: o, visual: v, appearance, completedHidden, frame, asset, rgb } = render;
  const imageSource = asset ? documentMediaUrl(asset.source) : undefined;
  const [dimensions, setDimensions] = useState({
    width: v.width,
    height: v.height,
  });
  useEffect(() => {
    let alive = true;
    if (imageSource) {
      const image = new Image();
      image.onload = () => {
        if (alive)
          setDimensions({
            width: image.naturalWidth,
            height: image.naturalHeight,
          });
      };
      image.src = imageSource;
    }
    return () => {
      alive = false;
    };
  }, [imageSource]);
  const region = frame?.region;
  return (
    <g
      transform={render.outerTransform}
    >
      {shapes && !(preview && completedHidden) && (
        <g pointerEvents="none">
          <ShapeOutline shape={o.detection.shape} color="var(--theme-success)" />
          <ShapeOutline shape={o.pointer} color="var(--theme-blue)" />
          {(appearance.solidEnabled ?? o.solid.enabled) && (
            <ShapeOutline shape={o.solid.shape} color="var(--theme-warning)" />
          )}
        </g>
      )}
      {art && (
        <g
          opacity={render.opacity}
          transform={render.innerTransform}
        >
          <defs>
            <filter id={`scene-tint-${i.id}`} colorInterpolationFilters="sRGB">
              <feColorMatrix
                type="matrix"
                values={`${rgb[0]} 0 0 0 0 0 ${rgb[1]} 0 0 0 0 0 ${rgb[2]} 0 0 0 0 0 1 0`}
              />
            </filter>
          </defs>
          {asset ? (
            <svg
              x={-v.width / 2}
              y={-v.height / 2}
              width={v.width}
              height={v.height}
              preserveAspectRatio="none"
              viewBox={
                region
                  ? `${region.x} ${region.y} ${region.width} ${region.height}`
                  : `0 0 ${dimensions.width} ${dimensions.height}`
              }
            >
              <image
                filter={`url(#scene-tint-${i.id})`}
                href={documentMediaUrl(asset.source)}
                width={dimensions.width}
                height={dimensions.height}
                style={{ imageRendering: 'pixelated' }}
              />
            </svg>
          ) : (
            <rect
              x={v.dot ? -5 : -v.width / 2}
              y={v.dot ? -5 : -v.height / 2}
              width={v.dot ? 10 : v.width}
              height={v.dot ? 10 : v.height}
              rx={v.dot ? 5 : 3}
              fill={render.placeholderFill}
            />
          )}
        </g>
      )}
    </g>
  );
}
