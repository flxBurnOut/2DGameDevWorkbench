extends Area2D
## Generalized from copyWorms InteractiveObject.gd / DropItem.gd, bb1581d.
signal focus_entered(context: Dictionary)
signal focus_exited(context: Dictionary)
signal interaction_started(context: Dictionary)
signal interaction_finished(context: Dictionary)
signal interaction_cancelled(context: Dictionary)
signal interaction_completed(context: Dictionary)
signal picked_up(context: Dictionary)
signal toggled(context: Dictionary)
signal sequence_advanced(context: Dictionary)
signal state_changed(context: Dictionary)

@export var definition: Resource
@export var instance_id: String = ""
var config: Dictionary = {}
var runtime: Node
var phase: String = "IDLE"
var enabled: bool = true
var in_range: bool = false
var auto_pending: bool = false
var completed: bool = false
var toggle_state: bool = false
var sequence_index: int = 0
var success_count: int = 0
var _focused: bool = false
var _source: Node
var _has_source: bool = false
var _steps: Array = []
var _step: int = 0
var _waiting: String = ""
var _remaining: float = 0.0
var _cooldown: float = 0.0
var _appearance: Dictionary = {}
var _result_appearance: Dictionary = {}
var _elapsed: float = 0.0
var _feedback_animation: String = ""
var visible_override: Variant = null
@onready var visual: Node2D = $VisualRoot
@onready var sprite: Sprite2D = $VisualRoot/Sprite
@onready var animated: AnimatedSprite2D = $VisualRoot/Animated
@onready var prompt: Label = $PromptAnchor/PromptLabel
@onready var audio: AudioStreamPlayer2D = $AudioStreamPlayer2D

func _enter_tree() -> void:
	call_deferred("_attach_runtime")

func _ready() -> void:
	if definition == null:
		push_error("Workbench Interaction: missing definition")
		set_process(false)
		return
	config = definition.data
	enabled = config.activation.enabled
	toggle_state = config.behavior.initialToggle
	body_entered.connect(_body_changed)
	body_exited.connect(_body_changed)
	animated.animation_finished.connect(_animation_finished)
	animated.frame_changed.connect(_sync_frame_size)
	prompt.hide()
	apply_state({})

func _attach_runtime() -> void:
	if not is_inside_tree() or config.is_empty() or is_instance_valid(runtime):
		return
	var ancestor := get_parent()
	while ancestor != null:
		for child in ancestor.get_children():
			if child.is_in_group("workbench_interaction_runtime"):
				runtime = child
				runtime.register_interactable(self)
				return
		ancestor = ancestor.get_parent()
	push_warning("Workbench Interaction: add InteractionRuntime2D to this level")

func _body_changed(_body: Node2D) -> void:
	call_deferred("refresh_range")

func refresh_range() -> void:
	if not is_instance_valid(runtime) or config.is_empty():
		return
	var source: Node2D = runtime.resolve_actor(config.detection.actorGroup)
	var inside := enabled and is_instance_valid(source) and get_overlapping_bodies().has(source)
	if inside == in_range:
		return
	in_range = inside
	if inside and config.activation.mode == "automatic_enter":
		auto_pending = true
	if not inside:
		auto_pending = false
		if phase == "INTERACTING" and config.activation.cancelOnExit and _has_source:
			cancel_interaction("source_exited")

func can_interact() -> bool:
	return enabled and not completed and phase == "IDLE" and is_inside_tree() and not is_queued_for_deletion()

func request_interaction(source: Node = null) -> bool:
	if not is_instance_valid(runtime) or not can_interact():
		return false
	return runtime.try_interact(self, source)

func set_enabled(value: bool) -> void:
	enabled = value
	if not value:
		auto_pending = false
		set_focused(false)
	call_deferred("refresh_range")

func set_focused(value: bool) -> void:
	if config.is_empty() or _focused == value:
		return
	_focused = value
	prompt.visible = value and can_interact()
	if value:
		var action: String = config.activation.action
		var bindings := InputMap.action_get_events(action)
		var key_label: String = config.activation.key
		if not runtime.uses_fallback_key(action) and not bindings.is_empty():
			key_label = bindings[0].as_text()
		prompt.text = config.content.prompt if not config.content.prompt.is_empty() else ("[" + key_label + "] " + definition.display_name)
		if _feedback_animation.is_empty():
			_play_clip(config.visual.focusAnimation)
	else:
		_restore_appearance()
	var source: Node = runtime.resolve_actor(config.detection.actorGroup) if is_instance_valid(runtime) else null
	var context := _context()
	context.source = source
	if value:
		focus_entered.emit(context)
	else:
		focus_exited.emit(context)

