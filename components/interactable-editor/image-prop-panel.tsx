'use client';
import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ImageAssetsPanel } from '@/components/image-assets/image-assets-panel';
import { readImagePropAsset, type PropArtTarget } from '@/features/interactable-editor/prop-art.mjs';
import type { Asset } from '@/features/interactable-editor/contract.mjs';

export function ImagePropPanel({ projectId, definitionId, objectName, imageId, disabled, beforeGenerate, onAdopt, onBusy }: {
  projectId: string; definitionId: string; objectName: string; imageId: string; disabled: boolean;
  beforeGenerate: () => Promise<void>; onAdopt: (target: PropArtTarget, asset: Asset) => void; onBusy: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(location.search).has('imageTask')) queueMicrotask(() => setOpen(true));
  }, []);
  return <details className="ie-prop-art" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><Sparkles size={16} />生成透明物件<small>GPT Image 2.6</small></summary>
    {open && <div className="ie-prop-art-body"><ImageAssetsPanel kind="prop" name={objectName} disabled={disabled} beforeGenerate={beforeGenerate} onBusy={onBusy} adoptionLabel={`采用到「${objectName}」`} onAdopt={async (taskId) => {
      const target = { projectId, definitionId, previousAssetId: imageId };
      const asset = await readImagePropAsset(taskId);
      onAdopt(target, asset);
    }} /></div>}
  </details>;
}
