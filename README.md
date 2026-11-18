# Octo Gens

Octo Gens is a native desktop trading studio for Windows and macOS. It is an agent harness for tokenized stocks and crypto spot markets: research a token, inspect the tool trace, and send the resulting ticket to a paper account or a connected exchange.

The installed app includes its own runtime and opens from Start or Applications. It does not require a browser.

## Install

- **Windows:** run `dist/Octo Gens-0.2.0-win64.msi`, then open **Octo Gens** from Start.
- **macOS:** build `Octo Gens.dmg` on a Mac and drag the app to Applications. See [Build the installers](#build-the-installers).

On first launch the desk opens on **TSLAx/USDT** with **100,000 USDT** in a local paper account. No exchange key or model download is required.

1. Ask **Compare TSLAx and NVDAx**. The run shows each price source and the pattern comparison.
2. Ask **Buy 0.5 TSLAx**. Review the ticket, then place the paper order and open **Portfolio**.
3. Open **Connections** to attach Bybit, OKX, or Binance.

`Ctrl+K` on Windows or `Cmd+K` on Mac focuses the agent prompt.

## Instruments

The desk trades spot tokens quoted in USDT. **TSLAx, AAPLx, NVDAx, and SPYx are tokenized stocks (xStocks), not broker shares and not stock perpetuals.** `TSLA` is rejected and does not fall back to the underlying equity. BTC, ETH, and SOL are their USDT spot pairs.

A venue connection checks the exact token, USDT quote, spot category, and listing status. If that pair is not listed, the desk says so. It does not substitute another market.

## Exchange MCP

| Venue | What Connect starts |
| --- | --- |
| Bybit | Official `bybit-official-trading-server@2.1.28` through Node, plus the built-in spot adapter |
| OKX | Official `@okx_ai/okx-trade-mcp@1.5.1` through Node, plus the built-in spot adapter |
| Binance | Built-in Binance spot MCP server. Binance does not publish an MCP server |

Node.js 20 or newer is required for the official Bybit and OKX packages. The app launches `node` with `npx-cli.js`; it does not use Windows `.cmd` launchers, which cannot carry the MCP stdio stream. The first connection may take a minute while npx downloads the pinned package.

Bybit keys are passed only to that server process and are not saved. Leave them blank for market data. OKX market tools need no key. Its live and demo profiles use the OKX config file you already created; Octo Gens does not write that file. Binance, and the built-in adapters for the other venues, can take a key and secret for the current session to enable balances and spot tickets.

You can also connect a custom stdio command or a remote Streamable HTTP MCP endpoint. HTTP must be HTTPS, except on loopback. After connecting, **Inspect tools** lists the schemas the server advertised. Read-only tools can be called from the prompt as `@bybit tool_name {"symbol":"BTCUSDT"}`. Tools that are not marked read-only run only from the inspector.

Paper prices come from the built-in spot adapter, which normalizes the venue response. Official server tools remain available to the agent even when their names differ.

## Agents

- **Research** compares completed daily moves and five earlier three-return patterns. Those matches are historical examples, not probabilities.
- **Portfolio** reads the paper ledger for the selected feed.
- **Order** turns `Buy 0.5 TSLAx` into a ticket. It does not submit the order.
- **Pattern** buys, sells, or holds in the paper account. **Watch every 15 min** runs only while the app is open and stops when you switch feeds or close the window.

An optional local Ollama model can explain research. Open **Model settings** and enter a model from `ollama list`, for example `qwen3:4b`. The model receives desk readings and returns text; it cannot submit an order. Leave the field blank to use only the built-in agents.

## Run from source

Python 3.11 or newer is required. Windows also needs the WebView2 runtime, which current Windows installs include.

```sh
python -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/python -m octogens
.venv/bin/python -m unittest discover -s tests -v
```

On Windows, use `.venv\Scripts\python` instead of `.venv/bin/python`.

## Build the installers

Build on the target operating system with Python 3.13.

```sh
python -m venv .venv
.venv/bin/python -m pip install -r requirements-build.txt
.venv/bin/python -m pip install -e .
.venv/bin/cxfreeze bdist_msi    # Windows
.venv/bin/cxfreeze bdist_dmg    # macOS
```

The Windows installer is per-user and adds a Start menu shortcut. A local macOS build is ad-hoc signed. Public distribution needs Developer ID signing and notarization, which this repository does not configure.

The desktop workflow builds Windows x64, macOS Apple silicon, and macOS Intel installers.

## Local data

Paper books, run traces, and the optional model name are stored per user.

- Windows: `%LOCALAPPDATA%\Octo Gens\`
- macOS: `~/Library/Application Support/Octo Gens/`

Exchange credentials are not written there. Set `OCTOGENS_DATA_DIR` to use another directory.
