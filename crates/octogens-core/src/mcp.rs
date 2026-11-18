//! Model Context Protocol client: attach an exchange's own tool server.
//!
//! Market data and orders use the native adapters in [`crate::venues`]. MCP is
//! for everything else a venue offers through its official server, or through a
//! server the trader chooses. Three ways to attach one:
//!
//! - **official**: the venue's pinned npm package, started with Node;
//! - **stdio**: any local command that speaks MCP over stdin/stdout;
//! - **http**: a remote Streamable HTTP endpoint (HTTPS, or HTTP on loopback).
//!
//! The assistant may only call tools a server marks read-only. Anything else
//! has to be run by the trader from the tool inspector.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{ConfigureCommandExt, StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{Peer, RoleClient, ServiceExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Result;
use crate::model::VenueId;
use crate::{bail, desk_err};

const CALL_TIMEOUT: Duration = Duration::from_secs(35);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(35);
/// The first launch of an official server downloads its package.
const OFFICIAL_TIMEOUT: Duration = Duration::from_secs(180);

/// The pinned package of each venue's official MCP server. Binance publishes none.
pub fn official_package(venue: VenueId) -> Option<&'static str> {
    match venue {
        VenueId::Bybit => Some("bybit-official-trading-server@2.1.28"),
        VenueId::Okx => Some("@okx_ai/okx-trade-mcp@1.5.1"),
        VenueId::Binance => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Official,
    Stdio,
    Http,
}

/// How to attach a server. Mirrors `McpConnectRequest` in the UI contract.
#[derive(Clone, Deserialize)]
#[serde(tag = "transport", rename_all = "lowercase")]
pub enum McpConnectRequest {
    Official {
        venue: VenueId,
        #[serde(default)]
        key: String,
        #[serde(default)]
        secret: String,
        #[serde(default)]
        testnet: bool,
        #[serde(default)]
        profile: Option<String>,
    },
    Stdio {
        venue: VenueId,
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: HashMap<String, String>,
    },
    Http {
        venue: VenueId,
        url: String,
        #[serde(default)]
        token: Option<String>,
    },
}

