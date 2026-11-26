import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkbenchProvider, useWorkbench } from '../../components/workbench/workbench-provider';
import { InteractableEditor } from '../../components/interactable-editor/interactable-editor';
import { AssetLibrary } from '../../components/workbench/asset-library';
import '../../app/globals.css';
import '../../components/workbench/workbench.css';

const report = (message: string) => void fetch('/__smoke/client-error', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
window.addEventListener('error', event => report(event.message));
window.addEventListener('unhandledrejection', event => report(String(event.reason)));
const editor = location.pathname === '/assets' ? <AssetLibrary /> : <InteractableEditor />;
function FixtureNavigationStatus() {
  const workbench = useWorkbench();
  return <output data-ui-smoke-navigation style={{ position: 'fixed', bottom: 30, left: 10, zIndex: 9999, color: '#f66' }}>{workbench.navigationError || workbench.storageError}</output>;
}
createRoot(document.getElementById('root')!).render(<WorkbenchProvider>{editor}<FixtureNavigationStatus /></WorkbenchProvider>);
