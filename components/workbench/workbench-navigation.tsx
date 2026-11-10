'use client';
import type { WorkbenchModule } from '@/lib/workbench/modules';
import { SharedWorkbenchNavigation } from './shared-navigation';

/** Compatibility export. All navigation is owned by the shared Forge chrome. */
export function WorkbenchNavigation(_props: { modules: readonly WorkbenchModule[] }) {
  return <SharedWorkbenchNavigation />;
}
