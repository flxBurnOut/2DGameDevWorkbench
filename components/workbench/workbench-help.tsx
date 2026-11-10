'use client';
import { useEffect } from 'react';
import { Archive, ArrowRight, Save } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { currentWorkbenchPage, workbenchDestinations, workspaceGroups } from '@/lib/workbench/navigation';
import { useWorkbench } from './workbench-provider';
import { ModuleIcon } from './module-icon';

const GUIDE_KEY = 'workbench.onboarding.v1';
function dismissGuide() {
  try { localStorage.setItem(GUIDE_KEY, JSON.stringify({ dismissed: true })); } catch { /* Optional device preference. */ }
}

export function Onboarding() {
  const wb = useWorkbench();
  const { setGuideOpen } = wb;
  useEffect(() => {
    let dismissed = false;
    try { dismissed = JSON.parse(localStorage.getItem(GUIDE_KEY) || 'null')?.dismissed === true; } catch { /* Use goal selection when the preference is unreadable. */ }
    if (location.pathname === '/' && !dismissed) setGuideOpen(true);
  }, [setGuideOpen]);
  const close = () => { dismissGuide(); wb.setGuideOpen(false); };
  const start = (href: string) => { close(); void wb.navigate(href); };
  return <Dialog open={wb.guideOpen} onOpenChange={(open) => open ? wb.setGuideOpen(true) : close()}>
    <DialogContent className="wb-dialog wb-guide-dialog">
      <DialogHeader><div className="wb-eyebrow">START YOUR NEXT ASSET</div><DialogTitle>这次想制作什么？</DialogTitle><DialogDescription>选择目标，直接进入工具。之后可从“工作区”切换，或在“帮助”查看当前工具说明。</DialogDescription></DialogHeader>
      {workspaceGroups.map((group) => <section key={group.id} className="wb-goal-group"><h2>{group.name}</h2><div className="wb-guide-choices">
        {group.tools.map((tool) => <button key={tool.id} className="wb-guide-choice" data-accent={tool.accent} onClick={() => start(tool.href)}><ModuleIcon icon={tool.icon} className="size-5" /><strong>{tool.name}</strong><span>{tool.starterHint}</span><ArrowRight size={16} /></button>)}
      </div></section>)}
      <button className="wb-package-goal wb-button" onClick={() => start(`${workbenchDestinations.assets.href}?import=package`)}><Archive size={18} /><span><strong>导入 Forge 素材包</strong><small>已有 Forge 下载包或编辑器源文件？先识别可恢复内容，再确认入库。</small></span><ArrowRight size={16} /></button>
      <div className="wb-guide-actions"><button className="wb-button wb-ghost" onClick={close}>稍后选择</button></div>
    </DialogContent>
  </Dialog>;
}

export function ContextHelp() {
  const wb = useWorkbench();
  const { tool, name } = currentWorkbenchPage(wb.pathname);
  const help = tool?.id === 'sprite-generator'
    ? '选择角色并描述动作，确认方案后开始制作。最近动作只列出当前动作流程；顶部“制作记录”可查看各工具作品。'
    : tool?.id === 'map-stitcher'
      ? '新建地图工程，生成或打开地图原图，也可从资产库选用地图。添加图块和区域后，下载源文件备份或导出 Godot。'
      : tool?.id === 'interactable-editor'
        ? '新建或打开工程，先添加物件外观，再配置状态、行为和碰撞。已有图片、动画和交互物项目可从资产库选用。'
        : tool?.id === 'scene-composer'
          ? '新建或打开场景，先从资产库选用地图和交互物，再摆放实例、配置联动并导出。打开源工程可继续编辑。'
          : tool?.id === 'reference-art'
            ? '描述角色外观并生成原图，检查后采用。已有角色原图也可直接进入角色动画制作。'
            : wb.pathname === '/assets'
              ? '在资产库搜索、筛选并查看素材详情。导入 Forge 素材包会先检查可恢复内容；从编辑器选用素材会保留来源。'
              : '从“工作区”选择制作工具，从资产库复用素材，或打开“制作记录”继续已有作品。';
  const session = wb.sessions.find((entry) => entry.capabilityId === tool?.id);
  const active = session?.items[0];
  const saveState = wb.navigationError || wb.storageError
    ? '当前保存需要处理，请先查看页面错误提示。'
    : session?.busy ? '当前操作进行中，完成后再离开。'
      : tool?.id === 'sprite-generator' && active ? '当前动作任务由本机服务保存；准备表单另存为当前浏览器草稿。'
      : session?.dirty ? '当前修改正在保存，离开前会检查保存结果。'
        : active?.savedAt ? '当前本机草稿已保存。' : '当前还没有可恢复的本机草稿。';
  return <Dialog open={wb.helpOpen} onOpenChange={wb.setHelpOpen}>
    <DialogContent className="wb-dialog wb-help-dialog">
      <DialogHeader><DialogTitle>{name} · 帮助</DialogTitle><DialogDescription>{help}</DialogDescription></DialogHeader>
      {tool && <div className="wb-help-next"><strong>下一步</strong><p>{tool.starterHint}</p><span className="wb-muted">{tool.stages.join(' → ')}</span></div>}
      <div className="wb-guide-materials"><div><Save size={21} /><div><strong>当前保存状态</strong><p>{saveState}</p></div></div></div>
      <dl className="wb-save-locations">
        <dt>本机草稿</dt><dd>保存在当前浏览器，保存成功后可从制作记录恢复；下载源文件可另存备份。</dd>
        <dt>服务端工程</dt><dd>共享地图、场景、交互物工程和动作任务由本机服务保存，按工程版本恢复。</dd>
        <dt>资产库素材</dt><dd>登记已有素材和导入文件，供其他工具选用；浏览器草稿不会自动入库。</dd>
        <dt>Godot 导出</dt><dd>导出是该次工程的交付快照；继续修改后需要重新导出。</dd>
      </dl>
      <div className="wb-guide-actions"><button className="wb-button wb-primary" onClick={() => { wb.setHelpOpen(false); wb.setGuideOpen(true); }}>完整入门 · 选择制作目标<ArrowRight size={15} /></button></div>
    </DialogContent>
  </Dialog>;
}
