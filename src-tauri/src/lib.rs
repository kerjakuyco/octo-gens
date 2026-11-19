//! The desktop shell: a window, a keychain, and one command per studio action.
//!
//! All behaviour lives in `octoneo-core`. This crate only translates between
//! the web view and the [`Studio`]: commands take the arguments named in
//! `src/api/types.ts`, return a fresh [`Snapshot`], and fail with a plain
//! message the interface shows as-is. The web view has no network access of
//! its own; every request to the exchange or a model is made from here.

mod keychain;

use std::path::PathBuf;
use std::sync::Arc;

use octoneo_core::DeskError;
use octoneo_core::llm::ModelInfo;
use octoneo_core::mcp::{McpConnectRequest, ToolInfo};
use octoneo_core::model::Network;
use octoneo_core::store::{Provider, SecretStore, Theme};
use octoneo_core::studio::view::{
    AssistantRequest, CandleSeries, FundingRequest, FundingView, MarketRow, ModelsRequest, OrderBookView,
    RiskRequest, Snapshot, TechnicalsView, TicketRequest, TradeView, TurnEvent, TurnSink,
    WalletBrowserRequest, WalletKeyRequest,
};
use octoneo_core::studio::{Studio, StudioConfig};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_opener::OpenerExt;

type Desk<'a> = State<'a, Arc<Studio>>;
type Reply<T> = Result<T, String>;

/// Name of the event that carries snapshots produced by background work.
const SNAPSHOT_EVENT: &str = "snapshot";

fn message(error: DeskError) -> String {
    error.0
}

/// Forwards turn events to the web view over the command's own channel.
struct ChannelSink(Channel<TurnEvent>);

impl TurnSink for ChannelSink {
    fn emit(&self, event: TurnEvent) {
        // The window may have closed mid-turn; there is nobody left to tell.
        let _ = self.0.send(event);
    }
}

/// Where the desk keeps its files. `OCTONEO_DATA_DIR` overrides the default,
/// which is the same per-user folder earlier releases used.
fn data_directory(app: &AppHandle) -> Result<PathBuf, tauri::Error> {
    if let Some(custom) = std::env::var_os("OCTONEO_DATA_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(custom));
    }
    // The folder keeps the name the app had before it was called OctoNeo, so an
    // existing install finds its conversations and settings.
    let folder =
        if cfg!(any(target_os = "windows", target_os = "macos")) { "Octo Gens" } else { "octo-gens" };
    Ok(app.path().local_data_dir()?.join(folder))
}

/// Another origin for a network's API, from `OCTONEO_MAINNET_URL` or
/// `OCTONEO_TESTNET_URL`. Used by the smoke test, which serves a
/// stand-in for the exchange on this computer.
fn exchange_origin(network: Network) -> Option<String> {
    let name = match network {
        Network::Mainnet => "OCTONEO_MAINNET_URL",
        Network::Testnet => "OCTONEO_TESTNET_URL",
    };
    let value = std::env::var(name).ok()?;
    let value = value.trim();
    (value.starts_with("https://") || value.starts_with("http://")).then(|| value.to_string())
}

#[tauri::command]
async fn boot(studio: Desk<'_>) -> Reply<Snapshot> {
    studio.boot().await.map_err(message)
}

#[tauri::command]
async fn snapshot(studio: Desk<'_>) -> Reply<Snapshot> {
    Ok(studio.snapshot())
}

#[tauri::command]
async fn set_network(studio: Desk<'_>, network: Network) -> Reply<Snapshot> {
    studio.set_network(network).await.map_err(message)
}

#[tauri::command]
async fn select_symbol(studio: Desk<'_>, symbol: String) -> Reply<Snapshot> {
    studio.select_symbol(&symbol).await.map_err(message)
}

#[tauri::command]
async fn refresh_quotes(studio: Desk<'_>) -> Reply<Snapshot> {
    studio.refresh_quotes().await.map_err(message)
}

#[tauri::command]
async fn refresh_account(studio: Desk<'_>) -> Reply<Snapshot> {
    studio.refresh_account().await.map_err(message)
}

#[tauri::command]
async fn candles(studio: Desk<'_>, symbol: String, timeframe: String) -> Reply<CandleSeries> {
    studio.candles(&symbol, &timeframe).await.map_err(message)
}

