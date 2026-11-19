//! The trading core of OctoNeo.
//!
//! This crate has no user interface. It talks to the exchange, signs with an API
//! wallet, computes indicators and runs the assistant. The desktop shell in
//! `src-tauri` is a thin layer over it.

pub mod assistant;
pub mod connect;
pub mod error;
pub mod exchange;
pub mod indicators;
pub mod instruments;
pub mod llm;
pub mod mcp;
pub mod model;
pub mod net;
pub mod store;
pub mod studio;
pub mod web;

pub use error::{DeskError, Result};
