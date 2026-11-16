import { workbenchModules } from './modules';

const route = (id: string, fallback: string) => workbenchModules.find((module) => module.id === id)?.href || fallback;

/** Both pages read the same open-motion works; the object type picks the default page. */
export const characterMotionRoute = route('sprite-generator', '/tools/sprite-generator');
export const interactableMotionRoute = route('interactable-motion', '/tools/interactable-motion');

export function motionWorkRoute(objectType?: string | null) {
  return objectType === 'interactable' ? interactableMotionRoute : characterMotionRoute;
}
