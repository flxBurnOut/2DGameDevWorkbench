extends SceneTree
var checks := 0
var errors := 0
var captures: Array = []
var physical_checks: Array = []
var settings: Dictionary

func _initialize() -> void:
	call_deferred("run")

func check(value: bool, message: String) -> void:
	checks += 1
	if not value:
		errors += 1
		push_error(message)

func frames(count: int = 4) -> void:
	for index in range(count):
		await physics_frame
		await process_frame

func find_object(runtime: Node, id: String) -> Node:
	for object in runtime.objects:
		if is_instance_valid(object) and object.effective_instance_id() == id:
			return object
	return null

func router_for(level: Node) -> Node:
	for child in level.get_children():
		if child.get_script() and child.get_script().resource_path.ends_with("/scene_link_router.gd"):
			return child
	return null

func collision_at_gate(gate: Node) -> bool:
	var body: StaticBody2D = gate.get_node("SolidBody")
	var shape: CollisionShape2D = gate.get_node("SolidBody/SolidShape")
	var query := PhysicsPointQueryParameters2D.new()
	query.position = shape.global_position
	query.collision_mask = body.collision_layer
	query.collide_with_bodies = true
	query.collide_with_areas = false
	for hit in gate.get_world_2d().direct_space_state.intersect_point(query, 64):
		if hit.collider == body:
			return true
	return false

func matching_actions(router: Node) -> Array:
	return router.events.filter(func(event): return event.type == "link_applied" and event.sourceInstanceId == settings.sourceId and event.targetInstanceId == settings.targetId and event.action == "set_toggle")

func capture(level: Node, label: String) -> void:
	if not settings.rendered:
		return
	await RenderingServer.frame_post_draw
	var image: Image = root.get_texture().get_image()
	check(image != null and not image.is_empty(), "Native renderer produced a viewport image")
	if image == null or image.is_empty():
		return
	DirAccess.make_dir_recursive_absolute("res://captures")
	var filename := "captures/" + label + ".png"
	check(image.save_png("res://" + filename) == OK, "Native viewport capture saved")
	captures.append(filename)

func setup_camera(level: Node) -> void:
	var bounds := Rect2()
	var first := true
	for child in level.get_children():
		if child is Sprite2D and child.texture:
			var rect := Rect2(child.position, child.texture.get_size())
			bounds = rect if first else bounds.merge(rect)
			first = false
	if first:
		return
	var camera := Camera2D.new()
	camera.position = bounds.get_center()
	var zoom := minf(1280.0 / bounds.size.x, 900.0 / bounds.size.y)
	camera.zoom = Vector2(zoom, zoom)
	level.add_child(camera)
	camera.make_current()

