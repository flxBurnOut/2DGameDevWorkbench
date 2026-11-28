import * as z from 'zod/v4';
import { InteractionSimulation, stateAppearance } from '../interactable-editor/simulator.mjs';
import { normalizeProject } from '../interactable-editor/contract.mjs';

const coordinate = z.number().min(-1e7).max(1e7);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const event = (type, fields = {}) => z.object({ type: z.literal(type), ...fields }).strict();
export const simulationEventSchema = z.discriminatedUnion('type', [
  event('move-actor', { x: coordinate, y: coordinate }), event('tick', { seconds: z.number().min(0).max(60) }), event('press'), event('click', { x: coordinate, y: coordinate }), event('request', { instanceId: id }), event('advance-text'), event('finish-audio'), event('cancel'),
]);
export const simulationEventsSchema = z.array(simulationEventSchema).max(200);
export function createInteractableSimulation(content) {
  const simulation = new InteractionSimulation(normalizeProject(content).objects);
  simulation.objects.forEach(instance => { instance.id = instance.definition.definitionId; });
  return simulation;
}
export function simulationInstanceState(simulation, instanceId) {
  const instance = simulation.objects.find(instance => instance.id === instanceId);
  if (!instance) return null;
  const appearance = stateAppearance(instance.definition, instance.state);
  const completedHidden = instance.state.completed && instance.definition.completion !== 'remain';
  return { ...instance.state, enabled: instance.definition.activation.enabled, visible: Boolean((appearance.visible ?? instance.definition.visual.visible) && !completedHidden), solidEnabled: Boolean((appearance.solidEnabled ?? instance.definition.solid.enabled) && !completedHidden) };
}
export function replaySimulationEvents(simulation, input) {
  const parsed = simulationEventsSchema.parse(input);
  const eventLog = []; let eventCount = 0;
  const originalEmit = simulation.emit;
  simulation.emit = function (...args) {
    originalEmit.apply(this, args); eventCount++;
    if (eventLog.length < 1000) eventLog.push(structuredClone(this.events[0]));
  };
  const steps = [];
  try {
    for (const [index, inputEvent] of parsed.entries()) {
      const step = { index, ...inputEvent };
      if (inputEvent.type === 'move-actor') simulation.moveActor(inputEvent.x, inputEvent.y);
      else if (inputEvent.type === 'tick') simulation.tick(inputEvent.seconds);
      else if (inputEvent.type === 'press') simulation.press();
      else if (inputEvent.type === 'click') simulation.click(inputEvent.x, inputEvent.y);
      else if (inputEvent.type === 'advance-text') simulation.advanceText();
      else if (inputEvent.type === 'finish-audio') simulation.finishAudio();
      else if (inputEvent.type === 'cancel') simulation.cancel();
      else if (inputEvent.type === 'request') {
        const instance = simulation.objects.find(instance => instance.id === inputEvent.instanceId);
        if (!instance) throw Object.assign(new Error('Simulation instance does not exist.'), { status: 400, code: 'SIMULATION_INSTANCE_MISSING' });
        step.accepted = simulation.request(instance);
      }
      step.time = simulation.time;
      steps.push(step);
    }
  } finally { simulation.emit = originalEmit; }
  const events = eventLog, total = eventCount;
  return { simulation, steps, events, eventCount: total, truncated: total > events.length, states: simulation.objects.map(instance => ({ instanceId: instance.id, definitionId: instance.definition.definitionId, state: { ...instance.state }, ...simulationInstanceState(simulation, instance.id), cooldown: instance.cooldown, inRange: instance.inRange })), linkAttempts: 0, linkDiagnostics: [] };
}
