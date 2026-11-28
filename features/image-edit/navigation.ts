export interface ImageEditNavigation { editId: string; candidateVersion?: string }
export function readImageEditNavigation(search = window.location.search): ImageEditNavigation | null {
  const params = new URLSearchParams(search), editId = params.get('imageEdit'), candidateVersion = params.get('imageCandidate');
  const valid = (value: string) => /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);
  if (!editId || !valid(editId) || (candidateVersion && !valid(candidateVersion))) return null;
  return { editId, ...(candidateVersion ? { candidateVersion } : {}) };
}
export function clearImageEditNavigation() {
  const url = new URL(window.location.href); url.searchParams.delete('imageEdit'); url.searchParams.delete('imageCandidate');
  window.history.replaceState(window.history.state, '', url);
}
export function imageEditNavigationUrl(href: string, selection: ImageEditNavigation) {
  const url = new URL(href);
  url.searchParams.set('imageEdit', selection.editId);
  url.searchParams.set('imageCandidate', selection.candidateVersion || 'source');
  if (!readImageEditNavigation(url.search)) throw new Error('图片会话链接身份无效。');
  return url.href;
}
export function writeImageEditNavigation(selection: ImageEditNavigation) {
  const href = imageEditNavigationUrl(window.location.href, selection);
  if (href !== window.location.href) window.history.replaceState(window.history.state, '', href);
}
