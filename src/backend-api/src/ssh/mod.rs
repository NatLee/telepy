//! 後端 → 裝置的 SSH 連線層：
//! - `device`：russh 連線（行程內經 gateway 的通道）；`pool`：依「隧道 + OS 帳號」共用連線
//! - `process`：OpenSSH 客戶端（terminal、`ssh -D`）的 argv、PTY spawn、非阻塞讀寫、子程序終止
//! SSH client plumbing: russh connections (+ pool) and the OpenSSH client used by the terminal.

pub mod device;
pub mod exec;
pub mod pool;
pub mod process;

pub use process::{PtyChild, SshTarget};
