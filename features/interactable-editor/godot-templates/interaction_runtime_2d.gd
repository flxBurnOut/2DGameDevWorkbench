extends Node
## Nearest eligible selection extracted from copyWorms Level_01.gd (bb1581d).
## No project singleton, player controller or gameplay state dependency.
signal busy_changed(busy: bool)
signal interactable_registered(object: Node)
signal interactable_unregistered(object: Node)
@export var actor: Node2D
@export var shared_state_store: Node
@export var scene_key: String = ""
var objects: Array = []
var focused: Node = null
var active_object: Node = null
var _actors: Dictionary = {}
static var _fallback_actions: Dictionary = {}
@onready var dialogue: Node = $DialoguePresenter

func _enter_tree() -> void:
	add_to_group("workbench_interaction_runtime")

func _ready() -> void:
	dialogue.finished.connect(_text_finished)

func register_interactable(object: Node) -> void:
	if not objects.has(object):
		objects.append(object)
	var config: Dictionary = object.config.activation
	var action := StringName(config.action)
	if not InputMap.has_action(action):
		InputMap.add_action(action)
		_fallback_actions[action] = []
	if uses_fallback_key(action):
		var key := InputEventKey.new()
		key.physical_keycode = OS.find_keycode_from_string(config.key)
		if key.physical_keycode != KEY_NONE and not InputMap.action_has_event(action, key):
			InputMap.action_add_event(action, key)
			_fallback_actions[action].append(key.physical_keycode)
	object.restore_memory()
	interactable_registered.emit(object)

func uses_fallback_key(action: StringName) -> bool:
	if not _fallback_actions.has(action):
		return false
	# A game can remap an action after this runtime first created it.
	var bindings := InputMap.action_get_events(action)
	var installed: Array = _fallback_actions[action]
	return bindings.size() == installed.size() and bindings.all(func(binding):
		return binding is InputEventKey and installed.has(binding.get_physical_keycode_with_modifiers()))

func accepts_activation(event: InputEvent, activation: Dictionary) -> bool:
	if not event.is_action_pressed(activation.action):
		return false
	if event is InputEventKey and uses_fallback_key(activation.action):
		var key: Key = event.physical_keycode if event.physical_keycode != KEY_NONE else event.keycode
		return key == OS.find_keycode_from_string(activation.key)
	return true

func unregister_interactable(object: Node) -> void:
	objects.erase(object)
	if focused == object:
		focused = null
	if active_object == object:
		release_interaction(object)
	interactable_unregistered.emit(object)

func resolve_actor(group: String) -> Node2D:
	if is_instance_valid(actor):
		return actor
	var cached = _actors.get(group)
	if is_instance_valid(cached) and cached.is_inside_tree() and cached.is_in_group(group):
		return cached
	var candidates := get_tree().get_nodes_in_group(group).filter(func(n): return n is PhysicsBody2D and get_parent().is_ancestor_of(n))
	candidates.sort_custom(func(a, b): return str(a.get_path()) < str(b.get_path()))
	var found: Node2D = candidates[0] if not candidates.is_empty() else null
	_actors[group] = found
	return found

func _physics_process(_delta: float) -> void:
	objects = objects.filter(func(o): return is_instance_valid(o) and o.is_inside_tree())
	for object in objects.duplicate():
		object.refresh_range()
	if is_instance_valid(active_object):
		_set_focus(null)
		return
	var candidates := objects.filter(func(o): return o.can_interact() and o.in_range and o.config.activation.mode == "proximity_press")
	candidates.sort_custom(_nearer)
	_set_focus(candidates[0] if not candidates.is_empty() else null)
	var pending := objects.filter(func(o): return o.auto_pending and o.in_range and o.can_interact())
	pending.sort_custom(_nearer)
	if not pending.is_empty():
		pending[0].request_interaction(resolve_actor(pending[0].config.detection.actorGroup))

func _nearer(a: Node2D, b: Node2D) -> bool:
	var ap := int(a.config.detection.priority)
	var bp := int(b.config.detection.priority)
	if ap != bp:
		return ap > bp
	var source_a := resolve_actor(a.config.detection.actorGroup)
	var source_b := resolve_actor(b.config.detection.actorGroup)
	var ad := a.global_position.distance_squared_to(source_a.global_position if is_instance_valid(source_a) else Vector2.ZERO)
	var bd := b.global_position.distance_squared_to(source_b.global_position if is_instance_valid(source_b) else Vector2.ZERO)
	return str(a.get_path()) < str(b.get_path()) if is_equal_approx(ad, bd) else ad < bd

func _set_focus(object: Node) -> void:
	if focused == object:
		return
	if is_instance_valid(focused):
		focused.set_focused(false)
	focused = object
	if is_instance_valid(focused):
		focused.set_focused(true)

func _unhandled_input(event: InputEvent) -> void:
	if event.is_echo():
		return
	if is_instance_valid(active_object):
		if dialogue.is_open() and (accepts_activation(event, active_object.config.activation) or event.is_action_pressed("ui_accept")):
			get_viewport().set_input_as_handled()
			dialogue.advance()
		return
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		var hits := objects.filter(func(o): return o.can_interact() and o.config.activation.mode == "pointer_click" and o.pointer_contains(o.get_global_mouse_position()))
		hits.sort_custom(func(a, b): return a.z_index > b.z_index if a.z_index != b.z_index else _nearer(a, b))
		if not hits.is_empty() and hits[0].request_interaction():
			get_viewport().set_input_as_handled()
	elif is_instance_valid(focused) and accepts_activation(event, focused.config.activation):
		if focused.request_interaction(resolve_actor(focused.config.detection.actorGroup)):
			get_viewport().set_input_as_handled()

func try_interact(object: Node, source: Node) -> bool:
	if is_instance_valid(active_object) or not objects.has(object) or not object.can_interact():
		return false
	active_object = object
	_set_focus(null)
	busy_changed.emit(true)
	if is_instance_valid(object) and object.is_inside_tree():
		object.begin_interaction(source)
	return true

func release_interaction(object: Node) -> void:
	if active_object != object:
		return
	active_object = null
	if is_instance_valid(dialogue):
		dialogue.close()
	busy_changed.emit(false)

func _text_finished() -> void:
	if is_instance_valid(active_object):
		active_object.resume_text()

func state_store() -> Node:
	return shared_state_store if is_instance_valid(shared_state_store) else $InteractionStateStore

func level_key() -> String:
	if not scene_key.is_empty():
		return scene_key
	var root: Node = get_parent()
	return root.scene_file_path if not root.scene_file_path.is_empty() else str(root.get_path())

func _exit_tree() -> void:
	for object in objects.duplicate():
		if is_instance_valid(object):
			object.cancel_interaction("runtime_exited")
	objects.clear()
	_actors.clear()
	focused = null
	active_object = null
