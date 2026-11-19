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
use crate::llm::ModelInfo;
use crate::model::Network;

/// Name of the OpenRouter key in the secret store.
pub const OPENROUTER_SECRET: &str = "openrouter-key";
/// Name of the Cloudflare API token in the secret store.
pub const CLOUDFLARE_SECRET: &str = "cloudflare-token";

/// Name of a network's API wallet key in the secret store.
pub fn agent_secret(network: Network) -> String {
    format!("agent-key-{}", network.as_str())
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

/// Who answers. The assistant is always a language model; until one is
/// connected there is nobody to answer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    /// No model is connected. Releases before 0.5 called their rule-based agents `builtin`.
    #[default]
    #[serde(alias = "builtin")]
    None,
    OpenRouter,
    Cloudflare,
    Ollama,
    LmStudio,
}

impl Provider {
    /// The providers a model can be connected through, in display order.
    pub const CONNECTABLE: [Provider; 4] =
        [Provider::OpenRouter, Provider::Cloudflare, Provider::Ollama, Provider::LmStudio];

    pub fn as_str(self) -> &'static str {
        match self {
            Provider::None => "none",
            Provider::OpenRouter => "openrouter",
            Provider::Cloudflare => "cloudflare",
            Provider::Ollama => "ollama",
            Provider::LmStudio => "lmstudio",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Provider::None => "",
            Provider::OpenRouter => crate::llm::openrouter::NAME,
            Provider::Cloudflare => crate::llm::cloudflare::NAME,
            Provider::Ollama => crate::llm::ollama::NAME,
            Provider::LmStudio => crate::llm::lmstudio::NAME,
        }
    }

    /// The model runs on this computer: no key, and nothing leaves the machine.
    pub fn local(self) -> bool {
        matches!(self, Provider::Ollama | Provider::LmStudio)
    }
}

/// The model chosen for one provider, with what was known about it when it was chosen.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelChoice {
    pub id: String,
    pub info: Option<ModelInfo>,
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

/// What the desk remembers about a connected wallet. The API wallet's key is
/// not here: it lives in the secret store.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WalletPref {
    /// Main wallet address.
    pub user: String,
    /// API wallet address, to check the stored key still matches.
    pub agent: String,
    /// When the approval ends, as Unix milliseconds, if the app made it.
    pub expires_ms: Option<i64>,
}

/// Non-secret settings, stored as `preferences.json` in the data folder.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    pub provider: Provider,
    /// The model last used with each provider, by provider name, so switching back needs no setup.
    pub models: HashMap<String, ModelChoice>,
    /// Cloudflare account the gateway belongs to. Not a secret.
    pub cloudflare_account: String,
    pub cloudflare_gateway: String,
    /// Where Ollama and LM Studio listen; empty means their usual address.
    pub ollama_url: String,
    pub lmstudio_url: String,
    pub effort: Effort,
    /// The assistant may draft tickets on mainnet. Testnet is always allowed.
    pub live_tickets: bool,
    /// The assistant may search the news and read web pages.
    pub web_search: bool,
    pub theme: Theme,
    /// Network to return to on the next launch: `mainnet` or `testnet`.
    pub network: String,
    pub focus: String,
    /// Symbols the trader added to the watchlist.
    pub custom: Vec<String>,
    /// Highest leverage any ticket may use.
    pub max_leverage: u32,
    /// New positions use isolated margin.
    pub isolated: bool,
    /// Connected wallets by network name.
    pub wallets: HashMap<String, WalletPref>,
    /// Releases before 0.3 kept the OpenRouter key in this file. It is read
    /// once, moved to the secret store, and never written back.
    #[serde(rename = "openrouter_key", skip_serializing)]
    pub legacy_key: Option<String>,
    /// Releases before 0.5 kept one model for whichever provider was chosen.
    #[serde(rename = "model", skip_serializing)]
    pub legacy_model: String,
    #[serde(rename = "model_info", skip_serializing)]
    pub legacy_model_info: Option<ModelInfo>,
    /// Releases before 0.4 traded on other exchanges and listed here the ones
    /// whose API keys were kept in the secret store. Those keys are removed on
    /// the first launch; a name stays only until its key is gone.
    #[serde(rename = "remembered", skip_serializing_if = "Vec::is_empty")]
    pub legacy_remembered: Vec<String>,
}

