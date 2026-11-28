'use client';
import { lazy, Suspense, useState, type ComponentProps } from 'react';
import type { AssetImportPicker as Picker } from './asset-import-picker';
import type { AssetPackageImport as PackageImport } from './asset-package-import';

// Dialogs that a page opens on request load on first use.
const LazyPicker = lazy(() =>
  import('./asset-import-picker').then((module) => ({ default: module.AssetImportPicker })),
);
const LazyPackageImport = lazy(() =>
  import('./asset-package-import').then((module) => ({ default: module.AssetPackageImport })),
);

/** Mounted from its first opening onward, so closing keeps the dialog's own exit behavior. */
export function AssetImportPicker(props: ComponentProps<typeof Picker>) {
  const [used, setUsed] = useState(props.open);
  if (props.open && !used) setUsed(true);
  return used ? (
    <Suspense fallback={null}>
      <LazyPicker {...props} />
    </Suspense>
  ) : null;
}

export function AssetPackageImport(props: ComponentProps<typeof PackageImport>) {
  return (
    <Suspense fallback={null}>
      <LazyPackageImport {...props} />
    </Suspense>
  );
}
