"""Small JSON transport shared by the public feeds, broker and local model."""

import json
from pathlib import Path
import ssl
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import (
    HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener,
)

from .domain import DeskError


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_json(url, *, body=None, headers=None, timeout=12, method=None, wire=None):
    host = urlsplit(url).hostname
    req = Request(
        url, data=wire if wire is not None else (json.dumps(body).encode() if body is not None else None),
        method=method, headers={"User-Agent": "OctoGens/0.2", "Accept": "application/json",
                 "Content-Type": "application/json", **(headers or {})},
    )
    handlers = [_NoRedirect()]
    if host == "127.0.0.1":
        handlers.append(ProxyHandler({}))
    elif sys.platform == "darwin" and Path("/etc/ssl/cert.pem").is_file():
        handlers.append(HTTPSHandler(context=ssl.create_default_context(cafile="/etc/ssl/cert.pem")))
    try:
        with build_opener(*handlers).open(req, timeout=timeout) as response:
            raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise DeskError(f"{host} returned an unexpectedly large response.")
        return json.loads(raw)
    except HTTPError as exc:
        with exc:
            try:
                data = json.loads(exc.read(8192))
                detail = str(data.get("message") or data.get("msg") or data.get("retMsg")
                             or data.get("error") or exc.reason)[:240]
            except (ValueError, AttributeError):
                detail = str(exc.reason)
        raise DeskError(f"{host} ({exc.code}): {detail}") from None
    except (OSError, URLError) as exc:
        raise DeskError(f"Could not reach {host}: {getattr(exc, 'reason', exc)}.") from None
    except ValueError:
        raise DeskError(f"{host} returned invalid JSON.") from None
