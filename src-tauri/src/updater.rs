//! Cross-platform semi-automatic updates backed by GitHub Releases.
//!
//! When a Tauri updater public key is configured in `tauri.conf.json` and the
//! latest release ships a signed `latest.json` manifest, updates are verified
//! with minisign, downloaded with progress streaming, and installed in place
//! once the trader confirms. When no signing key or manifest is available for
//! the current package format, the check falls back to the GitHub Releases API
//! and links straight to the release page for manual installation.
//!
//! Installing differs by platform, inside the updater plugin:
//! - macOS swaps the `.app` bundle in place (asking for an administrator's
//!   password when its folder is not writable), then OctoNeo restarts itself.
//! - Linux replaces the AppImage, or installs the `.deb`/`.rpm` through
//!   `pkexec`, then OctoNeo restarts itself.
//! - Windows starts the NSIS or MSI installer in passive mode and ends the
//!   process at once; the installer starts OctoNeo again when it is done.
//!   Because the process ends inside the plugin, the app's own shutdown is run
//!   from the plugin's `on_before_exit` hook instead.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use octoneo_core::studio::Studio;
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::ipc::Channel;
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};
use tokio::sync::Mutex;

const REPO: &str = "kerjakuyco/octo-neo";
const RELEASES_URL: &str = "https://github.com/kerjakuyco/octo-neo/releases";
const LATEST_RELEASE_API: &str = "https://api.github.com/repos/kerjakuyco/octo-neo/releases/latest";
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const PROGRESS_STEP_BYTES: u64 = 64 * 1024;
/// Appended to every install failure: the installer on the release page always works.
const MANUAL_INSTALL: &str = "You can download the installer from the release page instead.";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub date: Option<String>,
    pub notes: String,
    pub release_url: String,
    /// True when a signed updater bundle can be downloaded and installed in-app.
    /// False when the trader should download the installer from GitHub Releases.
    pub can_install: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdateCheckResult {
    Available(UpdateInfo),
    UpToDate {
        #[serde(rename = "currentVersion")]
        current_version: String,
        #[serde(rename = "releaseUrl")]
        release_url: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum UpdateProgress {
    Started {
        #[serde(rename = "contentLength")]
        content_length: Option<u64>,
    },
    Progress {
        downloaded: u64,
        #[serde(rename = "contentLength")]
        content_length: Option<u64>,
    },
    Downloaded,
}

#[derive(Default)]
struct PendingUpdate {
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}

/// Holds the signed update handle and verified payload between check, download, and install.
#[derive(Default)]
pub struct UpdaterState {
    inner: Mutex<PendingUpdate>,
    /// Set by the Windows `on_before_exit` hook once it has shut the studio down for the installer.
    closed_for_install: Arc<AtomicBool>,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: Option<String>,
    published_at: Option<String>,
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

fn clean_version(raw: &str) -> String {
    raw.trim().trim_start_matches(['v', 'V']).to_string()
}

fn parse_version(raw: &str) -> Option<Version> {
    Version::parse(&clean_version(raw)).ok()
}

fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(next), Some(now)) => next > now,
        _ => false,
    }
}

fn release_tag_url(version: &str) -> String {
    let clean = clean_version(version);
    let safe = !clean.is_empty()
        && clean.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'));
    if safe { format!("{RELEASES_URL}/tag/v{clean}") } else { RELEASES_URL.to_string() }
}

fn safe_release_url(candidate: Option<&str>, version: &str) -> String {
    let prefix = format!("https://github.com/{REPO}/releases/");
    if let Some(url) = candidate.map(str::trim)
        && url.starts_with(&prefix)
    {
        return url.to_string();
    }
    release_tag_url(version)
}

fn updater_config(app: &AppHandle) -> Option<serde_json::Value> {
    app.config().plugins.0.get("updater").cloned()
}

fn has_signing_pubkey(app: &AppHandle) -> bool {
    updater_config(app)
        .as_ref()
        .and_then(|config| config.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|key| !key.trim().is_empty())
}

