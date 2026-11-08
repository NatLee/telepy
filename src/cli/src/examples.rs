//! 範例：`telepy` 唯一一份。`<指令> --help` 結尾的 Examples、`telepy examples [主題|指令]`、網頁 CLI 頁的範例與指令表
//! 都從這裡來：網頁的 `src/frontend/src/lib/cliExamples.gen.ts` 由它產生（`UPDATE_CLI_EXAMPLES=1 npm test`），
//! `en.ts` 的 `cli.ex.<id>` / `cli.ex.<id>Note` / `cli.topic.<id>` 要跟這裡的英文一字不差（網頁的測試會比），指令速查頁的
//! telepy 指令也要跟這裡的轉發範例一樣（同一個測試）。每一行都會被 clap 解析一次（下面的測試），參數改了範例就跟著壞。
//! 佔位字：`<tunnel>`、`<account>`、`<tunnel2>`、`<label>`、`<group>`、`<snippet>`、`<url>`；網頁換成這個人自己的。
//! 改這個檔要守的格式（網頁的測試用正規表示式讀它）：每個欄位一行、字串用一般的 `"…"`（不用 raw string）。
//!
//! The examples, once: the Examples at the end of `<command> --help`, `telepy examples [topic|command]`, and the web
//! CLI page's examples and command list all come from here. The web's `lib/cliExamples.gen.ts` is generated from it
//! (`UPDATE_CLI_EXAMPLES=1 npm test`), `en.ts`'s `cli.ex.<id>` / `cli.ex.<id>Note` / `cli.topic.<id>` must equal the
//! English here (the web test compares them), and the command sheet's telepy commands must match the forwarding
//! examples (same test). Every line is parsed by clap (tests below), so a changed flag breaks its examples.
//! Placeholders: `<tunnel>`, `<account>`, `<tunnel2>`, `<label>`, `<group>`, `<snippet>`, `<url>`; the web fills in
//! the person's own. Keep the format the web test reads with regexes: one field per line, plain `"…"` strings.

use crate::color;
use anyhow::{bail, Result};
use std::fmt::Write as _;

pub struct Topic {
    pub id: &'static str,
    pub title: &'static str,
    /// 開頭一句（網頁的 `cli.topic.<id>Intro`）；空字串 = 沒有。/ An opening sentence (the web's `cli.topic.<id>Intro`); "" = none.
    pub intro: &'static str,
}

pub struct Example {
    /// 網頁的翻譯 key：`cli.ex.<id>`、`cli.ex.<id>Note`。/ The web's keys.
    pub id: &'static str,
    pub topic: &'static str,
    pub title: &'static str,
    pub note: &'static str,
    /// 一行一條指令（shell 語法）。/ One shell line each.
    pub lines: &'static [&'static str],
    /// 要什麼：scope、`ssh-key`（系統的 OpenSSH 用你的金鑰）或 `tunnels:manage`（只有 API token 有）。
    /// What it needs: a scope, `ssh-key` (the system's OpenSSH logs in with your key) or `tunnels:manage` (tokens only).
    pub needs: &'static [&'static str],
}

/// 順序 = 網頁的主題順序。/ The web's topic order.
pub const TOPICS: &[Topic] = &[
    Topic {
        id: "everyday",
        title: "Everyday",
        intro: "",
    },
    Topic {
        id: "forward",
        title: "Port forwarding",
        intro: "One port: telepy forward waits until it answers and prints the address (--open opens it). Several ports, the other direction (-R) or a SOCKS proxy (-D): telepy ssh -N with the flags ssh uses. A whole network: telepy vpn. The device makes the connection to the host, so only the device has to reach it.",
    },
    Topic {
        id: "many",
        title: "Many devices",
        intro: "",
    },
    Topic {
        id: "files",
        title: "Files",
        intro: "",
    },
    Topic {
        id: "sessions",
        title: "Sessions & recordings",
        intro: "",
    },
    Topic {
        id: "toolbox",
        title: "Toolbox",
        intro: "",
    },
    Topic {
        id: "network",
        title: "Network & browser",
        intro: "",
    },
    Topic {
        id: "ci",
        title: "Scripts & CI",
        intro: "",
    },
    Topic {
        id: "setup",
        title: "Sign-in & upkeep",
        intro: "",
    },
];