#[tauri::command]
async fn market_overview(studio: Desk<'_>) -> Reply<Vec<MarketRow>> {
    studio.market_overview().await.map_err(message)
}

#[tauri::command]
async fn order_book(studio: Desk<'_>, symbol: String) -> Reply<OrderBookView> {
    studio.order_book(&symbol).await.map_err(message)
}

#[tauri::command]
async fn recent_trades(studio: Desk<'_>, symbol: String) -> Reply<Vec<TradeView>> {
    studio.recent_trades(&symbol).await.map_err(message)
}

#[tauri::command]
async fn market_funding(studio: Desk<'_>, symbol: String) -> Reply<FundingView> {
    studio.market_funding(&symbol).await.map_err(message)
}

#[tauri::command]
async fn market_technicals(studio: Desk<'_>, symbol: String) -> Reply<TechnicalsView> {
    studio.market_technicals(&symbol).await.map_err(message)
}

#[tauri::command]
async fn watch_add(studio: Desk<'_>, symbol: String) -> Reply<Snapshot> {
    studio.watch_add(&symbol).await.map_err(message)
}

#[tauri::command]
async fn watch_remove(studio: Desk<'_>, symbol: String) -> Reply<Snapshot> {
    studio.watch_remove(&symbol).map_err(message)
}

#[tauri::command]
async fn ask(studio: Desk<'_>, prompt: String, on_event: Channel<TurnEvent>) -> Reply<Snapshot> {
    studio.ask(&prompt, &ChannelSink(on_event)).await.map_err(message)
}

#[tauri::command]
async fn stop_turn(studio: Desk<'_>) -> Reply<()> {
    studio.stop_turn();
    Ok(())
}

#[tauri::command]
async fn new_thread(studio: Desk<'_>) -> Reply<Snapshot> {
    studio.new_thread().map_err(message)
}

#[tauri::command]
async fn open_thread(studio: Desk<'_>, id: String) -> Reply<Snapshot> {
    studio.open_thread(&id).map_err(message)
}

#[tauri::command]
async fn delete_thread(studio: Desk<'_>, id: String) -> Reply<Snapshot> {
    studio.delete_thread(&id).map_err(message)
}

#[tauri::command]
async fn prepare_ticket(studio: Desk<'_>, request: TicketRequest) -> Reply<Snapshot> {
    studio.prepare_ticket(request).await.map_err(message)
}

#[tauri::command]
async fn submit_ticket(studio: Desk<'_>, id: String) -> Reply<Snapshot> {
    studio.submit_ticket(&id).await.map_err(message)
}

#[tauri::command]
async fn dismiss_ticket(studio: Desk<'_>) -> Reply<Snapshot> {
    Ok(studio.dismiss_ticket())
}

#[tauri::command]
async fn close_position(studio: Desk<'_>, symbol: String) -> Reply<Snapshot> {
    studio.close_position(&symbol).await.map_err(message)
}

#[tauri::command]
async fn cancel_order(studio: Desk<'_>, symbol: String, order_id: String) -> Reply<Snapshot> {
    studio.cancel_order(&symbol, &order_id).await.map_err(message)
}

#[tauri::command]
async fn cancel_all_orders(studio: Desk<'_>, symbol: String) -> Reply<Snapshot> {
    studio.cancel_all_orders(&symbol).await.map_err(message)
}

#[tauri::command]
async fn connect_wallet_key(studio: Desk<'_>, request: WalletKeyRequest) -> Reply<Snapshot> {
    studio.connect_wallet_key(request).await.map_err(message)
}

/// Opens the wallet page a command just started. The page is served on this
/// computer, and the browser is where the trader's wallet lives. If no browser
/// opens, the interface shows the address to copy.
fn open_wallet_page(app: &AppHandle, snapshot: &Snapshot) {
    if let Some(pending) = &snapshot.pending_wallet {
        let _ = app.opener().open_url(pending.url.as_str(), None::<&str>);
    }
}