func run() -> void:
	settings = JSON.parse_string(FileAccess.get_file_as_string("res://acceptance.json"))
	var packed: PackedScene = load(settings.scene)
	check(packed != null, "Exported scene loads")
	if packed == null:
		quit(1)
		return
	var level: Node = packed.instantiate()
	root.add_child(level)
	setup_camera(level)
	await frames()
	var runtime: Node = level.get_node("InteractionRuntime")
	var router: Node = router_for(level)
	var source: Node = find_object(runtime, settings.sourceId)
	var gate: Node = find_object(runtime, settings.targetId)
	check(is_instance_valid(source) and is_instance_valid(gate) and is_instance_valid(router), "Source, gate and scene router registered")
	if not is_instance_valid(source) or not is_instance_valid(gate) or not is_instance_valid(router):
		quit(1)
		return
	check(runtime.objects.size() == 2, "Exactly two exported interaction instances")
	check(not source.toggle_state and not gate.toggle_state, "Source and gate begin closed")
	check(gate.visual.visible, "Closed gate visual is visible")
	check(collision_at_gate(gate), "Closed gate participates in real physics point queries")
	physical_checks.append({"phase": "closed", "collision": collision_at_gate(gate)})
	await capture(level, "closed")
	router.events.clear()
	var chronology: Array = []
	source.interaction_started.connect(func(_context): chronology.append("interaction_started"))
	source.toggled.connect(func(_context): chronology.append("toggled"))
	source.interaction_finished.connect(func(_context): chronology.append("interaction_finished"))
	source.state_changed.connect(func(_context): chronology.append("state_changed"))
	router.link_applied.connect(func(_context): chronology.append("link_applied"))
	gate.state_changed.connect(func(_context): chronology.append("state_changed"))
	router._connect_object(source)
	router._connect_object(source)
	check(source.request_interaction(), "First source interaction accepted")
	await frames()
	check(source.toggle_state and gate.toggle_state, "Switch event opens linked gate")
	check(not gate.visual.visible, "Open gate visual is hidden")
	check(not collision_at_gate(gate), "Open gate has no actual solid collision")
	physical_checks.append({"phase": "open", "collision": collision_at_gate(gate)})
	check(gate.success_count == 0, "Linked setter never fakes a gate interaction")
	check(matching_actions(router).size() == 1, "Repeated registration never duplicates link execution")
	check(chronology == ["interaction_started", "toggled", "interaction_finished", "state_changed", "link_applied", "state_changed"], "Engine event order matches deterministic simulation")
	await capture(level, "open")
	check(source.request_interaction(), "Second source interaction accepted")
	await frames()
	check(not source.toggle_state and not gate.toggle_state, "Second source event closes gate")
	check(gate.visual.visible and collision_at_gate(gate), "Closed gate restores both visual and physical collision")
	physical_checks.append({"phase": "closed-again", "collision": collision_at_gate(gate)})
	check(matching_actions(router).size() == 2, "One action per successful source interaction")
	var before: int = router.events.size()
	check(not gate.set_link_value("set_toggle", false), "Setting unchanged toggle is a no-op")
	await frames()
	check(router.events.size() == before, "No-op setter emits no further link events")
	check(runtime.active_object == null, "Shared global interaction lock released")
	await capture(level, "closed-again")
	var original_links: Array = router.links.duplicate(true)
	for action in ["set_enabled", "set_visible"]:
		router.links.append({"id": "fixture-" + action, "sourceInstanceId": settings.sourceId, "targetInstanceId": settings.targetId, "event": "toggled", "action": action, "value": false, "enabled": true})
	check(source.request_interaction(), "Flag-link source interaction accepted")
	await frames()
	check(not gate.enabled and not gate.visual.visible, "Typed enable and visibility actions apply to the existing object")
	check(source.request_interaction(), "Close gate while explicit flags remain")
	await frames()
	check(not gate.toggle_state and not gate.visual.visible, "Visibility override survives subsequent toggle commits")
	gate.set_focused(true)
	gate.set_focused(false)
	check(not gate.visual.visible, "Visibility override survives focus restoration")
	gate.reset_state()
	check(gate.enabled and gate.visual.visible and not gate.toggle_state, "Reset clears visibility override and restores initial enable state")
	router.links = original_links
	root.remove_child(level)
	root.add_child(level)
	await frames()
	check(runtime.objects.size() == 2, "Both existing objects re-register after the same level re-enters the tree")
	router.events.clear()
	check(source.request_interaction(), "Reattached source accepts interaction")
	await frames()
	check(gate.toggle_state and matching_actions(router).size() == 1, "Reattached router delivers exactly one action")
	var old_router: WeakRef = weakref(router)
	var old_source: WeakRef = weakref(source)
	check(source.request_interaction(), "Queue source event before unloading")
	level.queue_free()
	await frames()
	check(old_router.get_ref() == null and old_source.get_ref() == null, "Unload frees relay and listeners without stale references")
	level = packed.instantiate()
	root.add_child(level)
	await frames()
	runtime = level.get_node("InteractionRuntime")
	router = router_for(level)
	source = find_object(runtime, settings.sourceId)
	gate = find_object(runtime, settings.targetId)
	check(not gate.toggle_state and source.success_count == 0, "New isolated scene starts without leaked state")
	check(source.request_interaction(), "Reloaded source accepts interaction")
	await frames()
	check(gate.toggle_state and matching_actions(router).size() == 1, "Reloaded links execute once")
	level.queue_free()
	await frames()
	var report := {"checks": checks, "failures": errors, "physics": physical_checks, "captures": captures, "renderingLimitations": [] if settings.rendered else ["Headless run validates physics and signals; it does not produce a rendered gameplay screenshot."]}
	var file := FileAccess.open("res://engine-report.json", FileAccess.WRITE)
	file.store_string(JSON.stringify(report, "\t"))
	file.close()
	print("SCENE_LINK_ENGINE_TESTS ", checks, " checks, ", errors, " failures")
	quit(1 if errors else 0)
