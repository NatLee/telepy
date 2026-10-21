//! 後端 → 裝置的 SSH 連線層：OpenSSH 客戶端的 argv 建構、PTY spawn、非阻塞讀寫、子程序終止。
//! 內建 gateway（M5）之後只有目標主機從 `reverse`（雙跳 ProxyCommand）換成 `127.0.0.1`（單跳），
//! 其餘不變。/ SSH client plumbing: argv builders, PTY spawning, non-blocking I/O, process teardown.

pub mod process;

pub use process::{PtyChild, SshTarget};