#[tauri::command]
async fn connect_wallet_browser(
    app: AppHandle,
    studio: Desk<'_>,
    request: WalletBrowserRequest,
) -> Reply<Snapshot> {
    let snapshot = studio.inner().connect_wallet_browser(request).await.map_err(message)?;
    open_wallet_page(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
async fn fund_wallet(app: AppHandle, studio: Desk<'_>, request: FundingRequest) -> Reply<Snapshot> {
    let snapshot = studio.inner().fund_wallet(request).await.map_err(message)?;
    open_wallet_page(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
async fn cancel_wallet_page(studio: Desk<'_>) -> Reply<Snapshot> {
    Ok(studio.cancel_wallet_page())
}

#[tauri::command]
async fn disconnect_wallet(studio: Desk<'_>, network: Network) -> Reply<Snapshot> {
    studio.disconnect_wallet(network).map_err(message)
}

#[tauri::command]
async fn save_risk(studio: Desk<'_>, request: RiskRequest) -> Reply<Snapshot> {
    studio.save_risk(request).map_err(message)
}

#[tauri::command]
async fn mcp_connect(studio: Desk<'_>, request: McpConnectRequest) -> Reply<Snapshot> {
    studio.mcp_connect(request).await.map_err(message)
}

#[tauri::command]
async fn mcp_disconnect(studio: Desk<'_>, id: String) -> Reply<Snapshot> {
    studio.mcp_disconnect(&id).await.map_err(message)
}

#[tauri::command]
async fn mcp_tools(studio: Desk<'_>, id: String) -> Reply<Vec<ToolInfo>> {
    studio.mcp_tools(&id).await.map_err(message)
}

#[tauri::command]
async fn mcp_call(studio: Desk<'_>, id: String, name: String, args: serde_json::Value) -> Reply<String> {
    studio.mcp_call(&id, &name, args).await.map_err(message)
}

#[tauri::command]
async fn list_models(studio: Desk<'_>, request: ModelsRequest) -> Reply<Vec<ModelInfo>> {
    studio.list_models(request).await.map_err(message)
}

#[tauri::command]
async fn save_assistant(studio: Desk<'_>, request: AssistantRequest) -> Reply<Snapshot> {
    studio.save_assistant(request).await.map_err(message)
}

#[tauri::command]
async fn forget_provider(studio: Desk<'_>, provider: Provider) -> Reply<Snapshot> {
    studio.forget_provider(provider).map_err(message)
}

#[tauri::command]
async fn set_theme(studio: Desk<'_>, theme: Theme) -> Reply<Snapshot> {
    studio.set_theme(theme).map_err(message)
}

#[tauri::command]
async fn set_web_search(studio: Desk<'_>, on: bool) -> Reply<Snapshot> {
    studio.set_web_search(on).map_err(message)
}

/// The self-test, for debug builds started with `OCTONEO_SELFTEST=1`.
///
/// `scripts/smoke.mjs --e2e` serves a stand-in for the exchange's testnet and a
/// stand-in for a model server on this computer, and points the app at both.
/// The app then connects a throwaway wallet and the stand-in model, and drives
/// one order through its own window: it types a message, the model drafts a
/// ticket, and the script confirms it. The stand-in exchange must receive that
/// order, signed. This proves the interface, the IPC channel, the assistant
/// loop, the core and the signing work together in the real web view. None of
/// it is compiled into a release build.
#[cfg(debug_assertions)]
mod selftest {
    use super::*;

    /// The example API wallet from the exchange's API documentation. It is public and holds nothing.
    const USER: &str = "0x63DD5aCC6b1aa0f563956C0e534DD30B6dcF7C4e";
    const AGENT_KEY: &str = "0x4fd0a42218f3eae43a6ce26d22544e986139a01e5b34a62db53757ffca81bae1";

    const SCRIPT: &str = r#"(async () => {
  const wait = (find, ms = 20000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = find();
      if (found) resolve(found);
      else if (Date.now() - started > ms) reject(new Error("timed out"));
      else setTimeout(tick, 100);
    };
    tick();
  });
  const button = (label) => [...document.querySelectorAll("button")].find(
    (b) => !b.disabled && (b.getAttribute("aria-label") === label || b.textContent.trim() === label),
  );
  const box = await wait(() => document.querySelector("textarea"));
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, "Long 0.01 BTC, stop at 60000");
  box.dispatchEvent(new Event("input", { bubbles: true }));
  (await wait(() => button("Send"))).click();
  (await wait(() => button("Place order"))).click();
})().catch((error) => console.error("selftest", error));"#;

    /// The model the stand-in server offers.
    const MODEL: &str = "selftest/model";

    pub fn wanted() -> bool {
        std::env::var_os("OCTONEO_SELFTEST").is_some()
    }

    /// Puts the desk on testnet with the throwaway wallet and the stand-in model
    /// before the window asks for anything. The model is connected the way a
    /// trader connects LM Studio: by the address of a server on this computer.
    pub fn prepare(studio: &Arc<Studio>) {
        let request = WalletKeyRequest {
            network: Network::Testnet,
            user: USER.to_string(),
            agent_key: AGENT_KEY.to_string(),
        };
        let model = AssistantRequest {
            provider: Provider::LmStudio,
            model: MODEL.to_string(),
            key: None,
            account: None,
            gateway: None,
            url: std::env::var("OCTONEO_SELFTEST_MODEL_URL").ok(),
            effort: octoneo_core::store::Effort::Auto,
            live_tickets: false,
        };
        let prepared = tauri::async_runtime::block_on(async {
            // The news is the one thing here that no stand-in serves, and the self-test must not reach the internet.
            studio.set_web_search(false)?;
            studio.set_network(Network::Testnet).await?;
            studio.connect_wallet_key(request).await?;
            studio.save_assistant(model).await
        });
        if let Err(error) = prepared {
            eprintln!("selftest: the desk could not be prepared: {error}");
        }
    }

    pub fn drive(app: &AppHandle) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            // Give the web view a moment to load the page; the script itself waits for the interface.
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(SCRIPT);
            }
        });
    }
}

