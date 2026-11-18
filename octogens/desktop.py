"""Native WebView2 / WKWebView shell. Only the bundled UI can reach the bridge."""

from pathlib import Path
import sys
from uuid import uuid4

from .desk import data_directory
from .studio import Studio


class Bridge:
    def __init__(self, studio):
        self._studio = studio

    def dispatch(self, action, payload):
        with self._studio.lock:
            try:
                value = self._studio.action(action, payload)
                return {"ok": True, "result": value, "state": self._studio.state()}
            except Exception as exc:
                return {"ok": False, "error": str(exc)[:1500], "state": self._studio.state()}

    def pulse(self):
        run = self._studio.active
        return {"title": run["title"], "steps": [dict(s) for s in run["steps"]]} if run else None


def document():
    assets = Path(__file__).with_name("ui")
    nonce = uuid4().hex
    return ((assets / "index.html").read_text(encoding="utf8").replace("__NONCE__", nonce)
            .replace("/* STUDIO_STYLE */", (assets / "studio.css").read_text(encoding="utf8"))
            .replace("/* STUDIO_SCRIPT */", (assets / "studio.js").read_text(encoding="utf8")))


def launch(directory, started=None):
    import webview
    studio = Studio(directory)
    api = Bridge(studio)
    window = webview.create_window("Octo Gens · Trading Studio", html=document(), js_api=api,
                                   width=1250, height=830, min_size=(760, 550), background_color="#101316")
    window.events.closed += studio.close
    gui = "edgechromium" if sys.platform == "win32" else None
    webview.start(started, window, gui=gui, private_mode=True)


def main():
    launch(data_directory())
