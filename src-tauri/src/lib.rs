//! The desktop shell: a window, a keychain, and one command per studio action.
//!
//! All behaviour lives in `octoneo-core`. This crate only translates between
//! the web view and the [`Studio`]: commands take the arguments named in
//! `src/api/types.ts`, return a fresh [`Snapshot`], and fail with a plain
//! message the interface shows as-is. The web view has no network access of
//! its own; every request to the exchange or a model is made from here,
//! including the pictures of news stories, which it loads from the
//! `newsimg` scheme. A news article opens in a second web view that only
//! shows the publisher's page (see `article`): it cannot call commands.

mod article;
mod keychain;
mod updater;

use std::path::PathBuf;
use std::sync::Arc;

use octoneo_core::DeskError;
use octoneo_core::llm::ModelInfo;
use octoneo_core::mcp::{McpConnectRequest, ToolInfo};
use octoneo_core::model::Network;
use octoneo_core::store::{Provider, SecretStore, Theme};
use octoneo_core::studio::view::{
    AssistantRequest, CandleSeries, FundingRequest, FundingView, MarketRow, ModelsRequest, NewsFeedView,
    OrderBookView, RiskRequest, Snapshot, TechnicalsView, TicketRequest, TradeView, TurnEvent, TurnSink,
    WalletBrowserRequest, WalletKeyRequest,
};
use octoneo_core::studio::{Studio, StudioConfig};
use tauri::http::{Response, StatusCode, header};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, EventTarget, Manager, RunEvent, State};
use tauri_plugin_opener::OpenerExt;

type Desk<'a> = State<'a, Arc<Studio>>;
type Reply<T> = Result<T, String>;

/// The label of the window, and of the web view that draws the interface.
pub(crate) const MAIN: &str = "main";
/// Name of the event that carries snapshots produced by background work.
const SNAPSHOT_EVENT: &str = "snapshot";
/// The scheme the interface loads story pictures from: `newsimg://localhost/<address>`,
/// or `http://newsimg.localhost/<address>` on Windows, as `convertFileSrc` writes it.
const PICTURES: &str = "newsimg";

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

#[tauri::command]
async fn news_feed(studio: Desk<'_>) -> Reply<NewsFeedView> {
    studio.news_feed().await.map_err(message)
}

#[tauri::command]
async fn article_open(app: AppHandle, url: String, bounds: article::Bounds) -> Reply<()> {
    article::open(&app, &url, bounds)
}

#[tauri::command]
async fn article_bounds(app: AppHandle, bounds: article::Bounds) -> Reply<()> {
    article::place(&app, bounds)
}

#[tauri::command]
async fn article_shown(app: AppHandle, shown: bool) -> Reply<()> {
    article::show(&app, shown)
}

#[tauri::command]
async fn article_reload(app: AppHandle) -> Reply<()> {
    article::reload(&app)
}

#[tauri::command]
async fn article_close(app: AppHandle) -> Reply<()> {
    article::close(&app)
}

