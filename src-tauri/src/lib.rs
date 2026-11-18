//! The desktop shell: a window, a keychain, and one command per studio action.
//!
//! All behaviour lives in `octogens-core`. This crate only translates between
//! the web view and the [`Studio`]: commands take the arguments named in
//! `src/api/types.ts`, return a fresh [`Snapshot`], and fail with a plain
//! message the interface shows as-is. The web view has no network access of
//! its own; every request to an exchange or a model is made from here.

mod keychain;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use octogens_core::DeskError;
use octogens_core::llm::openrouter::ModelInfo;
use octogens_core::mcp::{McpConnectRequest, ToolInfo};
use octogens_core::model::{Feed, VenueId};
use octogens_core::store::Theme;
use octogens_core::studio::view::{
    AssistantRequest, BalanceRow, CandleSeries, CredentialsRequest, Snapshot, TicketRequest, TurnEvent,
    TurnSink,
};
use octogens_core::studio::{Studio, StudioConfig};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

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

/// Shell-only state.
#[derive(Default)]
struct Shell {
    /// The last live feed is restored once per launch, not on every reload.
    restored: AtomicBool,
}

/// Where the desk keeps its files. `OCTOGENS_DATA_DIR` overrides the default,
/// which is the same per-user folder earlier releases used.
fn data_directory(app: &AppHandle) -> Result<PathBuf, tauri::Error> {
    if let Some(custom) = std::env::var_os("OCTOGENS_DATA_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(custom));
    }
    let folder =
        if cfg!(any(target_os = "windows", target_os = "macos")) { "Octo Gens" } else { "octo-gens" };
    Ok(app.path().local_data_dir()?.join(folder))
}

#[tauri::command]
async fn boot(app: AppHandle, studio: Desk<'_>, shell: State<'_, Shell>) -> Reply<Snapshot> {
    let snapshot = studio.boot().await.map_err(message)?;
    if !shell.restored.swap(true, Ordering::SeqCst) {
        // The window opens on the sample tape at once; last session's live feed follows.
        let studio = Arc::clone(&studio);
        tauri::async_runtime::spawn(async move {
            let restored = studio.restore_feed().await;
            if restored.feed != Feed::Sample || !restored.feed_error.is_empty() {
                let _ = app.emit(SNAPSHOT_EVENT, restored);
            }
        });
    }
    Ok(snapshot)
}

#[tauri::command]
async fn snapshot(studio: Desk<'_>) -> Reply<Snapshot> {
    Ok(studio.snapshot())
}

#[tauri::command]
async fn set_feed(studio: Desk<'_>, feed: Feed) -> Reply<Snapshot> {
    studio.set_feed(feed).await.map_err(message)
}

#[tauri::command]
async fn select_pair(studio: Desk<'_>, pair: String) -> Reply<Snapshot> {
    studio.select_pair(&pair).await.map_err(message)
}

#[tauri::command]
async fn refresh_quotes(studio: Desk<'_>) -> Reply<Snapshot> {
    studio.refresh_quotes().await.map_err(message)
}

#[tauri::command]
async fn candles(studio: Desk<'_>, pair: String, timeframe: String) -> Reply<CandleSeries> {
    studio.candles(&pair, &timeframe).await.map_err(message)
}

#[tauri::command]
async fn watch_add(studio: Desk<'_>, symbol: String) -> Reply<Snapshot> {
    studio.watch_add(&symbol).await.map_err(message)
}

