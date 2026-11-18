"""Model providers. Explanations are text only; neither provider can submit an order."""

import re

from .domain import DeskError
from .network import request_json


SYSTEM = ("You explain research inside a desktop trading studio. Use the supplied desk facts "
          "for prices, holdings, dates and calculations. Distinguish sample data from exchange data. "
          "Tokenized stocks such as TSLAx are spot tokens, not broker shares. "
          "Explain uncertainty and do not claim to place orders. Be concise.")
OPENROUTER = "https://openrouter.ai/api/v1"
MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,159}$")


def messages(prompt, facts, history):
    dialog = [{"role": "system", "content": SYSTEM}]
    dialog.extend({"role": role, "content": text[:2400]} for role, text in history[-6:]
                  if role in ("user", "assistant"))
    dialog.append({"role": "user", "content": f"Current desk facts:\n{facts}\n\nQuestion: {prompt}"})
    return dialog


def _answer(text, empty):
    if not isinstance(text, str) or not text.strip():
        raise DeskError(empty)
    return text.strip()


def ollama_explain(model, prompt, facts, history, fetch=request_json):
    if not MODEL_ID.fullmatch(model or ""):
        raise DeskError("Enter a locally installed Ollama model tag.")
    local = "http://127.0.0.1:11434/api"
    info = fetch(local + "/show", body={"model": model})
    if not isinstance(info, dict):
        raise DeskError("Ollama returned invalid model details.")
    if info.get("remote_model") or info.get("remote_host") or re.search(r"[:-]cloud(?:$|:)", model, re.I):
        raise DeskError("Choose a locally installed Ollama model.")
    if not isinstance(info.get("model_info"), dict):
        raise DeskError("Ollama did not report an installed model.")
    result = fetch(local + "/chat", body={"model": model, "messages": messages(prompt, facts, history),
                                          "stream": False, "options": {"num_predict": 480}}, timeout=90)
    message = result.get("message") if isinstance(result, dict) else None
    return _answer(message.get("content") if isinstance(message, dict) else None,
                   "The local model returned an empty reply.")


def openrouter_key(raw):
    key = str(raw or "").strip()
    if not re.fullmatch(r"sk-or-[A-Za-z0-9_-]{20,220}", key):
        raise DeskError("Paste an OpenRouter key that starts with sk-or-.")
    return key


def _headers(key):
    return {"Authorization": "Bearer " + key, "HTTP-Referer": "https://github.com/kerjakuyco/octo-gens",
            "X-OpenRouter-Title": "Octo Gens"}


def openrouter_models(key, fetch=request_json):
    key = openrouter_key(key)
    data = fetch(OPENROUTER + "/models", headers=_headers(key), timeout=30, limit=12_000_000)
    rows = data.get("data") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        raise DeskError("OpenRouter did not return a model catalog.")
    models = []
    for row in rows:
        if not isinstance(row, dict) or not MODEL_ID.fullmatch(str(row.get("id", ""))):
            continue
        if "/api/v1/chat/completions" not in (row.get("endpoints") or []):
            continue
        outputs = (row.get("architecture") or {}).get("output_modalities") or []
        if outputs != ["text"]:
            continue
        price = (row.get("pricing") or {}).get("prompt")
        try:
            per_million = f"{float(price) * 1_000_000:.4g}" if price is not None else ""
        except (TypeError, ValueError):
            per_million = ""
        models.append({"id": row["id"], "name": str(row.get("name") or row["id"])[:120],
                       "context": row.get("context_length") or 0, "price": per_million})
    if not models:
        raise DeskError("OpenRouter returned no chat models for this key.")
    return sorted(models, key=lambda item: item["name"].lower())


def openrouter_explain(key, model, prompt, facts, history, fetch=request_json):
    key = openrouter_key(key)
    if not MODEL_ID.fullmatch(model or ""):
        raise DeskError("Choose a model from the OpenRouter catalog.")
    result = fetch(OPENROUTER + "/chat/completions", headers=_headers(key), timeout=90, body={
        "model": model, "messages": messages(prompt, facts, history), "max_tokens": 700, "temperature": 0.2,
    })
    try:
        content = result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        content = None
    answer = _answer(content, "OpenRouter returned an empty reply.")
    return answer.replace(key, "••••")
