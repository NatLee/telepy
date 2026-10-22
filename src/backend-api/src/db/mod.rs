//! 資料存取層：針對 Django 既有表名的 SQL。所有 struct 的欄位名 = 資料表欄名。
//! Data-access layer over the Django-named tables. Struct fields mirror column names.

pub mod ai_audit;
pub mod keys;
pub mod mfa;
pub mod oauth;
pub mod pool;
pub mod schema;
pub mod settings;
pub mod sharing;
pub mod tunnel_endpoints;
pub mod tunnels;
pub mod users;

pub use pool::Db;