pub const EXAMPLES: &[Example] = &[
    // ---------------------------------------------------------------- everyday
    Example {
        id: "ls",
        topic: "everyday",
        title: "Your tunnels",
        note: "Every tunnel you can use, with health, latency, accounts and labels.",
        lines: &["telepy ls"],
        needs: &["tunnels:read"],
    },
    Example {
        id: "lsJson",
        topic: "everyday",
        title: "Only the online ones, as JSON",
        note: "For scripts: pipe it into jq.",
        lines: &["telepy ls --online --json"],
        needs: &["tunnels:read"],
    },
    Example {
        id: "status",
        topic: "everyday",
        title: "One device in detail",
        note: "Health, uptime, device facts and warnings.",
        lines: &["telepy status <tunnel>"],
        needs: &["tunnels:read"],
    },
    Example {
        id: "ssh",
        topic: "everyday",
        title: "A shell on the device",
        note: "With the tunnel's default account. Nothing to set up in ~/.ssh first.",
        lines: &["telepy ssh <tunnel>"],
        needs: &["tunnels:read", "ssh-key"],
    },
    Example {
        id: "sshAccount",
        topic: "everyday",
        title: "Another account, one command",
        note: "<tunnel>@<account> picks the account; after -- comes a command instead of a shell.",
        lines: &["telepy ssh <tunnel>@<account> -- uname -a"],
        needs: &["tunnels:read", "ssh-key"],
    },
    Example {
        id: "keysAdd",
        topic: "everyday",
        title: "Add this computer's SSH key",
        note: "Opens the Keys page with the key filled in; you confirm it there (a sign-in from the terminal can't add keys on its own). No key yet? It makes one with ssh-keygen first.",
        lines: &["telepy keys add"],
        needs: &[],
    },
    Example {
        id: "keysCheck",
        topic: "everyday",
        title: "Why won't ssh get in?",
        note: "Checks each hop (your key in Telepy, the account, step-up, the device online, the key on the device) and with --yes puts your key on the device's list for that account.",
        lines: &["telepy keys check <tunnel>@<account> --yes"],
        needs: &["tunnels:read", "ssh:exec"],
    },
    Example {
        id: "configInstall",
        topic: "everyday",
        title: "Put every device in ~/.ssh/config",
        note: "Afterwards plain ssh, rsync and VS Code Remote reach them too. Re-running replaces the blocks instead of adding more.",
        lines: &["telepy config install --all"],
        needs: &["tunnels:read", "ssh-key"],
    },
    Example {
        id: "configTidy",
        topic: "everyday",
        title: "Simplify your ~/.ssh/config",
        note: "Lines several hosts share are written once and repeats ssh never reads go; every name is checked to read the same. Shows the diff and asks first; no sign-in needed.",
        lines: &["telepy config tidy"],
        needs: &[],
    },
    // ---------------------------------------------------------------- port forwarding
    // 指令速查頁「用 telepy」的預設值產生的就是這幾行（網頁測試比對）。/ The command sheet's telepy way builds exactly these with its defaults.
    Example {
        id: "lanWeb",
        topic: "forward",
        title: "A LAN web page in your own browser",
        note: "Forwards the port through the device to localhost and opens it; the host can also be its label from telepy lan ls. Ctrl+C stops it.",
        lines: &["telepy forward <tunnel>@<account> 192.168.1.20:8080 --open"],
        needs: &["tunnels:read", "ssh-key"],
    },
    Example {
        id: "forward",
        topic: "forward",
        title: "Forward a port",
        note: "The device's port 80 shows up as http://localhost:8080 on your computer.",
        lines: &["telepy forward <tunnel>@<account> localhost:80 --local 8080"],
        needs: &["tunnels:read", "ssh-key"],
    },
    Example {
        id: "forwardLan",
        topic: "forward",
        title: "A port on a machine behind the device",
        note: "Its page at https://localhost:8443. The device opens the connection, so only the device has to reach 192.168.1.1.",
        lines: &["telepy forward <tunnel>@<account> 192.168.1.1:443 --local 8443"],
        needs: &["tunnels:read", "ssh-key"],
    },
    Example {
        id: "vpn",
        topic: "forward",
        title: "A whole network behind the device",
        note: "Every machine on 192.168.1.0/24 answers at its own address on your computer until Ctrl-C (TCP and DNS; ping with --carrier). Nothing runs on the device: its sshd only forwards. sudo asks for your password to add the network device here.",
        lines: &["telepy vpn <tunnel>@<account> 192.168.1.0/24"],
        needs: &["tunnels:read", "ssh-key"],
    },
    Example {
        id: "vpnDns",
        topic: "forward",
        title: "With the network's own names",
        note: "The device's sshd finds names under corp.lan the device's own way, so http://nas.corp.lan works. Not for Mac devices.",
        lines: &["telepy vpn <tunnel>@<account> 192.168.1.0/24 --dns-domain corp.lan"],
        needs: &["tunnels:read", "ssh-key"],
    },
    Example {
        id: "vpnDnsServer",
        topic: "forward",
        title: "Names from the network's DNS server",
        note: "Asks 192.168.1.1 for names under corp.lan, over TCP through the device: real answers, Mac devices too.",
        lines: &["telepy vpn <tunnel>@<account> 192.168.1.0/24 --dns-domain corp.lan --dns-server 192.168.1.1"],
        needs: &["tunnels:read", "ssh-key"],
    },
    Example {
        id: "vpnCarrier",
        topic: "forward",
        title: "Ping and UDP too",
        note: "Starts the Telepy carrier already on the device (added the automatic or web-port way) for as long as the VPN runs: ping, UDP and names. Nothing is installed or written there.",
        lines: &["telepy vpn <tunnel>@<account> 192.168.1.0/24 --carrier"],
        needs: &["tunnels:read", "ssh-key"],
    },
    Example {
        id: "forwardMany",
        topic: "forward",
        title: "Several ports at once",
        note: "-L <local port>:<host>:<port> as in ssh, once per port. -N only forwards; leave it out to get a shell as well. Ctrl+C stops it.",
        lines: &["telepy ssh <tunnel>@<account> -N -L 8080:localhost:80 -L 15432:localhost:5432"],
        needs: &["tunnels:read", "ssh-key"],
    },
    Example {
        id: "forwardSocks",
        topic: "forward",
        title: "Everything through the device (SOCKS)",
        note: "Set your browser's SOCKS5 proxy to localhost:1080 and every site loads as if from the device's network.",
        lines: &["telepy ssh <tunnel>@<account> -N -D 1080"],
        needs: &["tunnels:read", "ssh-key"],
    },
    Example {
        id: "forwardRemote",
        topic: "forward",
        title: "Lend the device a port of yours",
        note: "The other way round: localhost:9000 on the device reaches port 3000 on your computer, e.g. a dev server the device should call.",
        lines: &["telepy ssh <tunnel>@<account> -N -R 9000:localhost:3000"],
        needs: &["tunnels:read", "ssh-key"],
    },
    Example {
        id: "forwardRustdesk",
        topic: "forward",
        title: "RustDesk's direct port",
        note: "Then connect the RustDesk app to 127.0.0.1. Direct IP access must be on in RustDesk on the device.",
        lines: &["telepy forward <tunnel>@<account> localhost:21118 --local 21118"],
        needs: &["tunnels:read", "ssh-key"],
    },
    // ---------------------------------------------------------------- many devices
    Example {
        id: "exec",
        topic: "many",
        title: "Run a command",
        note: "Through Telepy, so command rules apply and it is audited.",
        lines: &["telepy exec <tunnel> -- uptime"],
        needs: &["ssh:exec"],
    },
    Example {
        id: "execTwo",
        topic: "many",
        title: "The same command on two devices",
        note: "In parallel; each line starts with the device's name.",
        lines: &["telepy exec <tunnel> <tunnel2> -- df -h /"],
        needs: &["ssh:exec"],
    },
    Example {
        id: "execLabel",
        topic: "many",
        title: "Every device with a label",
        note: "Labels are set in the tunnel details; repeat --label to require several.",
        lines: &["telepy exec --label <label> -- systemctl is-active nginx"],
        needs: &["ssh:exec"],
    },
    Example {
        id: "execGroup",
        topic: "many",
        title: "Every device in one of your groups",
        note: "Your tunnel groups from the tunnels page.",
        lines: &["telepy exec --group <group> -- free -h"],
        needs: &["ssh:exec"],
    },
    Example {
        id: "execJson",
        topic: "many",
        title: "Results as JSON",
        note: "One object per device: exit code, output, errors.",
        lines: &["telepy exec --label <label> --json -- hostname"],
        needs: &["ssh:exec"],
    },
    Example {
        id: "execApproval",
        topic: "many",
        title: "Wait for an approval",
        note: "When a command rule asks for approval, keep waiting (up to 10 minutes) instead of failing.",
        lines: &["telepy exec <tunnel> --wait-approval -- sudo systemctl restart nginx"],
        needs: &["ssh:exec"],
    },
    // ---------------------------------------------------------------- files
    Example {
        id: "cpUp",
        topic: "files",
        title: "Copy a file to the device",
        note: "Over Telepy's SFTP; write the device side as <tunnel>[@account]:<path>.",
        lines: &["telepy cp ./backup.tar.gz <tunnel>:/tmp/"],
        needs: &["ssh:files"],
    },
    Example {
        id: "cpDown",
        topic: "files",
        title: "Copy a file from the device",
        note: "Swap the two sides to download.",
        lines: &["telepy cp <tunnel>:/var/log/syslog ./syslog"],
        needs: &["ssh:files"],
    },
    Example {
        id: "scp",
        topic: "files",
        title: "Copy a folder with scp",
        note: "Through your system's OpenSSH, so -r and every scp option work.",
        lines: &["telepy scp -r ./project <tunnel>@<account>:~/"],
        needs: &["tunnels:read", "ssh-key"],
    },
    Example {
        id: "rsync",
        topic: "files",
        title: "Sync a folder with rsync",
        note: "rsync's own options as usual; only what changed travels. rsync has to be installed on the device too.",
        lines: &["telepy rsync -avz --progress ./project <tunnel>@<account>:~/"],
        needs: &["tunnels:read", "ssh-key"],
    },
    Example {
        id: "sftp",
        topic: "files",
        title: "An sftp prompt",
        note: "Browse and move files interactively.",
        lines: &["telepy sftp <tunnel>"],
        needs: &["tunnels:read", "ssh-key"],
    },
    // ---------------------------------------------------------------- sessions & recordings
    Example {
        id: "sessions",
        topic: "sessions",
        title: "Live sessions on your tunnels",
        note: "Who is in a terminal, the file manager or a desktop right now.",
        lines: &["telepy sessions"],
        needs: &["tunnels:read"],
    },
    Example {
        id: "sessionsEnd",
        topic: "sessions",
        title: "End a session",
        note: "Ending isn't revoking: they can reconnect.",
        lines: &["telepy sessions end 42"],
        needs: &["tunnels:manage"],
    },
    Example {
        id: "recordings",
        topic: "sessions",
        title: "Terminal recordings",
        note: "For tunnels that record their web terminals.",
        lines: &["telepy recordings ls --tunnel <tunnel>"],
        needs: &["ssh:exec"],
    },
    Example {
        id: "play",
        topic: "sessions",
        title: "Play one in this terminal",
        note: "With its timing, twice as fast; long pauses are shortened.",
        lines: &["telepy recordings play 17 --speed 2"],
        needs: &["ssh:exec"],
    },
    // ---------------------------------------------------------------- toolbox
    Example {
        id: "snippets",
        topic: "toolbox",
        title: "Your toolbox snippets",
        note: "Yours, the site's and this device's.",
        lines: &["telepy snippets ls --tunnel <tunnel>"],
        needs: &["ssh:exec"],
    },
    Example {
        id: "run",
        topic: "toolbox",
        title: "Run a snippet",
        note: "Variables become --var name=value; snippets marked “ask first” ask unless you add -y.",
        lines: &["telepy run <snippet> <tunnel>"],
        needs: &["ssh:exec"],
    },
    // ---------------------------------------------------------------- network & browser
    Example {
        id: "lanLs",
        topic: "network",
        title: "The LAN behind a device",
        note: "The hosts Telepy knows there, from a scan or added by hand.",
        lines: &["telepy lan ls <tunnel>", "telepy lan map <tunnel>"],
        needs: &["tunnels:read"],
    },
    Example {
        id: "lanScan",
        topic: "network",
        title: "Scan the LAN and see what each machine is",
        note: "Waits for the scan and lists the hosts with a WHAT column (Proxmox VE, OpenWrt, a printer…); show prints each port's page title, server, certificate or banner. --no-identify skips the one GET / per web port.",
        lines: &["telepy lan scan <tunnel>", "telepy lan show <tunnel> 192.168.1.20"],
        needs: &["network:scan"],
    },
    Example {
        id: "lanWatch",
        topic: "network",
        title: "Rescan on a schedule and watch a machine",
        note: "schedule repeats the scan as you while the device is online (new machines are told to you and the tunnel's Admins); watch tells you when a scan finds that machine gone, back or with other ports; check probes just that machine now.",
        lines: &["telepy lan schedule <tunnel> --every 6h", "telepy lan watch <tunnel> 192.168.1.20", "telepy lan check <tunnel> 192.168.1.20"],
        needs: &["network:scan"],
    },
    Example {
        id: "lanWake",
        topic: "network",
        title: "Wake a machine and see it come up",
        note: "The device sends the Wake-on-LAN packet (wakeonlan, etherwake or python3 on it); it needs the MAC address from an earlier scan. Machines usually take 10–60 s to start.",
        lines: &["telepy lan wake <tunnel> 192.168.1.20", "telepy lan check <tunnel> 192.168.1.20"],
        needs: &["ssh:exec"],
    },
    Example {
        id: "lanOs",
        topic: "network",
        title: "Find out which system a machine runs",
        note: "Only for the machine you name: the device pings it, Telepy reads its SSH greeting and asks its SMB server (no login); nmap -O runs too when the device has nmap and root. lan show prints the stored result.",
        lines: &["telepy lan os <tunnel> 192.168.1.20", "telepy lan show <tunnel> 192.168.1.20"],
        needs: &["network:scan"],
    },
    Example {
        id: "lanShell",
        topic: "network",
        title: "A shell on a machine behind the device",
        note: "The device's own ssh logs in to that machine, with the device's keys or a password prompt; --ssh-opt -t gives it a terminal.",
        lines: &["telepy ssh <tunnel>@<account> --ssh-opt -t -- ssh ubuntu@192.168.1.20"],
        needs: &["tunnels:read", "ssh-key"],
    },
    Example {
        id: "lanCp",
        topic: "network",
        title: "Copy files to or from a machine behind the device",
        note: "Write the machine after a slash: <tunnel>/[login@]<host>:<path>, the host by its label, address or id. The device's sshd opens the hop and Telepy logs in with its key; set TELEPY_LAN_PASSWORD to use a password instead (used once, never stored).",
        lines: &["telepy cp <tunnel>/admin@192.168.1.20:/etc/hosts ./hosts", "TELEPY_LAN_PASSWORD=… telepy cp ./backup.tgz <tunnel>/nas:/srv/backup/"],
        needs: &["ssh:files"],
    },
    Example {
        id: "lanAdd",
        topic: "network",
        title: "Add a LAN host",
        note: "With a label, the login for its terminal and the SSH port.",
        lines: &["telepy lan add <tunnel> 192.168.1.20 --label nas --user admin", "telepy lan edit <tunnel> nas --labels rack-2,prod --note \"top shelf, UPS on the left\""],
        needs: &["tunnels:manage"],
    },
    Example {
        id: "browse",
        topic: "network",
        title: "A browser on the device's network",
        note: "Opens a scripted browser through the device, reads the page, saves a screenshot and closes it.",
        lines: &["ID=$(telepy browse <tunnel> http://192.168.1.1/)", "telepy browse text \"$ID\" --selector main", "telepy browse shot \"$ID\" -o router.png", "telepy browse close \"$ID\""],
        needs: &["browser:use"],
    },
    Example {
        id: "browseLogin",
        topic: "network",
        title: "Sign in with browser:use",
        note: "The default sign-in leaves it out; ask for it once.",
        lines: &["telepy login <url> --scope \"tunnels:read ssh:exec ssh:files browser:use\""],
        needs: &["browser:use"],
    },
    // ---------------------------------------------------------------- scripts & CI
    // 網頁在這個主題後面多一個 GitHub Actions 的 job（`lib/cliGuide.githubActions`，是檔案範本不是指令）。
    // The web adds a GitHub Actions job after this topic (`githubActions`: a file template, not a command).
    Example {
        id: "ciEnv",
        topic: "ci",
        title: "Run it from a script",
        note: "Two environment variables replace the sign-in; nothing is written to the machine.",
        lines: &["export TELEPY_URL=<url>", "export TELEPY_TOKEN=tpt_…", "telepy exec --label <label> -- uptime"],
        needs: &["ssh:exec"],
    },
    Example {
        id: "activity",
        topic: "ci",
        title: "Watch what your tokens do",
        note: "The API page's Activity tab, live in the terminal.",
        lines: &["telepy api activity --since 1h --follow"],
        needs: &[],
    },
    // ---------------------------------------------------------------- sign-in & upkeep
    Example {
        id: "login",
        topic: "setup",
        title: "Sign in",
        note: "Opens your browser to approve it; the sign-in is kept in the system keychain. --scope asks for more than the default.",
        lines: &["telepy login <url>"],
        needs: &[],
    },
    Example {
        id: "loginToken",
        topic: "setup",
        title: "Sign in with an API token",
        note: "No browser needed, e.g. on a server: make the token on the API page.",
        lines: &["telepy login <url> --with-token tpt_…"],
        needs: &[],
    },
    Example {
        id: "whoami",
        topic: "setup",
        title: "Who am I signed in as?",
        note: "The account, the server and what the sign-in may do.",
        lines: &["telepy whoami"],
        needs: &[],
    },
    Example {
        id: "doctor",
        topic: "setup",
        title: "Something's off?",
        note: "Checks the server, the sign-in, its scopes and the local ssh, and says whether a newer telepy is out.",
        lines: &["telepy doctor"],
        needs: &[],
    },
    Example {
        id: "completions",
        topic: "setup",
        title: "Tab completion",
        note: "Prints the line to add for your shell. Tunnel names, accounts and labels complete too.",
        lines: &["telepy completions"],
        needs: &[],
    },
    Example {
        id: "update",
        topic: "setup",
        title: "Keep telepy up to date",
        note: "--check only says whether a newer release is out. The update is checked against the release's SHA-256 and rolled back if the new binary doesn't start; --to v2.9.0 installs a given release.",
        lines: &["telepy update --check", "telepy update"],
        needs: &[],
    },
    Example {
        id: "apiTokens",
        topic: "setup",
        title: "Your API tokens",
        note: "Each token with a summary of its calls; telepy api activity lists the calls themselves.",
        lines: &["telepy api tokens"],
        needs: &[],
    },
    Example {
        id: "examples",
        topic: "setup",
        title: "These examples in the terminal",
        note: "By topic or by command: telepy examples forward, telepy examples lan.",
        lines: &["telepy examples forward"],
        needs: &[],
    },
    Example {
        id: "logout",
        topic: "setup",
        title: "Sign out",
        note: "Forgets the sign-in here and revokes it on the server.",
        lines: &["telepy logout"],
        needs: &[],
    },
];

