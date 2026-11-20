//! Cross-platform semi-automatic updates backed by GitHub Releases.
//!
//! When a Tauri updater public key is configured in `tauri.conf.json` and the
//! latest release ships a signed `latest.json` manifest, updates are verified
//! with minisign, downloaded with progress streaming, and installed in place
//! once the trader confirms. When no signing key or manifest is available for
//! the current package format, the check falls back to the GitHub Releases API
//! and links straight to the release page for manual installation.

use std::sync::Arc;
use std::time::Duration;

use octoneo_core::studio::Studio;
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::ipc::Channel;
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

const REPO: &str = "kerjakuyco/octo-neo";
const RELEASES_URL: &str = "https://github.com/kerjakuyco/octo-neo/releases";
const LATEST_RELEASE_API: &str = "https://api.github.com/repos/kerjakuyco/octo-neo/releases/latest";
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const PROGRESS_STEP_BYTES: u64 = 64 * 1024;

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

fn has_signing_pubkey(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|key| !key.trim().is_empty())
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

pub async fn check(app: &AppHandle, state: &UpdaterState) -> Result<UpdateCheckResult, String> {
    let current_version = app.package_info().version.to_string();

    if has_signing_pubkey(app) {
        let native = async {
            let updater = app.updater_builder().timeout(CHECK_TIMEOUT).build()?;
            updater.check().await
        }
        .await;

        match native {
            Ok(Some(update)) if update.download_url.scheme() == "https" => {
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
                // Non-HTTPS download URL: refuse native install and fall back to GitHub Releases.
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

pub async fn download(state: &UpdaterState, on_event: &Channel<UpdateProgress>) -> Result<(), String> {
    let update = {
        let pending = state.inner.lock().await;
        pending.update.clone()
    }
    .ok_or_else(|| "Check for updates first.".to_string())?;

    if update.download_url.scheme() != "https" {
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

    if let Err(error) = update.install(&bytes) {
        let mut pending = state.inner.lock().await;
        pending.update = Some(update);
        pending.bytes = Some(bytes);
        return Err(format!(
            "Could not install the update automatically ({error}). You can download the installer from GitHub instead."
        ));
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