func pointer_contains(world_point: Vector2) -> bool:
	if not is_visible_in_tree():
		return false
	var shape: Dictionary = config.pointer
	var p := to_local(world_point) - Vector2(shape.offset.x, shape.offset.y)
	if shape.type == "circle":
		return p.length_squared() <= float(shape.radius) * float(shape.radius)
	if shape.type == "capsule":
		var r := float(shape.width) / 2.0
		var half_line := maxf(0, float(shape.height) / 2.0 - r)
		return Vector2(p.x, maxf(absf(p.y) - half_line, 0)).length_squared() <= r * r
	return absf(p.x) <= float(shape.width) / 2.0 and absf(p.y) <= float(shape.height) / 2.0

func begin_interaction(source: Node) -> void:
	_restore_appearance()
	phase = "INTERACTING"
	_source = source
	_has_source = is_instance_valid(source)
	auto_pending = false
	_step = 0
	_waiting = ""
	_steps = []
	_result_appearance = {}
	var pages: Array = config.content.pages.duplicate()
	var extra: Array = []
	if config.behavior.kind == "toggle":
		var entry: Dictionary = config.behavior.states[0 if toggle_state else 1]
		pages.append_array(entry.pages)
		extra = entry.feedback.duplicate(true)
		_result_appearance = entry.appearance.duplicate(true)
	elif config.behavior.kind == "sequence":
		var entry: Dictionary = config.behavior.entries[sequence_index]
		pages.append_array(entry.pages)
		extra = entry.feedback.duplicate(true)
		_result_appearance = entry.appearance.duplicate(true)
	if not pages.is_empty():
		_steps.append({"type": "show_text", "pages": pages})
	_steps.append_array(config.feedback.duplicate(true))
	_steps.append_array(extra)
	interaction_started.emit(_context())
	if is_instance_valid(self) and is_inside_tree() and phase == "INTERACTING":
		_advance()

func _advance() -> void:
	while phase == "INTERACTING" and _step < _steps.size():
		var step: Dictionary = _steps[_step]
		_step += 1
		match step.type:
			"show_text":
				if not step.pages.is_empty():
					_waiting = "text"
					runtime.dialogue.present(step.pages, config.content.charactersPerSecond, config.activation.action)
					return
			"wait":
				_remaining = step.seconds
				_waiting = "time"
				return
			"play_animation":
				animated.stop()
				if _play_clip(step.animation):
					_feedback_animation = step.animation
					if step.waitForEnd and not animated.sprite_frames.get_animation_loop(step.animation):
						_waiting = "animation"
						return
			"play_audio":
				var stream = definition.assets.get(step.assetId)
				if stream is AudioStream:
					audio.stream = stream
					audio.volume_db = step.volumeDb
					audio.play()
					if step.waitForEnd:
						_waiting = "audio"
						return
	if phase == "INTERACTING":
		_commit()

func resume_text() -> void:
	if phase == "INTERACTING" and _waiting == "text":
		_waiting = ""
		_advance()

func _animation_finished() -> void:
	var was_feedback := not _feedback_animation.is_empty()
	_feedback_animation = ""
	if _waiting == "animation" and phase == "INTERACTING":
		_waiting = ""
		_advance()
	elif was_feedback:
		_restore_appearance()
		if _focused:
			_play_clip(config.visual.focusAnimation)

func _process(delta: float) -> void:
	if config.is_empty():
		return
	_elapsed += delta
	if config.visual.float:
		visual.position.y = config.visual.offset.y + sin(_elapsed * 2) * 5
	if _focused:
		prompt.modulate.a = 0.65 + 0.35 * absf(sin(_elapsed * 4))
	if phase == "COOLDOWN":
		_cooldown = maxf(0, _cooldown - delta)
		if _cooldown <= 0:
			phase = "IDLE"
	elif phase == "INTERACTING":
		if _waiting == "time":
			_remaining -= delta
			if _remaining <= 0:
				_waiting = ""
				_advance()
		elif _waiting == "audio" and not audio.playing:
			_waiting = ""
			_advance()

