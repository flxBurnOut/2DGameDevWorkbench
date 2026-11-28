'use client';
import {createContext} from 'react';
import type {WorkbenchActions, WorkbenchState} from './workbench-provider';

// Keep the context identity outside the provider's refresh boundary. Editor changes
// must not give the RSC provider and its client consumers different contexts.
export const workbenchContext=createContext<WorkbenchState|null>(null);
// Stable callbacks only. Large editors read these without re-rendering on every status poll.
export const workbenchActionsContext=createContext<WorkbenchActions|null>(null);