/// True only for a build whose config opts into the plugin's insecure transport, which a
/// test build serving `latest.json` from this computer does. Release builds never set it.
fn insecure_transport_allowed(app: &AppHandle) -> bool {
    updater_config(app)
        .as_ref()
        .and_then(|config| config.get("dangerousInsecureTransportProtocol"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

/// Updates download over HTTPS. Plain HTTP is accepted only from this computer, and only when
/// the build opted into insecure transport for a local update test; the package's signature is
/// verified either way.
fn download_allowed(scheme: &str, host: Option<&str>, insecure_transport: bool) -> bool {
    scheme == "https"
        || (insecure_transport
            && scheme == "http"
            && matches!(host, Some("127.0.0.1" | "localhost" | "[::1]")))
}

fn update_download_allowed(update: &Update, insecure_transport: bool) -> bool {
    download_allowed(update.download_url.scheme(), update.download_url.host_str(), insecure_transport)
}

/// Says in plain words why installing failed, and what still works.
fn install_error_text(error: &UpdaterError) -> String {
    let reason = match error {
        // macOS reports a dismissed administrator prompt this way too.
        UpdaterError::Io(io) if io.kind() == std::io::ErrorKind::PermissionDenied => {
            "OctoNeo could not replace itself where it is installed: that folder needs an administrator's permission, and it was not given.".to_string()
        }
        UpdaterError::AuthenticationFailed => {
            "The administrator's password was not given, so the update was not installed.".to_string()
        }
        UpdaterError::PreviousAppNotRestored(kept) => {
            return format!(
                "The update could not be installed, and the previous version could not be put back. It was kept at {}. {MANUAL_INSTALL}",
                kept.display()
            );
        }
        UpdaterError::PackageInstallFailed | UpdaterError::DebInstallFailed => {
            "The system's package installer did not install the update.".to_string()
        }
        UpdaterError::TempDirNotOnSameMountPoint | UpdaterError::TempDirNotFound => {
            "There was no folder to unpack the update in next to OctoNeo.".to_string()
        }
        UpdaterError::InvalidUpdaterFormat | UpdaterError::BinaryNotFoundInArchive => {
            "The downloaded update does not fit the way OctoNeo was installed.".to_string()
        }
        UpdaterError::FailedToDetermineExtractPath => "OctoNeo could not find where it is installed.".to_string(),
        other => format!("Could not install the update automatically ({other})."),
    };
    format!("{reason} {MANUAL_INSTALL}")
}

fn parse_github_release(release: GitHubRelease, current_version: &str) -> UpdateCheckResult {
    if release.draft || release.prerelease || !is_newer(&release.tag_name, current_version) {
        return UpdateCheckResult::UpToDate {
            current_version: current_version.to_string(),
            release_url: RELEASES_URL.to_string(),
        };
    }

    let version = clean_version(&release.tag_name);
    let release_url = safe_release_url(release.html_url.as_deref(), &version);
    let notes = release.body.unwrap_or_default().trim().to_string();

    UpdateCheckResult::Available(UpdateInfo {
        version,
        current_version: current_version.to_string(),
        date: release.published_at,
        notes,
        release_url,
        can_install: false,
    })
}

async fn check_github_release(current_version: &str) -> Result<UpdateCheckResult, String> {
    let client = reqwest::Client::builder()
        .timeout(CHECK_TIMEOUT)
        .user_agent(format!("OctoNeo/{current_version}"))
        .build()
        .map_err(|error| format!("Could not start the update check: {error}"))?;

    let response = client
        .get(LATEST_RELEASE_API)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("Could not reach GitHub Releases: {error}"))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(UpdateCheckResult::UpToDate {
            current_version: current_version.to_string(),
            release_url: RELEASES_URL.to_string(),
        });
    }

    if !response.status().is_success() {
        return Err(format!("GitHub Releases returned HTTP {}.", response.status().as_u16()));
    }

    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|error| format!("Could not read the GitHub release details: {error}"))?;

    Ok(parse_github_release(release, current_version))
}

pub async fn check(
    app: &AppHandle,
    studio: &Arc<Studio>,
    state: &UpdaterState,
) -> Result<UpdateCheckResult, String> {
    let current_version = app.package_info().version.to_string();
    let insecure_transport = insecure_transport_allowed(app);

    if has_signing_pubkey(app) {
        let native = async {
            let shutdown = Arc::clone(studio);
            let closed = Arc::clone(&state.closed_for_install);
            let updater = app
                .updater_builder()
                .timeout(CHECK_TIMEOUT)
                // Windows only: the plugin starts the installer and ends the process right after
                // this hook, so `RunEvent::Exit` never comes. Close a waiting wallet page and stop
                // the tool servers here. `install` runs the plugin on a blocking thread, where
                // blocking on the studio is allowed.
                .on_before_exit(move || {
                    closed.store(true, Ordering::SeqCst);
                    tauri::async_runtime::block_on(shutdown.close());
                })
                .build()?;
            updater.check().await
        }
        .await;

        match native {
            Ok(Some(update)) if update_download_allowed(&update, insecure_transport) => {
                let version = clean_version(&update.version);
                let date = update
                    .raw_json
                    .get("pub_date")
                    .and_then(serde_json::Value::as_str)
                    .map(ToString::to_string);
                let notes = update.body.clone().unwrap_or_default().trim().to_string();
                let release_url = release_tag_url(&version);

                let mut pending = state.inner.lock().await;
                let same_version = pending
                    .update
                    .as_ref()
                    .is_some_and(|existing| clean_version(&existing.version) == version);
                pending.update = Some(update);
                if !same_version {
                    pending.bytes = None;
                }

                return Ok(UpdateCheckResult::Available(UpdateInfo {
                    version,
                    current_version,
                    date,
                    notes,
                    release_url,
                    can_install: true,
                }));
            }
            Ok(Some(_)) => {
                // A download address that is not HTTPS: refuse it and fall back to GitHub Releases.
                let mut pending = state.inner.lock().await;
                pending.update = None;
                pending.bytes = None;
            }
            Ok(None) => {
                let mut pending = state.inner.lock().await;
                pending.update = None;
                pending.bytes = None;
                return Ok(UpdateCheckResult::UpToDate {
                    current_version,
                    release_url: RELEASES_URL.to_string(),
                });
            }
            Err(_) => {
                // Missing latest.json or unsupported package format: fall back to GitHub Releases.
                let mut pending = state.inner.lock().await;
                pending.update = None;
                pending.bytes = None;
            }
        }
    } else {
        let mut pending = state.inner.lock().await;
        pending.update = None;
        pending.bytes = None;
    }

    check_github_release(&current_version).await
}

