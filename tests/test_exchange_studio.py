from datetime import UTC, datetime
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from threading import Thread
import unittest
from urllib.parse import parse_qs, urlsplit

from octogens.domain import DeskError
from octogens.exchanges import Venue
from octogens.instruments import instrument
from octogens.mcp_link import Harness, Link
from octogens.mcp_presets import official_stdio
from octogens.studio import Studio, as_quote


class ExchangeTests(unittest.TestCase):
    def test_official_launch_pins_the_package_and_keeps_secrets_out_of_argv(self):
        runtime = (Path("C:/node/node.exe"), Path("C:/node/npx-cli.js"))
        with patch("octogens.mcp_presets.node_runtime", return_value=runtime):
            bybit = official_stdio("bybit", {"key": "id-1", "secret": "secret-1", "testnet": "on"})
            okx = official_stdio("okx", {"profile": "market"})
            with self.assertRaisesRegex(DeskError, "does not publish"):
                official_stdio("binance", {})
        self.assertEqual(bybit["command"], str(runtime[0]))
        self.assertIn("bybit-official-trading-server@2.1.28", bybit["args"])
        self.assertNotIn("secret-1", " ".join(bybit["args"]))
        self.assertEqual(bybit["env"]["BYBIT_API_SECRET"], "secret-1")
        self.assertEqual(bybit["env"]["BYBIT_TESTNET"], "true")
        self.assertEqual(okx["args"][-2:], ["--modules", "market"])
        self.assertNotIn("api_key", okx["env"])

    def test_harness_routes_spot_tools_to_the_adapter_and_vendor_tools_separately(self):
        class Fake:
            def __init__(self, tools):
                self.tools, self.connected, self.name, self.version = tools, True, "vendor", "9"
                self.calls = []
            def call(self, name, args):
                self.calls.append((name, args))
                return name
            def close(self):
                self.connected = False
        bundled, official = Fake({"spot_quote": {"name": "spot_quote"}}), Fake({"get_tickers": {"name": "get_tickers"}})
        harness = Harness(bundled, official)
        self.assertEqual(harness.call("spot_quote", {"pair": "TSLAX/USDT"}), "spot_quote")
        self.assertEqual(harness.call("get_tickers", {}), "get_tickers")
        self.assertEqual(bundled.calls[0][0], "spot_quote")
        self.assertEqual(official.calls[0][0], "get_tickers")
        harness.close()
        self.assertFalse(bundled.connected and official.connected)

    def test_unknown_listing_never_substitutes_an_underlying_or_derivative(self):
        with self.assertRaisesRegex(DeskError, "underlying"):
            instrument("TSLA")
        calls = []
        def feed(url, **_):
            calls.append(url)
            return {"retCode": 0, "result": {"category": "spot", "list": [
                {"symbol": "TSLAXUSDT", "baseCoin": "TSLAX", "quoteCoin": "USDT",
                 "status": "Trading", "symbolType": "not-an-xstock"}]}}
        with self.assertRaisesRegex(DeskError, "No active spot listing"):
            Venue("bybit", fetch=feed).quote("TSLAx")
        self.assertEqual(len(calls), 1)
        self.assertIn("category=spot&symbol=TSLAXUSDT", calls[0])
        with self.assertRaisesRegex(DeskError, "different venue"):
            as_quote({"venue":"bybit","pair":"TSLA/USDT","market":"linear","listed":True}, "bybit", "TSLAX/USDT")

    def test_all_live_order_payloads_use_base_units_and_exact_spot_market(self):
        for v in ("bybit", "okx", "binance"):
            calls = []
            def fetch(url, *, wire, headers, method):
                calls.append((url, headers, wire))
                if method == "POST":
                    return {"bybit":{"retCode":0,"result":{"orderId":"id1"}},
                            "okx":{"code":"0","data":[{"sCode":"0","ordId":"id2"}]},
                            "binance":{"orderId":"id3","status":"NEW"}}[v]
                return {"bybit":{"retCode":0,"result":{"category":"spot","list":[{"symbol":"BTCUSDT","baseCoin":"BTC",
                         "quoteCoin":"USDT","status":"Trading"}]}}, "okx":{"code":"0","data":[{"instId":"BTC-USDT",
                         "baseCcy":"BTC","quoteCcy":"USDT","state":"live","instType":"SPOT"}]},
                        "binance":{"symbols":[{"symbol":"BTCUSDT","baseAsset":"BTC","quoteAsset":"USDT",
                         "status":"TRADING","isSpotTradingAllowed":True}]}}[v]
            r = Venue(v, "test-key", "test-secret", "test-passphrase", fetch).order("BTC", "buy", ".125", "a"*32)
            self.assertEqual(r["quantity"], "0.125")
            url, headers, wire = calls[-1]
            self.assertNotIn("test-secret", (wire or b"").decode()+url+str(headers))
            if v == "bybit":
                data = json.loads(wire)
                self.assertEqual((data["category"],data["marketUnit"],data["qty"]),("spot","baseCoin","0.125"))
            elif v == "okx":
                data = json.loads(wire)
                self.assertEqual((data["tdMode"],data["tgtCcy"],data["sz"]),("cash","base_ccy","0.125"))
            else:
                params = parse_qs(urlsplit(url).query)
                self.assertEqual(params["quantity"],["0.125"])
                self.assertIn("signature",params)

    def test_bundled_stdio_negotiates_tools_and_propagates_tool_errors(self):
        link = Link("bybit", {"transport":"bundled"})
        try:
            self.assertEqual(set(link.tools), {"spot_quote","spot_listing"})
            with self.assertRaisesRegex(DeskError, "underlying"):
                link.call("spot_quote", {"pair":"AAPL"})
        finally:
            link.close()
        self.assertFalse(link.connected)

    def test_streamable_http_mcp_with_session_id_and_pagination(self):
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                self.send_error(405)
            def do_DELETE(self):
                self.send_response(200); self.end_headers()
            def do_POST(self):
                rpc=json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                method=rpc["method"]; seen.append((method,self.headers.get("mcp-session-id")))
                if "id" not in rpc:
                    self.send_response(202); self.end_headers(); return
                if method=="initialize":
                    result={"protocolVersion":rpc["params"]["protocolVersion"],"capabilities":{"tools":{}},
                            "serverInfo":{"name":"fixture exchange","version":"1"}}
                elif method=="tools/list":
                    second=rpc.get("params",{}).get("cursor")=="next"
                    result={"tools":[{"name":"inspect" if second else "lookup","inputSchema":{"type":"object"},
                                     "description":"read", "annotations":{"readOnlyHint":True}}]}
                    if not second: result["nextCursor"]="next"
                else:
                    result={"content":[{"type":"text","text":"verified fixture"}]}
                raw=json.dumps({"jsonrpc":"2.0","id":rpc["id"],"result":result}).encode()
                self.send_response(200); self.send_header("Content-Type","application/json")
                self.send_header("Mcp-Session-Id","fixture-session"); self.send_header("Content-Length",str(len(raw)))
                self.end_headers(); self.wfile.write(raw)
        server=ThreadingHTTPServer(("127.0.0.1",0), Handler)
        Thread(target=server.serve_forever,daemon=True).start()
        try:
            link=Link("okx", {"transport":"http","url":f"http://127.0.0.1:{server.server_port}/mcp"})
            try:
                self.assertEqual(set(link.tools),{"lookup","inspect"})
                self.assertEqual(link.call("inspect",{}),"verified fixture")
            finally:
                link.close()
            self.assertIn(("tools/call","fixture-session"),seen)
        finally:
            server.shutdown();server.server_close()

    def test_new_usdt_books_traces_and_invalidated_cross_venue_ticket(self):
        class FixtureLink:
            connected=True; name="fixture"; version="1"; transport="bundled"
            tools={"spot_quote":{"readOnly":True}, "spot_listing":{"readOnly":True}}
            def __init__(self,venue,_): self.venue=venue
            def call(self,name,args):
                return {"venue":self.venue,"pair":args["pair"],"market":"spot","listed":True,"price":"225.50",
                        "closes":["224"]*24,"as_of":datetime.now(UTC).isoformat()}
            def close(self): self.connected=False
        with TemporaryDirectory() as temp:
            s=Studio(Path(temp),FixtureLink)
            s.action("boot",{})
            old=s.ask("buy 0.25 AAPLx")["ticket"]
            s.action("connect",{"venue":"bybit","config":{"transport":"bundled"}})
            with self.assertRaisesRegex(DeskError,"expired"):
                s.action("submit",{"id":old["id"]})
            r=s.ask("compare TSLAx and AAPLx")
            self.assertIsNone(r)
            self.assertEqual([row["name"] for row in s.runs[0]["steps"]],
                             ["bybit.spot_quote","bybit.spot_quote","research.patterns"])
            draft=s.ask("buy 0.25 AAPLx")["ticket"]
            s.action("submit",{"id":draft["id"]})
            self.assertEqual(s.state()["account"]["cash"],"99943.62")
            s.action("source",{"source":"sample"})
            self.assertEqual(s.state()["account"]["cash"],"100000.00")
            self.assertFalse((Path(temp)/"paper.sqlite3").exists())
            s.close()
            self.assertTrue(Studio(Path(temp)).runs)
