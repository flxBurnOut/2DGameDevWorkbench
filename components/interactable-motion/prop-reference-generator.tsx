'use client';
import { useState } from 'react';
import Link from 'next/link';
import { AssetImportPicker } from '@/components/workbench/asset-import-picker';
import { base64Bytes } from '@/features/interactable-motion/png-rgba';
import { motionRequest } from '../sprite-generator/open-motion-model';

export function propProvenanceLabel(type?: string) {
  if (type === 'pixellab') return 'PixelLab 原图';
  if (type === 'convert-prop') return '像素化原图';
  return '导入原图';
}

export function PropReferenceGenerator({
  objectName,
  onTransferred,
}: {
  objectName: string;
  onTransferred: (objectId: string) => Promise<void>;
}) {
  const [name, setName] = useState(objectName),
    [description, setDescription] = useState('');
  const [file, setFile] = useState<File>(),
    [task, setTask] = useState(''),
    [library, setLibrary] = useState(false);
  const [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit() {
    if (!file || !confirmed || busy) return;
    setBusy(true);
    setError('');
    try {
      const fields = {
        identity_description: description.trim(),
        confirmation: '已核对初始状态、部件外观与透明背景',
      };
      const value = task
        ? await motionRequest<{ object: { id: string } }>(
            'open-motion/references/from-prop',
            { ...fields, source_task_id: task },
          )
        : await motionRequest<{ object: { id: string } }>(
            'open-motion/references',
            {
              ...fields,
              object_type: 'interactable',
              display_name: name.trim() || file.name.replace(/\.png$/i, ''),
              png_base64: base64Bytes(new Uint8Array(await file.arrayBuffer())),
            },
          );
      await onTransferred(value.object.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function choose(next: File, title: string, sourceTask = '') {
    if (next.size > 1_500_000) throw new Error('请选择 128 × 128 的透明 PNG。');
    setFile(next);
    setTask(sourceTask);
    setName(title);
    setConfirmed(false);
    setError('');
  }
  return (
    <details className="im-tool" open={!objectName || undefined}>
      <summary>导入交互物原图</summary>
      <fieldset disabled={busy}>
        <label>
          128 × 128 透明 PNG
          <input
            type="file"
            accept="image/png"
            onChange={(e) => {
              const next = e.target.files?.[0];
              e.target.value = '';
              if (!next) return;
              try {
                choose(next, next.name.replace(/\.png$/i, ''));
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
        </label>
        <button type="button" onClick={() => setLibrary(true)}>
          从资产库选择原图
        </button>
        <Link href="/tools/interactable-editor">制作物品原图</Link>
        {file && (
          <>
            <label>
              物件名称
              <input
                value={name}
                disabled={!!task}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              外观说明（可选）
              <input
                value={description}
                maxLength={1000}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              已确认原图的初始状态、部件和透明背景
            </label>
            <button
              disabled={!confirmed || !name.trim()}
              onClick={() => void submit()}
            >
              用于状态动画
            </button>
          </>
        )}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <AssetImportPicker
        open={library}
        purposes={['image']}
        onClose={() => setLibrary(false)}
        onImport={async (bundle) => {
          const next = bundle.files[0]?.file;
          if (!next) throw new Error('素材包缺少图片。');
          choose(
            next,
            bundle.asset.title,
            bundle.asset.kind === 'prop' ? bundle.asset.taskId : undefined,
          );
          setLibrary(false);
        }}
      />
    </details>
  );
}
