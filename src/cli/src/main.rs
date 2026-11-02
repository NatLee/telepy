//! `telepy` 的進入點：解析參數、跑、把錯誤印成一行。/ Entry point: parse, run, print errors on one line.
use clap::FromArgMatches;
use telepy_cli::{color, complete};

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
    // shell 按 Tab 時叫的就是這裡（`TELEPY_COMPLETE=<shell>`）：印出候選就結束。/ A Tab in the shell lands here: print the candidates and exit.
    clap_complete::CompleteEnv::with_factory(telepy_cli::command).var(complete::VAR).complete();
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    // `--color` 先看：clap 自己的說明與錯誤訊息也照它。/ `--color` first: clap's own help and errors follow it too.
    let when = color::when_from_args(&args);
    color::set(when);
    let matches = telepy_cli::command().color(when.clap()).get_matches_from(args);
    let cli = telepy_cli::Cli::from_arg_matches(&matches).unwrap_or_else(|e| e.exit());
    match telepy_cli::run(cli) {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("{} {e:#}", color::err(color::ERROR, "telepy:"));
            std::process::exit(1);
        }
    }
}
