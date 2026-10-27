//! `telepy` 的進入點：解析參數、跑、把錯誤印成一行。/ Entry point: parse, run, print errors on one line.
use clap::Parser;

fn main() {
    let cli = telepy_cli::Cli::parse();
    match telepy_cli::run(cli) {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("telepy: {e:#}");
            std::process::exit(1);
        }
    }
}