/// `%XX` escapes decoded, as `encodeURIComponent` writes them. `None` if they do not make UTF-8.
fn unescape(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let pair = std::str::from_utf8(bytes.get(at + 1..at + 3)?).ok()?;
            out.push(u8::from_str_radix(pair, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Answers a picture request from the interface. The core fetches the picture,
/// and only one it offered with a story; anything else is not found.
async fn picture(studio: Arc<Studio>, path: String) -> Response<Vec<u8>> {
    let not_found = || {
        let mut response = Response::new(Vec::new());
        *response.status_mut() = StatusCode::NOT_FOUND;
        response
    };
    let Some(address) = unescape(path.trim_start_matches('/')) else {
        return not_found();
    };
    match studio.news_picture(&address).await {
        Ok(picture) => Response::builder()
            .header(header::CONTENT_TYPE, picture.content_type)
            .header(header::CACHE_CONTROL, "max-age=3600")
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .body(picture.bytes)
            .unwrap_or_else(|_| not_found()),
        Err(_) => not_found(),
    }
}

#[tauri::command]
async fn check_update(
    app: AppHandle,
    state: State<'_, updater::UpdaterState>,
) -> Reply<updater::UpdateCheckResult> {
    #[cfg(debug_assertions)]
    if selftest::wanted() {
        return Ok(updater::UpdateCheckResult::UpToDate {
            current_version: app.package_info().version.to_string(),
            release_url: "https://github.com/kerjakuyco/octo-neo/releases".to_string(),
        });
    }
    updater::check(&app, &state).await
}

#[tauri::command]
async fn download_update(
    state: State<'_, updater::UpdaterState>,
    on_event: Channel<updater::UpdateProgress>,
) -> Reply<()> {
    updater::download(&state, &on_event).await
}

#[tauri::command]
async fn install_update(
    app: AppHandle,
    studio: Desk<'_>,
    state: State<'_, updater::UpdaterState>,
) -> Reply<()> {
    updater::install(&app, studio.inner(), &state).await
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
    let commands: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
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
        check_update,
        download_update,
        install_update,
        news_feed,
        article_open,
        article_bounds,
        article_shown,
        article_reload,
        article_close,
    ];
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_asynchronous_uri_scheme_protocol(PICTURES, |context, request, responder| {
            let studio = context.app_handle().try_state::<Arc<Studio>>().map(|studio| studio.inner().clone());
            // The whole address is the path. Take the query too, in case the web view decoded a `%3F`.
            let path =
                request.uri().path_and_query().map(|value| value.as_str().to_string()).unwrap_or_default();
            match studio {
                // Only the interface shows pictures; the article view never asks.
                Some(studio) if context.webview_label() == MAIN => {
                    tauri::async_runtime::spawn(
                        async move { responder.respond(picture(studio, path).await) },
                    );
                }
                _ => {
                    let mut response = Response::new(Vec::new());
                    *response.status_mut() = StatusCode::NOT_FOUND;
                    responder.respond(response);
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let mut config = StudioConfig::new(data_directory(&handle)?, secret_store());
            for network in Network::ALL {
                if let Some(origin) = exchange_origin(network) {
                    config.exchange_bases.insert(network, origin);
                }
            }
            let studio = Studio::open(config).map_err(|error| error.0)?;
            // Background work (a wallet page finishing in the browser) pushes its snapshot to the
            // interface, and only to it: the article view shows other people's pages.
            studio.set_notifier(move |snapshot| {
                let _ = handle.emit_to(
                    EventTarget::Webview { label: MAIN.to_string() },
                    SNAPSHOT_EVENT,
                    snapshot,
                );
            });
            #[cfg(debug_assertions)]
            if selftest::wanted() {
                selftest::prepare(&studio);
                selftest::drive(app.handle());
            }
            app.manage(studio);
            app.manage(updater::UpdaterState::default());
            app.manage(article::ArticleState::default());
            Ok(())
        })
        // Commands answer the interface only. Tauri already refuses them to remote pages such
        // as the article view's; this holds even if a page there ever counted as the app's own.
        .invoke_handler(move |invoke| {
            if invoke.message.webview_ref().label() != MAIN {
                invoke.resolver.reject("Only the app's own window can do that.");
                return true;
            }
            commands(invoke)
        })
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

#[cfg(test)]
mod tests {
    use super::unescape;

    #[test]
    fn a_picture_address_comes_back_whole_from_its_escaped_path() {
        // What `convertFileSrc` makes of a picture's address, with and without the web view decoding parts of it.
        let address = "https://images.example.com/2026/11/btc.jpg?width=800&q=80";
        for path in [
            "https%3A%2F%2Fimages.example.com%2F2026%2F11%2Fbtc.jpg%3Fwidth%3D800%26q%3D80",
            "https://images.example.com/2026/11/btc.jpg?width=800&q=80",
        ] {
            assert_eq!(unescape(path).as_deref(), Some(address), "{path}");
        }
        assert_eq!(unescape("caf%C3%A9").as_deref(), Some("café"));
        for broken in ["%", "%4", "%zz", "%C3"] {
            assert_eq!(unescape(broken), None, "{broken}");
        }
    }
}
