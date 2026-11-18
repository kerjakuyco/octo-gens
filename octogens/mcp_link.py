"""A long-lived native MCP client. Each SDK session owns its own event loop."""

import asyncio
from concurrent.futures import Future, TimeoutError
from contextlib import AsyncExitStack
from datetime import timedelta
import json
import os
from pathlib import Path
import sys
from threading import Thread
from urllib.parse import urlsplit

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client

from .domain import DeskError
from .instruments import VENUES
from .mcp_presets import launchable


def _message(exc):
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    return str(exc) or type(exc).__name__


def _stdio(venue, cfg):
    env = {}
    if cfg["transport"] == "bundled":
        if getattr(sys, "frozen", False):
            helper = "OctoVenue.exe" if sys.platform == "win32" else "OctoVenue"
            command, args = str(Path(sys.executable).with_name(helper)), [venue]
        else:
            command, args = sys.executable, ["-m", "octogens.venue_server", venue]
            env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])
        env.update(OCTO_KEY=cfg.get("key", ""), OCTO_SECRET=cfg.get("secret", ""),
                   OCTO_PASSPHRASE=cfg.get("passphrase", ""))
    else:
        args = cfg.get("args", [])
        if not isinstance(args, list) or not all(isinstance(v, str) for v in args):
            raise DeskError("Server arguments must be a JSON array of strings.")
        command, args = launchable(cfg.get("command", ""), args)
        # Vendor-specific settings may be supplied by the user, for this process only.
        extras = cfg.get("env", {})
        if not isinstance(extras, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in extras.items()):
            raise DeskError("Server environment must be a JSON object of string values.")
        env.update(extras)
    return StdioServerParameters(command=command, args=args, env=env)


class Link:
    def __init__(self, venue, config):
        if venue not in VENUES or config.get("transport") not in ("bundled", "stdio", "http"):
            raise DeskError("Unknown exchange or transport.")
        config = dict(config)
        self.venue, self.transport = venue, config["transport"]
        self._timeout = min(180, max(5, float(config.pop("timeout", 35))))
        retries = int(config.pop("retries", 0))
        self.name, self.version, self.tools = "", "", {}
        self._loop = self._task = self._stop = self._session = None
        last = None
        for attempt in range(retries + 1):
            self._ready = Future()
            self._thread = Thread(target=self._run, args=(dict(config), self._ready), daemon=True, name=f"mcp-{venue}")
            self._thread.start()
            try:
                self._ready.result(timeout=self._timeout)
                return
            except Exception as exc:
                last = exc
                self.close()
                if attempt == retries or "Connection closed" not in _message(exc):
                    break
        raise DeskError(f"{VENUES[venue]} MCP connection failed: {_message(last)}") from None

    def _run(self, cfg, ready):
        try:
            asyncio.run(self._serve(cfg, ready))
        except BaseException as exc:
            if not ready.done():
                ready.set_exception(DeskError(_message(exc)))
        finally:
            self._session = None

    async def _serve(self, cfg, ready):
        self._loop, self._task, self._stop = asyncio.get_running_loop(), asyncio.current_task(), asyncio.Event()
        async with AsyncExitStack() as stack:
            if self.transport == "http":
                url = str(cfg.get("url", "")).strip()
                address = urlsplit(url)
                if (address.username or address.password or not address.hostname or not (
                    address.scheme == "https" or (address.scheme == "http" and address.hostname in
                                                  ("127.0.0.1", "localhost", "::1")))):
                    raise DeskError("Use an HTTPS MCP URL (HTTP is supported on loopback).")
                headers = {"Authorization": "Bearer " + cfg["token"]} if cfg.get("token") else {}
                http = await stack.enter_async_context(httpx.AsyncClient(headers=headers, timeout=35, follow_redirects=False))
                reader, writer, _ = await stack.enter_async_context(streamable_http_client(url, http_client=http))
            else:
                err = stack.enter_context(open(os.devnull, "w", encoding="utf-8"))
                reader, writer = await stack.enter_async_context(stdio_client(_stdio(self.venue, cfg), errlog=err))
            cfg.clear()
            session = await stack.enter_async_context(ClientSession(reader, writer, read_timeout_seconds=timedelta(seconds=30)))
            hello = await session.initialize()
            self.name, self.version = hello.serverInfo.name, hello.serverInfo.version
            cursor, seen = None, set()
            while True:
                page = await session.list_tools(cursor=cursor)
                for t in page.tools:
                    self.tools[t.name] = {"name": t.name, "description": t.description or "", "schema": t.inputSchema,
                                          "readOnly": bool(t.annotations and t.annotations.readOnlyHint)}
                cursor = page.nextCursor
                if not cursor:
                    break
                if cursor in seen or len(seen) >= 64:
                    raise DeskError("Invalid tool catalog pagination.")
                seen.add(cursor)
            self._session = session
            ready.set_result(True)
            await self._stop.wait()

    @property
    def connected(self):
        return self._session is not None and self._thread.is_alive()

    def call(self, name, args):
        if not self.connected or name not in self.tools or not isinstance(args, dict):
            raise DeskError("This tool is not available on the connection.")
        future = asyncio.run_coroutine_threadsafe(self._session.call_tool(name, args), self._loop)
        try:
            result = future.result(timeout=35)
        except TimeoutError:
            future.cancel()
            raise DeskError(f"{name} timed out; the call was not retried.") from None
        except Exception as exc:
            raise DeskError(f"{name}: {_message(exc)}") from None
        text = "\n".join(x.text for x in result.content if x.type == "text")
        if result.isError:
            raise DeskError((text or f"{name} failed.")[:1200])
        if result.structuredContent is not None:
            return result.structuredContent
        try:
            return json.loads(text)
        except ValueError:
            return text

    def close(self):
        if self._loop and self._loop.is_running():
            try:
                callback = self._stop.set if self._ready.done() else self._task.cancel
                self._loop.call_soon_threadsafe(callback)
            except RuntimeError:
                pass
        self._thread.join(timeout=4)


class Harness:
    """Official exchange tools plus the venue-scoped spot adapter, in one catalog."""

    def __init__(self, bundled, official):
        self.bundled, self.official = bundled, official
        self.transport, self.name, self.version = "official", official.name, official.version
        self.tools, self._route = {}, {}
        for name, tool in bundled.tools.items():
            self.tools[name] = tool
            self._route[name] = (bundled, name)
        for name, tool in official.tools.items():
            key = name if name not in self._route else "official." + name
            self.tools[key] = {**tool, "name": key}
            self._route[key] = (official, name)
        self.connected = bundled.connected and official.connected

    def call(self, name, args):
        if name not in self._route:
            raise DeskError("This tool is not available on the connection.")
        server, real = self._route[name]
        return server.call(real, args)

    def close(self):
        self.official.close()
        self.bundled.close()
        self.connected = False
