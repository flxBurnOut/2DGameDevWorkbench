'use client';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { useState, type ReactNode } from 'react';
import { appearanceAnimation } from '@/features/interactable-editor/contract.mjs';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import {
  type Asset,
  type Entry,
  type Feedback,
  type Interactable,
  type Shape,
  type Appearance,
} from '@/features/interactable-editor/contract.mjs';

/**
 * Tint as a swatch plus an editable hex value. White means "no tint", so it
 * is labelled instead of showing an empty white bar.
 */
export function ColorField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const plain = value.toLowerCase() === '#ffffff';
  return (
    <div className="ie-color-field">
      <span className="ie-field-label">颜色</span>
      <span className="ie-color">
        <input type="color" aria-label="选择颜色" value={value} onChange={(e) => { setDraft(null); onChange(e.target.value); }} />
        <input
          aria-label="颜色值"
          value={draft ?? value}
          maxLength={7}
          spellCheck={false}
          onChange={(e) => {
            const next = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
            setDraft(next);
            if (/^#[0-9a-f]{6}$/i.test(next)) onChange(next.toLowerCase());
          }}
          onBlur={() => setDraft(null)}
        />
        {plain && <small>不着色</small>}
      </span>
    </div>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label>
      {label}
      {children}
    </label>
  );
}
export function Numeric({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber))
            onChange(e.target.valueAsNumber);
        }}
      />
    </Field>
  );
}
export function Check({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="ie-check">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
export function Pages({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <Field label="文本（单独一行 --- 分页）">
      <textarea
        value={value.join('\n---\n')}
        onChange={(e) =>
          onChange(e.target.value ? e.target.value.split(/\n---\n/) : [])
        }
      />
    </Field>
  );
}
export function AssetSelect({
  assets,
  value,
  onChange,
  media = 'image',
  label = '图片',
}: {
  assets: Asset[];
  value: string;
  onChange: (v: string) => void;
  media?: string;
  label?: string;
}) {
  return (
    <Field label={label}>
      <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
        <NativeSelectOption value="">未设置</NativeSelectOption>
        {assets
          .filter((a) => a.mime.startsWith(media))
          .map((a) => (
            <NativeSelectOption key={a.id} value={a.id}>
              {a.name}
            </NativeSelectOption>
          ))}
      </NativeSelect>
    </Field>
  );
}
export function ClipSelect({
  object,
  value,
  onChange,
  label = '动画',
}: {
  object: Interactable;
  value: string;
  onChange: (v: string) => void;
  label?: string;
}) {
  return (
    <Field label={label}>
      <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
        <NativeSelectOption value="">未设置</NativeSelectOption>
        {object.visual.clips.map((c) => (
          <NativeSelectOption key={c.name} value={c.name}>
            {c.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
}
export function ShapeFields({
  value,
  onChange,
}: {
  value: Shape;
  onChange: (s: Shape) => void;
}) {
  const patch = (v: Partial<Shape>) => onChange({ ...value, ...v });
  return (
    <>
      <Field label="形状">
        <NativeSelect
          value={value.type}
          onChange={(e) => patch({ type: e.target.value as Shape['type'] })}
        >
          <NativeSelectOption value="rectangle">矩形</NativeSelectOption>
          <NativeSelectOption value="circle">圆形</NativeSelectOption>
          <NativeSelectOption value="capsule">胶囊</NativeSelectOption>
        </NativeSelect>
      </Field>
      <div className="ie-row">
        {value.type === 'circle' ? (
          <Numeric
            label="半径"
            min={1}
            value={value.radius}
            onChange={(radius) => patch({ radius })}
          />
        ) : (
          <>
            <Numeric
              label="宽度"
              min={1}
              value={value.width}
              onChange={(width) => patch({ width })}
            />
            <Numeric
              label="高度"
              min={1}
              value={value.height}
              onChange={(height) => patch({ height })}
            />
          </>
        )}
      </div>
      <div className="ie-row">
        <Numeric
          label="偏移 X"
          value={value.offset.x}
          onChange={(x) => patch({ offset: { ...value.offset, x } })}
        />
        <Numeric
          label="偏移 Y"
          value={value.offset.y}
          onChange={(y) => patch({ offset: { ...value.offset, y } })}
        />
      </div>
    </>
  );
}
export function FeedbackFields({
  value,
  onChange,
  object,
  assets,
}: {
  value: Feedback[];
  onChange: (steps: Feedback[]) => void;
  object: Interactable;
  assets: Asset[];
}) {
  const change = (index: number, step: Feedback) =>
    onChange(value.map((s, i) => (i === index ? step : s)));
  const move = (index: number, direction: number) => {
    const copy = [...value];
    [copy[index], copy[index + direction]] = [
      copy[index + direction],
      copy[index],
    ];
    onChange(copy);
  };
  return (
    <>
      <div className="ie-row">
        <strong>反馈步骤</strong>
        <NativeSelect
          aria-label="添加反馈步骤"
          value=""
          onChange={(e) => {
            const type = e.target.value;
            const step: Feedback =
              type === 'show_text'
                ? { type, pages: [] }
                : type === 'wait'
                  ? { type, seconds: 0.5 }
                  : type === 'play_animation'
                    ? { type, animation: '', waitForEnd: true }
                    : {
                        type: 'play_audio',
                        assetId: '',
                        waitForEnd: true,
                        volumeDb: 0,
                      };
            onChange([...value, step]);
          }}
        >
          <NativeSelectOption value="">＋ 添加步骤</NativeSelectOption>
          <NativeSelectOption value="show_text">文本</NativeSelectOption>
          <NativeSelectOption value="play_animation">动画</NativeSelectOption>
          <NativeSelectOption value="play_audio">音效</NativeSelectOption>
          <NativeSelectOption value="wait">等待</NativeSelectOption>
        </NativeSelect>
      </div>
      {value.map((s, i) => (
        <div className="ie-card" key={i}>
          <div className="ie-row">
            <strong>
              {i + 1}.{' '}
              {
                {
                  show_text: '文本',
                  play_animation: '动画',
                  play_audio: '音效',
                  wait: '等待',
                }[s.type]
              }
            </strong>
            <span className="ie-spacer" />
            <button title="上移步骤" disabled={!i} onClick={() => move(i, -1)}>
              <ArrowUp size={14} />
            </button>
            <button
              title="下移步骤"
              disabled={i === value.length - 1}
              onClick={() => move(i, 1)}
            >
              <ArrowDown size={14} />
            </button>
            <button
              title="删除步骤"
              onClick={() => onChange(value.filter((_, n) => n !== i))}
            >
              <Trash2 size={14} />
            </button>
          </div>
          {s.type === 'show_text' && (
            <Pages
              value={s.pages}
              onChange={(pages) => change(i, { ...s, pages })}
            />
          )}{' '}
          {s.type === 'wait' && (
            <Numeric
              label="秒"
              min={0}
              step={0.1}
              value={s.seconds}
              onChange={(seconds) => change(i, { ...s, seconds })}
            />
          )}{' '}
          {s.type === 'play_animation' && (
            <>
              <ClipSelect
                object={object}
                value={s.animation}
                onChange={(animation) => change(i, { ...s, animation })}
              />
              <Check
                label="等待播放结束（非循环动画）"
                value={s.waitForEnd}
                onChange={(waitForEnd) => change(i, { ...s, waitForEnd })}
              />
            </>
          )}{' '}
          {s.type === 'play_audio' && (
            <>
              <AssetSelect
                assets={assets}
                media="audio"
                label="音效"
                value={s.assetId}
                onChange={(assetId) => change(i, { ...s, assetId })}
              />
              <Numeric
                label="音量 dB"
                value={s.volumeDb}
                min={-80}
                max={12}
                onChange={(volumeDb) => change(i, { ...s, volumeDb })}
              />
              <Check
                label="播放结束后继续"
                value={s.waitForEnd}
                onChange={(waitForEnd) => change(i, { ...s, waitForEnd })}
              />
            </>
          )}
        </div>
      ))}
    </>
  );
}
function AppearanceFields({
  value,
  onChange,
  assets,
  object,
  onEditImage,
  imageBusy,
}: {
  value: Appearance;
  onChange: (a: Appearance) => void;
  assets: Asset[];
  object: Interactable;
  onEditImage?: () => void;
  imageBusy?: boolean;
}) {
  return (
    <>
      <AssetSelect
        assets={assets}
        value={value.assetId}
        onChange={(assetId) => onChange({ ...value, assetId })}
      />
      {onEditImage && <><button type="button" disabled={imageBusy || !(value.assetId || object.visual.assetId) || !!appearanceAnimation(value, object.visual)} onClick={onEditImage}>局部调整此状态图片</button><p className="ie-note">{appearanceAnimation(value, object.visual) ? '此状态使用动画，静态图片调整只读；请先明确选择静态外观。' : !value.assetId ? '当前继承默认图片；采用仅覆盖此状态，默认图片与其他状态保留。' : '仅调整此状态图片；行为、动画片段和其他状态保留。'}</p></>}
      <Check label="使用静态状态图" value={!!value.staticImage} onChange={staticImage =>
        onChange({ ...value, staticImage, animation: staticImage ? '' : value.animation })} />
      <ClipSelect
        object={object}
        value={value.animation}
        onChange={(animation) => onChange({ ...value, animation, staticImage: false })}
      />
      <div className="ie-row">
        <Check
          label="显示外观"
          value={value.visible}
          onChange={(visible) => onChange({ ...value, visible })}
        />
        <Check
          label="实体阻挡"
          value={value.solidEnabled}
          onChange={(solidEnabled) => onChange({ ...value, solidEnabled })}
        />
        <ColorField value={value.tint} onChange={(tint) => onChange({ ...value, tint })} />
      </div>
    </>
  );
}
export function EntryFields({
  value,
  onChange,
  assets,
  object,
  onEditImage,
  imageBusy,
}: {
  value: Entry;
  onChange: (e: Entry) => void;
  assets: Asset[];
  object: Interactable;
  onEditImage?: () => void;
  imageBusy?: boolean;
}) {
  return (
    <>
      <Field label="条目名称">
        <input
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </Field>
      <Pages
        value={value.pages}
        onChange={(pages) => onChange({ ...value, pages })}
      />
      <AppearanceFields
        value={value.appearance}
        onChange={(appearance) => onChange({ ...value, appearance })}
        assets={assets}
        object={object}
        onEditImage={onEditImage}
        imageBusy={imageBusy}
      />
      <details>
        <summary>本条目反馈</summary>
        <FeedbackFields
          value={value.feedback}
          onChange={(feedback) => onChange({ ...value, feedback })}
          assets={assets}
          object={object}
        />
      </details>
    </>
  );
}
export function BehaviorPanel({
  object,
  assets,
  edit,
  onEditImage,
  imageBusy,
}: {
  object: Interactable;
  assets: Asset[];
  edit: (fn: (o: Interactable) => void) => void;
  onEditImage?: (slot: 'toggle-state' | 'sequence-entry', index: number) => void;
  imageBusy?: boolean;
}) {
  const b = object.behavior;
  const addEntry = () =>
    edit((o) => {
      o.behavior.entries.push({
        name: `第 ${o.behavior.entries.length + 1} 步`,
        pages: [],
        appearance: {
          assetId: '',
          animation: '',
          visible: true,
          solidEnabled: false,
          tint: '#ffffff',
        },
        feedback: [],
      });
    });
  return (
    <>
      <Pages
        value={object.content.pages}
        onChange={(pages) =>
          edit((o) => {
            o.content.pages = pages;
          })
        }
      />
      <Numeric
        label="每秒显示字数（0 为立即显示）"
        min={0}
        max={300}
        value={object.content.charactersPerSecond}
        onChange={(v) =>
          edit((o) => {
            o.content.charactersPerSecond = v;
          })
        }
      />
      {b.kind === 'inspect' && (
        <Check
          label="允许重复查看"
          value={b.repeat}
          onChange={(v) =>
            edit((o) => {
              o.behavior.repeat = v;
            })
          }
        />
      )}{' '}
      {b.kind === 'toggle' && (
        <>
          <Check
            label="初始为 B 状态"
            value={b.initialToggle}
            onChange={(v) =>
              edit((o) => {
                o.behavior.initialToggle = v;
              })
            }
          />
          {b.states.map((s, i) => (
            <details key={i} open>
              <summary>{i === 0 ? 'A' : 'B'} 状态</summary>
              <EntryFields
                value={s}
                onChange={(e) =>
                  edit((o) => {
                    o.behavior.states[i] = e;
                  })
                }
                object={object}
                assets={assets}
                onEditImage={onEditImage ? () => onEditImage('toggle-state', i) : undefined}
                imageBusy={imageBusy}
              />
            </details>
          ))}
        </>
      )}{' '}
      {b.kind === 'sequence' && (
        <>
          <Field label="最后一步之后">
            <NativeSelect
              value={b.onEnd}
              onChange={(e) =>
                edit((o) => {
                  o.behavior.onEnd = e.target.value as typeof b.onEnd;
                })
              }
            >
              <NativeSelectOption value="stop">完成并停止</NativeSelectOption>
              <NativeSelectOption value="loop">循环到第一步</NativeSelectOption>
              <NativeSelectOption value="stay_last">继续显示最后一步</NativeSelectOption>
            </NativeSelect>
          </Field>
          {b.entries.map((s, i) => (
            <details key={i} open>
              <summary>
                第 {i + 1} 步 · {s.name}
              </summary>
              <div className="ie-row">
                <button
                  title="上移条目"
                  disabled={!i}
                  onClick={() =>
                    edit((o) => {
                      [o.behavior.entries[i - 1], o.behavior.entries[i]] = [
                        o.behavior.entries[i],
                        o.behavior.entries[i - 1],
                      ];
                    })
                  }
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  disabled={b.entries.length === 1}
                  onClick={() =>
                    edit((o) => {
                      o.behavior.entries.splice(i, 1);
                    })
                  }
                >
                  <Trash2 size={14} />
                  删除
                </button>
              </div>
              <EntryFields
                value={s}
                onChange={(e) =>
                  edit((o) => {
                    o.behavior.entries[i] = e;
                  })
                }
                object={object}
                assets={assets}
                onEditImage={onEditImage ? () => onEditImage('sequence-entry', i) : undefined}
                imageBusy={imageBusy}
              />
            </details>
          ))}
          <button onClick={addEntry}>
            <Plus size={14} />
            添加条目
          </button>
        </>
      )}
      <details open>
        <summary>共同反馈</summary>
        <FeedbackFields
          object={object}
          assets={assets}
          value={object.feedback}
          onChange={(feedback) =>
            edit((o) => {
              o.feedback = feedback;
            })
          }
        />
      </details>
      <Numeric
        label="成功后冷却（秒）"
        value={object.cooldownSeconds}
        min={0}
        step={0.1}
        onChange={(v) =>
          edit((o) => {
            o.cooldownSeconds = v;
          })
        }
      />
      {(b.kind === 'pickup' ||
        (b.kind === 'inspect' && !b.repeat) ||
        (b.kind === 'sequence' && b.onEnd === 'stop')) && (
        <Field label="最终完成后">
          <NativeSelect
            value={object.completion}
            onChange={(e) =>
              edit((o) => {
                o.completion = e.target.value as Interactable['completion'];
              })
            }
          >
            <NativeSelectOption value="remain">保留外观</NativeSelectOption>
            <NativeSelectOption value="hide">隐藏</NativeSelectOption>
            <NativeSelectOption value="free">释放节点</NativeSelectOption>
          </NativeSelect>
        </Field>
      )}
    </>
  );
}
