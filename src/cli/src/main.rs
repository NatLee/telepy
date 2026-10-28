//! `telepy` 的進入點：解析參數、跑、把錯誤印成一行。/ Entry point: parse, run, print errors on one line.
use clap::Parser;

fn main() {
    // Rust 預設忽略 SIGPIPE，所以輸出管線被關掉（`telepy ls | head`）時 println! 會 panic。改回預設：
    // 跟其他命令列工具一樣安靜結束。子程序（ssh 等）本來就從預設開始，不受影響；網路連線不會收到 SIGPIPE
    // （std 在 Linux 用 MSG_NOSIGNAL、在 macOS 設 SO_NOSIGPIPE）。
    // Rust ignores SIGPIPE, so println! panics when the output pipe closes (`telepy ls | head`). Restore the default:
    // end quietly like other command-line tools. Child processes (ssh…) already start with the default; sockets never
    // raise SIGPIPE (std sends with MSG_NOSIGNAL on Linux and sets SO_NOSIGPIPE on macOS).
    #[cfg(unix)]
    // SAFETY: called first thing in main, before any other thread exists; SIG_DFL is a valid disposition.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    let cli = telepy_cli::Cli::parse();
    match telepy_cli::run(cli) {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("telepy: {e:#}");
            std::process::exit(1);
        }
    }
}
