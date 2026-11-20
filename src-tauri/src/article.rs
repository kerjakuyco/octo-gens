//! The article view: a news story's own page, opened inside the window.
//!
//! It is a second web view, drawn over the main one in the room the interface
//! leaves for it. It shows a publisher's page the way a browser would, so it is
//! kept apart from everything else:
//! - it cannot call the app's commands: Tauri refuses commands from remote
//!   pages, the capability names only the main web view, and every command
//!   checks which web view asked (see `run` in `lib.rs`);
//! - it keeps no cookies or storage once it is closed;
//! - it moves only to ordinary public `https` pages; other schemes, addresses
//!   on this computer or the local network, and downloads are refused;
//! - a link that asks for a new window opens in the same view.
//!
//! The interface measures the room it leaves and passes it in CSS pixels, and
//! hears what the view is showing through the `article` event.
//!
//! Each view gets a label of its own. Closing a web view finishes later, on the
//! event loop, so a view opened straight after another closed must not be taken
//! for it; and what a closing view still reports is not passed on.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::{Color, NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Rect, Runtime, Url, Webview,
    WebviewBuilder, WebviewUrl,
};

use crate::MAIN;

/// The labels of article views begin with this; each view adds a number of its own.
const LABEL: &str = "article";
/// The event that tells the interface what the article view is showing.
const EVENT: &str = "article";
/// What the view shows before the page draws: most news pages are white.
const PAPER: Color = Color(255, 255, 255, 255);

/// Where the article view sits, in CSS pixels from the top-left of the window.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Bounds {
    fn rect(self) -> Result<Rect, String> {
        let parts = [self.x, self.y, self.width, self.height];
        if parts.iter().any(|part| !part.is_finite()) || self.width < 0.0 || self.height < 0.0 {
            return Err("The article view was given a place it cannot take.".to_string());
        }
        Ok(Rect {
            position: LogicalPosition::new(self.x.max(0.0), self.y.max(0.0)).into(),
            size: LogicalSize::new(self.width.max(1.0), self.height.max(1.0)).into(),
        })
    }
}

/// What the article view shows, as the interface is told it.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Showing {
    url: String,
    title: Option<String>,
    loading: bool,
}

#[derive(Default)]
struct Current {
    /// The open view's label, if one is open.
    label: Option<String>,
    /// How many views were opened, for the next label.
    opened: u64,
    showing: Showing,
}

/// The article view that is open, and what it is showing.
#[derive(Default)]
pub struct ArticleState(Mutex<Current>);

fn current<R: Runtime>(app: &AppHandle<R>) -> std::sync::MutexGuard<'_, Current> {
    app.state::<ArticleState>().inner().0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Changes what the view labelled `label` is showing and tells the interface,
/// and only the interface. A view that is no longer the open one is not heard.
fn tell<R: Runtime>(app: &AppHandle<R>, label: &str, change: impl FnOnce(&mut Showing)) {
    let showing = {
        let mut current = current(app);
        if current.label.as_deref() != Some(label) {
            return;
        }
        change(&mut current.showing);
        current.showing.clone()
    };
    let _ = app.emit_to(EventTarget::Webview { label: MAIN.to_string() }, EVENT, showing);
}

/// Whether the view may go to `url`. On macOS this is asked for every frame of
/// a page as well, so the blank, blob and data frames pages build for
/// themselves are let through; they cannot leave the page they belong to.
fn allowed(url: &Url) -> bool {
    match url.scheme() {
        "https" => octoneo_core::web::public_link(url.as_str()).is_ok(),
        "about" | "blob" | "data" => true,
        _ => false,
    }
}

/// The open article view, if there is one.
fn view<R: Runtime>(app: &AppHandle<R>) -> Option<Webview<R>> {
    let label = current(app).label.clone()?;
    app.get_webview(&label)
}

fn failed(error: tauri::Error) -> String {
    format!("The article view failed: {error}.")
}

