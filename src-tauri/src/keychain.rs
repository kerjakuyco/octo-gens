//! Secrets in the operating system's keychain: Keychain Services on macOS,
//! Credential Manager on Windows, the Secret Service on Linux.

use std::collections::HashMap;
use std::sync::Mutex;

use keyring::{Entry, Error};
use octoneo_core::desk_err;
use octoneo_core::error::Result;
use octoneo_core::store::SecretStore;

/// The name secrets are filed under. It is the app's identifier, which keeps the
/// name the app had before it was called OctoNeo: changing it would leave every
/// stored key behind, and make the system ask again whether the app may read them.
const SERVICE: &str = "org.octogens.desktop";

/// Stores secrets in the system keychain.
///
/// Some systems have no keychain (a Linux session without a Secret Service, for
/// example). There a secret is kept in memory instead, so the app works for the
/// session; it simply has to be entered again next launch. Values are never
/// logged and never written to a file by this type.
#[derive(Default)]
pub struct Keychain {
    session: Mutex<HashMap<String, String>>,
}

impl Keychain {
    fn session(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl SecretStore for Keychain {
    fn get(&self, name: &str) -> Result<Option<String>> {
        if let Some(value) = self.session().get(name) {
            return Ok(Some(value.clone()));
        }
        match Entry::new(SERVICE, name).and_then(|entry| entry.get_password()) {
            Ok(value) => Ok(Some(value)),
            Err(Error::NoEntry) => Ok(None),
            // An unavailable keychain means "nothing stored", not a broken app.
            Err(_) => Ok(None),
        }
    }

    fn set(&self, name: &str, value: &str) -> Result<()> {
        match Entry::new(SERVICE, name).and_then(|entry| entry.set_password(value)) {
            Ok(()) => {
                self.session().remove(name);
            }
            Err(_) => {
                self.session().insert(name.to_string(), value.to_string());
            }
        }
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<()> {
        self.session().remove(name);
        match Entry::new(SERVICE, name).and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(Error::NoEntry | Error::NoDefaultStore) => Ok(()),
            Err(error) => Err(desk_err!("The system keychain could not remove the stored secret: {error}.")),
        }
    }
}
