//! Telepy backend（Rust）：REST + WebSocket，取代 Django/DRF/Channels。
//! 模組對應見 docs/rust-migration-plan.md §5。

pub mod ai;
pub mod api;
pub mod app;
pub mod auth;
pub mod client_ip;
pub mod config;
pub mod db;
pub mod desktop;
pub mod device_keys;
pub mod error;
pub mod expiry;
pub mod gateway;
pub mod geoip;
pub mod hub;
pub mod join;
pub mod lan;
pub mod mcp;
pub mod mfa;
pub mod monitor;
pub mod oauth;
pub mod permissions;
pub mod presence;
pub mod remote_browser;
pub mod scripts;
pub mod sftp;
pub mod ssh;
pub mod state;
pub mod tokens;
pub mod tunnel_service;
pub mod util;
pub mod ws;