// ---------------------------------------------------------------- reading the lines

/// 一行裡每個 `telepy …` 的參數（`$(…)` 裡的也算；在 `|`、`;`、`&&`、不成對的 `)` 停）。佔位字照原樣。
/// The arguments of each `telepy …` in a line (inside `$(…)` too; stops at `|`, `;`, `&&` or an unmatched `)`).
pub fn invocations(line: &str) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut from = 0;
    while let Some(i) = line[from..].find("telepy ").map(|i| i + from) {
        let starts_word = i == 0 || matches!(bytes[i - 1], b' ' | b'(' | b'\t');
        from = i + "telepy ".len();
        if !starts_word {
            continue;
        }
        let (words, end) = split_words(&line[from..]);
        from += end;
        out.push(words);
    }
    out
}

/// shell 式拆字：單引號、雙引號、反斜線；遇到命令的結尾就停，回傳讀到哪。/ Shell-style words up to the end of the command.
fn split_words(s: &str) -> (Vec<String>, usize) {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut has = false;
    let mut quote: Option<char> = None;
    let mut chars = s.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') => {
                if let Some((_, n)) = chars.next() {
                    cur.push(n);
                }
            }
            (Some(_), c) => cur.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                has = true;
            }
            (None, '\\') => {
                if let Some((_, n)) = chars.next() {
                    cur.push(n);
                    has = true;
                }
            }
            (None, ' ' | '\t') => {
                if has {
                    words.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            (None, '|' | ';' | ')') => {
                if has {
                    words.push(cur);
                }
                return (words, i);
            }
            (None, '&') if matches!(chars.peek(), Some((_, '&'))) => {
                if has {
                    words.push(cur);
                }
                return (words, i);
            }
            (None, c) => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        words.push(cur);
    }
    (words, s.len())
}