func _commit() -> void:
	phase = "COMMITTING"
	success_count += 1
	var kind: String = config.behavior.kind
	if kind == "toggle":
		toggle_state = not toggle_state
	elif kind == "sequence":
		if sequence_index + 1 < config.behavior.entries.size():
			sequence_index += 1
		elif config.behavior.onEnd == "loop":
			sequence_index = 0
		elif config.behavior.onEnd == "stop":
			completed = true
	elif kind == "pickup" or not config.behavior.repeat:
		completed = true
	if not _result_appearance.is_empty():
		_appearance = _result_appearance.duplicate(true)
	_restore_appearance(true)
	_save_memory()
	var context := _context()
	if kind == "pickup":
		picked_up.emit(context.duplicate(true))
	elif kind == "toggle":
		toggled.emit(context.duplicate(true))
	elif kind == "sequence":
		sequence_advanced.emit(context.duplicate(true))
	if not is_instance_valid(self) or not is_inside_tree():
		return
	interaction_finished.emit(context.duplicate(true))
	if not is_instance_valid(self) or not is_inside_tree():
		return
	state_changed.emit(_link_context("interaction"))
	if not is_instance_valid(self) or not is_inside_tree():
		return
	if completed:
		interaction_completed.emit(context.duplicate(true))
	if not is_instance_valid(self) or not is_inside_tree():
		return
	_cooldown = config.cooldownSeconds
	phase = "COMPLETED" if completed else ("COOLDOWN" if _cooldown > 0 else "IDLE")
	_source = null
	if is_instance_valid(runtime):
		runtime.release_interaction(self)
	_apply_completion()

func cancel_interaction(reason: String = "cancelled") -> void:
	if phase != "INTERACTING":
		return
	_waiting = ""
	_steps.clear()
	audio.stop()
	animated.stop()
	_restore_appearance()
	phase = "IDLE"
	var context := _context()
	context.reason = reason
	_source = null
	if is_instance_valid(runtime):
		runtime.release_interaction(self)
	interaction_cancelled.emit(context)

func _context() -> Dictionary:
	return {"definitionId": definition.definition_id, "instanceId": effective_instance_id(), "source": _source if is_instance_valid(_source) else null, "kind": config.behavior.kind, "result": get_state()}

func get_state() -> Dictionary:
	return {"completed": completed, "toggleState": toggle_state, "sequenceIndex": sequence_index, "successCount": success_count}

func get_link_state() -> Dictionary:
	var result := get_state()
	result.enabled = enabled
	result.visible = bool(visible_override if visible_override != null else _appearance.get("visible", config.visual.visible)) and not (completed and config.completion != "remain")
	result.solidEnabled = bool(_appearance.get("solidEnabled", config.solid.enabled)) and not (completed and config.completion != "remain")
	return result

func _link_context(reason: String = "link", link_id: String = "") -> Dictionary:
	var context := _context()
	context.result = get_link_state()
	context.reason = reason
	if not link_id.is_empty():
		context.linkId = link_id
	return context

## Typed scene-link setters change state without replaying interaction success.
func set_link_value(action: String, value: bool, emit_changed: bool = true) -> bool:
	if config.is_empty() or not is_inside_tree() or is_queued_for_deletion():
		return false
	var before := get_link_state()
	match action:
		"set_toggle":
			if config.behavior.kind != "toggle" or toggle_state == value:
				return false
			toggle_state = value
			_appearance = config.behavior.states[1 if value else 0].appearance.duplicate(true)
			_restore_appearance()
			_save_memory()
		"set_enabled":
			set_enabled(value)
		"set_visible":
			visible_override = value
			_restore_appearance(true)
		_:
			return false
	var changed := before != get_link_state()
	if changed and emit_changed:
		publish_link_state()
	return changed

func publish_link_state(reason: String = "link", link_id: String = "") -> void:
	state_changed.emit(_link_context(reason, link_id))

func reset_state() -> void:
	cancel_interaction("reset")
	apply_state({})
	_save_memory()

