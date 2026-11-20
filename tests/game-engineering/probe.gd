extends SceneTree

const Merge = preload("res://sprite_frames_merge.gd")
var failures: Array[String] = []
var finished: int = 0
var cues: int = 0
var loops: int = 0

func _initialize() -> void:
	_run.call_deferred()

func check(condition: bool, label: String) -> void:
	if not condition:
		failures.append(label)
		printerr("FAILED: " + label)

func wait_for(predicate: Callable) -> bool:
	var until: int = Time.get_ticks_msec() + 3000
	while not predicate.call() and Time.get_ticks_msec() < until:
		await process_frame
	return bool(predicate.call())

func _run() -> void:
	var parent := Node2D.new()
	root.add_child(parent)
	var frames: SpriteFrames = load("res://Assets/Hero/frames.tres")
	check(frames != null, "load SpriteFrames")
	if frames == null:
		quit(1)
		return
	check(frames.get_frame_count(&"attack") == 3, "attack frame count")
	check(is_equal_approx(frames.get_animation_speed(&"attack"), 20.0), "effective fps")
	check(not frames.get_animation_loop(&"attack") and frames.get_animation_loop(&"idle"), "loop contract")
	var atlas: AtlasTexture = frames.get_frame_texture(&"attack", 0) as AtlasTexture
	check(atlas != null and atlas.region == Rect2(32, 0, 32, 32), "non-row-major first atlas region")
	var second: AtlasTexture = frames.get_frame_texture(&"attack", 1) as AtlasTexture
	check(second.region == Rect2(0, 32, 32, 32), "non-row-major second atlas region")
	check(atlas.get_image().get_pixel(8, 8).g > 0.9, "first frame is actual green texture")
	check(second.get_image().get_pixel(8, 8).b > 0.9, "second frame is actual blue texture")
	check(is_equal_approx(frames.get_frame_duration(&"idle", 1), 2.0), "relative duration")
	var original := SpriteFrames.new()
	original.add_animation(&"walk")
	original.add_frame(&"walk", frames.get_frame_texture(&"idle", 0))
	original.add_animation(&"attack")
	original.add_frame(&"attack", frames.get_frame_texture(&"idle", 0))
	original.set_animation_speed(&"attack", 7.0)
	var merged: SpriteFrames = Merge.merge_clips(original, frames)
	check(merged.has_animation(&"walk") and merged.get_frame_count(&"walk") == 1, "partial import preserves unrelated walk")
	check(merged.get_frame_count(&"attack") == 3 and merged.get_animation_speed(&"attack") == 20.0, "partial import replaces selected clip")
	check(original.get_frame_count(&"attack") == 1 and original.get_animation_speed(&"attack") == 7.0, "merge does not mutate source resource")
	check(not frames.has_animation(&"walk"), "merge does not mutate incoming resource")
	var scene: PackedScene = load("res://Assets/Hero/visual.tscn")
	var sprite: AnimatedSprite2D = scene.instantiate() as AnimatedSprite2D
	parent.add_child(sprite)
	sprite.connect("visual_finished", func(_action: StringName): finished += 1)
	sprite.connect("frame_cue", func(_action: StringName, cue: StringName):
		check(cue == &"swing_sound", "explicit cue name")
		cues += 1)
	sprite.animation_looped.connect(func(): loops += 1)
	check(sprite.call("show_action", &"attack"), "start attack")
	check(await wait_for(func():
		sprite.call("show_action", &"attack")
		return finished == 1), "state updates do not restart animation")
	check(sprite.frame == 2 and cues == 1, "one-shot holds last frame and cue fires once")
	check(not sprite.call("show_action", &"missing"), "missing action refused")
	check(sprite.animation == &"attack", "missing action preserves playback")
	sprite.call("show_action", &"attack", true)
	check(await wait_for(func(): return finished == 2), "explicit repeated attack completes")
	check(cues == 2, "repeated attack has one more cue")
	sprite.call("show_action", &"idle")
	check(await wait_for(func(): return loops >= 2), "idle actually loops")
	check(finished == 2, "loop does not send finished event")
	sprite.call("face_right", false)
	check(sprite.flip_h and parent.scale == Vector2.ONE, "facing mirrors visual only")
	check(sprite.offset == Vector2(0, -10), "feet offset preserved")
	sprite.pause()
	var stopped_frame: int = sprite.frame
	await create_timer(0.15).timeout
	check(sprite.frame == stopped_frame, "pause freezes visual")

	parent.queue_free()
	await process_frame
	if failures.is_empty():
		print("ENGINEERING_ENGINE_OK: actual frame playback, restart, cues, pause and clip merge")
	quit(0 if failures.is_empty() else 1)
