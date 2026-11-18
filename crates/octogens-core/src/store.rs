//! What the desk remembers between launches: preferences, secrets and the run journal.
//!
//! Secrets never go in the preferences file or the journal. They live behind
//! [`SecretStore`], which the desktop shell backs with the system keychain.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::llm::openrouter::ModelInfo;
use crate::model::VenueId;

/// Name of the OpenRouter key in the secret store.
pub const OPENROUTER_SECRET: &str = "openrouter-key";

/// Name of a venue's credentials in the secret store.
pub fn venue_secret(venue: VenueId) -> String {
    format!("venue-{}", venue.as_str())
}

/// Somewhere safe to keep a secret. Implementations must not log values.
pub trait SecretStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>>;
    fn set(&self, name: &str, value: &str) -> Result<()>;
    fn delete(&self, name: &str) -> Result<()>;
}

/// Keeps secrets for the life of the process only. Used in tests and as the
/// fallback when no system keychain is available.
#[derive(Default)]
pub struct MemorySecrets(Mutex<HashMap<String, String>>);

impl SecretStore for MemorySecrets {
    fn get(&self, name: &str) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap_or_else(|p| p.into_inner()).get(name).cloned())
    }

    fn set(&self, name: &str, value: &str) -> Result<()> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).insert(name.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<()> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).remove(name);
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    /// Rule-based agents; no language model.
    #[default]
    Builtin,
    OpenRouter,
    Ollama,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    /// Leave the model's own default.
    #[default]
    Auto,
    Low,
    Medium,
    High,
}

impl Effort {
    /// The value to send to the provider, if any.
    pub fn as_param(self) -> Option<&'static str> {
        match self {
            Effort::Auto => None,
            Effort::Low => Some("low"),
            Effort::Medium => Some("medium"),
            Effort::High => Some("high"),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// Non-secret settings, stored as `preferences.json` in the data folder.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    pub provider: Provider,
    pub model: String,
    /// What the catalog said about `model` when it was chosen.
    pub model_info: Option<ModelInfo>,
    pub effort: Effort,
    /// The assistant may draft tickets for the real exchange account.
    pub live_tickets: bool,
    pub theme: Theme,
    /// Feed to return to on the next launch.
    pub feed: String,
    pub focus: String,
    /// Pairs the trader added to the watchlist.
    pub custom: Vec<String>,
    /// Venues whose credentials are in the secret store.
    pub remembered: Vec<VenueId>,
    /// Releases before 0.3 kept the OpenRouter key in this file. It is read
    /// once, moved to the secret store, and never written back.
    #[serde(rename = "openrouter_key", skip_serializing)]
    pub legacy_key: Option<String>,
}

impl Prefs {
    /// Reads preferences, falling back to defaults if the file is missing or damaged.
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// Writes preferences through a temporary file so a crash cannot leave half a file.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".to_string());
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, text)?;
        std::fs::rename(&temporary, path)?;
        Ok(())
    }
}

/// How many runs the journal keeps on disk.
const JOURNAL_LIMIT: i64 = 300;

/// An append-only record of what the agents did, as JSON rows in SQLite.
pub struct Journal {
    db: Mutex<Connection>,
}

