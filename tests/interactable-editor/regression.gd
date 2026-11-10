extends SceneTree
var errors: int = 0
var checks: int = 0
var level: Node2D
var runtime: Node
var signals_seen: Array = []

func check(value: bool, message: String) -> void:
	checks += 1
	if not value:
		errors += 1
		push_error(message)

func _initialize() -> void:
	call_deferred("run")

func object(kind: String, changes: Dictionary = {}, stable_id: String = "") -> Node:
	var packed = load("res://addons/workbench_interaction/objects/test-" + kind + "/object.tscn")
	check(packed is PackedScene, "scene loads: " + kind)
	if packed == null:
		return null
	var obj = packed.instantiate()
	obj.instance_id = stable_id
	if not changes.is_empty():
		obj.definition = obj.definition.duplicate(true)
		for key in changes:
			if changes[key] is Dictionary:
				obj.definition.data[key].merge(changes[key], true)
			else:
				obj.definition.data[key] = changes[key]
	level.add_child(obj)
	return obj

func frames(count: int = 3) -> void:
	for i in range(count):
		await physics_frame
		await process_frame

func press(action: String = "workbench_interact") -> void:
	var event := InputEventAction.new()
	event.action = action
	event.pressed = true
	Input.parse_input_event(event)
	await process_frame
	event = InputEventAction.new()
	event.action = action
	event.pressed = false
	Input.parse_input_event(event)
	await process_frame

