'use client';
import { useEffect, useRef, useState } from 'react';
import {
  decodePng,
  encodePng,
  base64Bytes,
  type RgbaImage,
} from '@/features/interactable-motion/png-rgba';
import { framePatch } from '@/features/interactable-motion/frame-tools';
import { fetchRgba, paint } from '../interactable-motion/use-rgba-frames';
import { MotionAdjustment } from './motion-adjustment';
import { motionRequest, motionUrl, type MotionWork } from './open-motion-model';

export type MotionFrameTarget = {
  kind: 'motion-frame';
  workId: string;
  workRevision: number;
  candidateIndex: number;
  stageIndex?: number;
  frameIndex: number;
};
type Props = {
  target: MotionFrameTarget;
  work: MotionWork;
  readOnly?: boolean;
  onClose: () => void;
  onAdopt: (updated: MotionWork) => void;
};
type Source = { token: string; sha: string; image: RgbaImage };

export function MotionFrameEditor(props: Props) {
  const t = props.target;
  return (
    <FrameEditor
      key={JSON.stringify([
        t.workId,
        t.workRevision,
        t.candidateIndex,
        t.stageIndex,
        t.frameIndex,
      ])}
      {...props}
    />
  );
}

function FrameEditor({ target, work, readOnly, onClose, onAdopt }: Props) {
  const { workId, workRevision, candidateIndex, stageIndex, frameIndex } =
    target;
  const [source, setSource] = useState<Source | null>(null);
  const [image, setImage] = useState<RgbaImage | null>(null);
  const [color, setColor] = useState('#ffffff'),
    [erase, setErase] = useState(false);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const submission = useRef<{ image: RgbaImage; key: string } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    const query = {
      revision: String(workRevision),
      candidate: String(candidateIndex),
      ...(stageIndex === undefined ? {} : { stage: String(stageIndex) }),
    };
    async function load() {
      const ctx = await motionRequest<{
        token: string;
        frames: { sha256: string }[];
        locked_frames: number[];
      }>(`open-motion/${workId}/adjustments`, undefined, query, abort.signal);
      if (ctx.locked_frames.includes(frameIndex) || !ctx.frames[frameIndex])
        throw new Error('该帧已锁定或不存在。');
      const original = await fetchRgba(
        motionUrl(`open-motion/${workId}/edit-source/${frameIndex}`, {
          ...query,
          token: ctx.token,
        }),
        abort.signal,
      );
      if (!abort.signal.aborted) {
        setSource({
          token: ctx.token,
          sha: ctx.frames[frameIndex].sha256,
          image: original.image,
        });
        setImage(original.image);
      }
    }
    void load().catch((e) => {
      if (!abort.signal.aborted) setError((e as Error).message);
    });
    return () => abort.abort();
  }, [workId, workRevision, candidateIndex, stageIndex, frameIndex]);
  useEffect(() => {
    paint(canvas.current, image || undefined);
  }, [image]);

  async function save() {
    if (!image || !source || busy || readOnly) return;
    setBusy(true);
    setError('');
    try {
      const patch = framePatch(
        frameIndex,
        source.sha,
        source.image.pixels,
        image.pixels,
        0,
      );
      if (!patch) throw new Error('当前帧尚未修改。');
      if (submission.current?.image !== image)
        submission.current = { image, key: crypto.randomUUID() };
      await motionRequest(`open-motion/${workId}/local-frame-edits`, {
        expected_revision: workRevision,
        candidate_index: candidateIndex,
        stage_index: stageIndex ?? null,
        token: source.token,
        request_key: submission.current.key,
        description: `手工修改第 ${frameIndex + 1} 帧选中的像素`,
        frames: [
          {
            region: patch.region,
            png_base64: base64Bytes(await encodePng(image)),
          },
        ],
      });
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="motion-card" aria-label="局部调整当前帧">
      <div className="motion-card-title">
        <h3>调整第 {frameIndex + 1} 帧</h3>
        <button disabled={busy} onClick={onClose}>
          关闭
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {saved ? (
        <MotionAdjustment
          work={work}
          candidate={candidateIndex}
          stage={stageIndex}
          readOnly={Boolean(readOnly)}
          onSaved={onAdopt}
        />
      ) : (
        image && (
          <fieldset disabled={busy || readOnly}>
            <canvas
              ref={canvas}
              aria-label="点击修改像素"
              style={{
                width: 'min(100%, 320px)',
                imageRendering: 'pixelated',
                cursor: 'crosshair',
              }}
              onClick={(e) => {
                if (busy || readOnly) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const x = Math.floor(
                    ((e.clientX - rect.left) * image.width) / rect.width,
                  ),
                  y = Math.floor(
                    ((e.clientY - rect.top) * image.height) / rect.height,
                  );
                if (x < 0 || y < 0 || x >= image.width || y >= image.height)
                  return;
                const pixels = image.pixels.slice();
                const rgb = parseInt(color.slice(1), 16);
                pixels.set(
                  erase
                    ? [0, 0, 0, 0]
                    : [rgb >> 16, (rgb >> 8) & 255, rgb & 255, 255],
                  (y * image.width + x) * 4,
                );
                setImage({ ...image, pixels });
              }}
            />
            <label>
              画笔颜色
              <input
                type="color"
                value={color}
                onChange={(e) => {
                  setColor(e.target.value);
                  setErase(false);
                }}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={erase}
                onChange={(e) => setErase(e.target.checked)}
              />
              擦除像素
            </label>
            <label>
              或载入同尺寸修正版 PNG
              <input
                type="file"
                accept="image/png"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  try {
                    if (file.size > 2_000_000)
                      throw new Error('PNG 超过 2 MB。');
                    const bytes = new Uint8Array(await file.arrayBuffer());
                    const header = new DataView(bytes.buffer);
                    if (
                      bytes.length < 24 ||
                      header.getUint32(16) !== image.width ||
                      header.getUint32(20) !== image.height
                    )
                      throw new Error('修正版和原帧尺寸必须相同。');
                    setImage(await decodePng(bytes));
                    setError('');
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }}
              />
            </label>
            <button onClick={() => source && setImage(source.image)}>
              还原本帧
            </button>
            <button onClick={() => void save()}>保存本地备选并对比</button>
          </fieldset>
        )
      )}
    </section>
  );
}
