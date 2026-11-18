use std::path::PathBuf;

use serde_json::{Value, json};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

use super::*;

fn runtime() -> (PathBuf, PathBuf) {
    (PathBuf::from("/opt/node/bin/node"), PathBuf::from("/opt/node/lib/node_modules/npm/bin/npx-cli.js"))
}

#[test]
fn official_launches_pin_the_package_and_keep_secrets_out_of_the_command_line() {
    let runtime = runtime();
    let bybit =
        official_launch(VenueId::Bybit, "id-1", "secret-1", true, None, Some(&runtime)).expect("bybit");
    assert_eq!(bybit.program, runtime.0);
    assert_eq!(
        bybit.args,
        ["/opt/node/lib/node_modules/npm/bin/npx-cli.js", "-y", "bybit-official-trading-server@2.1.28"]
    );
    assert!(!bybit.args.join(" ").contains("secret-1"));
    assert_eq!(
        (
            bybit.env["BYBIT_API_KEY"].as_str(),
            bybit.env["BYBIT_API_SECRET"].as_str(),
            bybit.env["BYBIT_TESTNET"].as_str()
        ),
        ("id-1", "secret-1", "true")
    );

    let market = official_launch(VenueId::Bybit, "", "", false, None, Some(&runtime)).expect("market data");
    assert!(!market.env.contains_key("BYBIT_API_KEY") && !market.env.contains_key("BYBIT_TESTNET"));
    assert!(
        official_launch(VenueId::Bybit, "id-1", "", false, None, Some(&runtime)).is_err(),
        "half a credential is refused"
    );

    let okx = official_launch(VenueId::Okx, "", "", false, Some("market"), Some(&runtime)).expect("okx");
    assert_eq!(okx.args[2..], ["@okx_ai/okx-trade-mcp@1.5.1", "--modules", "market"]);
    let demo = official_launch(VenueId::Okx, "", "", false, Some("demo"), Some(&runtime)).expect("okx demo");
    assert_eq!(demo.args[3..], ["--profile", "demo", "--modules", "all"]);
    assert!(
        okx.env.keys().all(|k| !k.to_ascii_lowercase().contains("key")),
        "OKX profiles come from its own config file"
    );
    assert!(official_launch(VenueId::Okx, "", "", false, Some("everything"), Some(&runtime)).is_err());

    assert!(
        official_launch(VenueId::Binance, "", "", false, None, Some(&runtime))
            .expect_err("none")
            .to_string()
            .contains("does not publish")
    );
    assert!(
        official_launch(VenueId::Okx, "", "", false, None, None)
            .expect_err("no node")
            .to_string()
            .contains("Install Node.js")
    );
}

#[test]
fn typed_commands_resolve_to_real_executables_never_shell_wrappers() {
    let runtime = runtime();
    let args = vec!["-y".to_string(), "some-mcp@1".to_string()];
    for npx in ["npx", "npx.cmd", "C:\\node\\npx.cmd", "/usr/local/bin/npx"] {
        let (program, full) = launchable(npx, &args, Some(&runtime)).unwrap_or_else(|e| panic!("{npx}: {e}"));
        assert_eq!(program, runtime.0);
        assert_eq!(full, ["/opt/node/lib/node_modules/npm/bin/npx-cli.js", "-y", "some-mcp@1"]);
    }
    assert_eq!(
        launchable("node", &["server.js".to_string()], Some(&runtime)).expect("node"),
        (runtime.0.clone(), vec!["server.js".to_string()])
    );
    assert!(launchable("npx", &args, None).expect_err("no node").to_string().contains("Install Node.js"));
    assert!(
        launchable("start-server.cmd", &[], Some(&runtime))
            .expect_err("wrapper")
            .to_string()
            .contains(".cmd or .bat")
    );
    assert!(
        launchable("definitely-not-installed-anywhere", &[], Some(&runtime))
            .expect_err("missing")
            .to_string()
            .contains("not found")
    );
    let this_test = std::env::current_exe().expect("exe");
    assert_eq!(launchable(&this_test.to_string_lossy(), &[], None).expect("full path").0, this_test);
}

