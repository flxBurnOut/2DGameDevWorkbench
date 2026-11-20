import type { ReactNode } from 'react';

import { WorkbenchProvider } from '@/components/workbench/workbench-provider';
import { WorkbenchChrome } from '@/components/workbench/workbench-chrome';
import { ToastProvider } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import '@/components/workbench/workbench.css';

export default function WorkbenchLayout({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <TooltipProvider>
        <WorkbenchProvider><WorkbenchChrome>{children}</WorkbenchChrome></WorkbenchProvider>
      </TooltipProvider>
    </ToastProvider>
  );
}
