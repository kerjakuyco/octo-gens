//! The trading core of Octo Gens.
//!
//! This crate has no user interface. It knows the instruments, talks to the
//! exchanges, keeps the paper ledger, computes indicators and runs the
//! assistant. The desktop shell in `src-tauri` is a thin layer over it.

pub mod assistant;
pub mod error;
pub mod indicators;
pub mod instruments;
pub mod ledger;
pub mod llm;
pub mod mcp;
pub mod model;
pub mod net;
pub mod sample;
pub mod store;
pub mod studio;
pub mod venues;

pub use error::{DeskError, Result};