/// Where secrets are kept: the system keychain. With `OCTONEO_NO_KEYCHAIN` set
/// they are kept in memory for the session instead. Test runs use that, so they
/// never read a real key, never leave a test key behind, and never wait on the
/// system's question whether this build may open the keychain.
fn secret_store() -> Arc<dyn SecretStore> {
    let in_memory = std::env::var_os("OCTONEO_NO_KEYCHAIN").is_some_and(|value| !value.is_empty());
    #[cfg(debug_assertions)]
    let in_memory = in_memory || selftest::wanted();
    if in_memory {
        return Arc::new(octoneo_core::store::MemorySecrets::default());
    }
    Arc::new(keychain::Keychain::default())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let mut config = StudioConfig::new(data_directory(&handle)?, secret_store());
            for network in Network::ALL {
                if let Some(origin) = exchange_origin(network) {
                    config.exchange_bases.insert(network, origin);
                }
            }
            let studio = Studio::open(config).map_err(|error| error.0)?;
            // Background work (a wallet page finishing in the browser) pushes its snapshot to the window.
            studio.set_notifier(move |snapshot| {
                let _ = handle.emit(SNAPSHOT_EVENT, snapshot);
            });
            #[cfg(debug_assertions)]
            if selftest::wanted() {
                selftest::prepare(&studio);
                selftest::drive(app.handle());
            }
            app.manage(studio);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            boot,
            snapshot,
            set_network,
            select_symbol,
            refresh_quotes,
            refresh_account,
            candles,
            market_overview,
            order_book,
            recent_trades,
            market_funding,
            market_technicals,
            watch_add,
            watch_remove,
            ask,
            stop_turn,
            new_thread,
            open_thread,
            delete_thread,
            prepare_ticket,
            submit_ticket,
            dismiss_ticket,
            close_position,
            cancel_order,
            cancel_all_orders,
            connect_wallet_key,
            connect_wallet_browser,
            fund_wallet,
            cancel_wallet_page,
            disconnect_wallet,
            save_risk,
            mcp_connect,
            mcp_disconnect,
            mcp_tools,
            mcp_call,
            list_models,
            save_assistant,
            forget_provider,
            set_theme,
            set_web_search,
        ])
        .build(tauri::generate_context!());

    match app {
        Ok(app) => app.run(|handle, event| {
            if let RunEvent::Exit = event {
                // Close a waiting wallet page and shut down any tool server this app started.
                if let Some(studio) = handle.try_state::<Arc<Studio>>() {
                    tauri::async_runtime::block_on(studio.close());
                }
            }
        }),
        Err(error) => {
            eprintln!("OctoNeo could not start: {error}");
            std::process::exit(1);
        }
    }
}