/// Opens `address` in the article view at `bounds`, creating the view if none is open.
pub fn open<R: Runtime>(app: &AppHandle<R>, address: &str, bounds: Bounds) -> Result<(), String> {
    let link = octoneo_core::web::public_link(address).map_err(|error| error.0)?;
    let url = Url::parse(&link).map_err(|_| "That link cannot be opened.".to_string())?;
    let rect = bounds.rect()?;
    if let Some(view) = view(app) {
        let label = view.label().to_string();
        tell(app, &label, |showing| *showing = Showing { url: url.to_string(), title: None, loading: true });
        view.navigate(url).map_err(failed)?;
        view.set_bounds(rect).map_err(failed)?;
        return view.show().map_err(failed);
    }
    let window = app.get_window(MAIN).ok_or_else(|| "The window is gone.".to_string())?;
    let label = {
        let mut current = current(app);
        current.opened += 1;
        let label = format!("{LABEL}-{}", current.opened);
        current.label = Some(label.clone());
        current.showing = Showing { url: url.to_string(), title: None, loading: true };
        label
    };
    let handle = app.clone();
    let titled = app.clone();
    let loaded = app.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .incognito(true)
        .background_color(PAPER)
        .zoom_hotkeys_enabled(true)
        // The keys stay with the interface, so Escape still goes back, until the reader clicks into the page.
        .focused(false)
        .on_navigation(allowed)
        .on_new_window(move |url, _features| {
            // A link meant for another window opens here; there is no other window.
            if allowed(&url) && url.scheme() == "https" {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(view) = view(&handle) {
                        let _ = view.navigate(url);
                    }
                });
            }
            NewWindowResponse::Deny
        })
        .on_download(|_, _| false)
        .on_page_load(move |view, payload| {
            let url = payload.url().to_string();
            match payload.event() {
                PageLoadEvent::Started => tell(&loaded, view.label(), |showing| {
                    *showing = Showing { url, title: None, loading: true };
                }),
                PageLoadEvent::Finished => tell(&loaded, view.label(), |showing| {
                    showing.url = url;
                    showing.loading = false;
                }),
            }
        })
        .on_document_title_changed(move |view, title| {
            let title = title.trim().to_string();
            tell(&titled, view.label(), |showing| showing.title = (!title.is_empty()).then_some(title));
        });
    if let Err(error) = window.add_child(builder, rect.position, rect.size) {
        current(app).label = None;
        return Err(failed(error));
    }
    Ok(())
}

/// Moves or resizes the article view.
pub fn place<R: Runtime>(app: &AppHandle<R>, bounds: Bounds) -> Result<(), String> {
    let rect = bounds.rect()?;
    match view(app) {
        Some(view) => view.set_bounds(rect).map_err(failed),
        None => Ok(()),
    }
}

/// Hides the article view while the interface draws something where it is, or shows it again.
pub fn show<R: Runtime>(app: &AppHandle<R>, shown: bool) -> Result<(), String> {
    match view(app) {
        Some(view) if shown => view.show().map_err(failed),
        Some(view) => view.hide().map_err(failed),
        None => Ok(()),
    }
}

/// Loads the article view's page again.
pub fn reload<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    match view(app) {
        Some(view) => view.reload().map_err(failed),
        None => Ok(()),
    }
}

/// Closes the article view, and with it the page's cookies and storage. From
/// here on nothing it still reports reaches the interface.
pub fn close<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let view = view(app);
    {
        let mut current = current(app);
        current.label = None;
        current.showing = Showing::default();
    }
    match view {
        Some(view) => view.close().map_err(failed),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_view_goes_only_to_public_https_pages_and_the_frames_pages_build() {
        let url = |text: &str| Url::parse(text).expect(text);
        for fine in [
            "https://www.example.com/markets/2026/11/20/story",
            "about:blank",
            "about:srcdoc",
            "blob:https://www.example.com/0d4c",
            "data:text/html,<p>frame</p>",
        ] {
            assert!(allowed(&url(fine)), "{fine}");
        }
        for refused in [
            "http://www.example.com/story",
            "https://localhost/admin",
            "https://192.168.1.1/",
            "https://router.local/",
            "https://www.example.com:8443/",
            "tauri://localhost/",
            "http://tauri.localhost/",
            "newsimg://localhost/x",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:someone@example.com",
            "zoommtg://join",
        ] {
            assert!(!allowed(&url(refused)), "{refused}");
        }
    }

    #[test]
    fn a_place_must_be_real() {
        let bounds = |x: f64, y: f64, width: f64, height: f64| Bounds { x, y, width, height };
        assert!(bounds(240.0, 56.0, 900.0, 700.0).rect().is_ok());
        // A rect measured mid-layout can be empty; it still makes a view, one pixel wide.
        assert!(bounds(0.0, 0.0, 0.0, 0.0).rect().is_ok());
        for broken in [
            bounds(f64::NAN, 0.0, 10.0, 10.0),
            bounds(0.0, 0.0, f64::INFINITY, 10.0),
            bounds(0.0, 0.0, -1.0, 10.0),
        ] {
            assert!(broken.rect().is_err(), "{broken:?}");
        }
    }
}