func apply_state(snapshot: Dictionary) -> void:
	if config.is_empty():
		return
	cancel_interaction("restore")
	enabled = config.activation.enabled
	visible_override = null
	completed = bool(snapshot.get("completed", false))
	toggle_state = bool(snapshot.get("toggleState", config.behavior.initialToggle))
	sequence_index = clampi(int(snapshot.get("sequenceIndex", 0)), 0, config.behavior.entries.size() - 1)
	success_count = maxi(0, int(snapshot.get("successCount", 0)))
	_cooldown = 0
	phase = "COMPLETED" if completed else "IDLE"
	_appearance = {}
	if config.behavior.kind == "toggle":
		_appearance = config.behavior.states[1 if toggle_state else 0].appearance.duplicate(true)
	elif config.behavior.kind == "sequence" and success_count > 0:
		var previous := maxi(0, sequence_index - 1)
		if completed or (config.behavior.onEnd == "stay_last" and success_count >= config.behavior.entries.size()):
			previous = config.behavior.entries.size() - 1
		elif config.behavior.onEnd == "loop" and sequence_index == 0:
			previous = config.behavior.entries.size() - 1
		_appearance = config.behavior.entries[previous].appearance.duplicate(true)
	show()
	_restore_appearance()
	_apply_completion()

func _restore_appearance(preserve_feedback: bool = false) -> void:
	if not is_instance_valid(visual):
		return
	var asset_id: String = _appearance.get("assetId", "")
	if asset_id.is_empty():
		asset_id = config.visual.assetId
	var texture = definition.assets.get(asset_id)
	sprite.texture = texture if texture is Texture2D else null
	if sprite.texture:
		sprite.scale = Vector2(config.visual.width, config.visual.height) / sprite.texture.get_size()
	sprite.visible = sprite.texture != null
	$VisualRoot/Placeholder.visible = sprite.texture == null
	visual.visible = visible_override if visible_override != null else _appearance.get("visible", config.visual.visible)
	visual.modulate = Color(_appearance.get("tint", config.visual.tint))
	var solid_enabled: bool = get_link_state().solidEnabled
	$SolidBody/SolidShape.set_deferred("disabled", not solid_enabled)
	if preserve_feedback and not _feedback_animation.is_empty():
		sprite.hide()
		$VisualRoot/Placeholder.hide()
		return
	_feedback_animation = ""
	animated.hide()
	animated.stop()
	var animation: String = _appearance.get("animation", "")
	if animation.is_empty() and not _appearance.get("staticImage", false):
		animation = config.visual.idleAnimation
	_play_clip(animation)

func _play_clip(name: String) -> bool:
	if name.is_empty() or not animated.sprite_frames or not animated.sprite_frames.has_animation(name):
		return false
	animated.show()
	sprite.hide()
	$VisualRoot/Placeholder.hide()
	animated.play(name)
	_sync_frame_size()
	return true

func _sync_frame_size() -> void:
	if config.is_empty() or not animated.sprite_frames.has_animation(animated.animation):
		return
	var texture := animated.sprite_frames.get_frame_texture(animated.animation, animated.frame)
	if texture:
		animated.scale = Vector2(config.visual.width, config.visual.height) / texture.get_size()

func _apply_completion() -> void:
	if not completed:
		return
	prompt.hide()
	if config.completion == "hide" or config.completion == "free":
		hide()
		$SolidBody/SolidShape.set_deferred("disabled", true)
	if config.completion == "free":
		queue_free()

func effective_instance_id() -> String:
	if not instance_id.is_empty():
		return instance_id
	return str(runtime.get_parent().get_path_to(self)) if is_instance_valid(runtime) else str(get_path())

func _memory_key() -> String:
	return config.memory.slot + "/" + config.memory.namespace + "/" + runtime.level_key() + "/" + effective_instance_id()

func restore_memory() -> void:
	if config.memory.scope != "instance":
		apply_state(runtime.state_store().read_state(_memory_key(), config.memory.scope == "persistent", config.memory.slot))

func _save_memory() -> void:
	if config.memory.scope != "instance" and is_instance_valid(runtime):
		runtime.state_store().write_state(_memory_key(), get_state(), config.memory.scope == "persistent", config.memory.slot)

func _exit_tree() -> void:
	cancel_interaction("object_exited")
	if is_instance_valid(runtime):
		runtime.unregister_interactable(self)
	runtime = null
	_source = null
	in_range = false
	auto_pending = false
	_focused = false
	if is_instance_valid(prompt):
		prompt.hide()
