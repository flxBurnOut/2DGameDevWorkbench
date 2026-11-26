import { appearanceAnimation } from './contract.mjs';

export function shapeContains(shape, x, y, radius = 0) {
  x -= shape.offset.x;
  y -= shape.offset.y;
  if (shape.type === 'circle') return Math.hypot(x, y) <= shape.radius + radius;
  if (shape.type === 'capsule')
    return (
      Math.hypot(
        x,
        Math.max(
          0,
          Math.abs(y) - Math.max(0, shape.height / 2 - shape.width / 2),
        ),
      ) <=
      shape.width / 2 + radius
    );
  return (
    Math.hypot(
      Math.max(0, Math.abs(x) - shape.width / 2),
      Math.max(0, Math.abs(y) - shape.height / 2),
    ) <= radius
  );
}
export function initialState(o) {
  return {
    completed: false,
    toggleState: o.behavior.initialToggle,
    sequenceIndex: 0,
    successCount: 0,
  };
}
export function committedState(o, state) {
  const s = { ...state, successCount: state.successCount + 1 },
    b = o.behavior;
  if (b.kind === 'toggle') s.toggleState = !s.toggleState;
  else if (b.kind === 'sequence') {
    if (s.sequenceIndex + 1 < b.entries.length) s.sequenceIndex++;
    else if (b.onEnd === 'loop') s.sequenceIndex = 0;
    else if (b.onEnd === 'stop') s.completed = true;
  } else if (b.kind === 'pickup' || !b.repeat) s.completed = true;
  return s;
}
export function stateAppearance(o, state) {
  if (o.behavior.kind === 'toggle')
    return o.behavior.states[state.toggleState ? 1 : 0].appearance;
  if (o.behavior.kind === 'sequence' && state.successCount) {
    const b = o.behavior,
      last = b.entries.length - 1;
    const previous =
      state.completed ||
      (b.onEnd === 'loop' && state.sequenceIndex === 0) ||
      (b.onEnd === 'stay_last' && state.successCount >= b.entries.length)
        ? last
        : Math.max(0, state.sequenceIndex - 1);
    return b.entries[previous].appearance;
  }
  return {};
}
export class InteractionSimulation {
  constructor(objects) {
    this.objects = objects.map((o, i) => ({
      definition: o,
      id: `preview-${i}`,
      x: 320 + i * 24,
      y: 210,
      state: initialState(o),
      cooldown: 0,
      inRange: false,
      pending: false,
      animation: null,
    }));
    this.actor = { x: 100, y: 210 };
    this.focus = null;
    this.active = null;
    this.waiting = null;
    this.events = [];
    this.time = 0;
    for (const i of this.objects) this.restoreAppearance(i);
  }
  playClip(i, name, feedback = false) {
    const clip = i.definition.visual.clips.find((c) => c.name === name);
    if (!clip) return false;
    i.animation = {
      name,
      feedback,
      started: this.time,
      ends: clip.loop
        ? Infinity
        : this.time +
          clip.frames.reduce((sum, f) => sum + f.duration, 0) / clip.fps,
    };
    return true;
  }
  restoreAppearance(i, preserveFeedback = false) {
    if (preserveFeedback && i.animation?.feedback) return;
    i.animation = null;
    this.playClip(
      i,
      appearanceAnimation(stateAppearance(i.definition, i.state), i.definition.visual),
    );
  }
  emit(name, i, extra = {}) {
    this.events.unshift({
      name,
      instanceId: i.id,
      time: this.time,
      result: { ...i.state },
      ...extra,
    });
    this.events.length = Math.min(this.events.length, 100);
  }
  eligible(i) {
    return (
      i.definition.activation.enabled && !i.state.completed && i.cooldown <= 0
    );
  }
  sorted(items) {
    return [...items].sort(
      (a, b) =>
        b.definition.detection.priority - a.definition.detection.priority ||
        Math.hypot(a.x - this.actor.x, a.y - this.actor.y) -
          Math.hypot(b.x - this.actor.x, b.y - this.actor.y) ||
        a.id.localeCompare(b.id),
    );
  }
  tick(delta) {
    // A replay can advance several seconds at once. Finish each timed step
    // at its own time, then give the following step or cooldown the remainder.
    while (this.waiting?.remaining !== undefined && this.waiting.remaining < delta) {
      const elapsed = Math.max(0, this.waiting.remaining);
      this.tickSlice(elapsed);
      delta -= elapsed;
    }
    this.tickSlice(delta);
  }
  tickSlice(delta) {
    this.time += delta;
    for (const i of this.objects) {
      if (i.animation?.feedback && this.time >= i.animation.ends) {
        this.restoreAppearance(i);
        if (this.focus === i)
          this.playClip(i, i.definition.visual.focusAnimation);
      }
      i.cooldown = Math.max(0, i.cooldown - delta);
      const inside =
        i.definition.activation.enabled &&
        (i.definition.detection.mask & 1) !== 0 &&
        shapeContains(
          i.definition.detection.shape,
          this.actor.x - i.x,
          this.actor.y - i.y,
          12,
        );
      if (
        inside &&
        !i.inRange &&
        i.definition.activation.mode === 'automatic_enter'
      )
        i.pending = true;
      if (!inside) {
        i.pending = false;
        if (
          this.active === i &&
          this.sourcePresent &&
          i.definition.activation.cancelOnExit
        )
          this.cancel();
      }
      i.inRange = inside;
    }
    if (this.waiting?.type === 'show_text')
      this.waiting.shown +=
        delta * this.active.definition.content.charactersPerSecond;
    else if (this.waiting?.remaining !== undefined) {
      this.waiting.remaining -= delta;
      if (this.waiting.remaining <= 0) {
        this.waiting = null;
        this.next();
      }
    }
    const next = this.active
      ? null
      : (this.sorted(
          this.objects.filter(
            (i) =>
              this.eligible(i) &&
              i.inRange &&
              i.definition.activation.mode === 'proximity_press',
          ),
        )[0] ?? null);
    if (next !== this.focus) {
      if (this.focus) {
        this.restoreAppearance(this.focus);
        this.emit('focus_exited', this.focus);
      }
      this.focus = next;
      if (next) {
        if (!next.animation?.feedback)
          this.playClip(next, next.definition.visual.focusAnimation);
        this.emit('focus_entered', next);
      }
    }
    if (!this.active) {
      const pending = this.sorted(
        this.objects.filter((i) => i.pending && i.inRange && this.eligible(i)),
      )[0];
      if (pending) this.request(pending, true);
    }
  }
  press() {
    if (this.waiting?.type === 'show_text') this.advanceText();
    else if (this.focus) this.request(this.focus, true);
  }
  click(x, y) {
    const hits = this.sorted(
      this.objects.filter(
        (i) =>
          this.eligible(i) &&
          i.definition.activation.mode === 'pointer_click' &&
          shapeContains(i.definition.pointer, x - i.x, y - i.y),
      ),
    );
    hits.sort(
      (a, b) => b.definition.visual.zIndex - a.definition.visual.zIndex,
    );
    if (hits[0]) this.request(hits[0], false);
  }
  request(i = this.objects[0], source = false) {
    if (this.active || !this.eligible(i)) return false;
    this.active = i;
    if (this.focus) {
      this.restoreAppearance(this.focus);
      this.emit('focus_exited', this.focus);
      this.focus = null;
    }
    this.restoreAppearance(i);
    this.sourcePresent = source;
    i.pending = false;
    const o = i.definition,
      b = o.behavior,
      e =
        b.kind === 'toggle'
          ? b.states[i.state.toggleState ? 0 : 1]
          : b.kind === 'sequence'
            ? b.entries[i.state.sequenceIndex]
            : null;
    const pages = [...o.content.pages, ...(e?.pages ?? [])];
    this.steps = [
      ...(pages.length ? [{ type: 'show_text', pages }] : []),
      ...o.feedback,
      ...(e?.feedback ?? []),
    ];
    this.stepIndex = 0;
    this.emit('interaction_started', i);
    this.next();
    return true;
  }
  next() {
    if (!this.active) return;
    while (this.stepIndex < this.steps.length) {
      const s = this.steps[this.stepIndex++];
      if (s.type === 'show_text' && s.pages.length) {
        this.waiting = { ...s, index: 0, shown: 0 };
        return;
      }
      if (s.type === 'wait') {
        this.waiting = { ...s, remaining: s.seconds };
        return;
      }
      if (s.type === 'play_animation') {
        const clip = this.active.definition.visual.clips.find(
          (c) => c.name === s.animation,
        );
        this.playClip(this.active, s.animation, true);
        this.emit('play_animation', this.active, { animation: s.animation });
        if (clip && s.waitForEnd && !clip.loop) {
          this.waiting = {
            ...s,
            remaining:
              clip.frames.reduce((n, f) => n + f.duration, 0) / clip.fps,
          };
          return;
        }
      }
      if (s.type === 'play_audio' && s.assetId) {
        this.emit('play_audio', this.active, {
          assetId: s.assetId,
          volumeDb: s.volumeDb,
        });
        if (s.waitForEnd) {
          this.waiting = { ...s };
          return;
        }
      }
    }
    const i = this.active;
    i.state = committedState(i.definition, i.state);
    this.restoreAppearance(i, true);
    i.cooldown = i.state.completed ? 0 : i.definition.cooldownSeconds;
    const special = {
      pickup: 'picked_up',
      toggle: 'toggled',
      sequence: 'sequence_advanced',
    }[i.definition.behavior.kind];
    if (special) this.emit(special, i);
    this.emit('interaction_finished', i);
    if (i.state.completed) this.emit('interaction_completed', i);
    this.active = null;
    this.waiting = null;
  }
  finishAudio() {
    if (this.waiting?.type === 'play_audio') {
      this.waiting = null;
      this.next();
    }
  }
  advanceText() {
    const w = this.waiting;
    if (w?.type !== 'show_text') return;
    const page = w.pages[w.index];
    if (
      this.active.definition.content.charactersPerSecond > 0 &&
      w.shown < page.length
    ) {
      w.shown = page.length;
      return;
    }
    w.index++;
    w.shown = 0;
    if (w.index >= w.pages.length) {
      this.waiting = null;
      this.next();
    }
  }
  cancel() {
    if (this.active) {
      this.restoreAppearance(this.active);
      this.emit('interaction_cancelled', this.active, {
        reason: 'source_exited',
      });
    }
    this.active = null;
    this.waiting = null;
  }
  snapshot() {
    return this.objects.map((i) => ({ ...i.state }));
  }
  restore(states) {
    this.cancel();
    for (const [index, i] of this.objects.entries()) {
      i.state = { ...initialState(i.definition), ...states[index] };
      i.cooldown = 0;
      this.restoreAppearance(i);
    }
    this.focus = null;
  }
  moveActor(x, y) {
    this.actor = { x, y };
    this.tick(0);
  }
  reset() {
    this.restore([]);
    this.events = [];
    this.time = 0;
    for (const i of this.objects) this.restoreAppearance(i);
    this.moveActor(100, 210);
  }
}