impl McpConnectRequest {
    pub fn venue(&self) -> VenueId {
        match self {
            Self::Official { venue, .. } | Self::Stdio { venue, .. } | Self::Http { venue, .. } => *venue,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    /// JSON Schema of the input.
    pub schema: Value,
    /// The server declares the tool does not change anything.
    pub read_only: bool,
}

/// A command line ready to spawn.
#[derive(Debug, PartialEq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

fn is_file(path: &Path) -> bool {
    path.is_file()
}

/// Finds an executable by name: on `PATH` first, then where Node installers put
/// things. A desktop app started from the dock does not inherit the shell's
/// `PATH`, so the usual locations are checked explicitly.
fn find_program(name: &str) -> Option<PathBuf> {
    let names: Vec<String> =
        if cfg!(windows) { vec![format!("{name}.exe"), name.to_string()] } else { vec![name.to_string()] };
    let mut folders: Vec<PathBuf> =
        std::env::var_os("PATH").map(|path| std::env::split_paths(&path).collect()).unwrap_or_default();
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    if cfg!(windows) {
        folders.extend(
            ["ProgramFiles", "ProgramFiles(x86)"]
                .iter()
                .filter_map(std::env::var_os)
                .map(|base| PathBuf::from(base).join("nodejs")),
        );
    } else {
        folders.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    }
    if let Some(home) = home {
        folders.extend([home.join(".local/bin"), home.join(".volta/bin"), home.join(".asdf/shims")]);
        // nvm keeps one folder per version; prefer the newest.
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<PathBuf> =
                entries.filter_map(|e| e.ok()).map(|e| e.path().join("bin")).collect();
            versions.sort();
            folders.extend(versions.into_iter().rev());
        }
    }
    folders
        .iter()
        .flat_map(|folder| names.iter().map(move |name| folder.join(name)))
        .find(|candidate| is_file(candidate))
}

/// The real `node` executable and npm's `npx-cli.js` beside it.
///
/// The script is run with `node` directly. Windows `npx.cmd` is a shell wrapper
/// and cannot carry a JSON-RPC stream over stdio.
pub fn node_runtime() -> Option<(PathBuf, PathBuf)> {
    let node = find_program("node")?.canonicalize().ok()?;
    let folder = node.parent()?;
    let npx = [
        folder.join("node_modules/npm/bin/npx-cli.js"),
        folder.join("../lib/node_modules/npm/bin/npx-cli.js"),
        folder.join("../node_modules/npm/bin/npx-cli.js"),
    ]
    .into_iter()
    .find(|path| is_file(path))?;
    Some((node, npx))
}

/// The file name of a typed command, whichever path separator it uses.
fn leaf(command: &str) -> String {
    command.rsplit(['/', '\\']).next().unwrap_or(command).to_ascii_lowercase()
}

/// Resolves a user-typed command to a real executable.
pub fn launchable(
    command: &str,
    args: &[String],
    runtime: Option<&(PathBuf, PathBuf)>,
) -> Result<(PathBuf, Vec<String>)> {
    let raw = command.trim();
    let name = leaf(raw);
    if matches!(name.as_str(), "npx" | "npx.cmd" | "npx.exe" | "npm" | "npm.cmd") {
        let Some((node, npx)) = runtime else {
            bail!("Install Node.js 20 or newer to launch this MCP package.");
        };
        let mut full = vec![npx.to_string_lossy().to_string()];
        full.extend(args.iter().cloned());
        return Ok((node.clone(), full));
    }
    if matches!(name.as_str(), "node" | "node.exe" | "node.cmd" | "node.bat") {
        let Some((node, _)) = runtime else {
            bail!("Node.js was not found. Install Node.js 20 or newer, or give the full path to node.");
        };
        return Ok((node.clone(), args.to_vec()));
    }
    if name.ends_with(".cmd") || name.ends_with(".bat") {
        bail!("Choose a real executable. A .cmd or .bat launcher cannot speak MCP over stdio.");
    }
    let path = PathBuf::from(raw);
    let found = if is_file(&path) { Some(path) } else { find_program(raw) };
    match found {
        Some(program) => Ok((program, args.to_vec())),
        None => bail!("The server program was not found: {raw}. Give an installed program or its full path."),
    }
}

/// The launch command for a venue's official server. Secrets go in the child's
/// environment, never on its command line where other processes could read them.
pub fn official_launch(
    venue: VenueId,
    key: &str,
    secret: &str,
    testnet: bool,
    profile: Option<&str>,
    runtime: Option<&(PathBuf, PathBuf)>,
) -> Result<Launch> {
    let Some(package) = official_package(venue) else {
        bail!(
            "{} does not publish an MCP server. Its market data and orders work without one.",
            venue.name()
        );
    };
    let Some((node, npx)) = runtime else {
        bail!("Install Node.js 20 or newer to launch the official {} MCP server.", venue.name());
    };
    let mut args = vec![npx.to_string_lossy().to_string(), "-y".to_string(), package.to_string()];
    let mut env = HashMap::from([
        ("CI".to_string(), "true".to_string()),
        ("npm_config_update_notifier".to_string(), "false".to_string()),
    ]);
    match venue {
        VenueId::Bybit => {
            if key.trim().is_empty() != secret.trim().is_empty() {
                bail!("Enter both the Bybit API key and secret, or leave both blank for market data only.");
            }
            if !key.trim().is_empty() {
                env.insert("BYBIT_API_KEY".to_string(), key.trim().to_string());
                env.insert("BYBIT_API_SECRET".to_string(), secret.trim().to_string());
            }
            if testnet {
                env.insert("BYBIT_TESTNET".to_string(), "true".to_string());
            }
        }
        _ => match profile.unwrap_or("market") {
            "market" => args.extend(["--modules", "market"].map(str::to_string)),
            profile @ ("live" | "demo") => {
                args.extend(["--profile", profile, "--modules", "all"].map(str::to_string))
            }
            _ => bail!("Choose market tools, or an existing live or demo OKX profile."),
        },
    }
    Ok(Launch { program: node.clone(), args, env })
}

/// Only HTTPS is accepted for remote servers; plain HTTP is for this machine only.
fn checked_url(raw: &str) -> Result<String> {
    let url = url::Url::parse(raw.trim())
        .map_err(|_| desk_err!("Enter the full MCP endpoint URL, for example https://example.com/mcp."))?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    let secure = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    if !secure || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        bail!(
            "Use an HTTPS MCP URL without credentials in it. Plain HTTP is accepted for this computer only."
        );
    }
    Ok(url.to_string())
}

fn failure(venue: VenueId, error: impl std::fmt::Display) -> crate::error::DeskError {
    desk_err!("{} MCP connection failed: {error}", venue.name())
}

/// A live session with one MCP server.
pub struct McpLink {
    pub name: String,
    pub version: String,
    pub transport: Transport,
    tools: Vec<ToolInfo>,
    peer: Peer<RoleClient>,
    service: tokio::sync::Mutex<Option<RunningService<RoleClient, ()>>>,
}

impl std::fmt::Debug for McpLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpLink")
            .field("name", &self.name)
            .field("version", &self.version)
            .field("transport", &self.transport)
            .field("tools", &self.tools.len())
            .finish()
    }
}

