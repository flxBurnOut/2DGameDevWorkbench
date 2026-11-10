import { productionLines, workbenchModules } from './modules';

export const workbenchDestinations = {
  home: { href: '/', name: '工作台首页' },
  assets: { href: '/assets', name: '资产库' },
  records: { name: '制作记录' },
  help: { name: '帮助' },
  management: { href: '/advanced', name: '工作台管理' },
} as const;

export const workspaceGroups = productionLines.map((line) => ({
  ...line,
  tools: workbenchModules.filter((tool) => tool.productionLine === line.id),
}));

export function currentWorkbenchPage(pathname: string) {
  // Compatibility routes keep their original deep-link parameters and editor.
  const route = pathname === '/tools/map-stitcher-legacy'
    ? '/tools/map-stitcher' : pathname;
  const tool = workbenchModules.find((entry) => entry.href === route);
  const group = workspaceGroups.find((entry) => entry.id === tool?.productionLine || entry.href === route);
  const destination = Object.values(workbenchDestinations).find((entry) => 'href' in entry && entry.href === route);
  return { tool, group, name: tool?.name || group?.name || destination?.name || '工作台' };
}

/** Only asset-library locations can be supplied by a cross-tool return link. */
export function assetReturnHref(search: string): string | undefined {
  const value = new URLSearchParams(search).get('returnTo');
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return;
  for (const char of value) if (char.charCodeAt(0) < 32) return;
  try {
    const url = new URL(value, 'https://forge.invalid');
    if (url.origin === 'https://forge.invalid' && url.pathname === workbenchDestinations.assets.href) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch { /* An invalid source location never becomes a navigation target. */ }
}