/// 一個範例碰到的子指令路徑（`["lan", "wake"]`…），照 clap 的指令樹找。/ The subcommand paths an example invokes.
fn paths(cmd: &clap::Command, ex: &Example) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = Vec::new();
    for line in ex.lines {
        for argv in invocations(line) {
            let mut cur = cmd;
            let mut path = Vec::new();
            for w in &argv {
                match cur.find_subcommand(w) {
                    Some(sub) => {
                        path.push(sub.get_name().to_string());
                        cur = sub;
                    }
                    None => break,
                }
            }
            if !path.is_empty() && !out.contains(&path) {
                out.push(path);
            }
        }
    }
    out
}

/// 某個子指令（含它下面的）的範例。/ The examples of a subcommand and the ones below it.
fn examples_under(cmd: &clap::Command, prefix: &[String]) -> Vec<&'static Example> {
    EXAMPLES.iter().filter(|ex| paths(cmd, ex).iter().any(|p| p.starts_with(prefix))).collect()
}

// ---------------------------------------------------------------- --help

/// 每個有範例的子指令說明結尾加上 Examples；要參數卻什麼都沒給的子指令（`telepy forward`）印說明（含範例）而不是只報錯。
/// Adds Examples to the end of every subcommand's help, and makes a subcommand called without its required arguments
/// (`telepy forward`) print that help (examples included) instead of only an error.
pub fn attach(cmd: clap::Command) -> clap::Command {
    let root = cmd.clone();
    attach_at(cmd, &root, &[])
}

