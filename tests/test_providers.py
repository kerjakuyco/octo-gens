import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from octogens.domain import DeskError
from octogens.providers import openrouter_explain, openrouter_models
from octogens.studio import Studio


KEY = "sk-or-v1-" + "a" * 24


class OpenRouterTests(unittest.TestCase):
    def test_catalog_keeps_chat_models_and_chat_never_sends_the_key_or_tools(self):
        calls = []
        def fetch(url, **kwargs):
            calls.append((url, kwargs))
            if url.endswith("/models"):
                return {"data": [
                    {"id": "openai/gpt-test", "name": "GPT Test", "context_length": 8000,
                     "pricing": {"prompt": "0.000002"}, "endpoints": ["/api/v1/chat/completions"],
                     "architecture": {"output_modalities": ["text"]}},
                    {"id": "video/clip", "name": "Clip", "endpoints": ["/api/v1/chat/completions"],
                     "architecture": {"output_modalities": ["text", "video"]}},
                    {"id": "openai/gpt-test:batch", "name": "Batch", "endpoints": ["/api/v1/batches"],
                     "architecture": {"output_modalities": ["text"]}},
                ]}
            self.assertNotIn(KEY, json.dumps(kwargs.get("body")))
            self.assertEqual(kwargs["headers"]["Authorization"], "Bearer " + KEY)
            self.assertNotIn("tools", kwargs["body"])
            self.assertIn("TSLAx is a spot token", kwargs["body"]["messages"][-1]["content"])
            return {"choices": [{"message": {"content": "Tokenized stock, not a share."}}]}
        models = openrouter_models(KEY, fetch)
        self.assertEqual([item["id"] for item in models], ["openai/gpt-test"])
        self.assertEqual(models[0]["price"], "2")
        answer = openrouter_explain(KEY, "openai/gpt-test", "What is it?", "TSLAx is a spot token", (), fetch)
        self.assertIn("not a share", answer)
        with self.assertRaisesRegex(DeskError, "sk-or-"):
            openrouter_models("not-a-key", fetch)

    def test_saved_key_is_local_and_absent_from_desk_state_and_runs(self):
        with TemporaryDirectory() as folder:
            studio = Studio(Path(folder))
            studio.action("model", {"provider": "openrouter", "model": "openai/gpt-test", "key": KEY})
            state = studio.state()
            self.assertEqual(state["modelLabel"], "OpenRouter · openai/gpt-test")
            self.assertNotIn(KEY, json.dumps(state))
            saved = json.loads((Path(folder) / "preferences.json").read_text(encoding="utf8"))
            self.assertEqual(saved["openrouter_key"], KEY)
            studio.action("model", {"provider": "openrouter", "model": "openai/gpt-test", "key": ""})
            self.assertEqual(studio.openrouter_key, KEY)
            self.assertNotIn(KEY, Path(folder).joinpath("studio-runs.sqlite3").read_bytes().decode("utf8", "ignore"))
