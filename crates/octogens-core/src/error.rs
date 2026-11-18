//! One error type for the whole core: a message the user can act on.

use thiserror::Error;

/// An actionable error. Its text is written for the person using the app and
/// is shown as-is, so it must say what went wrong and, where possible, what
/// to do next. It must never contain a secret.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{0}")]
pub struct DeskError(pub String);

impl DeskError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

pub type Result<T> = std::result::Result<T, DeskError>;

/// Builds a [`DeskError`] with `format!` syntax.
#[macro_export]
macro_rules! desk_err {
    ($($arg:tt)*) => {
        $crate::error::DeskError::new(format!($($arg)*))
    };
}

/// Returns early with a [`DeskError`] built with `format!` syntax.
#[macro_export]
macro_rules! bail {
    ($($arg:tt)*) => {
        return Err($crate::desk_err!($($arg)*))
    };
}

impl From<rusqlite::Error> for DeskError {
    fn from(error: rusqlite::Error) -> Self {
        desk_err!("The local database could not be updated: {error}.")
    }
}

impl From<std::io::Error> for DeskError {
    fn from(error: std::io::Error) -> Self {
        desk_err!("A local file could not be read or written: {error}.")
    }
}
