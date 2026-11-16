'use client';
import type { ReactElement, ReactNode } from 'react';
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';

/** Shared delay so moving between neighbouring controls does not re-wait. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delay={400} closeDelay={80}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

/**
 * Hover and focus hint for a control. The trigger keeps its own aria-label;
 * the tooltip only repeats it visually.
 */
export function Tooltip({
  label,
  children,
  side = 'bottom',
}: {
  label: ReactNode;
  children: ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={6} className="z-50">
          <TooltipPrimitive.Popup className="ui-tooltip">{label}</TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