/// Leverage a new installation allows. Deliberately low: it is a ceiling the trader can raise.
pub const DEFAULT_MAX_LEVERAGE: u32 = 3;
/// The highest ceiling the app accepts, whatever a market allows.
pub const LEVERAGE_LIMIT: u32 = 50;

impl Default for Prefs {
    fn default() -> Self {
        Self {
            provider: Provider::default(),
            models: HashMap::new(),
            cloudflare_account: String::new(),
            cloudflare_gateway: String::new(),
            ollama_url: String::new(),
            lmstudio_url: String::new(),
            effort: Effort::default(),
            live_tickets: false,
            web_search: true,
            theme: Theme::default(),
            network: String::new(),
            focus: String::new(),
            custom: Vec::new(),
            max_leverage: DEFAULT_MAX_LEVERAGE,
            isolated: true,
            wallets: HashMap::new(),
            legacy_key: None,
            legacy_model: String::new(),
            legacy_model_info: None,
            legacy_remembered: Vec::new(),
        }
    }
}

impl Prefs {
    /// The model chosen for a provider, if one was.
    pub fn choice(&self, provider: Provider) -> Option<&ModelChoice> {
        self.models.get(provider.as_str()).filter(|choice| !choice.id.is_empty())
    }

    /// Carries the single model of an older release over to its provider.
    pub fn adopt_legacy_model(&mut self) {
        let model = std::mem::take(&mut self.legacy_model);
        let info = self.legacy_model_info.take();
        if !model.is_empty() && self.provider != Provider::None && self.choice(self.provider).is_none() {
            self.models.insert(self.provider.as_str().to_string(), ModelChoice { id: model, info });
        }
    }

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
const JOURNAL_LIMIT: i64 = 2000;
/// The conversation a row belongs to. Rows from another version of the app,
/// which have no network, count as belonging to none.
const THREAD: &str = "CASE WHEN json_valid(entry) AND json_extract(entry, '$.network') IS NOT NULL THEN json_extract(entry, '$.thread') END";

/// A conversation, summarised from its turns.
#[derive(Clone, Debug, PartialEq)]
pub struct ThreadRow {
    pub id: String,
    /// The first message.
    pub title: String,
    /// When the latest turn started.
    pub time: String,
    /// Network of the first turn.
    pub network: String,
    pub turns: usize,
}

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
        // A deleted conversation is overwritten, not left behind in the file's free pages.
        db.pragma_update(None, "secure_delete", "ON")?;
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

    /// The latest `limit` runs of one conversation, oldest first. The empty id
    /// names the runs that belong to no conversation, such as orders.
    pub fn thread<T: for<'de> Deserialize<'de>>(&self, thread: &str, limit: usize) -> Result<Vec<T>> {
        let db = self.db.lock().unwrap_or_else(|p| p.into_inner());
        let mut statement =
            db.prepare(&format!("SELECT entry FROM runs WHERE {THREAD} = ?1 ORDER BY seq DESC LIMIT ?2"))?;
        let rows = statement.query_map(params![thread, limit as i64], |row| row.get::<_, String>(0))?;
        let mut runs: Vec<T> =
            rows.filter_map(|row| row.ok()).filter_map(|text| serde_json::from_str(&text).ok()).collect();
        runs.reverse();
        Ok(runs)
    }

