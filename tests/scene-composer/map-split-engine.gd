extends SceneTree
var checks := 0
var failures: Array = []
var captures: Array = []
var physics_checks: Array = []
var render_checks: Array = []
var settings: Dictionary
var camera: Camera2D

func _initialize() -> void:
	call_deferred("run")

func check(value: bool, message: String) -> void:
	checks += 1
	if not value:
		failures.append(message)
		push_error(message)

func frames() -> void:
	for index in range(4):
		await physics_frame
		await process_frame

func vector(value: Dictionary) -> Vector2:
	return Vector2(value.x, value.y)

func color_distance(a: Color, b: Color) -> float:
	return Vector3(a.r, a.g, a.b).distance_to(Vector3(b.r, b.g, b.b))

func collision_at(body: StaticBody2D, position: Vector2) -> bool:
	var query := PhysicsPointQueryParameters2D.new()
	query.position = position
	query.collision_mask = body.collision_layer
	query.collide_with_bodies = true
	query.collide_with_areas = false
	for hit in body.get_world_2d().direct_space_state.intersect_point(query, 64):
		if hit.collider == body:
			return true
	return false

func any_collision_at(body: StaticBody2D, position: Vector2) -> bool:
	var query := PhysicsPointQueryParameters2D.new()
	query.position = position
	query.collision_mask = 0xffffffff
	query.collide_with_bodies = true
	query.collide_with_areas = false
	return not body.get_world_2d().direct_space_state.intersect_point(query, 1).is_empty()

func expected_overlap(position: Vector2, owner_id: String) -> bool:
	for polygon in settings.mapCollisionPolygons:
		var points := PackedVector2Array()
		for point in polygon:
			points.append(vector(point))
		if Geometry2D.is_point_in_polygon(position, points):
			return true
	for element in settings.elements:
		if element.id == owner_id or not element.collision.enabled:
			continue
		for polygon in element.collision.polygons:
			var points := PackedVector2Array()
			for point in polygon:
				points.append(vector(point) + vector(element.position))
			if Geometry2D.is_point_in_polygon(position, points):
				return true
	return false

func capture(label: String) -> void:
	if not settings.rendered:
		return
	await RenderingServer.frame_post_draw
	var image := root.get_texture().get_image()
	check(image != null and not image.is_empty(), "Native viewport image exists")
	if image == null or image.is_empty():
		return
	DirAccess.make_dir_recursive_absolute("res://captures")
	var filename := "captures/" + label + ".png"
	check(image.save_png("res://" + filename) == OK, "Native viewport capture saved")
	captures.append(filename)

func solid_pixel(image: Image) -> Vector2i:
	if image.is_compressed():
		image.decompress()
	var step_x := maxi(1, image.get_width() / 64)
	var step_y := maxi(1, image.get_height() / 64)
	for y in range(1, image.get_height() - 1, step_y):
		for x in range(1, image.get_width() - 1, step_x):
			if image.get_pixel(x, y).a > 0.98 and image.get_pixel(x-1, y).a > 0.98 and image.get_pixel(x+1, y).a > 0.98 and image.get_pixel(x, y-1).a > 0.98 and image.get_pixel(x, y+1).a > 0.98:
				return Vector2i(x, y)
	return Vector2i(-1, -1)

