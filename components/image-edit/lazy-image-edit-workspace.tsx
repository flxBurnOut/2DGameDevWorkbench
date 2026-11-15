'use client';
import { lazy, Suspense, type ComponentProps } from 'react';
import type { ImageEditWorkspace as Workspace } from './image-edit-workspace';

// The local image editor (and its stylesheet) loads when a page opens it.
const LazyWorkspace = lazy(() =>
  import('./image-edit-workspace').then((module) => ({ default: module.ImageEditWorkspace })),
);

export function ImageEditWorkspace(props: ComponentProps<typeof Workspace>) {
  return (
    <Suspense fallback={<output className="fixed inset-0 z-[100] grid place-items-center bg-[var(--theme-overlay)] text-[var(--theme-text)]">正在打开局部调整…</output>}>
      <LazyWorkspace {...props} />
    </Suspense>
  );
}
