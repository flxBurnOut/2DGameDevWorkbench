/* oxlint-disable next/no-img-element -- Asset previews preserve original pixels. */
'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  publishEditorSession,
  removeEditorSession,
} from '@/lib/workbench/editor-session';
import {
  loadLibraryAsset,
  purposesFor,
  type ImportPurpose,
  type ImportBundle,
  type LibraryAsset,
} from '@/lib/workbench/asset-import';

type Catalog = {
  assets: LibraryAsset[];
  nextOffset: number | null;
  snapshot: string;
  coverage?: { complete: boolean; note?: string };
};
export function AssetImportPicker({
  open,
  onClose,
  purposes,
  onImport,
  initialAsset = '',
  kind,
}: {
  open: boolean;
  onClose: () => void;
  purposes: ImportPurpose[];
  onImport: (bundle: ImportBundle) => Promise<void>;
  initialAsset?: string;
  kind?: string;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [query, setQuery] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [page, setPage] = useState({ offset: 0, snapshot: '' }),
    [refresh, setRefresh] = useState(0),
    [using, setUsing] = useState(false);
  const lock = useRef(false);
  const purposeKey = purposes.join(',');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        void (async () => {
          setLoading(true);
          setError('');
          try {
            const params = initialAsset
              ? new URLSearchParams({ assetId: initialAsset })
              : new URLSearchParams({
                  query,
                  purposes: purposeKey,
                  ...(kind ? { kind } : {}),
                  limit: '24',
                  offset: String(page.offset),
                  ...(page.snapshot ? { snapshot: page.snapshot } : {}),
                });
            const response = await fetch('/api/workbench/assets?' + params, {
              cache: 'no-store',
              signal: controller.signal,
            });
            const data = (await response.json()) as Catalog & {
              asset: LibraryAsset;
              error?: string;
            };
            if (!response.ok)
              throw new Error(data.error || '资产库无法读取，请检查本地后台。');
            if (!controller.signal.aborted)
              setCatalog(
                initialAsset
                  ? {
                      assets: [data.asset],
                      nextOffset: null,
                      snapshot: '',
                      coverage: data.coverage,
                    }
                  : data,
              );
          } catch (e) {
            if (!controller.signal.aborted) setError((e as Error).message);
          } finally {
            if (!controller.signal.aborted) setLoading(false);
          }
        })(),
      150,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, page, purposeKey, refresh, initialAsset, kind]);
  const choose = async (asset: LibraryAsset, purpose: ImportPurpose) => {
    if (lock.current) return;
    lock.current = true;
    setUsing(true);
    setError('');
    publishEditorSession({
      capabilityId: 'asset-import',
      items: [],
      dirty: false,
      busy: true,
      save: async () => {},
      beforeLeave: () => {
        throw new Error('素材正在导入，请完成后再离开。');
      },
    });
    try {
      await onImport(await loadLibraryAsset(asset.id, purpose));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      removeEditorSession('asset-import');
      lock.current = false;
      setUsing(false);
    }
  };
  const visible = (catalog?.assets || []).filter(
    (asset) => (!kind || asset.kind === kind) && purposesFor(asset, purposes).length,
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !using) onClose();
      }}
    >
      <DialogContent className="wb-import-modal">
        <DialogHeader>
          <DialogTitle>从资产库选用</DialogTitle>
          <DialogDescription>
            直接复用已保存素材。导入保留源文件，不会重新生成或产生费用。
          </DialogDescription>
        </DialogHeader>
        {!initialAsset && (
          <Input
            aria-label="搜索可导入资产"
            placeholder="按素材名称搜索"
            value={query}
            disabled={using}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage({ offset: 0, snapshot: '' });
            }}
          />
        )}
        {error && <p role="alert">{error}</p>}
        {loading && <p>正在读取资产库…</p>}
        {catalog?.coverage?.complete === false && (
          <p>部分素材来源暂不可读；仍可导入可用素材。</p>
        )}
        <div className="wb-import-grid">
          {visible.map((asset) => (
            <article key={asset.id}>
              {asset.previewUrl &&
                asset.previewKind !== 'none' &&
                asset.availability === 'available' && (
                  <img src={asset.previewUrl} alt={asset.title} />
                )}
              <strong>{asset.title}</strong>
              <small>{asset.statusLabel}</small>
              {purposesFor(asset, purposes).map((rule) => (
                <Button
                  key={rule.id}
                  size="sm"
                  disabled={using || asset.availability !== 'available'}
                  onClick={() => void choose(asset, rule.id as ImportPurpose)}
                >
                  导入{rule.label}
                </Button>
              ))}
            </article>
          ))}
        </div>
        {!loading && !visible.length && (
          <p>
            没有匹配的适用素材，可调整搜索条件或在资产库导入素材包。外观原图需要先在交互物编辑器配置行为，才能作为交互物加入场景。
          </p>
        )}
        <div className="wb-tool-links">
          <Button
            variant="outline"
            disabled={using || !page.offset}
            onClick={() =>
              setPage({
                offset: Math.max(0, page.offset - 24),
                snapshot: catalog?.snapshot || '',
              })
            }
          >
            上一页
          </Button>
          <Button
            variant="outline"
            disabled={using || catalog?.nextOffset == null}
            onClick={() =>
              setPage({
                offset: catalog!.nextOffset!,
                snapshot: catalog!.snapshot,
              })
            }
          >
            下一页
          </Button>
          <Button
            variant="ghost"
            disabled={using}
            onClick={() => {
              setPage({ offset: 0, snapshot: '' });
              setRefresh((n) => n + 1);
            }}
          >
            刷新列表
          </Button>
          {using && <span>正在导入…</span>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