func verify_render_planes(level: Node2D, actor: Node2D) -> void:
	if not settings.rendered:
		return
	# Exercise both sides of the same movable object when the map contains one.
	var candidates: Array = settings.elements.duplicate()
	for element in settings.elements:
		var planes := {}
		for part in element.parts:
			if part.enabled and part.role == "art":
				planes[part.plane] = true
		if element.kind == "object" and planes.has("front") and planes.has("back"):
			candidates.erase(element)
			candidates.push_front(element)
			break
	for plane in ["back", "front"]:
		var target: Sprite2D = null
		var sample := Vector2i(-1, -1)
		var source_color := Color.WHITE
		for element in candidates:
			if target != null or element.kind != "object":
				continue
			for part in element.parts:
				if part.plane != plane or not part.enabled or part.role != "art":
					continue
				var sprite := level.get_node(NodePath(element.id + "/Part_" + part.id)) as Sprite2D
				var image := sprite.texture.get_image()
				var pixel := solid_pixel(image)
				if pixel.x >= 0:
					target = sprite
					sample = pixel
					source_color = image.get_pixelv(pixel)
					break
		if target == null:
			render_checks.append({"plane": plane, "verified": false, "reason": "No enabled object art with an opaque interior sample"})
			continue
		var visibility: Dictionary = {}
		for child in level.get_children():
			if child is CanvasItem and child != actor and child != target.get_parent():
				visibility[child] = child.visible
				child.visible = false
		for child in target.get_parent().get_children():
			if child is Sprite2D:
				visibility[child] = child.visible
				child.visible = child == target
		for child in actor.get_children():
			if child is CanvasItem:
				visibility[child] = child.visible
				child.visible = false
		var marker := Polygon2D.new()
		marker.polygon = PackedVector2Array([Vector2(-20,-20), Vector2(20,-20), Vector2(20,20), Vector2(-20,20)])
		marker.color = Color.MAGENTA if color_distance(source_color, Color.MAGENTA) > 0.5 else Color.YELLOW
		actor.add_child(marker)
		var world := target.to_global(Vector2(sample) + Vector2(0.5, 0.5))
		marker.global_position = world
		var camera_position := camera.position
		var camera_zoom := camera.zoom
		camera.position = world
		camera.zoom = Vector2(2, 2)
		await process_frame
		await RenderingServer.frame_post_draw
		var rendered := root.get_texture().get_image()
		var actual := rendered.get_pixel(rendered.get_width() / 2, rendered.get_height() / 2)
		var distance := color_distance(actual, marker.color)
		check(distance < 0.05 if plane == "back" else distance > 0.1, "Native rendered " + plane + " pixels draw on the correct side of ActorSlot")
		render_checks.append({"plane": plane, "verified": true, "part": str(target.get_path()), "actorColor": marker.color.to_html(), "sampleColor": actual.to_html(), "markerDistance": distance})
		await capture("plane-" + plane)
		marker.queue_free()
		for child in visibility:
			child.visible = visibility[child]
		camera.position = camera_position
		camera.zoom = camera_zoom
		await process_frame

