// Pure native-frame sampling, shared by the player and offline comparisons.
// No image synthesis, pose interpolation, auto-alignment or state adoption.
export function worldPoint(point, placement) {
  return {
    x: placement.position.x + (point.x - placement.origin.x) * placement.scale * (placement.flip_x ? -1 : 1),
    y: placement.position.y + (point.y - placement.origin.y) * placement.scale,
  };
}

export function localPoint(point, placement) {
  return {
    x: placement.origin.x + (point.x - placement.position.x) / (placement.scale * (placement.flip_x ? -1 : 1)),
    y: placement.origin.y + (point.y - placement.position.y) / placement.scale,
  };
}

export function objectWorldPoint(point, context, state) {
  const layout=context.object_rendering;
  const local=layout?{
    x:layout.offset.x+(point.x/state.width-.5)*layout.width*layout.scale*(layout.flip_x?-1:1),
    y:layout.offset.y+(point.y/state.height-.5)*layout.height*layout.scale*(layout.flip_y?-1:1),
  }:point;
  return worldPoint(local,context.object);
}

export function objectLocalPoint(point, context, state) {
  const local=localPoint(point,context.object),layout=context.object_rendering;
  return layout?{
    x:((local.x-layout.offset.x)/(layout.width*layout.scale*(layout.flip_x?-1:1))+.5)*state.width,
    y:((local.y-layout.offset.y)/(layout.height*layout.scale*(layout.flip_y?-1:1))+.5)*state.height,
  }:local;
}

export function objectAnchorAt(context,state,id,frame) {
  if(state.visible===false)return null;
  const sample=state.anchors.find(a=>a.id===id)?.samples.find(s=>s.frame===frame);
  return sample?.state==='visible'&&sample.point?objectWorldPoint(sample.point,context,state):null;
}

export function objectAt(context, seconds) {
  let id = context.initial_state, start = 0;
  for (const event of context.events) {
    if (event.time > seconds) break;
    id = event.to_state;
    start = event.time;
  }
  const state = context.object_states.find(s => s.id === id);
  const duration = state.frames.reduce((sum, f) => sum + f.duration, 0);
  let tick = Math.max(0, seconds - start) * state.fps;
  tick = state.loop ? tick % duration : Math.min(tick, duration - 1e-8);
  let frame = 0;
  while (frame < state.frames.length - 1 && tick >= state.frames[frame].duration) {
    tick -= state.frames[frame++].duration;
  }
  return { state, frame, image: state.frames[frame], state_started: start };
}

export function sampleAt(source, context, seconds) {
  const time = Math.max(0, Math.min(seconds, source.frames.length / source.fps - 1e-8));
  const frame = Math.floor(time * source.fps + 1e-9);
  return { time, actor: source.frames[frame], object: objectAt(context, time) };
}

export function anchorAt(anchors, id, frame, placement) {
  const anchor = anchors.find(a => a.id === id);
  const sample = anchor?.samples.find(s => s.frame === frame);
  // Missing observations, occlusion and inferred points never become measured
  // contacts. The user's per-frame visible marking is the only manual truth.
  return sample?.state === 'visible' && sample.point ? worldPoint(sample.point, placement) : null;
}