pub async fn download(
    app: &AppHandle,
    state: &UpdaterState,
    on_event: &Channel<UpdateProgress>,
) -> Result<(), String> {
    let update = {
        let pending = state.inner.lock().await;
        pending.update.clone()
    }
    .ok_or_else(|| "Check for updates first.".to_string())?;

    if !update_download_allowed(&update, insecure_transport_allowed(app)) {
        return Err("Refused to download an update over an insecure connection.".to_string());
    }

    let expected_version = clean_version(&update.version);
    let mut started = false;
    let mut downloaded: u64 = 0;
    let mut last_emitted: u64 = 0;

    let bytes = update
        .download(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = on_event.send(UpdateProgress::Started { content_length });
                }
                downloaded = downloaded.saturating_add(chunk_length as u64);
                let finished_stream = content_length.is_some_and(|total| downloaded >= total);
                if downloaded.saturating_sub(last_emitted) >= PROGRESS_STEP_BYTES || finished_stream {
                    last_emitted = downloaded;
                    let _ = on_event.send(UpdateProgress::Progress { downloaded, content_length });
                }
            },
            || {
                let _ = on_event.send(UpdateProgress::Downloaded);
            },
        )
        .await
        .map_err(|error| format!("Could not download or verify the update: {error}"))?;

    let mut pending = state.inner.lock().await;
    let still_current =
        pending.update.as_ref().is_some_and(|existing| clean_version(&existing.version) == expected_version);
    if still_current {
        pending.bytes = Some(bytes);
    }

    Ok(())
}

