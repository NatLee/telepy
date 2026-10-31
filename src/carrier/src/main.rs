//! `telepy-carrier` 的進入點：解參數、選代理、跑裝置端的連線策略。/ Entry point: arguments, proxy, the device policy.
fn main() {
    let cli = match telepy_carrier::parse_args(std::env::args().skip(1)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("telepy-carrier: {e}");
            std::process::exit(2);
        }
    };
    if cli.version {
        println!("telepy-carrier {}", telepy_carrier::VERSION);
        return;
    }
    if cli.help {
        print!("{}", telepy_carrier::USAGE);
        return;
    }
    let url = cli.url.clone().unwrap_or_default();
    let host = match telepy_carrier::ws_endpoint(&url) {
        Ok((h, _, _)) => h,
        Err(e) => {
            eprintln!("telepy-carrier: {e:#}");
            std::process::exit(2);
        }
    };
    let proxy = match telepy_carrier::choose_proxy(&cli, &host) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("telepy-carrier: {e}");
            std::process::exit(2);
        }
    };
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("tokio runtime");
    let note = |m: &str| eprintln!("telepy-carrier: {m}");
    let code = rt.block_on(telepy_carrier::run_device(cli.tcp.as_deref(), &url, proxy.as_ref(), &note));
    std::process::exit(code);
}
