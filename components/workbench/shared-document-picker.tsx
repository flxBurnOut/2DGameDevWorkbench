'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { DocumentKind, SharedDocumentSummary } from '@/features/editor-documents/client';
import { readSharedDocumentLibrary, sharedDocumentPage } from '@/features/editor-documents/library';

export function SharedDocumentPicker({ open, kind, currentId, disabled = false, onClose, onOpen }: {
  open: boolean; kind: DocumentKind; currentId?: string; disabled?: boolean;
  onClose: () => void; onOpen: (document: SharedDocumentSummary) => Promise<void>;
}) {
  const [documents, setDocuments] = useState<SharedDocumentSummary[]>([]);
  const [search, setSearch] = useState(''), [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false), [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState(''), [issues, setIssues] = useState(0), [refresh, setRefresh] = useState(0);
  const generation = useRef(0), selection = useRef(false);
  const searchId = useId();
  useEffect(() => {
    const request = ++generation.current;
    if (!open) return;
    const controller = new AbortController();
    // oxlint-disable-next-line react/react-compiler -- Reset the explicit request state for a new server listing.
    setLoading(true); setError(''); setDocuments([]); setIssues(0); setPage(0); setOpening(null);
    void readSharedDocumentLibrary(kind, controller.signal).then(result => {
      if (generation.current !== request || controller.signal.aborted) return;
      setDocuments(result.documents); setIssues(result.issues.length);
    }).catch(cause => {
      if (generation.current === request && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '服务端共享工程暂时无法读取。');
    }).finally(() => {
      if (generation.current === request && !controller.signal.aborted) setLoading(false);
    });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Invalidate this request counter; it never refers to a DOM node.
    return () => { controller.abort(); generation.current++; };
  }, [open, kind, refresh]);
  const visible = sharedDocumentPage(documents, search, page);
  async function choose(document: SharedDocumentSummary) {
    if (selection.current || disabled || loading) return;
    selection.current = true; setOpening(document.id); setError('');
    const request = generation.current;
    try { await onOpen(document); }
    catch (cause) { if (generation.current === request) setError(cause instanceof Error ? cause.message : '工程尚未打开。'); }
    finally { selection.current = false; if (generation.current === request) setOpening(null); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!value && !selection.current) onClose(); }}>
    <DialogContent style={{ maxWidth: 720, maxHeight: '85dvh', overflowY: 'auto' }}>
      <DialogHeader>
        <DialogTitle>打开服务端共享{kind === 'scene' ? '场景' : '交互物工程'}</DialogTitle>
        <DialogDescription>这里列出当前连接的 Forge 服务保存的工程，同一服务中的工程可在其他浏览器打开。切换前会保存当前草稿，保留本机未同步修改并检查共享版本冲突。</DialogDescription>
      </DialogHeader>
      <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
        <label htmlFor={searchId} style={{ flex: 1 }}>搜索全部共享工程<Input id={searchId} aria-label="搜索共享工程" value={search} maxLength={200} onChange={event => { setSearch(event.target.value); setPage(0); }} placeholder="名称或工程 ID" /></label>
        <Button variant="outline" disabled={loading || Boolean(opening)} onClick={() => setRefresh(value => value + 1)}>刷新列表</Button>
      </div>
      {loading && <output>正在读取全部分页，请稍候…</output>}
      {error && <p role="alert">{error} 请刷新列表重试；尚未打开其他工程。</p>}
      {issues > 0 && <output>有 {issues} 条工程记录不可读；下方仅展示可读取工程。</output>}
      {!loading && !error && <>
        <p>{visible.total} 个匹配工程 · 第 {visible.page + 1} / {visible.pages} 页</p>
        {!visible.total && <p>{search.trim() ? '没有匹配的共享工程。' : '当前服务没有此类共享工程。浏览器独有草稿需先在原浏览器打开并同步。'}</p>}
        <div style={{ display: 'grid', gap: 8 }}>
          {visible.documents.map(document => <Button key={document.id} variant="outline" disabled={disabled || Boolean(opening)} onClick={() => void choose(document)} style={{ justifyContent: 'space-between', height: 'auto', minHeight: 56, whiteSpace: 'normal', textAlign: 'left' }}>
            <span style={{ overflowWrap: 'anywhere' }}><strong>{document.name}</strong>{document.id === currentId && ' · 当前工程'}<br /><small>共享版本 {document.revision} · {document.updatedAt ? new Date(document.updatedAt).toLocaleString() : '更新时间未知'}</small></span>
            <span>{opening === document.id ? '正在保存并打开…' : '打开'}</span>
          </Button>)}
        </div>
        <div style={{ display: 'flex', gap: 8 }}><Button variant="outline" disabled={visible.page === 0 || Boolean(opening)} onClick={() => setPage(visible.page - 1)}>上一页</Button><Button variant="outline" disabled={visible.page + 1 >= visible.pages || Boolean(opening)} onClick={() => setPage(visible.page + 1)}>下一页</Button></div>
        <p>列表读取期间其他页面的保存可能改变排序。需要最新内容时刷新；打开后以工程实际版本为准。</p>
      </>}
    </DialogContent>
  </Dialog>;
}
