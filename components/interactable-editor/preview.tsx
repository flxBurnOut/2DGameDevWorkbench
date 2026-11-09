/* oxlint-disable react/react-compiler -- This clock-driven imperative simulator deliberately opts out of React memoization. */
'use client';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { RotateCcw, Play } from 'lucide-react';
import {
  type Asset,
  type Interactable,
  type Shape,
} from '@/features/interactable-editor/contract.mjs';
import {
  InteractionSimulation,
  stateAppearance,
  type InteractionState,
} from '@/features/interactable-editor/simulator.mjs';
import { Check } from './property-panels';
import { documentMediaUrl } from '@/features/editor-documents/browser-media';
import { parseDocumentMediaReference } from '@/features/editor-documents/media-references.mjs';

export function assetUrl(asset?: Asset) {
  if (!asset) return '';
  if (parseDocumentMediaReference(asset.source)) return documentMediaUrl(asset.source);
  return asset.source.startsWith('data:')
    ? asset.source
    : `/api/workbench/interactable-assets?path=${encodeURIComponent(asset.source)}`;
}
function Outline({
  shape,
  color,
  ...rest
}: { shape: Shape; color: string } & React.SVGProps<SVGElement>) {
  const common = {
    fill: color,
    fillOpacity: 0.095,
    stroke: color,
    strokeWidth: 1.5,
    strokeDasharray: '5 4',
    ...rest,
  };
  const x = shape.offset.x,
    y = shape.offset.y;
  if (shape.type === 'circle')
    return (
      <circle
        {...(common as React.SVGProps<SVGCircleElement>)}
        cx={x}
        cy={y}
        r={shape.radius}
      />
    );
  return (
    <rect
      {...(common as React.SVGProps<SVGRectElement>)}
      x={x - shape.width / 2}
      y={
        y -
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
export function Preview({
  object,
  assets,
  edit,
}: {
  object: Interactable;
  assets: Asset[];
  edit: (fn: (o: Interactable) => void) => void;
}) {
  'use no memo';
  const [hasSaved, setHasSaved] = useState(false);
  const [overlap, setOverlap] = useState(false),
    [frame, setFrame] = useState(0),
    [mode, setMode] = useState<'actor' | 'detection' | 'pointer' | 'solid'>(
      'actor',
    );
  const sim = useMemo(
    () => new InteractionSimulation(overlap ? [object, object] : [object]),
    [object, overlap],
  );
  const saved = useRef<InteractionState[] | null>(null),
    drag = useRef(false),
    svg = useRef<SVGSVGElement>(null);
  const [dimensions, setDimensions] = useState<
    Record<string, { width: number; height: number }>
  >({});
  useEffect(() => {
    let alive = true;
    for (const a of assets.filter((a) => a.mime.startsWith('image'))) {
      const image = new Image();
      image.onload = () => {
        if (alive)
          setDimensions((p) => ({
            ...p,
            [a.id]: { width: image.width, height: image.height },
          }));
      };
      image.src = assetUrl(a);
    }
    return () => {
      alive = false;
    };
  }, [assets]);
  useEffect(() => {
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      sim.tick(Math.min(0.15, (now - last) / 1000));
      last = now;
      setFrame((n) => n + 1);
    }, 50);
    return () => clearInterval(timer);
  }, [sim]);
  const audioEvent = sim.events.find((e) => e.name === 'play_audio');
  const audioPlayer = useRef<HTMLAudioElement | null>(null);
  const cancellation = sim.events.find(
    (e) => e.name === 'interaction_cancelled',
  );
  useEffect(() => {
    if (cancellation) audioPlayer.current?.pause();
  }, [cancellation]);
  useEffect(() => {
    if (!audioEvent?.assetId) return;
    const audio = new Audio(
      assetUrl(assets.find((a) => a.id === audioEvent.assetId)),
    );
    audioPlayer.current = audio;
    audio.volume = Math.min(1, Math.pow(10, (audioEvent.volumeDb ?? 0) / 20));
    audio.onended = () => sim.finishAudio();
    audio.onerror = () => sim.finishAudio();
    void audio.play().catch(() => sim.finishAudio());
    return () => {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
    };
  }, [audioEvent, assets, sim]);

  const point = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = svg.current!.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    return p.matrixTransform(svg.current!.getScreenCTM()!.inverse());
  };
  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const p = point(e);
    if (mode === 'actor') sim.moveActor(p.x, p.y);
    else
      edit((o) => {
        const shape =
          mode === 'detection'
            ? o.detection.shape
            : mode === 'pointer'
              ? o.pointer
              : o.solid.shape;
        shape.offset = { x: Math.round(p.x - 320), y: Math.round(p.y - 210) };
      });
  };
  const w = sim.waiting;
  return (
    <section className="ie-center">
      <div className="ie-row">
        <strong>编辑器预览</strong>
        <span className="ie-spacer" />
        <Check label="双物件重叠" value={overlap} onChange={setOverlap} />
      </div>
      <div className="ie-row">
        <select
          aria-label="画布拖动目标"
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
        >
          <option value="actor">拖动交互来源</option>
          <option value="detection">移动感知范围</option>
          <option value="pointer">移动点击区域</option>
          <option value="solid">移动实体碰撞</option>
        </select>
      </div>
      <div className="ie-canvas">
        <svg
          ref={svg}
          viewBox="0 0 640 420"
          aria-label="物件、交互范围和来源预览"
          onPointerDown={(e) => {
            drag.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            move(e);
          }}
          onPointerMove={move}
          onPointerUp={(e) => {
            drag.current = false;
            const p = point(e);
            if (object.activation.mode === 'pointer_click' && mode === 'actor')
              sim.click(p.x, p.y);
          }}
          onPointerCancel={() => {
            drag.current = false;
          }}
        >
          {sim.objects.map((i) => {
            const o = i.definition,
              a = stateAppearance(o, i.state),
              hidden = i.state.completed && o.completion !== 'remain';
            const name = i.animation?.name;
            const clip = o.visual.clips.find((c) => c.name === name);
            let f = clip?.frames[0];
            if (clip) {
              const total = clip.frames.reduce((n, x) => n + x.duration, 0);
              const elapsed = Math.max(
                0,
                sim.time - (i.animation?.started ?? 0),
              );
              let cursor = clip.loop
                ? (elapsed * clip.fps) % total
                : Math.min(elapsed * clip.fps, total - 0.001);
              for (const x of clip.frames) {
                f = x;
                if (cursor < x.duration) break;
                cursor -= x.duration;
              }
            }
            const asset = assets.find(
                (x) => x.id === (f?.assetId || a.assetId || o.visual.assetId),
              ),
              region = f?.region;
            const dim = asset ? dimensions[asset.id] : undefined;
            const tint = a.tint ?? o.visual.tint;
            const rgb = [1, 3, 5].map(
              (n) => parseInt(tint.slice(n, n + 2), 16) / 255,
            );
            return (
              <g
                key={i.id}
                transform={`translate(${i.x} ${i.y})`}
                opacity={hidden ? 0.18 : 1}
              >
                <defs>
                  <filter
                    id={`ie-tint-${i.id}`}
                    colorInterpolationFilters="sRGB"
                  >
                    <feColorMatrix
                      type="matrix"
                      values={`${rgb[0]} 0 0 0 0 0 ${rgb[1]} 0 0 0 0 0 ${rgb[2]} 0 0 0 0 0 1 0`}
                    />
                  </filter>
                </defs>
                <Outline shape={o.detection.shape} color="var(--theme-success)" />
                <Outline shape={o.pointer} color="var(--theme-blue)" />
                {(a.solidEnabled ?? o.solid.enabled) && (
                  <Outline shape={o.solid.shape} color="var(--theme-warning)" />
                )}
                <g
                  transform={`translate(${o.visual.offset.x} ${o.visual.offset.y + (o.visual.float ? Math.sin(sim.time * 2) * 5 : 0)}) scale(${o.visual.scale * (o.visual.flipH ? -1 : 1)} ${o.visual.scale * (o.visual.flipV ? -1 : 1)})`}
                  opacity={(a.visible ?? o.visual.visible) ? 1 : 0.15}
                >
                  {asset ? (
                    <svg
                      preserveAspectRatio="none"
                      x={-o.visual.width / 2}
                      y={-o.visual.height / 2}
                      width={o.visual.width}
                      height={o.visual.height}
                      viewBox={
                        region
                          ? `${region.x} ${region.y} ${region.width} ${region.height}`
                          : `0 0 ${dim?.width ?? o.visual.width} ${dim?.height ?? o.visual.height}`
                      }
                    >
                      <image
                        filter={`url(#ie-tint-${i.id})`}
                        href={assetUrl(asset)}
                        width={dim?.width ?? o.visual.width}
                        height={dim?.height ?? o.visual.height}
                        style={{ imageRendering: 'pixelated' }}
                      />
                    </svg>
                  ) : (
                    <rect
                      x={o.visual.dot ? -5 : -o.visual.width / 2}
                      y={o.visual.dot ? -5 : -o.visual.height / 2}
                      width={o.visual.dot ? 10 : o.visual.width}
                      height={o.visual.dot ? 10 : o.visual.height}
                      rx={o.visual.dot ? 5 : 6}
                      fill={`rgb(${[0.3, 0.85, 0.65].map((v, n) => Math.round(255 * v * rgb[n])).join(' ')})`}
                    />
                  )}
                </g>
                <text textAnchor="middle" y={90} fill="var(--theme-muted)" fontSize="14">
                  {overlap ? i.id : o.displayName}
                </text>
                {sim.focus === i && (
                  <text
                    x={o.content.promptOffset.x}
                    y={o.content.promptOffset.y}
                    textAnchor="middle"
                    fill="var(--theme-cyan)"
                    fontSize="16"
                  >
                    {o.content.prompt ||
                      `[${o.activation.key}] ${o.displayName}`}
                  </text>
                )}
              </g>
            );
          })}
          <circle
            cx={sim.actor.x}
            cy={sim.actor.y}
            r="12"
            fill="var(--theme-panel)"
            stroke="var(--theme-blue)"
            strokeWidth="3"
          />
          <text
            x={sim.actor.x}
            y={sim.actor.y + 32}
            textAnchor="middle"
            fill="var(--theme-muted)"
            fontSize="13"
          >
            交互来源
          </text>
        </svg>
        {w?.type === 'show_text' && (
          <div className="ie-dialogue">
            <p>
              {object.content.charactersPerSecond === 0
                ? w.pages[w.index]
                : w.pages[w.index]?.slice(0, Math.floor(w.shown))}
            </p>
            <button onClick={() => sim.advanceText()}>
              继续 · {w.index + 1}/{w.pages.length}
            </button>
          </div>
        )}
      </div>
      <div className="ie-row">
        <button
          onClick={() => {
            const s = object.detection.shape;
            sim.moveActor(320 + s.offset.x, 210 + s.offset.y);
          }}
        >
          靠近
        </button>
        <button
          onClick={() => {
            sim.moveActor(70, 210);
          }}
        >
          离开
        </button>
        <button onClick={() => sim.press()}>
          <Play size={14} />按 {object.activation.key}
        </button>
        <button onClick={() => sim.request()}>外部调用</button>
        <button title="重置预览" onClick={() => sim.reset()}>
          <RotateCcw size={14} />
        </button>
      </div>
      <p className="ie-note">
        绿色：感知 · 蓝色：点击 · 橙色：实体碰撞。拖动白色来源可模拟进出范围。
      </p>
      <div className="ie-row">
        <span className="ie-badge">
          {sim.active
            ? '交互中'
            : sim.objects[0].state.completed
              ? '已完成'
              : sim.objects[0].cooldown > 0
                ? `冷却 ${sim.objects[0].cooldown.toFixed(1)}s`
                : '等待交互'}
        </span>
        <span className="ie-spacer" />
        <button
          onClick={() => {
            saved.current = sim.snapshot();
            setHasSaved(true);
            setFrame(frame + 1);
          }}
        >
          记住状态
        </button>
        <button
          disabled={!hasSaved}
          onClick={() => sim.restore(saved.current ?? [])}
        >
          恢复状态
        </button>
      </div>
      <div className="ie-log" aria-label="交互事件记录">
        {sim.events.length
          ? sim.events.map((event, i) => (
              <div key={`${event.time}-${i}`}>
                {event.time.toFixed(1)}s · {event.instanceId} · {event.name}
              </div>
            ))
          : '等待交互。预览不会阻止直接导出。'}
      </div>
    </section>
  );
}
