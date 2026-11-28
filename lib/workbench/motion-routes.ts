import { workbenchModules } from './modules';

const route = (id: string, fallback: string) =>
  workbenchModules.find((module) => module.id === id)?.href || fallback;

/** Both pages read the same open-motion works; the object type picks the default page. */
export const characterMotionRoute = route(
  'sprite-generator',
  '/tools/sprite-generator',
);
export const interactableMotionRoute = route(
  'interactable-motion',
  '/tools/interactable-motion',
);

export function motionWorkRoute(objectType?: string | null) {
  return objectType === 'interactable'
    ? interactableMotionRoute
    : characterMotionRoute;
}

export function interactableMotionHref(
  search: string,
  target: { work?: string; revision?: number; object?: string },
) {
  const query = new URLSearchParams(search);
  if (target.work) {
    query.set('work', target.work);
    query.delete('job');
    if (target.revision !== undefined)
      query.set('version', String(target.revision));
  }
  if (target.object) {
    query.set('object', target.object);
    query.delete('character');
  }
  return interactableMotionRoute + '?' + query;
}
