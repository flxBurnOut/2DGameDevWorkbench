from unittest.mock import Mock

from fastapi.testclient import TestClient

from sprite_pipeline import cli


def test_agent_serve_without_ui_builds_a_healthy_api(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "find_spec", lambda name: None)
    run = Mock()
    monkeypatch.setattr("uvicorn.run", run)
    assert cli.main(["--root", str(tmp_path), "serve", "--port", "7852"]) == 0
    assert run.call_args.kwargs == {"host": "127.0.0.1", "port": 7852}
    with TestClient(run.call_args.args[0]) as client:
        assert client.get("/health").json()["ok"] is True


def test_agent_serve_keeps_installed_operator_ui(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "find_spec", lambda name: object())
    run = Mock()
    monkeypatch.setattr("sprite_pipeline.ui.run_ui", run)
    assert cli.main(["--root", str(tmp_path), "serve", "--port", "7852"]) == 0
    run.assert_called_once_with(root=str(tmp_path), host="127.0.0.1", port=7852)
