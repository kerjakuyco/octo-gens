from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import time
import unittest

from octogens.desktop import launch


@unittest.skipUnless(sys.platform in ("win32", "darwin"), "Native desktop integration test")
class DesktopFlow(unittest.TestCase):
    def test_real_webview_prompt_ticket_fill_and_exchange_navigation(self):
        failures = []
        def exercise(w):
            def wait(js):
                until = time.monotonic() + 12
                while time.monotonic() < until:
                    if w.evaluate_js(js):
                        return
                    time.sleep(.08)
                raise AssertionError(f"Timed out: {js}; page: {w.evaluate_js('document.body.innerText.slice(-800)')}")
            try:
                wait("document.documentElement.dataset.ready === 'true'")
                self.assertIn("TSLAx", w.evaluate_js("document.querySelector('.assettitle').textContent"))
                w.evaluate_js("document.querySelector('[data-prompt=\"Buy 0.5 TSLAx\"]').click()")
                wait("!!document.querySelector('#previewform')")
                self.assertIn("TSLAX/USDT", w.evaluate_js("document.querySelector('.preview').textContent"))
                w.evaluate_js("document.querySelector('#previewform button[type=submit]').click()")
                wait("document.querySelector('h1')?.textContent === 'Portfolio' && document.querySelectorAll('tbody tr').length === 2")
                w.evaluate_js("document.querySelector('[data-page=links]').click()")
                self.assertEqual(w.evaluate_js("document.querySelectorAll('[data-link]').length"), 3)
                w.evaluate_js("document.querySelector('[data-link=bybit]').click()")
                wait("document.querySelector('#connectform')?.dataset.venue === 'bybit'")
            except Exception as exc:
                failures.append(exc)
            finally:
                w.destroy()
        with TemporaryDirectory() as folder:
            launch(Path(folder), exercise)
        if failures:
            raise failures[0]