impl McpLink {
    /// Starts or reaches the server, negotiates the session and reads its tool catalog.
    pub async fn connect(request: &McpConnectRequest) -> Result<Self> {
        let venue = request.venue();
        let runtime = node_runtime();
        let (transport, timeout, service) = match request {
            McpConnectRequest::Http { url, token, .. } => {
                let mut config = StreamableHttpClientTransportConfig::with_uri(checked_url(url)?);
                if let Some(token) = token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                    config = config.auth_header(token);
                }
                let serving = ().serve(StreamableHttpClientTransport::from_config(config));
                (Transport::Http, CONNECT_TIMEOUT, tokio::time::timeout(CONNECT_TIMEOUT, serving).await)
            }
            other => {
                let (kind, timeout, launch) = match other {
                    McpConnectRequest::Official { key, secret, testnet, profile, .. } => (
                        Transport::Official,
                        OFFICIAL_TIMEOUT,
                        official_launch(venue, key, secret, *testnet, profile.as_deref(), runtime.as_ref())?,
                    ),
                    McpConnectRequest::Stdio { command, args, env, .. } => {
                        let (program, args) = launchable(command, args, runtime.as_ref())?;
                        (Transport::Stdio, CONNECT_TIMEOUT, Launch { program, args, env: env.clone() })
                    }
                    McpConnectRequest::Http { .. } => unreachable!("handled above"),
                };
                let command = tokio::process::Command::new(&launch.program).configure(|command| {
                    command.args(&launch.args).envs(&launch.env).kill_on_drop(true);
                });
                // A server's stderr is its log; it is not ours to show or keep.
                let (process, _) = TokioChildProcess::builder(command)
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|error| failure(venue, error))?;
                (kind, timeout, tokio::time::timeout(timeout, ().serve(process)).await)
            }
        };
        let service = match service {
            Ok(Ok(service)) => service,
            Ok(Err(error)) => return Err(failure(venue, error)),
            Err(_) => return Err(failure(venue, format!("no answer within {} seconds", timeout.as_secs()))),
        };
        let info = service.peer_info().and_then(|info| info.server_info.clone());
        let listed = tokio::time::timeout(CONNECT_TIMEOUT, service.list_all_tools()).await;
        let tools = match listed {
            Ok(Ok(tools)) => tools,
            Ok(Err(error)) => return Err(failure(venue, error)),
            Err(_) => return Err(failure(venue, "the tool catalog did not arrive in time")),
        };
        let tools = tools
            .into_iter()
            .map(|tool| ToolInfo {
                name: tool.name.to_string(),
                description: tool.description.map(|d| d.to_string()).unwrap_or_default(),
                schema: Value::Object((*tool.input_schema).clone()),
                read_only: tool.annotations.and_then(|a| a.read_only_hint).unwrap_or(false),
            })
            .collect();
        Ok(Self {
            name: info.as_ref().map(|i| i.name.clone()).unwrap_or_else(|| "MCP server".to_string()),
            version: info.map(|i| i.version).unwrap_or_default(),
            transport,
            tools,
            peer: service.peer().clone(),
            service: tokio::sync::Mutex::new(Some(service)),
        })
    }

    pub fn tools(&self) -> &[ToolInfo] {
        &self.tools
    }

    pub fn tool(&self, name: &str) -> Option<&ToolInfo> {
        self.tools.iter().find(|tool| tool.name == name)
    }

    /// Calls a tool once. The result is the server's structured content when it
    /// sends any, otherwise its text parsed as JSON, otherwise the text itself.
    pub async fn call(&self, name: &str, arguments: &Value) -> Result<Value> {
        let Some(arguments) = arguments.as_object() else {
            bail!("Tool arguments must be a JSON object.");
        };
        if self.tool(name).is_none() {
            bail!("{name} is not a tool on this server. Open the tool inspector to see its catalog.");
        }
        let params = CallToolRequestParams::new(name.to_string()).with_arguments(arguments.clone());
        let result = match tokio::time::timeout(CALL_TIMEOUT, self.peer.call_tool(params)).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => bail!("{name}: {error}"),
            // The server may still be working; repeating a call that changes something is not safe.
            Err(_) => bail!("{name} timed out; the call was not repeated."),
        };
        let text = result
            .content
            .iter()
            .filter_map(|block| block.as_text())
            .map(|t| t.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if result.is_error == Some(true) {
            let message: String =
                if text.is_empty() { format!("{name} failed.") } else { text.chars().take(1200).collect() };
            bail!("{message}");
        }
        if let Some(structured) = result.structured_content.filter(|v| !v.is_null()) {
            return Ok(structured);
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }

    pub async fn connected(&self) -> bool {
        self.service.lock().await.as_ref().is_some_and(|service| !service.is_closed())
    }

    /// Ends the session and stops a server this app started.
    pub async fn close(&self) {
        if let Some(mut service) = self.service.lock().await.take() {
            let _ = service.close_with_timeout(Duration::from_secs(4)).await;
        }
    }
}

#[cfg(test)]
mod tests;
