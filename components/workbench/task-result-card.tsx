'use client';
/* oxlint-disable next/no-img-element -- Animated previews must remain animated. */
/* oxlint-disable next/no-html-link-for-pages -- Links use the shared draft-saving navigation guard. */
import { useEffect, useState } from 'react';

type Result = {
  presentation: {
    title: string;
    summary: string;
    state: string;
    preview?: { kind: string; url: string };
    actions: { label: string; viewPath: string }[];
  };
};
export function TaskResultCard({ taskId }: { taskId: string }) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch(
          `/api/workbench/result?taskId=${encodeURIComponent(taskId)}`,
          { cache: 'no-store', signal: controller.signal },
        );
        const data = (await response.json()) as Result;
        if (
          !response.ok ||
          !data.presentation ||
          !Array.isArray(data.presentation.actions)
        )
          throw new Error(
            '这份记录暂时无法读取。请检查服务连接或记录是否仍在本机。',
          );
        if (!controller.signal.aborted) {
          setResult(data);
          setError('');
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setResult(null);
          setError((e as Error).message);
        }
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => void load(), 6000);
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [taskId, retry]);
  if (error)
    return (
      <div role="alert">
        <p>{error}</p>
        <button className="wb-button" onClick={() => setRetry((v) => v + 1)}>
          重新读取
        </button>
      </div>
    );
  if (!result) return <output>正在读取这份作品…</output>;
  const p = result.presentation;
  return (
    <div className="wb-result-card">
      <h3>{p.title}</h3>
      <output>{p.summary}</output>
      {p.preview && (
        <figure>
          <img
            loading="lazy"
            decoding="async"
            src={p.preview.url}
            alt={p.preview.kind === 'animation' ? '动画预览' : '作品预览'}
            className="max-h-80 max-w-full [image-rendering:pixelated]"
          />
          <figcaption>
            {p.preview.kind === 'animation'
              ? '动画预览；完整检查请打开作品。'
              : '原图预览'}
          </figcaption>
        </figure>
      )}
      <div className="wb-tool-links">
        {p.actions.map((a) => (
          <a key={a.viewPath} className="wb-button" href={a.viewPath}>
            {a.label}
          </a>
        ))}
      </div>
    </div>
  );
}