impl Journal {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let db = Connection::open(path)?;
        db.execute("CREATE TABLE IF NOT EXISTS runs (seq INTEGER PRIMARY KEY, entry TEXT NOT NULL)", [])?;
        Ok(Self { db: Mutex::new(db) })
    }

    pub fn append<T: Serialize>(&self, entry: &T) -> Result<()> {
        let text = serde_json::to_string(entry)
            .map_err(|error| crate::desk_err!("A run could not be saved: {error}."))?;
        let db = self.db.lock().unwrap_or_else(|p| p.into_inner());
        db.execute("INSERT INTO runs (entry) VALUES (?1)", params![text])?;
        db.execute("DELETE FROM runs WHERE seq <= (SELECT MAX(seq) - ?1 FROM runs)", params![JOURNAL_LIMIT])?;
        Ok(())
    }

    /// The latest `limit` entries, newest first. Rows from an incompatible version are skipped.
    pub fn recent<T: for<'de> Deserialize<'de>>(&self, limit: usize) -> Result<Vec<T>> {
        let db = self.db.lock().unwrap_or_else(|p| p.into_inner());
        let mut statement = db.prepare("SELECT entry FROM runs ORDER BY seq DESC LIMIT ?1")?;
        let rows = statement.query_map(params![limit as i64], |row| row.get::<_, String>(0))?;
        Ok(rows.filter_map(|row| row.ok()).filter_map(|text| serde_json::from_str(&text).ok()).collect())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn preferences_round_trip_and_survive_a_damaged_file() {
        let folder = tempfile::tempdir().expect("tempdir");
        let path = folder.path().join("nested/preferences.json");
        assert_eq!(Prefs::load(&path), Prefs::default());

        let prefs = Prefs {
            provider: Provider::OpenRouter,
            model: "openai/gpt-test".to_string(),
            effort: Effort::High,
            live_tickets: true,
            theme: Theme::Dark,
            feed: "binance".to_string(),
            custom: vec!["PEPE/USDT".to_string()],
            remembered: vec![VenueId::Okx],
            ..Prefs::default()
        };
        prefs.save(&path).expect("save");
        assert_eq!(Prefs::load(&path), prefs);
        let on_disk: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
        assert_eq!(
            (&on_disk["provider"], &on_disk["effort"], &on_disk["remembered"]),
            (&json!("openrouter"), &json!("high"), &json!(["okx"]))
        );

        std::fs::write(&path, "{ not json").expect("write");
        assert_eq!(Prefs::load(&path), Prefs::default());
    }

    #[test]
    fn a_key_left_in_the_old_preferences_file_is_read_but_never_written_back() {
        let folder = tempfile::tempdir().expect("tempdir");
        let path = folder.path().join("preferences.json");
        std::fs::write(
            &path,
            r#"{"provider": "openrouter", "model": "openai/gpt-test", "openrouter_key": "sk-or-v1-legacy"}"#,
        )
        .expect("write");
        let prefs = Prefs::load(&path);
        assert_eq!(
            (prefs.provider, prefs.legacy_key.as_deref()),
            (Provider::OpenRouter, Some("sk-or-v1-legacy"))
        );
        prefs.save(&path).expect("save");
        assert!(!std::fs::read_to_string(&path).expect("read").contains("sk-or-v1-legacy"));
    }

    #[test]
    fn the_journal_returns_newest_first_prunes_and_skips_foreign_rows() {
        let folder = tempfile::tempdir().expect("tempdir");
        let path = folder.path().join("journal.sqlite3");
        let journal = Journal::open(&path).expect("journal");
        for n in 0..(JOURNAL_LIMIT + 5) {
            journal.append(&json!({"n": n})).expect("append");
        }
        journal.append(&"a row from another version").expect("append");
        drop(journal);

        let journal = Journal::open(&path).expect("reopen");
        let recent: Vec<HashMap<String, i64>> = journal.recent(3).expect("recent");
        assert_eq!(recent.iter().map(|r| r["n"]).collect::<Vec<_>>(), [JOURNAL_LIMIT + 4, JOURNAL_LIMIT + 3]);
        let all: Vec<Value> = journal.recent(1000).expect("all");
        assert_eq!(all.len() as i64, JOURNAL_LIMIT);
    }

    #[test]
    fn memory_secrets_set_get_and_delete() {
        let secrets = MemorySecrets::default();
        assert_eq!(secrets.get(OPENROUTER_SECRET).expect("get"), None);
        secrets.set(&venue_secret(VenueId::Bybit), "{}").expect("set");
        assert_eq!(secrets.get("venue-bybit").expect("get").as_deref(), Some("{}"));
        secrets.delete("venue-bybit").expect("delete");
        assert_eq!(secrets.get("venue-bybit").expect("get"), None);
    }
}
