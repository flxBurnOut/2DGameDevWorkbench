import React, {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {WorkbenchProvider} from '../../components/workbench/workbench-provider';
import {MotionStageReview} from '../../components/sprite-generator/motion-stage-review';
import {motionRequest,type MotionWork} from '../../components/sprite-generator/open-motion-model';
import '../../app/globals.css';
import '../../components/workbench/workbench.css';
import '../../components/sprite-generator/open-motion.css';

function Preview(){
  const [work,setWork]=useState<MotionWork|null>(null),[error,setError]=useState('');
  const workId=new URLSearchParams(location.search).get('work')||'';
  useEffect(()=>{void motionRequest<MotionWork>(`open-motion/${workId}`).then(setWork).catch(e=>setError(e.message));},[workId]);
  return <main className="motion-workspace" style={{maxWidth:1080,margin:'0 auto',padding:24}}><h1>Forge · V4 隔离验收</h1><p>实际保存素材的接口验证；没有制作或采用权限。</p>
    {error?<p role="alert">{error}</p>:work?<MotionStageReview work={work} candidate={1} stage={1} readOnly onSaved={setWork}/>:<p>正在读取原素材…</p>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<WorkbenchProvider><Preview/></WorkbenchProvider>);
