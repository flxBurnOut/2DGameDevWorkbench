import manifest from './ui-manifest.json';

export type WorkbenchModuleIcon =
  | 'frames'
  | 'interactable'
  | 'interactable-motion'
  | 'reference';

export type WorkbenchModule = {
  id: string;
  executable: boolean;
  name: string;
  shortName: string;
  description: string;
  href: string;
  icon: WorkbenchModuleIcon;
  accent: 'violet' | 'cyan';
  capabilities: readonly string[];
  status: 'ready' | 'beta' | 'planned';
  surface: 'editor' | 'preview';
  productionLine: string;
  entryTitle: string;
  starterHint: string;
  entryActions?: readonly { label: string; href: string }[];
  stages: readonly string[];
  /** Position inside its production line in the header; unset keeps manifest order. */
  navOrder?: number;
};

/**
 * The web shell and Agent runner both derive capabilities from the same
 * machine-readable manifest. Tool logic stays behind adapters/connectors.
 */
export const workbenchModules: readonly WorkbenchModule[] = manifest.modules.filter((capability) => !('embedded' in capability.ui && capability.ui.embedded)).map((capability) => ({
  id: capability.id,
  executable: capability.executable,
  name: capability.name,
  shortName: capability.shortName,
  description: capability.description,
  productionLine: capability.ui.productionLine,
  entryTitle: capability.ui.entryTitle,
  starterHint: capability.ui.starterHint,
  entryActions: ('entryActions' in capability.ui ? capability.ui.entryActions : undefined) as WorkbenchModule['entryActions'],
  stages: capability.ui.stages,
  href: capability.ui.route,
  icon: capability.ui.icon === 'reference' ? 'reference' : capability.ui.icon === 'interactable' ? 'interactable'
    : capability.ui.icon === 'interactable-motion' ? 'interactable-motion' : 'frames',
  navOrder: 'navOrder' in capability.ui && typeof capability.ui.navOrder === 'number' ? capability.ui.navOrder : undefined,
  accent: capability.ui.accent === 'cyan' ? 'cyan' : 'violet',
  capabilities: capability.ui.capabilities,
  status:
    capability.ui.status === 'planned'
      ? 'planned'
      : capability.ui.status === 'beta'
        ? 'beta'
        : 'ready',
  surface: capability.ui.surface === 'editor' ? 'editor' : 'preview',
}));

export const productionLines = manifest.productionLines;
