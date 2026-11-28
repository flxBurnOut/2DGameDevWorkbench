'use client';
import { lazy, Suspense, useEffect, useState } from 'react';
import type { GodotExportOffer } from '@/lib/workbench/godot-export';

// The export dialog and its ZIP reader load on the first export request.
const GodotExportDialog = lazy(() =>
  import('./godot-export-dialog').then((module) => ({ default: module.GodotExportDialog })),
);

export function GodotExportHost() {
  const [first, setFirst] = useState<GodotExportOffer | null>(null);
  useEffect(() => {
    if (first) return;
    const receive = (event: Event) => setFirst((event as CustomEvent<GodotExportOffer>).detail);
    window.addEventListener('forge:godot-export', receive);
    return () => window.removeEventListener('forge:godot-export', receive);
  }, [first]);
  return first ? (
    <Suspense fallback={null}>
      <GodotExportDialog initialOffer={first} />
    </Suspense>
  ) : null;
}
