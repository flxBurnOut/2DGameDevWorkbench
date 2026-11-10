export interface GameDelivery {
  deliveryId: string;
  title: string;
  kind: string;
  status: string;
  project: { path: string; name: string };
  createdAt: string;
  updatedAt: string;
  inboxPath: string;
  packageSha256: string;
  packageId: string;
  package?: { kind: string; details: Record<string, unknown> };
  integration?: {
    summary: string;
    files?: { path: string; sha256: string }[];
    engine: { status: string; version?: string; evidence?: string; baselineValidated?: boolean };
  } | null;
}

export interface GameDeliveryPage {
  deliveries: GameDelivery[];
  total: number;
  nextOffset: number | null;
  snapshot: string;
}

export const deliveryStates: Record<string, string> = {
  awaiting_agent: '等待 WorkBuddy 接入',
  assets_installed: '资源已就位，等待代码接入',
  integrated: '代码已接入',
  needs_attention: '接入需要处理',
};
export const deliveryKinds: Record<string, string> = {
  scene: '完整场景', map: '地图', interactable: '交互物', animation: '角色动画',
};

async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(15000);
  const response = await fetch(`/api/workbench/game-export/${path}`, {
    cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || '交付记录暂时无法读取。');
  return body as T;
}

export function readGameDeliveries(input: { pendingOnly?: boolean; offset?: number; snapshot?: string } = {}, signal?: AbortSignal) {
  const query = new URLSearchParams({ pendingOnly: String(input.pendingOnly ?? false), offset: String(input.offset ?? 0), limit: '20' });
  if (input.snapshot) query.set('snapshot', input.snapshot);
  return read<GameDeliveryPage>(`history?${query}`, signal);
}

export function readGameDelivery(deliveryId: string, signal?: AbortSignal) {
  return read<GameDelivery>(`record?${new URLSearchParams({ deliveryId })}`, signal);
}

export function gameDeliveryHref(deliveryId: string) {
  return `/advanced?${new URLSearchParams({ tab: 'deliveries', delivery: deliveryId })}`;
}
