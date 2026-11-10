'use client';

import { useEffect, useRef, useState } from 'react';
import { gameHandoff } from '@/features/godot-export/handoff.mjs';
import {
  deliveryKinds, deliveryStates, readGameDeliveries, readGameDelivery,
  type GameDelivery, type GameDeliveryPage,
} from '@/lib/workbench/game-export-client';

const time = (value: string) => Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('zh-CN') : '时间未记录';
const message = (cause: unknown) => cause instanceof Error ? cause.message : '交付记录暂时无法读取。';

export function GameDeliveryHistory() {
  const [hydrated, setHydrated] = useState(false);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [page, setPage] = useState<GameDeliveryPage | null>(null);
  const [delivery, setDelivery] = useState<GameDelivery | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const previousFilter = useRef(false);
  const moreRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const readLocation = () => {
      const query = new URLSearchParams(location.search);
      setSelectedId(query.get('delivery') || '');
      setPendingOnly(query.get('pending') === '1');
      setHydrated(true);
    };
    readLocation();
    window.addEventListener('popstate', readLocation);
    return () => window.removeEventListener('popstate', readLocation);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const turn = ++epoch.current;
    if (previousFilter.current !== pendingOnly) setPage(null);
    previousFilter.current = pendingOnly;
    const controller = new AbortController();
    moreRequest.current?.abort();
    // oxlint-disable-next-line react/react-compiler -- Synchronize loading state with a new external history request.
    setLoading(true);
    setLoadingMore(false);
    setError('');
    void readGameDeliveries({ pendingOnly }, controller.signal).then((result) => {
      if (turn === epoch.current && !controller.signal.aborted) setPage(result);
    }).catch((cause) => {
      if (turn === epoch.current && !controller.signal.aborted) setError(message(cause));
    }).finally(() => {
      if (turn === epoch.current && !controller.signal.aborted) setLoading(false);
    });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- These refs track the active request, never a rendered DOM node.
    return () => { controller.abort(); moreRequest.current?.abort(); epoch.current++; };
  }, [pendingOnly, reload, hydrated]);

  useEffect(() => {
    const controller = new AbortController();
    // oxlint-disable-next-line react/react-compiler -- Clear the previous remote record while the newly selected identity loads.
    setNotice('');
    setDetailError('');
    setDelivery(null);
    if (!selectedId) { setReading(false); return () => controller.abort(); }
    setReading(true);
    void readGameDelivery(selectedId, controller.signal).then((result) => {
      if (!controller.signal.aborted) setDelivery(result);
    }).catch((cause) => {
      if (!controller.signal.aborted) setDetailError(message(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setReading(false);
    });
    return () => controller.abort();
  }, [selectedId, reload]);

  const navigate = (id: string, pending = pendingOnly) => {
    const query = new URLSearchParams({ tab: 'deliveries' });
    if (id) query.set('delivery', id);
    if (pending) query.set('pending', '1');
    history.pushState(history.state, '', `/advanced?${query}`);
    setSelectedId(id);
    if (pending !== pendingOnly) setPage(null);
    setPendingOnly(pending);
  };

  const loadMore = async () => {
    if (!page || page.nextOffset === null || loading || loadingMore) return;
    const turn = epoch.current;
    const controller = new AbortController();
    moreRequest.current = controller;
    setLoadingMore(true);
    setError('');
    try {
      const result = await readGameDeliveries({ pendingOnly, offset: page.nextOffset, snapshot: page.snapshot }, controller.signal);
      if (turn !== epoch.current || controller.signal.aborted) return;
      setPage((current) => current && current.snapshot === result.snapshot
        ? { ...result, deliveries: [...new Map([...current.deliveries, ...result.deliveries].map((item) => [item.deliveryId, item])).values()] }
        : current);
    } catch (cause) {
      if (turn === epoch.current && !controller.signal.aborted) setError(message(cause));
    } finally {
      if (turn === epoch.current && !controller.signal.aborted) setLoadingMore(false);
    }
  };

  const handoff = gameHandoff(delivery, delivery?.package);
  return <div className="wb-delivery-history">
    <div className="wb-page-heading">
      <div><h2>游戏交付</h2><p>查看已导出到游戏项目的资源，以及保存的接入和引擎验收结果。</p></div>
      <button className="wb-button" disabled={loading || reading} onClick={() => setReload((value) => value + 1)}>刷新交付记录</button>
    </div>
    <div className="wb-record-filters" aria-label="交付筛选">
      <button className="wb-button" aria-pressed={!pendingOnly} onClick={() => navigate('', false)}>全部交付</button>
      <button className="wb-button" aria-pressed={pendingOnly} onClick={() => navigate('', true)}>待接入或需处理</button>
      {page && <span className="wb-muted">已显示 {page.deliveries.length} / {page.total} 条</span>}
    </div>
    {error && <p className="wb-notice" role="alert">{error} 已加载的记录仍保留，可刷新列表重试。</p>}
    <div className="wb-task-layout">
      <section aria-label="游戏交付列表" aria-busy={loading || loadingMore}>
        {loading && <output>正在读取交付记录…</output>}
        {page?.deliveries.map((item) => <button key={item.deliveryId} className="wb-task-button" aria-pressed={selectedId === item.deliveryId} onClick={() => navigate(item.deliveryId)}>
          <strong>{item.title}</strong>
          <span>{item.project.name} · {deliveryKinds[item.kind] || item.kind}</span>
          <span>{deliveryStates[item.status] || item.status}</span>
          <small>{time(item.createdAt)}</small>
        </button>)}
        {!loading && !error && page?.total === 0 && <p className="wb-muted">{pendingOnly ? '暂无待接入或需要处理的交付。' : '尚无游戏交付记录。可从资产详情或制作工具导出到 Godot 项目。'}</p>}
        {page?.nextOffset != null && <button className="wb-button" disabled={loading || loadingMore} onClick={() => void loadMore()}>{loadingMore ? '读取中…' : '加载更早交付'}</button>}
      </section>
      <section className="wb-task-detail" aria-label="游戏交付详情" aria-busy={reading}>
        {reading && <output>正在读取此交付…</output>}
        {detailError && <p role="alert">{detailError} 可刷新重试或选择其他记录。</p>}
        {!selectedId && <p className="wb-muted">选择一条交付，查看接入状态、保存位置与验收说明。</p>}
        {delivery && <>
          <h3>{delivery.title}</h3>
          <p><strong>{deliveryStates[delivery.status] || delivery.status}</strong> · {deliveryKinds[delivery.kind] || delivery.kind}</p>
          <p>目标项目：{delivery.project.name}</p>
          <p className="wb-delivery-path">{delivery.project.path}</p>
          <p className="wb-muted">交付于 {time(delivery.createdAt)} · 状态更新于 {time(delivery.updatedAt)}</p>
          {delivery.integration ? <>
            <h4>接入结果</h4><p className="wb-delivery-text">{delivery.integration.summary}</p>
            <h4>引擎验收</h4>
            <p>{delivery.integration.engine.status === 'passed'
              ? `Agent 已记录 Godot ${delivery.integration.engine.version || '版本未记录'} 通过证据`
              : delivery.integration.engine.status === 'failed' ? '引擎验收未通过' : '尚未执行引擎验收'}</p>
            {delivery.integration.engine.status === 'passed' && delivery.integration.engine.baselineValidated === false && <p>记录中的引擎版本不满足当前导出基线，请按目标项目版本核对。</p>}
            {delivery.integration.engine.evidence && <p className="wb-delivery-text">{delivery.integration.engine.evidence}</p>}
            {!!delivery.integration.files?.length && <details><summary>已记录的接入文件</summary><ul>{delivery.integration.files.map((file) => <li className="wb-delivery-path" key={file.path}>{file.path}</li>)}</ul></details>}
          </> : <p>尚未记录代码接入与引擎验收结果。</p>}
          <p className="wb-muted">这里显示保存的结果；查看和刷新不会重新导出、安装资源或启动 Agent。</p>
          {delivery.status !== 'integrated' && <>
            <button className="wb-button" onClick={() => {
              void navigator.clipboard.writeText(handoff.prompt).then(() => setNotice('接入请求已复制。')).catch(() => setNotice('自动复制不可用，请展开下方完整接入请求并手动复制。'));
            }}>复制给 WorkBuddy</button>
            <details><summary>完整接入请求</summary><textarea aria-label="历史交付接入请求" readOnly rows={6} value={handoff.prompt} /></details>
          </>}
          <details><summary>保存位置与交付身份</summary><p className="wb-delivery-path">{delivery.inboxPath}</p><p className="wb-delivery-path">{delivery.deliveryId}</p></details>
          {notice && <output>{notice}</output>}
        </>}
      </section>
    </div>
  </div>;
}