func run() -> void:
	settings = JSON.parse_string(FileAccess.get_file_as_string("res://acceptance.json"))
	var packed := load(settings.scene) as PackedScene
	check(packed != null, "Scene resource imports")
	if packed == null:
		quit(1)
		return
	var level := packed.instantiate() as Node2D
	root.add_child(level)
	await frames()
	var actor := level.get_node("ActorSlot") as Node2D
	check(actor.z_index == settings.actorZIndex, "ActorSlot keeps the shared display rank")
	for id in settings.originalMapLayerIds:
		check(level.get_node_or_null(NodePath(id)) == null, "Original map pixels are not redrawn: " + id)
	var map_body := level.get_node("MapCollisions") as StaticBody2D
	check(map_body.get_child_count() == settings.mapCollisionIndices.size(), "Transferred map collisions occur only at their owner")
	for index in settings.mapCollisionIndices:
		check(map_body.has_node("Collision_" + str(int(index))), "Untransferred map collision remains")
	if settings.rendered:
		camera = Camera2D.new()
		camera.position = vector(settings.mapPosition) + Vector2(settings.mapWidth, settings.mapHeight) / 2.0
		var zoom := minf(1280.0 / settings.mapWidth, 900.0 / settings.mapHeight)
		camera.zoom = Vector2(zoom, zoom)
		level.add_child(camera)
		camera.make_current()
		var marker := Polygon2D.new()
		marker.color = Color("ffff00")
		marker.polygon = PackedVector2Array([Vector2(-14,-14), Vector2(14,-14), Vector2(14,30), Vector2(-14,30)])
		for element in settings.elements:
			if element.kind == "object":
				marker.position = vector(element.position) + Vector2(6, 0)
				break
		actor.add_child(marker)
	await capture("initial")
	await verify_render_planes(level, actor)
	var captured_move := false
	for expected in settings.elements:
		var object := level.get_node_or_null(NodePath(expected.id)) as Node2D
		check(object != null, "Independent complete element exists: " + expected.id)
		if object == null:
			continue
		check(object.get_script() == null, "Split scenery carries no default interaction script")
		check(object.get_meta("forge_element_id", "") == expected.id, "Stable element ID survives export")
		check(object.position.is_equal_approx(vector(expected.position)), "Map origin, offset and element position apply exactly once")
		var old_positions: Dictionary = {}
		var old_body_position := Vector2.ZERO
		for part in expected.parts:
			var sprite := object.get_node_or_null("Part_" + part.id) as Sprite2D
			check(sprite != null, "Editable part remains addressable: " + part.id)
			if sprite == null:
				continue
			check(sprite.get_meta("forge_part_id", "") == part.id, "Stable part ID survives")
			check(not sprite.z_as_relative and sprite.z_index == part.zIndex, "Part has shared global Z")
			check(sprite.z_index > actor.z_index if part.plane == "front" else sprite.z_index < actor.z_index, "Part straddles player on the requested plane")
			check(sprite.position.is_equal_approx(vector(part)), "Part position is relative to its complete element")
			check(sprite.texture != null and sprite.texture.get_width() == part.width and sprite.texture.get_height() == part.height, "Part texture loads at original dimensions")
			check(sprite.visible == part.enabled, "Part/effect enable state survives")
			old_positions[part.id] = sprite.global_position
			if part.role == "effect":
				sprite.visible = not part.enabled
				check(sprite.visible != part.enabled, "Effect can be independently toggled")
				sprite.visible = part.enabled
		var body := object.get_node_or_null("CollisionBody") as StaticBody2D
		var probe := Vector2.ZERO
		var has_probe := false
		var clear_probe := false
		var bounds := Rect2()
		var first := true
		if body:
			old_body_position = body.global_position
			check(body.get_child_count() == expected.collision.polygons.size(), "All simplified collision polygons belong to the parent")
			for shape in body.get_children():
				check(shape is CollisionPolygon2D and shape.disabled == not expected.collision.enabled, "Collision enable state survives")
				for point in shape.polygon:
					bounds = Rect2(point, Vector2.ZERO) if first else bounds.expand(point)
					first = false
				if not clear_probe:
					var triangles := Geometry2D.triangulate_polygon(shape.polygon)
					for triangle in range(0, triangles.size(), 3):
						var point: Vector2 = shape.to_global((shape.polygon[triangles[triangle]] + shape.polygon[triangles[triangle + 1]] + shape.polygon[triangles[triangle + 2]]) / 3.0)
						if not has_probe or not expected_overlap(point, expected.id):
							probe = point
							has_probe = true
							clear_probe = not expected_overlap(point, expected.id)
						if clear_probe:
							break
			if has_probe:
				check(collision_at(body, probe) == expected.collision.enabled, "Physics state matches simplified collision flag")
		var original := object.position
		var delta := Vector2(maxf(bounds.size.x + 101.0, 143.0), maxf(bounds.size.y + 103.0, 129.0))
		object.position += delta
		await frames()
		for part in expected.parts:
			var sprite := object.get_node("Part_" + part.id) as Sprite2D
			check(sprite.global_position.is_equal_approx(old_positions[part.id] + delta), "Parent move carries every art/effect fragment")
		if body:
			check(body.global_position.is_equal_approx(old_body_position + delta), "Parent move carries its physics body")
			if has_probe:
				check(not collision_at(body, probe), "No owner collision remains at its old position")
				var old_position_clear = null
				if clear_probe:
					old_position_clear = not any_collision_at(body, probe)
					check(old_position_clear, "Original position is clear of all map and object collision")
				check(collision_at(body, probe + delta) == expected.collision.enabled, "Collision moves with complete element")
				for shape in body.get_children():
					shape.set_deferred("disabled", false)
				await frames()
				check(collision_at(body, probe + delta), "Simplified collision can be enabled in engine")
				for shape in body.get_children():
					shape.set_deferred("disabled", true)
				await frames()
				check(not collision_at(body, probe + delta), "Simplified collision can be disabled in engine")
				physics_checks.append({"elementId": expected.id, "moved": true, "oldPositionClear": old_position_clear, "oldPositionProbe": {"x": probe.x, "y": probe.y}, "overlappingExpectedTerrain": not clear_probe, "enabled": true, "disabled": true})
		if not captured_move and expected.kind == "object":
			await capture("moved-object")
			captured_move = true
		object.position = original
		if body:
			for shape in body.get_children():
				shape.set_deferred("disabled", not expected.collision.enabled)
		await frames()
	var file := FileAccess.open("res://engine-report.json", FileAccess.WRITE)
	file.store_string(JSON.stringify({"checks": checks, "failures": failures, "captures": captures, "physics": physics_checks, "renderPlanes": render_checks}, "\t"))
	file.close()
	print("MAP_SPLIT_ENGINE_TESTS %d checks, %d failures" % [checks, failures.size()])
	level.queue_free()
	await process_frame
	quit(0 if failures.is_empty() else 1)
