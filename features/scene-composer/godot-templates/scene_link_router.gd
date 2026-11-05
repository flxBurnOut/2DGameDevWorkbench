extends Node
## Bounded scene wiring over the shared interaction runtime, never another engine.
signal link_applied(context: Dictionary)
signal link_skipped(context: Dictionary)
signal link_error(context: Dictionary)

@export var links: Array = []
@export var runtime_path: NodePath = NodePath("../InteractionRuntime")
const MAX_ACTIONS := 256
const EVENT_NAMES := ["toggled", "picked_up", "sequence_advanced", "interaction_finished", "interaction_completed", "state_changed"]
const ACTION_NAMES := ["set_toggle", "set_enabled", "set_visible"]
var runtime: Node
var events: Array = []
var _bindings: Dictionary = {}
var _queue: Array = []
var _scheduled := false
var _flushing := false
var _current_batch := ""
var _serial := 0
var _attempts: Dictionary = {}
var _exhausted: Dictionary = {}
var _stopping := false

func _ready() -> void:
	_stopping = false
	runtime = get_node_or_null(runtime_path)
	if not is_instance_valid(runtime) or not runtime.has_signal("interactable_registered"):
		push_error("Scene links require the shared Workbench interaction runtime.")
		return
	runtime.interactable_registered.connect(_connect_object)
	runtime.interactable_unregistered.connect(_disconnect_object)
	runtime.busy_changed.connect(_on_busy_changed)
	for object in runtime.objects:
		_connect_object(object)

func _connect_object(object: Node) -> void:
	if _stopping or not is_instance_valid(object):
		return
	var instance_id: String = object.effective_instance_id()
	var key := object.get_instance_id()
	if _bindings.has(key):
		return
	var connections: Array = []
	for event_name in EVENT_NAMES:
		var wanted := links.any(func(link): return link.get("enabled", true) and link.get("sourceInstanceId", "") == instance_id and link.get("event", "") == event_name)
		if wanted and object.has_signal(event_name):
			var callback := _on_event.bind(event_name, instance_id, object)
			object.connect(event_name, callback)
			connections.append({"event": event_name, "callback": callback})
	_bindings[key] = {"object": object, "connections": connections}

func _disconnect_object(object: Node) -> void:
	if not is_instance_valid(object):
		return
	var key := object.get_instance_id()
	var record: Dictionary = _bindings.get(key, {})
	for connection in record.get("connections", []):
		if object.is_connected(connection.event, connection.callback):
			object.disconnect(connection.event, connection.callback)
	_bindings.erase(key)

func _on_event(context: Dictionary, event_name: String, source_id: String, source: Node) -> void:
	if _stopping:
		return
	var batch := _current_batch
	if not _flushing:
		if is_instance_valid(source) and source.phase == "COMMITTING":
			batch = "%s:%s" % [source_id, context.get("result", {}).get("successCount", 0)]
		else:
			_serial += 1
			batch = "external:%s" % _serial
	_queue.append({"context": context.duplicate(true), "event": event_name, "sourceId": source_id, "batch": batch})
	_schedule_flush()

func _on_busy_changed(busy: bool) -> void:
	if not busy:
		_schedule_flush()

func _schedule_flush() -> void:
	if _stopping or _scheduled or _flushing or _queue.is_empty():
		return
	_scheduled = true
	call_deferred("_flush")

func _target(instance_id: String) -> Node:
	if not is_instance_valid(runtime):
		return null
	for object in runtime.objects:
		if is_instance_valid(object) and object.is_inside_tree() and not object.is_queued_for_deletion() and object.effective_instance_id() == instance_id:
			if object.completed and object.config.completion == "free":
				return null
			return object
	return null

func _record(kind: String, payload: Dictionary) -> void:
	var entry := payload.duplicate(true)
	entry.type = kind
	entry.name = kind
	events.append(entry)
	if events.size() > 2048:
		events.pop_front()
	match kind:
		"link_applied": link_applied.emit(entry)
		"link_skipped": link_skipped.emit(entry)
		"link_error": link_error.emit(entry)

func _flush() -> void:
	_scheduled = false
	if _stopping or not is_instance_valid(runtime) or is_instance_valid(runtime.active_object):
		return
	_flushing = true
	while not _queue.is_empty() and not _stopping:
		var message: Dictionary = _queue.pop_front()
		_current_batch = message.batch
		if _exhausted.get(_current_batch, false):
			continue
		for link in links:
			if not link.get("enabled", true) or link.get("sourceInstanceId", "") != message.sourceId or link.get("event", "") != message.event:
				continue
			var payload := {"linkId": link.get("id", ""), "instanceId": message.sourceId, "sourceInstanceId": message.sourceId, "targetInstanceId": link.get("targetInstanceId", ""), "action": link.get("action", ""), "value": link.get("value", false)}
			var count := int(_attempts.get(_current_batch, 0))
			if count >= MAX_ACTIONS:
				_exhausted[_current_batch] = true
				payload.reason = "action_limit"
				payload.code = "LINK_ACTION_LIMIT"
				_record("link_error", payload)
				break
			_attempts[_current_batch] = count + 1
			var target := _target(payload.targetInstanceId)
			if target == null:
				payload.reason = "target_unavailable"
				_record("link_skipped", payload)
				continue
			if payload.action not in ACTION_NAMES or (payload.action == "set_toggle" and target.config.behavior.kind != "toggle"):
				payload.reason = "invalid_action_target"
				_record("link_error", payload)
				continue
			var value: Variant = payload.value
			if value is String and value == "source_toggle":
				value = message.context.get("result", {}).get("toggleState", null)
			if not value is bool:
				payload.reason = "invalid_value"
				_record("link_error", payload)
				continue
			payload.value = value
			payload.changed = target.set_link_value(payload.action, value, false)
			payload.targetState = target.get_link_state()
			_record("link_applied", payload)
			if payload.changed and is_instance_valid(target) and target.is_inside_tree() and not target.is_queued_for_deletion():
				target.publish_link_state("link", payload.linkId)
	_flushing = false
	_current_batch = ""
	_attempts.clear()
	_exhausted.clear()

func _exit_tree() -> void:
	_stopping = true
	request_ready()
	_queue.clear()
	for record in _bindings.values().duplicate():
		_disconnect_object(record.object)
	_bindings.clear()
	if is_instance_valid(runtime):
		if runtime.interactable_registered.is_connected(_connect_object):
			runtime.interactable_registered.disconnect(_connect_object)
		if runtime.interactable_unregistered.is_connected(_disconnect_object):
			runtime.interactable_unregistered.disconnect(_disconnect_object)
		if runtime.busy_changed.is_connected(_on_busy_changed):
			runtime.busy_changed.disconnect(_on_busy_changed)
	runtime = null
