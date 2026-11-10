'use client';
/* oxlint-disable next/no-html-link-for-pages -- WorkbenchProvider guards navigation. */
import { useEffect, useState } from 'react';
import { useWorkbench } from './workbench-provider';
import { ClearHistory } from './clear-history';
import { TaskResultCard } from './task-result-card';
import { GameDeliveryHistory } from './game-delivery-history';
import { workStateLabels, operationLabel } from '@/lib/workbench/work-items';

type Tab = 'services' | 'records' | 'deliveries' | 'data';
const tabs: [Tab, string][] = [
  ['services', '服务状态'],
  ['records', '全部制作记录'],
  ['deliveries', '游戏交付'],
  ['data', '本机数据'],
];
const time = (value: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('zh-CN')
    : '时间未记录';

export function WorkbenchManagement() {
  const wb = useWorkbench();
  const [tab, setTab] = useState<Tab>('services');
  const [selected, setSelected] = useState('');
  const [requestedTask, setRequestedTask] = useState('');
  const [filter, setFilter] = useState('all');
  const [health, setHealth] = useState<{
    uiReady?: boolean;
    pixellabConfigured?: boolean;
    error?: string;
  } | null>(null);
  useEffect(() => {
    const read = () => {
      const query = new URLSearchParams(location.search);
      const requested = query.get('tab');
      setTab(
        tabs.some(([id]) => id === requested)
          ? (requested as Tab)
          : query.has('task') || query.has('item')
            ? 'records'
            : 'services',
      );
      setSelected(query.get('item') || query.get('task') || '');
      setRequestedTask(query.get('task') || '');
    };
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  useEffect(() => {
    if (tab !== 'services') return;
    const controller = new AbortController();
    void fetch('/api/workbench/sprite-pipeline/health', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((response) => response.json())
      .then((value) => setHealth(value as NonNullable<typeof health>))
      .catch(() => {
        if (!controller.signal.aborted)
          setHealth({ error: '服务检查失败，请刷新重试。' });
      });
    return () => controller.abort();
  }, [tab, wb.refreshing]);
  const select = (next: Tab, id = '') => {
    setTab(next);
    setSelected(id);
    setRequestedTask('');
    const query = new URLSearchParams({ tab: next });
    if (id) query.set('item', id);
    history.pushState(null, '', `/advanced?${query}`);
  };
  const visible = wb.items.filter(
    (item) => filter === 'all' || item.state === filter,
  );
  const item = selected
    ? wb.items.find(
        (entry) => entry.id === selected || entry.taskIds?.includes(selected),
      )
    : visible[0];
  const tasks = wb.tasks.filter((task) => item?.taskIds?.includes(task.id));
  const resultTaskId = requestedTask || tasks.at(-1)?.id;
  return (
    <main className="wb-page wb-advanced">
      <div className="wb-page-heading">
        <div>
          <div className="wb-eyebrow">WORKBENCH / MANAGEMENT</div>
          <h1>工作台管理</h1>
          <p>检查服务、继续制作、查看游戏交付，或整理本机数据。</p>
        </div>
        {tab !== 'deliveries' && <button
          className="wb-button"
          disabled={wb.refreshing}
          onClick={() => void wb.refresh()}
        >
          {wb.refreshing ? '刷新中…' : '刷新状态'}
        </button>}
      </div>
      <div
        className="wb-management-tabs"
        role="tablist"
        aria-label="工作台管理"
      >
        {tabs.map(([id, label]) => (
          <button
            key={id}
            id={`tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            className="wb-button"
            onClick={() => select(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
      >
        {tab === 'services' && (
          <>
            <div className="wb-service-grid">
              <article className="wb-management-card">
                <h2>任务服务</h2>
                <strong>
                  {wb.runtimeOnline === null
                    ? '正在检查'
                    : wb.runtimeOnline
                      ? '已连接'
                      : '未连接'}
                </strong>
                <p>负责后台任务、制作记录和产物读取。</p>
                {wb.runtimeOnline === false && (
                  <p>请启动本地任务服务后刷新。已有浏览器草稿仍可继续编辑。</p>
                )}
              </article>
              <article className="wb-management-card">
                <h2>序列帧服务</h2>
                <p>
                  作业接口：
                  {wb.spriteOnline === null
                    ? '正在检查'
                    : wb.spriteOnline
                      ? '已连接'
                      : '未连接'}
                </p>
                <p>
                  编辑界面：
                  {!health
                    ? '正在检查'
                    : health.error
                      ? '无法确认'
                      : health.uiReady
                        ? '已就绪'
                        : '尚未就绪'}
                </p>
                <p>
                  图片生成配置：
                  {!health || health.error
                    ? '无法确认'
                    : health.pixellabConfigured
                      ? '已配置'
                      : '尚未配置'}
                </p>
                {health?.error && <p role="alert">{health.error}</p>}
                {health && !health.error && !health.uiReady && (
                  <p>
                    接口可用时，编辑界面仍可能未启动。请启动完整序列帧服务后刷新。
                  </p>
                )}
              </article>
            </div>
            <div className="wb-tool-links">
              {wb.modules.map((module) => (
                <a className="wb-button" key={module.id} href={module.href}>
                  打开{module.shortName}
                </a>
              ))}
              <button
                className="wb-button"
                onClick={() => { window.dispatchEvent(new Event('workbench:restart-guide')); wb.setGuideOpen(true); }}
              >
                查看制作引导
              </button>
            </div>
          </>
        )}
        {tab === 'records' && (
          <>
            <div className="wb-record-filters" aria-label="筛选制作记录">
              {[
                ['all', '全部'],
                ['running', '进行中'],
                ['attention', '待处理'],
                ['completed', '已完成'],
                ['saved', '已保存'],
                ['editing', '编辑中'],
              ].map(([id, label]) => (
                <button
                  className="wb-button"
                  key={id}
                  aria-pressed={filter === id}
                  onClick={() => {
                    setFilter(id);
                    select('records');
                  }}
                >
                  {label} ·{' '}
                  {id === 'all'
                    ? wb.items.length
                    : wb.items.filter((entry) => entry.state === id).length}
                </button>
              ))}
            </div>
            {(wb.runtimeOnline === false || wb.spriteOnline === false) && (
              <p className="wb-notice">
                部分服务未连接，记录可能不是最新状态。
                <button
                  className="wb-text-button"
                  onClick={() => select('services')}
                >
                  检查服务
                </button>
              </p>
            )}
            <div className="wb-task-layout">
              <section aria-label="全部制作记录">
                <h2>全部制作记录</h2>
                {visible.map((entry) => (
                  <button
                    className="wb-task-button"
                    key={entry.id}
                    aria-pressed={item?.id === entry.id}
                    onClick={() => select('records', entry.id)}
                  >
                    <strong>{entry.title}</strong>
                    <span>
                      {
                        wb.modules.find(
                          (module) => module.id === entry.capabilityId,
                        )?.shortName
                      }{' '}
                      · {workStateLabels[entry.state]}
                    </span>
                    <small>{time(entry.updatedAt)}</small>
                  </button>
                ))}
                {!visible.length && (
                  <p className="wb-muted">此分类暂无制作记录。</p>
                )}
              </section>
              <section className="wb-task-detail" aria-label="制作详情">
                <h2>{item?.title || '制作详情'}</h2>
                {resultTaskId && <TaskResultCard key={resultTaskId} taskId={resultTaskId} />}
                {item ? (
                  <>
                    <p>
                      {workStateLabels[item.state]} · {time(item.updatedAt)}
                    </p>
                    <p>
                      {tasks.some((task) => task.error || task.refreshError)
                        ? '执行遇到问题，请进入制作工具处理；具体原因见技术详情。'
                        : item.detail}
                    </p>
                    {item.state === 'attention' && (
                      <p className="wb-notice">
                        请检查服务配置或在制作工具中查看待处理内容。
                      </p>
                    )}
                    {!item.href.startsWith('/advanced') && (
                      <a className="wb-button" href={item.href}>
                        {item.state === 'completed'
                          ? '查看制作成果'
                          : '继续制作'}
                      </a>
                    )}
                    <h3>制作成果</h3>
                    {item.outputs?.map((output) => (
                      <a
                        className="wb-artifact"
                        key={output}
                        href={`/api/workbench/artifacts?path=${encodeURIComponent(output)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {output.split(/[\\/]/).pop()}
                      </a>
                    ))}
                    {!item.outputs?.length && (
                      <p className="wb-muted">
                        {item.draftKey
                          ? '草稿保存在此浏览器中，可继续制作后导出。'
                          : item.id.startsWith('sprite:')
                            ? '在序列帧工具中预览和导出素材。'
                            : '尚无导出文件。'}
                      </p>
                    )}
                    {tasks.length > 0 && (
                      <>
                        <h3>执行步骤</h3>
                        {tasks.map((task) => (
                          <p key={task.id}>
                            {operationLabel(task.input?.operation)} ·{' '}
                            {task.status === 'completed'
                              ? '已完成'
                              : task.status === 'running'
                                ? '进行中'
                                : task.status === 'prepared'
                                  ? '已准备，尚未执行'
                                  : task.status === 'awaiting_configuration'
                                    ? '等待配置'
                                    : '需要处理'}
                          </p>
                        ))}
                      </>
                    )}
                    <details className="wb-technical">
                      <summary>技术详情</summary>
                      <p>记录 ID：{item.id}</p>
                      {tasks.map((task) => (
                        <div key={task.id}>
                          <p>任务 ID：{task.id}</p>
                          {task.requiredEnvironment && (
                            <p>需要配置：{task.requiredEnvironment}</p>
                          )}
                          {(task.error || task.refreshError) && (
                            <p>{task.error || task.refreshError}</p>
                          )}
                          <pre>{JSON.stringify(task, null, 2)}</pre>
                        </div>
                      ))}
                    </details>
                  </>
                ) : (
                  <p className="wb-muted">
                    {selected
                      ? '未找到指定记录。它可能已归档，或对应服务尚未连接。请刷新或选择其他记录。'
                      : '选择一条制作记录查看详情。'}
                  </p>
                )}
              </section>
            </div>
          </>
        )}
        {tab === 'deliveries' && <GameDeliveryHistory />}
        {tab === 'data' && <ClearHistory />}
      </section>
    </main>
  );
}
