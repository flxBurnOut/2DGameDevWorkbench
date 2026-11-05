'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { ImageAssetsPanel } from '@/components/image-assets/image-assets-panel';
import { readImageAsset } from '@/features/image-assets/browser-client.mjs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import type { MapEditorController } from '../use-map-editor-controller';

export function MapOriginGenerator({ open, onOpenChange, c }: {
  open: boolean; onOpenChange: (open: boolean) => void; c: MapEditorController;
}) {
  const [busy, setBusy] = useState(false);
  const latest = useRef(c);
  useLayoutEffect(() => { latest.current = c; });
  return <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value); }}>
    <DialogContent className="map-origin-dialog">
      <DialogHeader>
        <DialogTitle>生成场景背景 · GPT Image 2.6</DialogTitle>
        <DialogDescription>生成图片后确认采用，再沿用地图编辑器制作区域和组装场景。</DialogDescription>
      </DialogHeader>
      <ImageAssetsPanel kind="background" name="场景背景" disabled={c.busy} onBusy={setBusy} adoptionLabel="用作地图中心图" onAdopt={async (taskId) => {
        const target = { workspaceId: c.workspaceId, revision: c.revision };
        const image = await readImageAsset(taskId, 'background');
        if (latest.current.workspaceId !== target.workspaceId || latest.current.revision !== target.revision)
          throw new Error('当前地图已变化，请确认后重新采用。');
        const file = new File([new Uint8Array(image.bytes)], `${image.name}-${taskId}.png`, { type: 'image/png' });
        await latest.current.importImages([file], image.task.input?.operation === 'process-image' ? 'pixel-edited' : 'api-generated', image.generation);
        latest.current.setHint('背景已用作地图中心图。编辑区域后点击“用于制作场景”继续。');
      }} />
    </DialogContent>
  </Dialog>;
}