fn attach_at(mut cmd: clap::Command, root: &clap::Command, path: &[String]) -> clap::Command {
    let names: Vec<String> = cmd.get_subcommands().map(|s| s.get_name().to_string()).collect();
    for name in names {
        let mut sub_path = path.to_vec();
        sub_path.push(name.clone());
        cmd = cmd.mut_subcommand(&name, |sub| {
            let sub = attach_at(sub, root, &sub_path);
            let needs_input = sub.is_subcommand_required_set() || sub.get_arguments().any(|a| a.is_required_set() && a.is_positional());
            let found = examples_under(root, &sub_path);
            let sub = if needs_input { sub.arg_required_else_help(true) } else { sub };
            if found.is_empty() {
                sub
            } else {
                sub.after_help(help_text(&found, &sub_path))
            }
        });
    }
    cmd
}

fn help_text(found: &[&Example], path: &[String]) -> clap::builder::StyledStr {
    let header = color::styles().get_header().to_owned();
    let dim = color::DIM;
    let mut s = String::new();
    let _ = writeln!(s, "{}Examples:{}", header.render(), header.render_reset());
    for (i, ex) in found.iter().enumerate() {
        if i > 0 {
            s.push('\n');
        }
        let _ = writeln!(s, "  {}# {}{}", dim.render(), ex.title, dim.render_reset());
        for line in ex.lines {
            let _ = writeln!(s, "  {}${} {line}", dim.render(), dim.render_reset());
        }
    }
    // 這個指令的全部範例，與第一個範例所屬的主題（同名就只寫一次）。/ All of this command's, and the first one's topic.
    let here = path.join(" ");
    let topic = found.first().map(|ex| ex.topic).unwrap_or("everyday");
    let more = if topic == here { format!("telepy examples {here}") } else { format!("telepy examples {here} · telepy examples {topic}") };
    let _ = write!(s, "\n{}More: {more}{}", dim.render(), dim.render_reset());
    clap::builder::StyledStr::from(s)
}

