'use client';
import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Radio } from 'lucide-react';
import { getEditorSessions, saveBeforeNavigation } from '@/lib/workbench/editor-session';
import { followDecision, previewSnapshotPath } from '@/lib/workbench/preview-follow-client.mjs';
import manifest from '@/lib/workbench/ui-manifest.json';

type Step = { id: string; viewPath: string; title: string; summary: string; expiresAt: number };
type Ack = { requestId: string; state: 'displayed' | 'navigating' | 'paused' | 'blocked'; reason?: 'editing' | 'busy' | 'save-failed' | 'user-paused' | 'page-arrived' };
const KEY = 'forge.agent-follow.v1';
// Hidden pages never navigate; they only keep their connection (server TTL 20 s).
// Visible pages answer a pending Agent step quickly and otherwise check less often.
const ACTIVE_POLL_MS = 1500;
const VISIBLE_POLL_MS = 3000;
const HIDDEN_POLL_MS = 8000;
function read(key: string) { try { return sessionStorage.getItem(key); } catch { return null; } }
function store(key: string, value: string) { try { sessionStorage.setItem(key, value); } catch { /* This page still works without persistent preferences. */ } }

export function AgentFollow() {
  const [step, setStep] = useState<Step | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [message, setMessage] = useState('');
  const following = useRef(true);
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;
    let navigating = false;
    let editedAt = 0;
    let held = '';
    let pending = false;
    let active = read(KEY + '.active') === 'true';
    let acknowledged = read(KEY + '.handled') || '';
    const incomingSession = new URL(location.href).searchParams.get('previewSession');
    if (incomingSession && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(incomingSession)) store(KEY + '.session', incomingSession);
    const sessionId = read(KEY + '.session') || undefined;
    const pageId = read(KEY + '.page') || crypto.randomUUID();
    store(KEY + '.page', pageId);
    following.current = read(KEY) !== 'paused';
    setEnabled(following.current);
    let ack: Ack | undefined;
    const pause = () => {
      if (!active) return;
      following.current = false;
      setEnabled(false);
      store(KEY, 'paused');
      setMessage('已暂停页面跟随');
    };
    const onInput = () => { editedAt = Date.now(); };
    const snapshot = () => {
      const sessions = getEditorSessions();
      return { pageId, ...(sessionId ? { sessionId } : {}), viewPath: previewSnapshotPath(location.href), visible: document.visibilityState === 'visible',
        focused: document.hasFocus(), following: following.current,
        dirty: sessions.some((s) => s.dirty), busy: sessions.some((s) => s.busy),
        items: sessions.flatMap((s) => s.items.map((i) => ({ id: i.id.slice(0, 200), title: i.title.slice(0, 160), capabilityId: s.capabilityId.slice(0, 80) }))).slice(0, 12),
      };
    };
    const send = async (value?: Ack): Promise<{ request: Step | null }> => {
      const response = await fetch('/api/workbench/frontend', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...snapshot(), ...(value ? { ack: value } : {}) }),
        signal: AbortSignal.timeout(6000), cache: 'no-store' });
      if (!response.ok) throw new Error('Page connection failed');
      return response.json();
    };
    const tick = async () => {
      if (inFlight || navigating || stopped) return;
      inFlight = true;
      try {
        const { request } = await send(ack);
        ack = undefined;
        pending = Boolean(request && request.expiresAt >= Date.now());
        if (!request || stopped || document.visibilityState !== 'visible' || request.expiresAt < Date.now()) return;
        const target = new URL(request.viewPath, location.origin);
        const routes = ['/', '/advanced', manifest.assetCatalogRoute, ...manifest.productionLines.map((p) => p.href),
          ...manifest.modules.map((c) => c.ui.route)];
        if (target.origin !== location.origin || !routes.includes(target.pathname)) throw new Error('Invalid page target');
        active = true; store(KEY + '.active', 'true');
        setStep(request);
        const current = snapshot();
        const decision = followDecision({ currentPath: current.viewPath, targetPath: request.viewPath, following: following.current,
          busy: current.busy, editing: Date.now() - editedAt < 2000, handled: acknowledged === request.id });
        if (decision === 'ignore') return;
        if (decision === 'displayed') {
          ack = { requestId: request.id, state: 'displayed', reason: 'page-arrived' };
          acknowledged = request.id;
          store(KEY + '.handled', request.id);
          setMessage('正在展示当前步骤');
        } else if (decision === 'paused') {
          ack = { requestId: request.id, state: 'paused', reason: 'user-paused' };
          setMessage('已暂停页面跟随');
        } else if (decision === 'busy' || decision === 'editing') {
          ack = { requestId: request.id, state: 'blocked', reason: decision };
          setMessage(decision === 'busy' ? '当前工具正在处理，稍后切换' : '正在编辑，暂缓切换');
        } else if (held !== request.id) {
          try {
            await saveBeforeNavigation();
            if (stopped || !following.current || document.visibilityState !== 'visible') return;
            if (Date.now() - editedAt < 2000 || getEditorSessions().some((s) => s.dirty || s.busy)) return;
            const latest = await send({ requestId: request.id, state: 'navigating' });
            if (latest.request?.id !== request.id || stopped || !following.current) return;
            navigating = true;
            window.location.assign(target.href);
            return;
          } catch {
            held = request.id;
            ack = { requestId: request.id, state: 'blocked', reason: 'save-failed' };
            setMessage('保存未完成，已保留当前页面；处理后点击继续');
          }
        }
        await send(ack);
        ack = undefined;
      } catch {
        if (!stopped) setMessage('页面跟随暂未连接，正在重连');
      } finally {
        inFlight = false;
        if (!stopped && !navigating)
          timer = setTimeout(() => void tick(), document.visibilityState !== 'visible' ? HIDDEN_POLL_MS : pending ? ACTIVE_POLL_MS : VISIBLE_POLL_MS);
      }
    };
    retry.current = () => { held = ''; clearTimeout(timer); void tick(); };
    const onVisibility = () => { if (document.visibilityState === 'visible' && !inFlight) { clearTimeout(timer); void tick(); } };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('workbench:manual-navigation', pause);
    window.addEventListener('popstate', pause);
    document.addEventListener('input', onInput, true);
    void tick();
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener('workbench:manual-navigation', pause);
      window.removeEventListener('popstate', pause); document.removeEventListener('input', onInput, true);
      document.removeEventListener('visibilitychange', onVisibility); };
  }, []);
  if (!step) return null;
  return <aside className="wb-agent-follow" aria-label="Agent 工作进度">
    <div className="wb-agent-follow-heading"><Radio size={15} /><strong>{step.title}</strong>
      <button type="button" onClick={() => {
        following.current = !following.current; setEnabled(following.current); store(KEY, following.current ? 'following' : 'paused'); retry.current();
      }}>{enabled ? <Pause size={14} /> : <Play size={14} />}{enabled ? '暂停跟随' : '继续跟随'}</button>
    </div>
    <p>{step.summary}</p>
    <output>{message}</output>
    {message.includes('保存未完成') && <button type="button" onClick={() => retry.current()}>继续</button>}
  </aside>;
}