#[tauri::command]
async fn watch_remove(studio: Desk<'_>, pair: String) -> Reply<Snapshot> {
    studio.watch_remove(&pair).map_err(message)
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
    Ok(studio.new_thread())
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
async fn run_pattern(studio: Desk<'_>, pair: String, budget: String) -> Reply<Snapshot> {
    studio.run_pattern(&pair, &budget).await.map_err(message)
}

#[tauri::command]
async fn start_watch(studio: Desk<'_>, pair: String, budget: String) -> Reply<Snapshot> {
    studio.inner().start_watch(&pair, &budget).await.map_err(message)
}

#[tauri::command]
async fn stop_watch(studio: Desk<'_>) -> Reply<Snapshot> {
    studio.stop_watch();
    Ok(studio.snapshot())
}

#[tauri::command]
async fn set_credentials(studio: Desk<'_>, request: CredentialsRequest) -> Reply<Snapshot> {
    studio.set_credentials(request).await.map_err(message)
}

#[tauri::command]
async fn clear_credentials(studio: Desk<'_>, venue: VenueId) -> Reply<Snapshot> {
    studio.clear_credentials(venue).map_err(message)
}

#[tauri::command]
async fn balances(studio: Desk<'_>, venue: VenueId) -> Reply<Vec<BalanceRow>> {
    studio.balances(venue).await.map_err(message)
}

#[tauri::command]
async fn mcp_connect(studio: Desk<'_>, request: McpConnectRequest) -> Reply<Snapshot> {
    studio.mcp_connect(request).await.map_err(message)
}

#[tauri::command]
async fn mcp_disconnect(studio: Desk<'_>, venue: VenueId) -> Reply<Snapshot> {
    studio.mcp_disconnect(venue).await.map_err(message)
}

#[tauri::command]
async fn mcp_tools(studio: Desk<'_>, venue: VenueId) -> Reply<Vec<ToolInfo>> {
    studio.mcp_tools(venue).await.map_err(message)
}

#[tauri::command]
async fn mcp_call(studio: Desk<'_>, venue: VenueId, name: String, args: serde_json::Value) -> Reply<String> {
    studio.mcp_call(venue, &name, args).await.map_err(message)
}

#[tauri::command]
async fn list_models(studio: Desk<'_>, key: Option<String>) -> Reply<Vec<ModelInfo>> {
    studio.list_models(key).await.map_err(message)
}

#[tauri::command]
async fn save_assistant(studio: Desk<'_>, request: AssistantRequest) -> Reply<Snapshot> {
    studio.save_assistant(request).await.map_err(message)
}

#[tauri::command]
async fn set_theme(studio: Desk<'_>, theme: Theme) -> Reply<Snapshot> {
    studio.set_theme(theme).map_err(message)
}

/// Drives one paper order through the real window: type it, send it, confirm the
/// ticket. `scripts/smoke.mjs --e2e` starts a debug build with
/// `OCTOGENS_SELFTEST=1` and then looks for the fill in the journal, which proves
/// the interface, the IPC channel and the core work together in the real web view.
#[cfg(debug_assertions)]
const SELFTEST: &str = r#"(async () => {
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
  const button = (label) => [...document.querySelectorAll("button")].find((b) => b.textContent.includes(label) && !b.disabled);
  const box = await wait(() => document.querySelector("textarea"));
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, "buy 0.01 BTC");
  box.dispatchEvent(new Event("input", { bubbles: true }));
  (await wait(() => button("Send"))).click();
  (await wait(() => button("Place paper order"))).click();
})().catch((error) => console.error("selftest", error));"#;

#[cfg(debug_assertions)]
fn selftest(app: &AppHandle) {
    if std::env::var_os("OCTOGENS_SELFTEST").is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Give the web view a moment to load the page; the script itself waits for the interface.
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval(SELFTEST);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Shell::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let config = StudioConfig::new(data_directory(&handle)?, Arc::new(keychain::Keychain::default()));
            let studio = Studio::open(config).map_err(|error| error.0)?;
            // Background work (the pattern watch) pushes its snapshots to the window.
            studio.set_notifier(move |snapshot| {
                let _ = handle.emit(SNAPSHOT_EVENT, snapshot);
            });
            app.manage(studio);
            #[cfg(debug_assertions)]
            selftest(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            boot,
            snapshot,
            set_feed,
            select_pair,
            refresh_quotes,
            candles,
            watch_add,
            watch_remove,
            ask,
            stop_turn,
            new_thread,
            prepare_ticket,
            submit_ticket,
            dismiss_ticket,
            run_pattern,
            start_watch,
            stop_watch,
            set_credentials,
            clear_credentials,
            balances,
            mcp_connect,
            mcp_disconnect,
            mcp_tools,
            mcp_call,
            list_models,
            save_assistant,
            set_theme,
        ])
        .build(tauri::generate_context!());

    match app {
        Ok(app) => app.run(|handle, event| {
            if let RunEvent::Exit = event {
                // Stop the watch and shut down any exchange tool server this app started.
                if let Some(studio) = handle.try_state::<Arc<Studio>>() {
                    tauri::async_runtime::block_on(studio.close());
                }
            }
        }),
        Err(error) => {
            eprintln!("Octo Gens could not start: {error}");
            std::process::exit(1);
        }
    }
}