// ---------------------------------------------------------------- telepy examples

/// `telepy examples [主題|指令]`。/ `telepy examples [topic|command]`.
pub fn run(query: &[String], root: &clap::Command) -> Result<i32> {
    let q: Vec<String> = query.iter().map(|w| w.trim().to_lowercase()).filter(|w| !w.is_empty()).collect();
    if q.is_empty() {
        print!("{}", list_topics());
        return Ok(0);
    }
    if q.len() == 1 {
        if let Some(topic) = TOPICS.iter().find(|t| t.id == q[0] || t.title.to_lowercase() == q[0]) {
            let found: Vec<&Example> = EXAMPLES.iter().filter(|e| e.topic == topic.id).collect();
            print!("{}", render(topic.title, topic.intro, &found, width()));
            return Ok(0);
        }
    }
    // 指令（`lan`、`lan wake`、別名也行）。/ A command (`lan`, `lan wake`, aliases too).
    let mut cur = root;
    let mut path = Vec::new();
    for w in &q {
        match cur.find_subcommand(w) {
            Some(sub) => {
                path.push(sub.get_name().to_string());
                cur = sub;
            }
            None => break,
        }
    }
    if path.len() == q.len() {
        let found = examples_under(root, &path);
        if found.is_empty() {
            bail!("No examples for `telepy {}` yet; try `telepy {} --help`.", path.join(" "), path.join(" "));
        }
        print!("{}", render(&format!("telepy {}", path.join(" ")), "", &found, width()));
        return Ok(0);
    }
    let topics: Vec<&str> = TOPICS.iter().map(|t| t.id).collect();
    bail!("'{}' is neither a topic ({}) nor a command.", q.join(" "), topics.join(", "))
}