#[test]
fn remote_servers_must_be_https_unless_they_are_on_this_computer() {
    for good in [
        "https://mcp.example.com/mcp",
        "http://127.0.0.1:8080/mcp",
        "http://localhost:3000/mcp",
        " https://a.example/x ",
    ] {
        assert!(checked_url(good).is_ok(), "{good}");
    }
    for bad in [
        "http://mcp.example.com/mcp",
        "https://user:pass@example.com/mcp",
        "ftp://example.com",
        "example.com/mcp",
        "",
    ] {
        assert!(checked_url(bad).is_err(), "{bad}");
    }
}

/// A minimal MCP server over Streamable HTTP: paginated catalog, one error tool.
struct Fixture;

impl Respond for Fixture {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let rpc: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        let Some(id) = rpc.get("id") else {
            return ResponseTemplate::new(202);
        };
        let result = match rpc["method"].as_str() {
            Some("initialize") => json!({
                "protocolVersion": rpc["params"]["protocolVersion"],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "fixture exchange", "version": "1.2.3"},
            }),
            Some("tools/list") if rpc["params"]["cursor"] == "next" => json!({"tools": [
                {"name": "place_order", "description": "writes", "inputSchema": {"type": "object"}},
                {"name": "explode", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": true}},
            ]}),
            Some("tools/list") => json!({
                "tools": [{"name": "lookup", "description": "reads a ticker", "inputSchema": {"type": "object", "properties": {"symbol": {"type": "string"}}}, "annotations": {"readOnlyHint": true}}],
                "nextCursor": "next",
            }),
            Some("tools/call") if rpc["params"]["name"] == "explode" => {
                json!({"content": [{"type": "text", "text": "symbol is required"}], "isError": true})
            }
            Some("tools/call") if rpc["params"]["name"] == "place_order" => {
                json!({"content": [{"type": "text", "text": "plain words"}]})
            }
            Some("tools/call") => {
                json!({"content": [{"type": "text", "text": format!("{{\"echo\":{}}}", rpc["params"]["arguments"])}]})
            }
            _ => json!({}),
        };
        ResponseTemplate::new(200)
            .insert_header("Mcp-Session-Id", "fixture-session")
            .set_body_json(json!({"jsonrpc": "2.0", "id": id, "result": result}))
    }
}

#[tokio::test]
async fn a_remote_server_is_negotiated_catalogued_and_called() {
    let server = MockServer::start().await;
    Mock::given(method("POST")).and(path("/mcp")).respond_with(Fixture).mount(&server).await;
    Mock::given(method("GET"))
        .and(path("/mcp"))
        .respond_with(ResponseTemplate::new(405))
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/mcp"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let request = McpConnectRequest::Http {
        venue: VenueId::Okx,
        url: format!("{}/mcp", server.uri()),
        token: Some("  t0ken ".to_string()),
    };
    let link = McpLink::connect(&request).await.expect("connect");
    assert_eq!(
        (link.name.as_str(), link.version.as_str(), link.transport),
        ("fixture exchange", "1.2.3", Transport::Http)
    );
    assert_eq!(
        link.tools().iter().map(|t| (t.name.as_str(), t.read_only)).collect::<Vec<_>>(),
        [("lookup", true), ("place_order", false), ("explode", true)]
    );
    assert_eq!(link.tool("lookup").expect("tool").schema["properties"]["symbol"]["type"], "string");
    assert!(link.connected().await);

    assert_eq!(
        link.call("lookup", &json!({"symbol": "BTCUSDT"})).await.expect("json result"),
        json!({"echo": {"symbol": "BTCUSDT"}})
    );
    assert_eq!(link.call("place_order", &json!({})).await.expect("text result"), json!("plain words"));
    assert_eq!(
        link.call("explode", &json!({})).await.expect_err("tool error").to_string(),
        "symbol is required"
    );
    assert!(
        link.call("missing", &json!({}))
            .await
            .expect_err("unknown")
            .to_string()
            .contains("not a tool on this server")
    );
    assert!(link.call("lookup", &json!([1])).await.is_err());

    link.close().await;
    assert!(!link.connected().await);
    let requests = server.received_requests().await.expect("recorded");
    let posts: Vec<&Request> = requests.iter().filter(|r| r.method.as_str() == "POST").collect();
    assert!(
        posts
            .iter()
            .all(|r| r.headers.get("authorization").and_then(|v| v.to_str().ok()) == Some("Bearer t0ken"))
    );
    let called = posts
        .iter()
        .filter(|r| String::from_utf8_lossy(&r.body).contains("tools/call"))
        .all(|r| r.headers.get("mcp-session-id").and_then(|v| v.to_str().ok()) == Some("fixture-session"));
    assert!(called, "tool calls carry the negotiated session");

    let refused = McpConnectRequest::Http {
        venue: VenueId::Okx,
        url: "http://example.com/mcp".to_string(),
        token: None,
    };
    assert!(McpLink::connect(&refused).await.is_err());
}

