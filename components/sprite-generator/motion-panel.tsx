'use client';
import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from '@/components/ui/dialog';

/** Secondary evidence stays off the main production surface. */
export function MotionPanel({title, children}: {title:string;children:ReactNode}) {
  return <Dialog>
    <DialogTrigger className="motion-secondary">{title}</DialogTrigger>
    <DialogContent className="motion-studio motion-detail-panel">
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription className="sr-only">查看详情或使用可选工具；关闭后回到当前动画。</DialogDescription>
      <div className="motion-panel-body">{children}</div>
    </DialogContent>
  </Dialog>;
}
