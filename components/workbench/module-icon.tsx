import { Film, MousePointerClick, UserRoundPen } from 'lucide-react';
import type { WorkbenchModuleIcon } from '@/lib/workbench/modules';

/** Drawing a character, making it move, making an object respond. */
export function ModuleIcon({
  icon,
  className,
}: {
  icon: WorkbenchModuleIcon;
  className?: string;
}) {
  const Icon = icon === 'reference' ? UserRoundPen : icon === 'interactable' ? MousePointerClick : Film;
  return <Icon aria-hidden="true" className={className} />;
}
