import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkbenchProvider } from '../../components/workbench/workbench-provider';
import { WorkbenchChrome } from '../../components/workbench/workbench-chrome';
import { AssetLibrary } from '../../components/workbench/asset-library';
import '../../app/globals.css';
import '../../components/workbench/workbench.css';
createRoot(document.getElementById('root')!).render(<WorkbenchProvider><WorkbenchChrome><AssetLibrary /></WorkbenchChrome></WorkbenchProvider>);