function boundaries(source, context, window) {
  const duration = source.frames.length / source.fps;
  // A zero-width window at the exclusive clip end has no real frame. Do not
  // clamp it backwards and accidentally report the last frame as a contact.
  if (!Number.isFinite(window.start) || !Number.isFinite(window.end) ||
      window.start < 0 || window.end < window.start || window.start >= duration || window.end > duration) return [];
  const points = new Set([window.start, Math.min(window.end, duration)]);
  for (let i = 0; i <= source.frames.length; i++) points.add(i / source.fps);
  const starts = [{ time: 0, to_state: context.initial_state }, ...context.events];
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index], end = Math.min(starts[index + 1]?.time ?? duration, duration);
    if (start.time >= end) continue;
    const state = context.object_states.find(s => s.id === start.to_state);
    const cycle = state.frames.reduce((sum, f) => sum + f.duration / state.fps, 0);
    points.add(start.time);
    for (let round = start.time; round < end; round += cycle) {
      let t = round;
      for (const frame of state.frames) { t += frame.duration / state.fps; if (t < end) points.add(t); }
      if (!state.loop) break;
    }
  }
  const sorted = [...points].filter(t => t >= window.start && t <= window.end && t <= duration).sort((a,b) => a-b);
  // Half-open intervals cover every distinct actor/object frame combination,
  // including a faster object's frames between two actor samples.
  return window.start === window.end ? [window.start] : sorted.slice(0,-1).map((t,i)=>(t + sorted[i+1])/2);
}

export function evaluateInteraction(source, context) {
  return context.relations.map(relation => {
    const samples = boundaries(source, context, relation.window).map(seconds => {
      const sample = sampleAt(source, context, seconds);
      const a = anchorAt(context.actor_anchors, relation.actor_anchor, sample.actor.index, context.actor);
      const b = objectAnchorAt(context,sample.object.state,relation.object_anchor,sample.object.frame);
      let distance = a && b ? Math.hypot(a.x-b.x,a.y-b.y) : null;
      if(relation.kind==='surface_contact') {
        const surface=sample.object.state.surfaces?.find(s=>s.id===relation.object_anchor);
        if(a&&surface&&sample.object.state.visible!==false) {
          const start=objectWorldPoint(surface.start,context,sample.object.state),end=objectWorldPoint(surface.end,context,sample.object.state);
          const dx=end.x-start.x,dy=end.y-start.y,denominator=dx*dx+dy*dy;
          const t=denominator?Math.max(0,Math.min(1,((a.x-start.x)*dx+(a.y-start.y)*dy)/denominator)):0;
          distance=Math.hypot(a.x-start.x-t*dx,a.y-start.y-t*dy);
        } else distance=null;
      }
      const matches = distance === null ? null : relation.kind === 'separated'
        ? distance >= relation.tolerance_px : distance <= relation.tolerance_px;
      return { seconds, actor_frame: sample.actor.index, object_frame: sample.object.frame, state: sample.object.state.id, distance, matches };
    });
    let timing = null;
    if (relation.response_state && relation.response_window) {
      const events = context.events.filter(e => e.to_state === relation.response_state);
      const matching = events.find(e=>e.time >= relation.response_window.start && e.time <= relation.response_window.end);
      const nearest = events.length ? Math.min(...events.map(e=>Math.max(relation.response_window.start-e.time,e.time-relation.response_window.end,0))) : null;
      timing = { matches: !!matching, error_seconds: nearest };
    }
    const known = samples.filter(s=>s.distance !== null);
    const status = samples.some(s=>s.matches === false) || timing?.matches === false ? 'mismatch'
      : samples.length === 0 || known.length !== samples.length ? 'unknown' : 'matched';
    return { id: relation.id, name: relation.name, kind: relation.kind, status, samples, timing,
      max_distance: known.length ? Math.max(...known.map(s=>s.distance)) : null,
      min_distance: known.length ? Math.min(...known.map(s=>s.distance)) : null,
      missing: samples.length-known.length };
  });
}

export function previewBounds(source, context) {
  const points = [...source.frames.flatMap(f=>[worldPoint({x:0,y:0},context.actor),worldPoint({x:f.width,y:f.height},context.actor)]),
    ...context.object_states.flatMap(s=>[objectWorldPoint({x:0,y:0},context,s),objectWorldPoint({x:s.width,y:s.height},context,s)])];
  const x=Math.min(...points.map(p=>p.x))-12, y=Math.min(...points.map(p=>p.y))-12;
  return {x,y,width:Math.max(...points.map(p=>p.x))-x+12,height:Math.max(...points.map(p=>p.y))-y+12};
}
