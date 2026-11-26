extends CanvasLayer
signal finished
var _pages: Array = []
var _index: int = 0
var _speed: float = 40.0
var _shown: float = 0.0
var _action: String = "workbench_interact"
@onready var panel: PanelContainer = $Panel
@onready var label: Label = $Panel/Margin/VBox/Text

func _ready() -> void:
	$Panel/Margin/VBox/Next.pressed.connect(advance)
	close()

func present(pages: Array, speed: float, action: String) -> void:
	_pages = pages.duplicate()
	_index = 0
	_speed = speed
	_action = action
	if _pages.is_empty():
		finished.emit()
		return
	panel.show()
	_render()

func is_open() -> bool:
	return is_instance_valid(panel) and panel.visible

func _process(delta: float) -> void:
	if not is_open():
		return
	if _speed > 0:
		_shown += _speed * delta
		label.visible_characters = int(_shown)

func _unhandled_input(event: InputEvent) -> void:
	if not is_open() or event.is_echo():
		return
	# The runtime handles its active object's own key and the project's remaps.
	if get_parent().has_method("accepts_activation") and is_instance_valid(get_parent().get("active_object")):
		return
	if event.is_action_pressed(_action) or event.is_action_pressed("ui_accept"):
		get_viewport().set_input_as_handled()
		advance()

func advance() -> void:
	if not is_open():
		return
	if _speed > 0 and label.visible_characters < label.get_total_character_count():
		_shown = label.get_total_character_count()
		label.visible_characters = -1
		return
	_index += 1
	if _index >= _pages.size():
		close()
		finished.emit()
	else:
		_render()

func _render() -> void:
	label.text = str(_pages[_index])
	_shown = 0
	label.visible_characters = -1 if _speed <= 0 else 0
	$Panel/Margin/VBox/Next.text = "完成" if _index == _pages.size() - 1 else "下一页"

func close() -> void:
	if is_instance_valid(panel):
		panel.hide()
	_pages.clear()