    /// Conversations, the one with the latest turn first.
    pub fn threads(&self, limit: usize) -> Result<Vec<ThreadRow>> {
        let db = self.db.lock().unwrap_or_else(|p| p.into_inner());
        let mut groups = db.prepare(&format!(
            "SELECT {THREAD} AS thread, COUNT(*), MIN(seq), MAX(seq) FROM runs GROUP BY thread HAVING thread != '' ORDER BY MAX(seq) DESC LIMIT ?1"
        ))?;
        let found = groups.query_map(params![limit as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;
        let found: Vec<(String, i64, i64, i64)> = found.filter_map(|row| row.ok()).collect();
        let mut field =
            db.prepare("SELECT COALESCE(json_extract(entry, ?2), '') FROM runs WHERE seq = ?1")?;
        let mut read = |seq: i64, path: &str| {
            field.query_row(params![seq, path], |row| row.get::<_, String>(0)).unwrap_or_default()
        };
        Ok(found
            .into_iter()
            .map(|(id, turns, first, last)| ThreadRow {
                id,
                title: read(first, "$.title"),
                time: read(last, "$.time"),
                network: read(first, "$.network"),
                turns: turns as usize,
            })
            .collect())
    }

    /// Removes a conversation and all its turns.
    pub fn delete_thread(&self, thread: &str) -> Result<()> {
        if thread.is_empty() {
            return Ok(());
        }
        let db = self.db.lock().unwrap_or_else(|p| p.into_inner());
        db.execute(&format!("DELETE FROM runs WHERE {THREAD} = ?1"), params![thread])?;
        Ok(())
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
        let fresh = Prefs::load(&path);
        assert_eq!(fresh, Prefs::default());
        assert_eq!(
            (fresh.max_leverage, fresh.isolated, fresh.live_tickets),
            (3, true, false),
            "a new install starts cautious"
        );

        let prefs = Prefs {
            provider: Provider::OpenRouter,
            models: HashMap::from([(
                "openrouter".to_string(),
                ModelChoice { id: "openai/gpt-test".into(), info: None },
            )]),
            cloudflare_account: "0123456789abcdef0123456789abcdef".into(),
            lmstudio_url: "http://127.0.0.1:1234".into(),
            effort: Effort::High,
            live_tickets: true,
            web_search: false,
            theme: Theme::Dark,
            network: "testnet".to_string(),
            custom: vec!["PEPEUSDT".to_string()],
            max_leverage: 10,
            isolated: false,
            wallets: HashMap::from([(
                "testnet".to_string(),
                WalletPref { user: "0xabc".into(), agent: "0xdef".into(), expires_ms: Some(1) },
            )]),
            ..Prefs::default()
        };
        prefs.save(&path).expect("save");
        assert_eq!(Prefs::load(&path), prefs);
        let on_disk: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
        assert_eq!(
            (&on_disk["provider"], &on_disk["effort"], &on_disk["max_leverage"]),
            (&json!("openrouter"), &json!("high"), &json!(10))
        );

        // A file from before these settings existed gets the cautious defaults, not zeros.
        std::fs::write(&path, r#"{"provider": "builtin", "feed": "binance", "remembered": ["okx"]}"#)
            .expect("write");
        let older = Prefs::load(&path);
        assert_eq!((older.max_leverage, older.isolated, older.wallets.len()), (3, true, 0));
        assert!(older.web_search && !older.live_tickets, "news is read unless it was turned off");
        assert_eq!(older.provider, Provider::None, "the rule-based agents of older releases are gone");
        assert_eq!(older.legacy_remembered, ["okx"], "so its stored key can be found and removed");

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

        // The single model an older release kept moves to its provider.
        let mut prefs = prefs;
        prefs.adopt_legacy_model();
        assert_eq!(prefs.choice(Provider::OpenRouter).map(|c| c.id.as_str()), Some("openai/gpt-test"));
        assert!(prefs.choice(Provider::Ollama).is_none() && prefs.legacy_model.is_empty());
        prefs.save(&path).expect("save");
        let reloaded = Prefs::load(&path);
        assert_eq!(reloaded.choice(Provider::OpenRouter).map(|c| c.id.as_str()), Some("openai/gpt-test"));
        for provider in Provider::CONNECTABLE {
            assert_eq!(serde_json::to_value(provider).expect("json"), provider.as_str());
            assert!(!provider.name().is_empty());
        }
        assert_eq!(
            (Provider::Ollama.local(), Provider::LmStudio.local(), Provider::Cloudflare.local()),
            (true, true, false)
        );
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
        let all: Vec<Value> = journal.recent(10_000).expect("all");
        assert_eq!(all.len() as i64, JOURNAL_LIMIT);
    }

    #[test]
    fn the_journal_groups_runs_into_conversations() {
        let folder = tempfile::tempdir().expect("tempdir");
        let journal = Journal::open(&folder.path().join("journal.sqlite3")).expect("journal");
        let run = |id: &str, thread: &str, title: &str, time: &str| json!({"id": id, "thread": thread, "title": title, "time": time, "network": "testnet"});
        journal.append(&run("1", "a", "Is BTC trending?", "2026-11-18T10:00:00Z")).expect("append");
        journal.append(&run("2", "b", "Long ETH", "2026-11-18T11:00:00Z")).expect("append");
        journal.append(&run("3", "", "Confirm buy 0.5 ETHUSDT", "2026-11-18T11:01:00Z")).expect("append");
        journal.append(&run("4", "a", "And on the daily?", "2026-11-19T09:00:00Z")).expect("append");
        // Rows this version cannot read belong to no conversation.
        journal
            .append(&json!({"id": "old", "thread": "z", "title": "from 0.3", "feed": "okx"}))
            .expect("append");
        journal.append(&"not an object").expect("append");

        let threads = journal.threads(10).expect("threads");
        assert_eq!(
            threads,
            [
                ThreadRow {
                    id: "a".into(),
                    title: "Is BTC trending?".into(),
                    time: "2026-11-19T09:00:00Z".into(),
                    network: "testnet".into(),
                    turns: 2
                },
                ThreadRow {
                    id: "b".into(),
                    title: "Long ETH".into(),
                    time: "2026-11-18T11:00:00Z".into(),
                    network: "testnet".into(),
                    turns: 1
                },
            ],
            "latest activity first; titled by the first message"
        );
        assert_eq!(journal.threads(1).expect("threads").len(), 1);

        let ids = |rows: Vec<Value>| {
            rows.iter().map(|row| row["id"].as_str().unwrap_or_default().to_string()).collect::<Vec<_>>()
        };
        assert_eq!(ids(journal.thread("a", 10).expect("a")), ["1", "4"], "oldest first");
        assert_eq!(
            ids(journal.thread("a", 1).expect("a")),
            ["4"],
            "the latest turns when there are too many"
        );
        assert_eq!(ids(journal.thread("", 10).expect("loose")), ["3"], "orders belong to no conversation");
        assert!(journal.thread::<Value>("z", 10).expect("z").is_empty());

        journal.delete_thread("a").expect("delete");
        journal.delete_thread("").expect("an empty id deletes nothing");
        assert_eq!(
            journal.threads(10).expect("threads").iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            ["b"]
        );
        assert_eq!(ids(journal.thread("", 10).expect("loose")), ["3"]);
        assert_eq!(journal.recent::<Value>(100).expect("all").len(), 4);
    }

    #[test]
    fn memory_secrets_set_get_and_delete() {
        let secrets = MemorySecrets::default();
        assert_eq!(secrets.get(OPENROUTER_SECRET).expect("get"), None);
        secrets.set(&agent_secret(Network::Testnet), "key").expect("set");
        assert_eq!(secrets.get("agent-key-testnet").expect("get").as_deref(), Some("key"));
        secrets.delete("agent-key-testnet").expect("delete");
        assert_eq!(secrets.get("agent-key-testnet").expect("get"), None);
    }
}
