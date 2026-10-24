//! 後端 → 裝置的 SSH 連線層：
//! - `device`：russh 連線（行程內經 gateway 的通道）；`pool`：依「隧道 + OS 帳號」共用連線
//! - `terminal`：網頁終端機的 PTY channel；`socks`：遠端瀏覽器的行程內 SOCKS5；`exec`：跑一個指令；
//!   `bridge`：給 OpenSSH 客戶端的一次性入口（區網主機那一跳）
//! - `process`：OpenSSH 客戶端（只剩區網主機的最後一跳）的 argv、PTY spawn、子程序終止
//! SSH client plumbing: russh connections, the shared pool and what runs on it; OpenSSH only for the LAN hop.

pub mod bridge;
pub mod device;
pub mod host_keys;
pub mod exec;
pub mod pool;
pub mod process;
pub mod resolve;
pub mod socks;
pub mod terminal;

pub use process::PtyChild;
