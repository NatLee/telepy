//! 資料存取層：針對 Django 既有表名的 SQL。所有 struct 的欄位名 = 資料表欄名。
//! Data-access layer over the Django-named tables. Struct fields mirror column names.

pub mod access_requests;
pub mod ai_audit;
pub mod audit_chain;
pub mod command_rules;
pub mod snippets;
pub mod credentials;
pub mod device_keys;
pub mod features;
pub mod groups;
pub mod host_keys;
pub mod keys;
pub mod lan;
pub mod mfa;
pub mod oauth;
pub mod pool;
pub mod recordings;
pub mod retention;
pub mod schema;
pub mod settings;
pub mod sharing;
pub mod sign_ins;
pub mod terminal_profile;
pub mod terminal_scheme;
pub mod tunnel_endpoints;
pub mod tunnel_keys;
pub mod tunnel_sessions;
pub mod tunnel_tags;
pub mod tunnels;
pub mod users;
pub mod web_sessions;
pub mod webhooks;

pub use pool::Db;