fn list_topics() -> String {
    let width = TOPICS.iter().map(|t| t.id.len()).max().unwrap_or(0);
    let mut s = String::new();
    let _ = writeln!(s, "{}", color::out(color::BOLD, "Examples by topic"));
    for t in TOPICS {
        let n = EXAMPLES.iter().filter(|e| e.topic == t.id).count();
        let _ = writeln!(s, "  {:width$}  {} {}", t.id, t.title, color::out(color::DIM, &format!("({n})")));
    }
    let _ = writeln!(s, "\n{}", color::out(color::DIM, "telepy examples <topic>, or by command: telepy examples lan wake"));
    s
}

/// 終端機寬度（說明折行用，最多 100 欄好讀）；不是終端機就不折。/ The terminal's width for wrapping (at most 100); none = no wrapping.
fn width() -> Option<usize> {
    crate::tapi::columns(crate::tapi::Out::Stdout).map(|w| w.min(100))
}

/// 一組範例：標題、開頭一句、每個範例的標題、說明（照 `cols` 折行、縮排）、指令（不折，複製得到整行）。
/// A set of examples: heading, intro, then each example's title, note (wrapped to `cols`, indented) and commands
/// (never wrapped, so they copy whole).
pub fn render(heading: &str, intro: &str, found: &[&Example], cols: Option<usize>) -> String {
    let wrapped = |text: &str, indent: usize| -> Vec<String> {
        match cols {
            Some(c) => crate::tapi::wrap(&[text], c.saturating_sub(indent).max(20)),
            None => vec![text.to_string()],
        }
    };
    let mut s = String::new();
    let _ = writeln!(s, "{}", color::out(color::BOLD, heading));
    if !intro.is_empty() {
        for l in wrapped(intro, 0) {
            let _ = writeln!(s, "{l}");
        }
    }
    for ex in found {
        let _ = writeln!(s);
        let _ = writeln!(s, "  {}", color::out(color::BOLD, ex.title));
        for l in wrapped(ex.note, 2) {
            let _ = writeln!(s, "  {}", color::out(color::DIM, &l));
        }
        for line in ex.lines {
            let _ = writeln!(s, "  {} {line}", color::out(color::DIM, "$"));
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::FromArgMatches;

    /// 佔位字換成能解析的值。/ Placeholders become parseable values.
    fn sample(line: &str) -> String {
        line.replace("<tunnel>", "box")
            .replace("<account>", "pi")
            .replace("<tunnel2>", "nas")
            .replace("<label>", "env=prod")
            .replace("<group>", "lab")
            .replace("<snippet>", "df")
            .replace("<url>", "https://telepy.example.com")
    }

    #[test]
    fn every_example_parses_with_the_real_command() {
        for ex in EXAMPLES {
            let mut seen = 0;
            for line in ex.lines {
                for argv in invocations(&sample(line)) {
                    seen += 1;
                    let mut args = vec!["telepy".to_string()];
                    args.extend(argv);
                    let m = crate::command().try_get_matches_from(&args).unwrap_or_else(|e| panic!("example {} does not parse: {}\n{e}", ex.id, args.join(" ")));
                    crate::Cli::from_arg_matches(&m).unwrap_or_else(|e| panic!("example {}: {e}", ex.id));
                }
            }
            assert!(seen > 0, "example {} runs no telepy command", ex.id);
        }
    }

    #[test]
    fn ids_topics_and_texts_are_well_formed() {
        let mut ids: Vec<&str> = EXAMPLES.iter().map(|e| e.id).collect();
        ids.sort();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n, "example ids are unique");
        for ex in EXAMPLES {
            assert!(TOPICS.iter().any(|t| t.id == ex.topic), "{} has a known topic", ex.id);
            assert!(ex.id.chars().all(|c| c.is_ascii_alphanumeric()) && ex.id.starts_with(|c: char| c.is_ascii_lowercase()), "{}: camelCase id (it is a translation key)", ex.id);
            assert!(!ex.title.ends_with('.'), "{}: a title, not a sentence", ex.id);
            assert!(ex.note.ends_with('.') || ex.note.ends_with('?'), "{}: the note is a sentence", ex.id);
            for need in ex.needs {
                assert!(["tunnels:read", "ssh:exec", "ssh:files", "network:scan", "browser:use", "tunnels:manage", "ssh-key"].contains(need), "{}: unknown need {need}", ex.id);
            }
        }
        for t in TOPICS {
            assert!(EXAMPLES.iter().any(|e| e.topic == t.id), "topic {} has examples", t.id);
        }
    }

    #[test]
    fn every_visible_command_has_an_example() {
        let cmd = crate::command();
        for sub in cmd.get_subcommands().filter(|s| !s.is_hide_set()) {
            let found = examples_under(&cmd, &[sub.get_name().to_string()]);
            assert!(!found.is_empty(), "`telepy {}` has no example", sub.get_name());
        }
    }

    #[test]
    fn invocations_are_found_inside_substitutions_and_quotes() {
        assert_eq!(invocations("telepy ls"), vec![vec!["ls".to_string()]]);
        assert_eq!(invocations("ID=$(telepy browse box http://x/)"), vec![vec!["browse", "box", "http://x/"].into_iter().map(String::from).collect::<Vec<_>>()]);
        assert_eq!(invocations("telepy lan edit box nas --note \"top shelf, UPS\""), vec![vec!["lan", "edit", "box", "nas", "--note", "top shelf, UPS"].into_iter().map(String::from).collect::<Vec<_>>()]);
        assert_eq!(invocations("export TELEPY_URL=x"), Vec::<Vec<String>>::new());
        assert_eq!(invocations("TELEPY_LAN_PASSWORD=… telepy cp a b | tee log").len(), 1);
        assert_eq!(invocations("telepy ls --json && telepy whoami").len(), 2);
        assert!(invocations("mytelepy ls").is_empty(), "only the word telepy");
    }

    #[test]
    fn help_shows_the_commands_examples_and_a_missing_argument_shows_help() {
        let mut cmd = crate::command().color(clap::ColorChoice::Never);
        let fwd = cmd.find_subcommand_mut("forward").unwrap();
        let help = fwd.render_long_help().to_string();
        assert!(help.contains("Examples:"));
        assert!(help.contains("$ telepy forward <tunnel>@<account> 192.168.1.20:8080 --open"));
        assert!(help.contains("More: telepy examples forward"));
        // 子指令的子指令：只有它自己的。/ A nested subcommand gets only its own.
        let wake = cmd.find_subcommand_mut("lan").unwrap().find_subcommand_mut("wake").unwrap().render_long_help().to_string();
        assert!(wake.contains("telepy lan wake <tunnel> 192.168.1.20"));
        assert!(!wake.contains("lan scan"));
        let err = crate::command().try_get_matches_from(["telepy", "forward"]).unwrap_err();
        assert_eq!(err.kind(), clap::error::ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand);
    }

    #[test]
    fn the_examples_command_finds_topics_and_commands() {
        let root = crate::command();
        assert!(run(&["forward".into()], &root).is_ok());
        assert!(run(&["lan".into(), "wake".into()], &root).is_ok());
        assert!(run(&["Port forwarding".into()], &root).is_ok());
        assert!(run(&["nonsense".into()], &root).is_err());
        let text = render("Port forwarding", "", &EXAMPLES.iter().filter(|e| e.topic == "forward").collect::<Vec<_>>(), Some(40));
        assert!(text.contains("$ telepy ssh <tunnel>@<account> -N -R 9000:localhost:3000"), "commands are never wrapped");
        assert!(text.lines().all(|l| l.contains("$ telepy") || crate::tapi::visible_width(l) <= 40), "notes are wrapped to the width");
    }
}