/// A dependency-free MCP server over stdio, to exercise the child-process transport.
const STDIO_SERVER: &str = r#"
const readline = require('node:readline');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const rpc = JSON.parse(line);
  if (rpc.id === undefined) return;
  let result = {};
  if (rpc.method === 'initialize') result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stdio fixture', version: '0.1.0' } };
  if (rpc.method === 'tools/list') result = { tools: [{ name: 'env_probe', description: 'reads one variable', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] };
  if (rpc.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({ marker: process.env.FIXTURE_MARKER, argv: process.argv.slice(2) }) }] };
  send({ jsonrpc: '2.0', id: rpc.id, result });
});
"#;

#[tokio::test]
async fn a_local_server_runs_as_a_child_process_with_its_own_environment() {
    if node_runtime().is_none() {
        eprintln!("skipped: Node.js is not installed, so the stdio transport cannot be exercised");
        return;
    }
    let folder = tempfile::tempdir().expect("tempdir");
    let script = folder.path().join("server.js");
    std::fs::write(&script, STDIO_SERVER).expect("script");
    let request = McpConnectRequest::Stdio {
        venue: VenueId::Bybit,
        command: "node".to_string(),
        args: vec![script.to_string_lossy().to_string(), "--flag".to_string()],
        env: HashMap::from([("FIXTURE_MARKER".to_string(), "from-the-desk".to_string())]),
    };
    let link = McpLink::connect(&request).await.expect("connect");
    assert_eq!(
        (link.name.as_str(), link.version.as_str(), link.transport),
        ("stdio fixture", "0.1.0", Transport::Stdio)
    );
    assert_eq!(link.tools().len(), 1);
    assert_eq!(
        link.call("env_probe", &json!({})).await.expect("call"),
        json!({"marker": "from-the-desk", "argv": ["--flag"]})
    );
    link.close().await;
    assert!(!link.connected().await);

    let missing = McpConnectRequest::Stdio {
        venue: VenueId::Bybit,
        command: "definitely-not-installed-anywhere".to_string(),
        args: Vec::new(),
        env: HashMap::new(),
    };
    assert!(McpLink::connect(&missing).await.expect_err("missing").to_string().contains("not found"));
}

#[test]
fn connect_requests_arrive_from_the_ui_tagged_by_transport() {
    let official: McpConnectRequest = serde_json::from_value(
        json!({"venue": "bybit", "transport": "official", "key": "k", "secret": "s", "testnet": true}),
    )
    .expect("official");
    assert!(matches!(official, McpConnectRequest::Official { venue: VenueId::Bybit, testnet: true, .. }));
    let stdio: McpConnectRequest = serde_json::from_value(
        json!({"venue": "okx", "transport": "stdio", "command": "node", "args": ["a.js"], "env": {"A": "1"}}),
    )
    .expect("stdio");
    assert_eq!(stdio.venue(), VenueId::Okx);
    let http: McpConnectRequest = serde_json::from_value(
        json!({"venue": "binance", "transport": "http", "url": "https://x.example/mcp"}),
    )
    .expect("http");
    assert!(matches!(http, McpConnectRequest::Http { token: None, .. }));
    assert!(
        serde_json::from_value::<McpConnectRequest>(json!({"venue": "okx", "transport": "carrier-pigeon"}))
            .is_err()
    );
    assert_eq!(
        serde_json::to_value(ToolInfo {
            name: "t".into(),
            description: String::new(),
            schema: json!({}),
            read_only: true
        })
        .expect("json")["readOnly"],
        true
    );
}
