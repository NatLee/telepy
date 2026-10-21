//! Telepy backend（Rust）：REST + WebSocket，取代 Django/DRF/Channels。
//! 模組對應見 docs/rust-migration-plan.md §5。

pub mod api;
pub mod app;
pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod hub;
pub mod monitor;
pub mod permissions;
pub mod scripts;
pub mod ssh;
pub mod state;
pub mod tokens;
pub mod util;
pub mod ws;