pub async fn install(app: &AppHandle, studio: &Arc<Studio>, state: &UpdaterState) -> Result<(), String> {
    let (update, bytes) = {
        let mut pending = state.inner.lock().await;
        match (pending.update.take(), pending.bytes.take()) {
            (Some(update), Some(bytes)) => (update, bytes),
            (update, bytes) => {
                pending.update = update;
                pending.bytes = bytes;
                return Err("Download the update before installing.".to_string());
            }
        }
    };

    // The plugin's install blocks: it can wait on a password prompt (macOS, Linux packages), it
    // runs the macOS prompt on the main thread and waits for it, and on Windows its exit hook
    // blocks on closing the studio. None of that may run on an async worker or the main thread.
    state.closed_for_install.store(false, Ordering::SeqCst);
    let attempt = update.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let result = attempt.install(&bytes);
        (result, bytes)
    })
    .await;

    let failure = match outcome {
        // macOS and Linux: the new version is in place.
        Ok((Ok(()), _)) => None,
        Ok((Err(error), bytes)) => {
            let mut pending = state.inner.lock().await;
            pending.update = Some(update);
            pending.bytes = Some(bytes);
            Some(install_error_text(&error))
        }
        Err(error) => {
            // The install thread itself failed; the update stays checked, and is downloaded again.
            let mut pending = state.inner.lock().await;
            pending.update = Some(update);
            Some(format!("Could not install the update automatically ({error}). {MANUAL_INSTALL}"))
        }
    };

    if let Some(message) = failure {
        if state.closed_for_install.load(Ordering::SeqCst) {
            // Windows: the exit hook already shut the studio down, but the installer did not
            // start. Start OctoNeo again so it is whole; the update is offered again from there.
            app.restart();
        }
        return Err(message);
    }

    // Shut down any active wallet page or MCP child process cleanly before restarting.
    studio.close().await;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_release_versions_using_semver() {
        assert!(is_newer("v0.7.0", "0.6.0"));
        assert!(is_newer("0.6.1", "0.6.0"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("v0.6.0", "0.6.0"));
        assert!(!is_newer("v0.5.9", "0.6.0"));
        assert!(!is_newer("v0.6.0-rc.1", "0.6.0"));
        assert!(!is_newer("not-a-version", "0.6.0"));
    }

    #[test]
    fn downloads_only_over_https_unless_a_local_test_build_opts_in() {
        assert!(download_allowed("https", Some("github.com"), false));
        assert!(download_allowed("https", Some("github.com"), true));
        // A release build never accepts plain HTTP, not even from this computer.
        assert!(!download_allowed("http", Some("127.0.0.1"), false));
        assert!(!download_allowed("http", Some("github.com"), false));
        // A test build that opts into insecure transport accepts it from this computer only.
        assert!(download_allowed("http", Some("127.0.0.1"), true));
        assert!(download_allowed("http", Some("localhost"), true));
        assert!(download_allowed("http", Some("[::1]"), true));
        assert!(!download_allowed("http", Some("github.com"), true));
        assert!(!download_allowed("http", Some("127.0.0.1.example.com"), true));
        assert!(!download_allowed("http", None, true));
        assert!(!download_allowed("ftp", Some("127.0.0.1"), true));
    }

    #[test]
    fn install_failures_read_plainly_and_point_to_the_installer() {
        let denied = UpdaterError::Io(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied"));
        let text = install_error_text(&denied);
        assert!(text.contains("administrator"), "{text}");
        assert!(text.ends_with(MANUAL_INSTALL), "{text}");

        let kept = UpdaterError::PreviousAppNotRestored(std::path::PathBuf::from("/Users/me/OctoNeo.app"));
        let text = install_error_text(&kept);
        assert!(text.contains("/Users/me/OctoNeo.app"), "{text}");
        assert!(text.ends_with(MANUAL_INSTALL), "{text}");

        for error in [
            UpdaterError::AuthenticationFailed,
            UpdaterError::PackageInstallFailed,
            UpdaterError::DebInstallFailed,
            UpdaterError::TempDirNotFound,
            UpdaterError::TempDirNotOnSameMountPoint,
            UpdaterError::InvalidUpdaterFormat,
            UpdaterError::BinaryNotFoundInArchive,
            UpdaterError::FailedToDetermineExtractPath,
            UpdaterError::ReleaseNotFound,
        ] {
            let text = install_error_text(&error);
            assert!(text.ends_with(MANUAL_INSTALL), "{text}");
            assert!(!text.starts_with(' '), "{text}");
        }
    }

    #[test]
    fn keeps_release_urls_scoped_to_this_repository() {
        assert_eq!(
            safe_release_url(Some("https://github.com/kerjakuyco/octo-neo/releases/tag/v0.7.0"), "0.7.0",),
            "https://github.com/kerjakuyco/octo-neo/releases/tag/v0.7.0"
        );
        assert_eq!(
            safe_release_url(Some("https://evil.example/download"), "0.7.0"),
            "https://github.com/kerjakuyco/octo-neo/releases/tag/v0.7.0"
        );
        assert_eq!(release_tag_url("../bad"), RELEASES_URL);
    }

    #[test]
    fn ignores_draft_and_prerelease_github_releases() {
        let draft = GitHubRelease {
            tag_name: "v0.9.0".to_string(),
            html_url: None,
            published_at: None,
            body: Some("Draft notes".to_string()),
            draft: true,
            prerelease: false,
        };
        assert_eq!(
            parse_github_release(draft, "0.6.0"),
            UpdateCheckResult::UpToDate {
                current_version: "0.6.0".to_string(),
                release_url: RELEASES_URL.to_string(),
            }
        );

        let pre = GitHubRelease {
            tag_name: "v0.9.0".to_string(),
            html_url: None,
            published_at: None,
            body: None,
            draft: false,
            prerelease: true,
        };
        assert_eq!(
            parse_github_release(pre, "0.6.0"),
            UpdateCheckResult::UpToDate {
                current_version: "0.6.0".to_string(),
                release_url: RELEASES_URL.to_string(),
            }
        );
    }

    #[test]
    fn parses_newer_github_release_for_manual_fallback() {
        let release = GitHubRelease {
            tag_name: "v0.7.0".to_string(),
            html_url: Some("https://github.com/kerjakuyco/octo-neo/releases/tag/v0.7.0".to_string()),
            published_at: Some("2026-11-20T00:00:00Z".to_string()),
            body: Some("  - Added semi-auto updates\n".to_string()),
            draft: false,
            prerelease: false,
        };
        assert_eq!(
            parse_github_release(release, "0.6.0"),
            UpdateCheckResult::Available(UpdateInfo {
                version: "0.7.0".to_string(),
                current_version: "0.6.0".to_string(),
                date: Some("2026-11-20T00:00:00Z".to_string()),
                notes: "- Added semi-auto updates".to_string(),
                release_url: "https://github.com/kerjakuyco/octo-neo/releases/tag/v0.7.0".to_string(),
                can_install: false,
            })
        );
    }
}
