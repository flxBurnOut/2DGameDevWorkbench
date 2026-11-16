'use client';
import { useState } from 'react';
import { Film, Trash2 } from 'lucide-react';
import {
  nextClipName,
  type Asset,
  type Clip,
  type Interactable,
} from '@/features/interactable-editor/contract.mjs';
import {
  ColorField,
  Field,
  Numeric,
  Check,
  ShapeFields,
  AssetSelect,
  ClipSelect,
} from './property-panels';
import { assetUrl } from './preview';

export function VisualPanel({
  object: o,
  assets,
  edit,
  run,
  importFrames,
  busy,
}: {
  object: Interactable;
  assets: Asset[];
  edit: (fn: (o: Interactable) => void) => void;
  run: (fn: () => Promise<void>) => Promise<void>;
  importFrames: () => void;
  busy: boolean;
}) {
  const [sheet, setSheet] = useState({ width: 32, height: 32, count: 8 }),
    [clipAsset, setClipAsset] = useState('');
  const addSheet = () =>
    run(async () => {
      const asset = assets.find(
        (a) => a.id === (clipAsset || o.visual.assetId),
      );
      if (!asset) throw new Error('请先选择精灵表图片');
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('无法读取精灵表'));
        i.src = assetUrl(asset);
      });
      const columns = Math.floor(image.width / sheet.width),
        rows = Math.floor(image.height / sheet.height),
        count = Math.min(Math.floor(sheet.count), columns * rows, 1000);
      if (
        columns < 1 ||
        rows < 1 ||
        count < 1 ||
        sheet.width < 1 ||
        sheet.height < 1
      )
        throw new Error('帧尺寸超出图片或帧数无效');
      edit((obj) => {
        const name = nextClipName(obj);
        obj.visual.clips.push({
          name,
          fps: 8,
          loop: true,
          frames: Array.from({ length: count }, (_, i) => ({
            assetId: asset.id,
            region: {
              x: (i % columns) * sheet.width,
              y: Math.floor(i / columns) * sheet.height,
              width: sheet.width,
              height: sheet.height,
            },
            duration: 1,
          })),
        });
        if (!obj.visual.idleAnimation) obj.visual.idleAnimation = name;
      });
    });
  const replaceClipReferences = (
    obj: Interactable,
    old: string,
    name: string,
  ) => {
    if (obj.visual.idleAnimation === old) obj.visual.idleAnimation = name;
    if (obj.visual.focusAnimation === old) obj.visual.focusAnimation = name;
    for (const entry of [...obj.behavior.states, ...obj.behavior.entries]) {
      if (entry.appearance.animation === old) entry.appearance.animation = name;
      for (const step of entry.feedback)
        if (step.type === 'play_animation' && step.animation === old)
          step.animation = name;
    }
    for (const step of obj.feedback)
      if (step.type === 'play_animation' && step.animation === old)
        step.animation = name;
  };
  const editClip = (index: number, patch: Partial<Clip>) =>
    edit((obj) => {
      const old = obj.visual.clips[index].name;
      obj.visual.clips[index] = { ...obj.visual.clips[index], ...patch };
      if (patch.name !== undefined && patch.name !== old)
        replaceClipReferences(obj, old, patch.name);
    });
  return (
    <div className="ie-tab-content">
      <AssetSelect
        assets={assets}
        value={o.visual.assetId}
        onChange={(assetId) =>
          edit((v) => {
            v.visual.assetId = assetId;
          })
        }
      />
      <div className="ie-row">
        <Numeric
          label="显示宽"
          value={o.visual.width}
          min={1}
          onChange={(width) =>
            edit((v) => {
              v.visual.width = width;
            })
          }
        />
        <Numeric
          label="显示高"
          value={o.visual.height}
          min={1}
          onChange={(height) =>
            edit((v) => {
              v.visual.height = height;
            })
          }
        />
      </div>
      <div className="ie-row">
        <Numeric
          label="偏移 X"
          value={o.visual.offset.x}
          onChange={(x) =>
            edit((v) => {
              v.visual.offset.x = x;
            })
          }
        />
        <Numeric
          label="偏移 Y"
          value={o.visual.offset.y}
          onChange={(y) =>
            edit((v) => {
              v.visual.offset.y = y;
            })
          }
        />
      </div>
      <div className="ie-row">
        <Numeric
          label="缩放"
          value={o.visual.scale}
          step={0.1}
          min={0.01}
          onChange={(scale) =>
            edit((v) => {
              v.visual.scale = scale;
            })
          }
        />
        <Numeric
          label="绘制层级"
          value={o.visual.zIndex}
          onChange={(zIndex) =>
            edit((v) => {
              v.visual.zIndex = zIndex;
            })
          }
        />
        <ColorField
          value={o.visual.tint}
          onChange={(tint) =>
            edit((v) => {
              v.visual.tint = tint;
            })
          }
        />
      </div>
      <div className="ie-row">
        {(['flipH', 'flipV', 'visible', 'float', 'dot'] as const).map(
          (key, i) => (
            <Check
              key={key}
              label={['水平翻转', '垂直翻转', '显示', '漂浮', '光点外观'][i]}
              value={o.visual[key]}
              onChange={(value) =>
                edit((v) => {
                  v.visual[key] = value;
                })
              }
            />
          ),
        )}
      </div>
      <details open>
        <summary>帧动画</summary>
        <button disabled={busy} onClick={importFrames}>
          <Film size={14} />
          导入有序帧图片
        </button>
        <details>
          <summary>从精灵表切帧</summary>
          <AssetSelect
            assets={assets}
            value={clipAsset || o.visual.assetId}
            onChange={setClipAsset}
            label="精灵表"
          />
          <div className="ie-row">
            <Numeric
              label="帧宽"
              value={sheet.width}
              min={1}
              onChange={(width) => setSheet({ ...sheet, width })}
            />
            <Numeric
              label="帧高"
              value={sheet.height}
              min={1}
              onChange={(height) => setSheet({ ...sheet, height })}
            />
            <Numeric
              label="帧数"
              value={sheet.count}
              min={1}
              max={1000}
              onChange={(count) => setSheet({ ...sheet, count })}
            />
          </div>
          <button disabled={busy} onClick={addSheet}>
            生成动画
          </button>
        </details>
        {o.visual.clips.map((clip, index) => (
          <div className="ie-card" key={index}>
            <Field label={`动画 ${index + 1} · ${clip.frames.length} 帧`}>
              <input
                value={clip.name}
                onChange={(e) => editClip(index, { name: e.target.value })}
              />
            </Field>
            <div className="ie-row">
              <Numeric
                label="帧率"
                value={clip.fps}
                min={0.1}
                max={120}
                onChange={(fps) => editClip(index, { fps })}
              />
              <Check
                label="循环"
                value={clip.loop}
                onChange={(loop) => editClip(index, { loop })}
              />
              <button
                title="删除动画"
                onClick={() =>
                  edit((obj) => {
                    replaceClipReferences(
                      obj,
                      obj.visual.clips[index].name,
                      '',
                    );
                    obj.visual.clips.splice(index, 1);
                  })
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
            <details>
              <summary>帧顺序与时长</summary>
              {clip.frames.map((f, n) => (
                <div className="ie-row" key={n}>
                  <span>{n + 1}</span>
                  <Numeric
                    label="相对时长"
                    value={f.duration}
                    step={0.1}
                    min={0.01}
                    onChange={(duration) =>
                      edit((obj) => {
                        obj.visual.clips[index].frames[n].duration = duration;
                      })
                    }
                  />
                  <button
                    disabled={!n}
                    onClick={() =>
                      edit((obj) => {
                        const fs = obj.visual.clips[index].frames;
                        [fs[n - 1], fs[n]] = [fs[n], fs[n - 1]];
                      })
                    }
                  >
                    前移
                  </button>
                  <button
                    disabled={clip.frames.length === 1}
                    title="移除此帧"
                    onClick={() =>
                      edit((obj) => {
                        obj.visual.clips[index].frames.splice(n, 1);
                      })
                    }
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </details>
          </div>
        ))}
        <ClipSelect
          object={o}
          value={o.visual.idleAnimation}
          label="待机动画"
          onChange={(v) =>
            edit((obj) => {
              obj.visual.idleAnimation = v;
            })
          }
        />
        <ClipSelect
          object={o}
          value={o.visual.focusAnimation}
          label="焦点动画"
          onChange={(v) =>
            edit((obj) => {
              obj.visual.focusAnimation = v;
            })
          }
        />
      </details>
      <details>
        <summary>感知范围</summary>
        <ShapeFields
          value={o.detection.shape}
          onChange={(v) =>
            edit((obj) => {
              obj.detection.shape = v;
            })
          }
        />
      </details>
      <details>
        <summary>鼠标点击区域</summary>
        <ShapeFields
          value={o.pointer}
          onChange={(v) =>
            edit((obj) => {
              obj.pointer = v;
            })
          }
        />
      </details>
      <details>
        <summary>实体碰撞</summary>
        <Check
          label="初始阻挡"
          value={o.solid.enabled}
          onChange={(v) =>
            edit((obj) => {
              obj.solid.enabled = v;
            })
          }
        />
        <ShapeFields
          value={o.solid.shape}
          onChange={(v) =>
            edit((obj) => {
              obj.solid.shape = v;
            })
          }
        />
        <Numeric
          label="碰撞 layer（位掩码）"
          value={o.solid.layer}
          min={0}
          onChange={(v) =>
            edit((obj) => {
              obj.solid.layer = v;
            })
          }
        />
        <Numeric
          label="碰撞 mask（位掩码）"
          value={o.solid.mask}
          min={0}
          onChange={(v) =>
            edit((obj) => {
              obj.solid.mask = v;
            })
          }
        />
      </details>
    </div>
  );
}
