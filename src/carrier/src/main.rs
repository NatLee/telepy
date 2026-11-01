//! `telepy-carrier` 的進入點：`tunnel` / `keygen` 子指令（內建的 SSH client），其餘是 ssh 的 ProxyCommand（參數跟以前
//! 一樣，裝好的裝置的包裝腳本照舊能用）。/ Entry point: the `tunnel` / `keygen` subcommands (the built-in SSH client);
//! anything else is the ssh ProxyCommand, with the same arguments as before (installed wrappers keep working).
fn main() {
    let mut args = std::env::args().skip(1).peekable();
    #[cfg(feature = "client")]
    match args.peek().map(String::as_str) {
        Some("tunnel") => {
            args.next();
            std::process::exit(tunnel(args.collect()));
        }
        Some("keygen") => {
            args.next();
            std::process::exit(keygen(args.collect()));
        }
        _ => {}
    }
    let cli = match telepy_carrier::parse_args(args) {
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

#[cfg(feature = "client")]
fn tunnel(args: Vec<String>) -> i32 {
    use telepy_carrier::tunnel;
    let t = match tunnel::parse_tunnel_args(args) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("telepy-carrier: {e}");
            return tunnel::EXIT_USAGE;
        }
    };
    if t.help {
        print!("{}", tunnel::TUNNEL_USAGE);
        return 0;
    }
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("tokio runtime");
    let note = |m: &str| eprintln!("telepy-carrier: {m}");
    rt.block_on(tunnel::run(&t, &note))
}

#[cfg(feature = "client")]
fn keygen(args: Vec<String>) -> i32 {
    use telepy_carrier::tunnel;
    let k = match tunnel::parse_keygen_args(args) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("telepy-carrier: {e}");
            return tunnel::EXIT_USAGE;
        }
    };
    let made = if k.public_only { tunnel::public_line(&k.file) } else { tunnel::keygen(&k.file, &k.comment) };
    match made {
        Ok(public) => {
            println!("{public}");
            0
        }
        Err(e) => {
            eprintln!("telepy-carrier: {e:#}");
            1
        }
    }
}
