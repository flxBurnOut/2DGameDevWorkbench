'use client';
import { useEffect, useState } from 'react';
import { decodePng, type RgbaImage } from '@/features/interactable-motion/png-rgba';

export async function fetchRgba(url: string, signal?: AbortSignal): Promise<{ image: RgbaImage; bytes: Uint8Array }> {
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) throw new Error('帧图片读取失败，请刷新后重试。');
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { image: await decodePng(bytes), bytes };
}

/** Exact RGBA pixels for a list of hash-bound frame URLs; reloads only when a URL changes. */
export function useRgbaFrames(urls: string[]) {
  const key = urls.join('\n');
  const [state, setState] = useState<{ key: string; frames: RgbaImage[]; error: string }>({ key: '', frames: [], error: '' });
  useEffect(() => {
    if (!key) return;
    const abort = new AbortController();
    void Promise.all(key.split('\n').map(url => fetchRgba(url, abort.signal).then(r => r.image)))
      .then(frames => { if (!abort.signal.aborted) setState({ key, frames, error: '' }); })
      .catch(e => { if (!abort.signal.aborted) setState({ key, frames: [], error: (e as Error).message }); });
    return () => abort.abort();
  }, [key]);
  const ready = Boolean(key) && state.key === key;
  return { frames: ready ? state.frames : [], ready: ready && !state.error, error: state.key === key ? state.error : '' };
}

/** Draw RGBA bytes for display only; tools never read pixels back from a canvas. */
export function paint(canvas: HTMLCanvasElement | null, image: RgbaImage | undefined) {
  if (!canvas || !image) return null;
  canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.putImageData(new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height), 0, 0);
  return context;
}
