/* oxlint-disable next/no-img-element -- Fixture displays the immutable source PNG used by real structure components. */
import React, { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkbenchProvider } from '../../components/workbench/workbench-provider';
import { MotionStructure } from '../../components/sprite-generator/motion-structure';
import { MotionTemporalStructure } from '../../components/sprite-generator/motion-temporal-structure';
import { ReferenceArtEditor } from '../../components/reference-art/reference-art-editor';
import { SpriteStudioEntry } from '../../components/sprite-generator/open-motion-studio';
import { blankSpec, type MotionWork } from '../../components/sprite-generator/open-motion-model';
import { workbenchModules } from '../../lib/workbench/modules';
import '../../app/globals.css';
import '../../components/workbench/workbench.css';
import '../../components/sprite-generator/open-motion.css';

function Inspection() {
  const [state, setState] = useState('');
  const refresh = async () => setState(JSON.stringify(await (await fetch('/__fixture/state')).json(), null, 2));
  return <aside style={{ padding: 16 }}><button onClick={() => void refresh()}>刷新验收记录</button><button onClick={() => void fetch('/__fixture/control', { method: 'POST', body: JSON.stringify({ failNext: true }) }).then(refresh)}>让下一次恢复请求失败（验收）</button><button onClick={() => void fetch('/__fixture/control', { method: 'POST', body: JSON.stringify({ delayNextPreview: true }) }).then(refresh)}>延迟下一次历史读取（验收）</button><button onClick={() => void fetch('/__fixture/control', { method: 'POST', body: JSON.stringify({ sourceCurrent: false }) }).then(refresh)}>改变源图片（验收）</button><button onClick={() => void fetch('/__fixture/control', { method: 'POST', body: JSON.stringify({ sourceCurrent: true }) }).then(refresh)}>恢复源图片（验收）</button><pre style={{ whiteSpace: 'pre-wrap' }}>{state}</pre></aside>;
}
function Histories() {
  const save = useCallback(() => {}, []);
  const work = { id: 'cccccccccccccccccccccccccccccccc', revision: 1, spec: { ...blankSpec, character_id: 'fixture_a' }, job: { revision: 1 } } as MotionWork;
  return <div className="motion-studio" style={{ height: 'auto', padding: 24 }}><h1>结构历史隔离验收</h1><p>原图和时序均从版本3开始；所有API均为内存fixture，没有模型或生产数据。</p><section aria-label="原图结构验收"><h2>原图结构</h2><MotionStructure characterId="fixture_a" disabled={false} registerDraftSaver={save} modelConfiguration="fixture" /></section><section aria-label="时序结构验收"><h2>时序结构</h2><MotionTemporalStructure work={work} candidate={1} frame={0} frameSha={'e'.repeat(64)} playing={false} readOnly={false} onFrame={() => {}} onStop={() => {}}><img src="/__fixture/image.png" alt="当前动画原始帧" /></MotionTemporalStructure></section><Inspection /></div>;
}
const content = location.pathname === '/authoring-history' ? <Histories /> : location.pathname.includes('reference-art') ? <><ReferenceArtEditor /><Inspection /></> : <SpriteStudioEntry module={workbenchModules.find(module => module.id === 'sprite-generator')!} />;
createRoot(document.getElementById('root')!).render(<WorkbenchProvider><div className="wb-app"><div className="wb-route">{content}</div></div></WorkbenchProvider>);