func run() -> void:
	level = Node2D.new()
	root.add_child(level)
	runtime = load("res://addons/workbench_interaction/runtime/v1/interaction_runtime_2d.tscn").instantiate()
	runtime.scene_key = "test-level"
	level.add_child(runtime)
	var inspect = object("inspect")
	var toggle = object("toggle")
	var pickup = object("pickup")
	var other_pickup = object("pickup")
	var sequence = object("sequence")
	await frames()
	check(inspect.definition.display_name == "中文 \"物件\" 0\n第二行", "unicode and quotes preserved")
	check(inspect.request_interaction(), "inspect accepted")
	check(inspect.success_count == 1 and not inspect.completed, "repeat inspect")
	check(inspect.request_interaction(), "inspect repeated")
	check(inspect.sprite.scale == Vector2(4.0, 8.0), "static texture dimensions match the editor")
	check(toggle.request_interaction() and toggle.toggle_state, "toggle on")
	check(toggle.request_interaction() and not toggle.toggle_state, "toggle off")
	pickup.picked_up.connect(func(context): signals_seen.append(context))
	check(pickup.definition == other_pickup.definition, "instances share config")
	check(pickup.request_interaction() and pickup.completed, "pickup completes")
	check(not pickup.request_interaction(), "pickup idempotent")
	check(signals_seen.size() == 1 and not pickup.visible, "pickup emits once and hides")
	pickup.set_link_value("set_visible", true)
	await frames()
	check(not pickup.get_link_state().solidEnabled and pickup.get_node("SolidBody/SolidShape").disabled, "Visibility link cannot revive a collected solid")
	check(not other_pickup.completed, "shared resource independent instances")
	check(sequence.request_interaction() and sequence.sequence_index == 1, "sequence advances")
	check(sequence.request_interaction() and sequence.completed, "sequence completes")
	var loop = object("sequence", {"behavior": {"onEnd": "loop"}})
	var stay = object("sequence", {"behavior": {"onEnd": "stay_last"}})
	var cooldown = object("inspect", {"cooldownSeconds": 0.1})
	await frames()
	loop.request_interaction()
	loop.request_interaction()
	check(not loop.completed and loop.sequence_index == 0, "sequence loops")
	stay.request_interaction()
	stay.request_interaction()
	stay.request_interaction()
	check(not stay.completed and stay.sequence_index == 1 and stay.success_count == 3, "sequence stays last")
	cooldown.request_interaction()
	check(not cooldown.request_interaction() and cooldown.phase == "COOLDOWN", "cooldown gates input")
	await create_timer(0.14).timeout
	check(cooldown.request_interaction(), "cooldown expires")
	await create_timer(0.14).timeout
	var player := CharacterBody2D.new()
	var pointer_a = object("inspect", {"activation": {"mode": "pointer_click"}, "behavior": {"repeat": false}})
	var pointer_b = object("inspect", {"activation": {"mode": "pointer_click"}, "behavior": {"repeat": false}})
	pointer_a.z_index = 5
	pointer_b.z_index = 2
	await frames()
	var click := InputEventMouseButton.new()
	click.button_index = MOUSE_BUTTON_LEFT
	click.pressed = true
	click.position = Vector2.ZERO
	Input.parse_input_event(click)
	await frames()
	check(pointer_a.success_count == 1 and pointer_b.success_count == 0, "pointer without actor selects topmost once")
	pointer_b.set_enabled(false)
	player.collision_layer = 1
	player.collision_mask = 0
	var collider := CollisionShape2D.new()
	collider.shape = CircleShape2D.new()
	collider.shape.radius = 8
	player.add_child(collider)
	player.add_to_group("interaction_actor")
	level.add_child(player)
	var near = object("inspect", {"activation": {"mode": "proximity_press"}})
	var far = object("inspect", {"activation": {"mode": "proximity_press", "key": "F"}})
	near.position.x = 15
	far.position.x = 35
	await frames(5)
	check(runtime.focused == near and near.prompt.visible and not far.prompt.visible, "unique nearest focus")
	await press()
	check(near.success_count == 1 and far.success_count == 0, "one input one object")
	near.set_enabled(false)
	await frames()
	check(runtime.focused == far, "disabled excluded")
	for keycode in [KEY_E, KEY_F]:
		var key := InputEventKey.new()
		key.physical_keycode = keycode
		key.pressed = true
		runtime._unhandled_input(key)
		check(far.success_count == (1 if keycode == KEY_F else 0), "Each object responds to its own fallback key")
	var remapped := InputEventKey.new()
	remapped.physical_keycode = KEY_G
	InputMap.action_add_event("workbench_interact", remapped)
	remapped.pressed = true
	check(runtime.accepts_activation(remapped, far.config.activation), "Game remapping takes precedence over generated fallback keys")
	InputMap.action_erase_event("workbench_interact", remapped)
	far.set_enabled(false)
	var masked = object("inspect", {"activation": {"mode": "proximity_press"}, "detection": {"mask": 2}})
	masked.collision_mask = 2
	await frames()
	check(not masked.in_range, "physics mask respected")
	masked.set_enabled(false)
	var automatic = object("inspect", {"activation": {"mode": "automatic_enter"}})
	await frames(5)
	check(automatic.success_count == 1, "automatic initial overlap")
	await frames(5)
	check(automatic.success_count == 1, "standing still never retriggers")
	player.position.x = 1000
	await frames()
	player.position.x = 0
	await frames(5)
	check(automatic.success_count == 2, "automatic reentry")
	automatic.set_enabled(false)
	var text_object = object("inspect", {"content": {"pages": ["第一页：中文", "第二页：完成"], "charactersPerSecond": 0}})
	await frames()
	text_object.request_interaction(player)
	check(runtime.dialogue.is_open() and runtime.dialogue.label.text == "第一页：中文", "text displayed")
	check(not inspect.request_interaction(), "global busy lock")
	await press()
	check(runtime.dialogue.is_open() and runtime.dialogue.label.text == "第二页：完成", "input advances one page")
	await press()
	check(not runtime.dialogue.is_open() and text_object.success_count == 1, "close input never reopens object")
	var cancel = object("inspect", {"activation": {"cancelOnExit": true}, "feedback": [{"type": "wait", "seconds": 5.0}]})
	await frames()
	cancel.request_interaction(player)
	player.position.x = 1000
	await frames(5)
	check(cancel.phase == "IDLE" and cancel.success_count == 0 and runtime.active_object == null, "exit cancels before commit")
	var media = object("inspect", {"feedback": [{"type": "play_animation", "animation": "burst", "waitForEnd": true}, {"type": "play_audio", "assetId": "sound", "volumeDb": -20.0, "waitForEnd": true}]})
	await frames()
	check(media.sprite.texture is Texture2D, "texture dependency loads")
	check(media.animated.sprite_frames.get_frame_count("burst") == 2, "sprite frames exported")
	media.request_interaction()
	check(media.phase == "INTERACTING", "media awaits feedback")
	await create_timer(0.6).timeout
	check(media.success_count == 1 and media.phase == "IDLE", "animation and audio finish")
	var concurrent = object("inspect", {"feedback": [{"type": "play_animation", "animation": "burst", "waitForEnd": false}]})
	await frames()
	concurrent.request_interaction()
	check(concurrent.success_count == 1 and concurrent.animated.visible and concurrent.animated.is_playing(), "nonblocking animation survives commit")
	await create_timer(0.16).timeout
	check(not concurrent.animated.visible and concurrent.sprite.visible, "feedback restores appearance after completion")
	var typewriter = object("inspect", {"content": {"pages": ["打字机测试"], "charactersPerSecond": 1}})
	await frames()
	typewriter.request_interaction()
	await press()
	check(runtime.dialogue.is_open() and typewriter.success_count == 0, "first input reveals typewriter page")
	await press()
	check(typewriter.success_count == 1 and not runtime.dialogue.is_open(), "second input completes typewriter page")
	var callback_pickup = object("pickup")
	var callback_acceptance: Array = []
	callback_pickup.picked_up.connect(func(_context):
		callback_acceptance.append(callback_pickup.request_interaction())
		callback_acceptance.append(inspect.request_interaction())
		callback_pickup.queue_free())
	await frames()
	callback_pickup.request_interaction()
	await frames()
	check(callback_acceptance == [false, false] and not is_instance_valid(callback_pickup) and runtime.active_object == null, "callbacks cannot reenter and free releases busy lock")
	var freed = object("pickup", {"completion": "free", "feedback": [{"type": "wait", "seconds": 0.05}]})
	await frames()
	freed.request_interaction()
	check(is_instance_valid(freed) and not freed.is_queued_for_deletion(), "free waits for feedback")
	await create_timer(0.12).timeout
	check(not is_instance_valid(freed), "free finishes safely")
	var persistent = object("pickup", {"memory": {"scope": "persistent", "slot": "test"}}, "persistent-id")
	await frames()
	persistent.request_interaction()
	persistent.queue_free()
	await frames()
	var replacement_store = load("res://addons/workbench_interaction/runtime/v1/interaction_state_store.gd").new()
	root.add_child(replacement_store)
	runtime.shared_state_store = replacement_store
	var restored = object("pickup", {"memory": {"scope": "persistent", "slot": "test"}}, "persistent-id")
	restored.picked_up.connect(func(context): signals_seen.append(context))
	await frames()
	check(restored.completed and not restored.visible and signals_seen.size() == 1, "persistent restore without replay")
	var session = object("pickup", {"memory": {"scope": "session"}}, "session-id")
	await frames()
	session.request_interaction()
	var old_level := level
	level = Node2D.new()
	root.add_child(level)
	var runtime2 = load("res://addons/workbench_interaction/runtime/v1/interaction_runtime_2d.tscn").instantiate()
	runtime2.scene_key = "test-level"
	runtime2.shared_state_store = replacement_store
	level.add_child(runtime2)
	var session_restored = object("pickup", {"memory": {"scope": "session"}}, "session-id")
	await frames()
	check(session_restored.runtime == runtime2 and session_restored.completed, "session shares explicit root store")
	check(not runtime.objects.has(session_restored), "scopes stay isolated")
	replacement_store.clear_session()
	var fresh = object("pickup", {"memory": {"scope": "session"}}, "session-id")
	await frames()
	check(not fresh.completed, "new session resets")
	level.queue_free()
	old_level.queue_free()
	replacement_store.queue_free()
	await frames()
	print("INTERACTION_TESTS ", checks, " checks, ", errors, " failures")
	quit(1 if errors else 0)
