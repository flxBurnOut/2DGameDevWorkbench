'use client';
import { useSyncExternalStore } from 'react';

function subscribe(update: () => void) {
  window.addEventListener('popstate', update);
  return () => window.removeEventListener('popstate', update);
}

export function SourceAssetLink() {
  const search = useSyncExternalStore(
    subscribe,
    () => location.search,
    () => '',
  );
  const from = new URLSearchParams(search).get('returnTo');
  if (!from?.startsWith('/assets')) return null;
  let href: string;
  try {
    const url = new URL(from, location.origin);
    if (url.origin !== location.origin || url.pathname !== '/assets')
      return null;
    href = url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
  return <a href={href}>返回来源资产</a>;
}
