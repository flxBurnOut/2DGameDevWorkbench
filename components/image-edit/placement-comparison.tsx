'use client';
/* oxlint-disable next/no-img-element -- Pixel evidence is rendered at its measured dimensions. */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { imageEditRequest, type ImageEditSession } from '@/features/image-edit/client';

export function PlacementComparison({ session, version }: { session: ImageEditSession; version: string }) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(64);
  const [result, setResult] = useState<NonNullable<ImageEditSession['comparison']>>();
  const [error, setError] = useState('');
  const placed = Boolean(session.target.placement);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void imageEditRequest<{ edit: ImageEditSession }>('session-get', {
      editId: session.editId, candidateVersion: version, comparison: placed ? {} : { previewWidth: width },
    }, abort.signal).then(({ edit }) => {
      if (abort.signal.aborted) return;
      const comparison = edit.comparison;
      if (!comparison || comparison.editId !== session.editId || comparison.candidateVersion !== version)
        throw new Error('对比证据的版本不匹配。');
      setResult(comparison);
    }).catch(cause => { if (!abort.signal.aborted) setError(cause.message); });
    return () => abort.abort();
  }, [open, session.editId, version, placed, width]);
  return <section className="ie-placement">
    <Button size="sm" variant="outline" aria-expanded={open} onClick={() => { setResult(undefined); setError(''); setOpen(value => !value); }}>按摆放尺寸比较</Button>
    {open && <>
      {!placed && <label>预览宽度 <select value={width} onChange={event => { setResult(undefined); setError(''); setWidth(Number(event.target.value)); }}>
        {[32, 64, 128, 256, 512].map(size => <option key={size} value={size}>{size} px</option>)}
      </select></label>}
      {error && <output>{error}</output>}
      {!result && !error && <p>读取本步对照…</p>}
      {result && <><p>{placed ? '会话保存时的摆放尺寸' : '指定预览尺寸'} {result.width} × {result.height} px · 单图原色</p>
        {(result.viewport.width < result.width || result.viewport.height < result.height) && <p>按原比例显示编辑区域附近的局部。</p>}
        <div className="ie-placement-scroll">{[['本步基准', result.beforePng], ['所选候选', result.afterPng]].map(([name, data]) =>
          <figure key={name}><figcaption>{name}</figcaption><img alt={name} src={'data:image/png;base64,' + data} width={result.viewport.width} height={result.viewport.height} /></figure>)}</div>
      </>}
    </>}
  </section>;
}
