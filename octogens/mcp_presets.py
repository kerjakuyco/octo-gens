"""Pinned launch commands for the exchange MCP servers this desk can start."""

from pathlib import Path
import shutil
import sys

from .domain import DeskError


PACKAGES = {
    "bybit": "bybit-official-trading-server@2.1.28",
    "okx": "@okx_ai/okx-trade-mcp@1.5.1",
}
_LAUNCHERS = {".cmd", ".bat"}


def node_runtime():
    found = shutil.which("node")
    if not found:
        return None
    exe = Path(found)
    if exe.name.lower() in {"node.cmd", "node.bat"}:
        exe = exe.with_name("node.exe")
    try:
        exe = exe.resolve()
    except OSError:
        return None
    if not exe.is_file():
        return None
    npx = next((path for path in (
        exe.parent / "node_modules/npm/bin/npx-cli.js",
        exe.parent.parent / "lib/node_modules/npm/bin/npx-cli.js",
        exe.parent.parent / "node_modules/npm/bin/npx-cli.js",
    ) if path.is_file()), None)
    return (exe, npx) if npx else None


def launchable(command, args):
    """Return a real executable. Windows npx.cmd cannot carry a JSON-RPC stdio stream."""
    raw = str(command).strip()
    leaf = Path(raw).name.lower()
    runtime = node_runtime()
    if leaf in {"npx", "npx.cmd", "npx.exe", "npm", "npm.cmd"}:
        if not runtime:
            raise DeskError("Install Node.js 20 or newer to launch this MCP package.")
        return str(runtime[0]), [str(runtime[1]), *args]
    if leaf in {"node", "node.cmd", "node.bat"}:
        if not runtime:
            raise DeskError("Node.js was found only as a shell launcher, not as node.exe.")
        return str(runtime[0]), list(args)
    path = Path(raw)
    if path.suffix.lower() in _LAUNCHERS or (sys.platform == "win32" and not path.suffix and leaf.endswith(".cmd")):
        raise DeskError("Choose node.exe or another executable. A .cmd launcher cannot speak MCP over stdio.")
    found = str(path) if path.is_file() else shutil.which(raw)
    if not found or Path(found).suffix.lower() in _LAUNCHERS:
        raise DeskError("Server executable was not found. Use an installed program, not a shell script.")
    return found, list(args)


def official_stdio(venue, cfg):
    runtime = node_runtime()
    if venue == "binance":
        raise DeskError("Binance does not publish an MCP server. Use the built-in Binance spot server, or connect a custom one.")
    if venue not in PACKAGES:
        raise DeskError("This venue has no official MCP package configured.")
    if not runtime:
        raise DeskError("Install Node.js 20 or newer to launch the official exchange MCP server.")
    node, npx = runtime
    env = {"CI": "true", "npm_config_update_notifier": "false"}
    args = [str(npx), "-y", PACKAGES[venue]]
    if venue == "bybit":
        if bool(cfg.get("key")) != bool(cfg.get("secret")):
            raise DeskError("Enter both the Bybit API key and secret, or leave both blank for market data.")
        if cfg.get("key"):
            env["BYBIT_API_KEY"] = cfg["key"]
            env["BYBIT_API_SECRET"] = cfg["secret"]
        if str(cfg.get("testnet", "")).lower() in {"1", "true", "on", "yes"}:
            env["BYBIT_TESTNET"] = "true"
    else:
        profile = cfg.get("profile") or "market"
        if profile == "market":
            args += ["--modules", "market"]
        elif profile in {"live", "demo"}:
            args += ["--profile", profile, "--modules", "all"]
        else:
            raise DeskError("Choose market tools, or an existing live or demo OKX profile.")
    return {"transport": "stdio", "command": str(node), "args": args, "env": env, "timeout": 180, "retries": 1}
