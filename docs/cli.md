# The `telepy` command line and personal API tokens

<p align="center"><b>English</b> | <a href="./cli.zh-TW.md">繁體中文</a> | <a href="./cli.ja.md">日本語</a></p>

`telepy` is Telepy in your terminal. It lists your tunnels, takes `ssh`, `scp` and `sftp` straight to a device, runs a command on one device or on every device with a label, copies files, shows and ends live sessions, plays terminal recordings and runs toolbox snippets.

Scripts and CI use the same commands. Instead of a browser sign-in, they carry a **personal API token**.

Tokens and CLI sign-ins live on the **API** page in the web (sidebar **Developers → API**), which has four tabs:

- **CLI sign-ins**: every computer you ran `telepy login` on.
- **Your tokens**: create, check and revoke tokens.
- **What a token can call**: every endpoint, with a copy-ready `curl` and the matching `telepy` command.
- **Activity**: what your tokens and CLI sign-ins did.

## Install

The easy way is the **CLI** page in the web (sidebar **Developers → CLI**). It picks the install command for your computer from your browser, gives you the sign-in command for your server, and fills its examples with your own tunnels, accounts, labels, groups and snippets.

By hand, it goes like this. Every Telepy release from `v2.8.0` on carries the CLI for:

- macOS arm64 and x86_64
- Linux x86_64 and arm64 (static, musl)
- Windows x86_64

Each build comes from that release's tag and reports the same version (`telepy --version`). The file names carry no version, so `releases/latest/download/…` always gets the newest.

```sh
# macOS / Linux
TARGET=aarch64-apple-darwin   # x86_64-apple-darwin, x86_64-unknown-linux-musl, aarch64-unknown-linux-musl
curl -fsSL "https://github.com/NatLee/telepy/releases/latest/download/telepy-$TARGET.tar.gz" | tar xz telepy
sudo mkdir -p /usr/local/bin && sudo install -m 755 telepy /usr/local/bin/ && rm telepy
telepy --version
```

```powershell
# Windows: unpacks into %LOCALAPPDATA%\telepy and adds it to your PATH once
$dir = "$env:LOCALAPPDATA\telepy"
Invoke-WebRequest https://github.com/NatLee/telepy/releases/latest/download/telepy-x86_64-pc-windows-msvc.zip -OutFile "$env:TEMP\telepy.zip"
Expand-Archive "$env:TEMP\telepy.zip" $dir -Force
$p = [Environment]::GetEnvironmentVariable("Path", "User")
if (($p -split ";") -notcontains $dir) { [Environment]::SetEnvironmentVariable("Path", "$p;$dir", "User") }
$env:Path += ";$dir"
telepy --version
```

For a specific version, use `…/releases/download/v2.11.0/telepy-$TARGET.tar.gz` instead.

`ssh`, `scp` and `sftp` also need the system's OpenSSH client on your PATH. `telepy doctor` checks that for you.

### Check what you downloaded

Each archive has a `.sha256` next to it, and every release has a `SHA256SUMS`: `curl -fsSL …/telepy-$TARGET.tar.gz.sha256 | sha256sum -c` (on macOS, `shasum -a 256 -c`).

The binary carries no Apple or Microsoft signature. If you downloaded it with a browser instead of `curl`, macOS wants `xattr -d com.apple.quarantine telepy` before it will run it.

Two more checks prove that a release file really is Telepy's. Neither needs an account.

- **Build provenance**: every file of a release is attested by the build itself (GitHub artifact attestations). `gh attestation verify telepy-$TARGET.tar.gz --repo NatLee/telepy` names the commit and the workflow run that produced exactly these bytes.
- **The signed checksum list**: `SHA256SUMS` is signed with Telepy's release key, an OpenSSH ed25519 key whose public half is in [`src/backend-api/src/release_key.rs`](../src/backend-api/src/release_key.rs). The signature is `SHA256SUMS.sig`, in OpenSSH's signature format, so OpenSSH alone can check it:

  ```sh
  echo "telepy-release $(sed -n 's/^ *"\(ssh-ed25519 [^"]*\)".*/\1/p' release_key.rs | head -1)" > allowed_signers
  ssh-keygen -Y verify -f allowed_signers -I telepy-release -n telepy-release -s SHA256SUMS.sig < SHA256SUMS
  sha256sum -c --ignore-missing SHA256SUMS
  ```

  You can also paste the key line from that file by hand: `allowed_signers` is one line, `telepy-release <the key>`.

`telepy update` runs this check itself, and so does the Telepy server when it downloads its device helper from a release. Both refuse a release whose `SHA256SUMS` is missing or not signed with a Telepy release key. A mirror that re-signs releases with its own key can set `TELEPY_RELEASE_KEYS` (one or more public key lines, separated by newlines or `;`) to replace the built-in keys.

### Build it yourself

With Rust 1.88 or newer:

```sh
cargo install --locked --git https://github.com/NatLee/telepy telepy-cli
```

That build reports Cargo.toml's version, `0.1.0`. Set `TELEPY_VERSION` while building to stamp another one.

### Update

```sh
telepy update --check        # is a newer release out?
telepy update                # download it, check it against the release's signed SHA256SUMS and replace this telepy
telepy update --to v2.9.0    # a given release (also to go back)
```

What `telepy update` does:

1. Downloads this platform's archive from the release.
2. Refuses it when `SHA256SUMS` isn't signed with a Telepy release key, or the archive's SHA-256 doesn't match it.
3. Writes the new binary next to the old one, moves the old one aside and runs the new one's `--version`.
4. If that fails, puts the old one back.

It needs write access to the folder telepy is in (`sudo telepy update` for `/usr/local/bin`). A telepy installed with `cargo install` or Homebrew is left to those tools. On Windows the old `.exe` is renamed, because a running file can't be deleted, and cleaned up on the next run.

Release builds also look for a newer release on their own:

- at most once a day, in the background, with a two-second timeout;
- only when stderr is a terminal and `CI` is not set;
- when one is out, a single line after a successful command says so.

`TELEPY_NO_UPDATE_CHECK=1` turns that off. `TELEPY_RELEASES_URL` points both the check and `telepy update` at a mirror of `https://github.com/NatLee/telepy/releases`. The latest tag is read from the `/latest` redirect, so no GitHub API rate limit applies.

`telepy doctor` shows the version and whether a newer one is out (a warning, never a failure). A telepy you built yourself never checks on its own.

## Sign in

```sh
telepy login https://telepy.example.com                 # browser: OAuth + PKCE, loopback callback
telepy login https://telepy.example.com --scope "tunnels:read ssh:exec ssh:files network:scan"
telepy login https://telepy.example.com --no-browser    # print the sign-in URL instead of opening a browser
telepy login https://telepy.example.com --token tpt_…   # a personal API token (the API page → Your tokens); --with-token works too
telepy whoami                                           # who, and with which token / app, scopes, tunnels and expiry
telepy logout
```

Without `--scope`, the browser sign-in asks for `tunnels:read ssh:exec ssh:files`. See [Scopes](#scopes) for what each one allows.

After you approve, the browser lands on Telepy's "signed in" page. It shows what the CLI may do now and a few commands to try, and it follows the approval page's look from **Site settings → Sign-in**. An older Telepy server without that page gets a small page drawn by the CLI itself.

### CLI sign-ins are not MCP apps

The browser sign-in uses the same OAuth approval as MCP apps, which is why the approval page looks alike. The CLI is still not an MCP app:

- It is listed on the **API** page under **CLI sign-ins**, one per computer, and its calls show up in the API activity. It never appears among MCP apps.
- You sign it out there, or with `telepy logout`.
- Running `telepy login` again on the same computer offers to replace its earlier sign-in.
- Each person keeps at most 10 CLI sign-ins. An 11th signs out the one used least recently.
- Browser sign-in follows the **MCP apps** feature, which an admin can turn off (**Admin → Users & access → Feature permissions**). A token keeps working without it.

### Where the sign-in is kept

The CLI stores an access token and a refresh token:

- **macOS**: in the Keychain.
- **Windows**: in the Credential Manager.
- **Linux**, and anywhere with `TELEPY_NO_KEYRING=1` or a keyring that fails: in `credentials.json`, mode 0600, in the config directory. That is `TELEPY_CONFIG_DIR` when set, else `$XDG_CONFIG_HOME/telepy` or `~/.config/telepy` (Windows: `%APPDATA%\telepy`).

`telepy logout` forgets the sign-in and, for a browser sign-in, revokes it on the server. A token stays valid until you revoke it on the API page.

In CI there is nothing to store: see [In CI](#in-ci).

### Meet Tapi

In a terminal, `telepy login` and a clean `telepy doctor` show Tapi, Telepy's little ghost, next to the result. The text beside it wraps to the terminal's width. In a narrow terminal it moves below Tapi, and in a very narrow one Tapi is left out.

Tapi only haunts terminals: piped output never gets a ghost. `NO_COLOR` draws it without colour, and `TELEPY_NO_MASCOT=1` leaves it out for good.

## Everyday commands

![How the CLI reaches your devices](images/en/cli-flow.png)

A target is a tunnel, optionally with a device account: `box` uses the tunnel's default account, `box@pi` uses `pi` (`pi@box` works too). `telepy <command> --help` lists every option of a command.

### Find your tunnels

```sh
telepy ls                                  # NAME  HEALTH  LATENCY  ACCOUNTS  LABELS  GROUP  SEEN
telepy ls --label env=prod --online --json
telepy ls --group "Lab"
telepy status box                          # health, uptime, device facts and warnings
```

### SSH, scp and sftp

```sh
telepy ssh box                             # the tunnel's default account
telepy ssh box@pi -- uname -a              # <tunnel>@<account> (pi@box works too)
telepy ssh box -L 8080:localhost:80        # forward a port; -D 1080 for SOCKS
telepy ssh box -i ~/.ssh/id_work           # a specific key for both hops
telepy ssh box --ssh-opt "-o ServerAliveInterval=30"   # any other ssh option (repeatable; scp / sftp take it too)
telepy scp ./build.tar.gz box@pi:/tmp/
telepy scp -r box@pi:/var/log/app ./logs
telepy sftp box@pi
```

These run your system's OpenSSH and log in with **your personal SSH key**, through Telepy's gateway and the tunnel. It is the same path the web's **SSH config** dialog sets up.

Each run writes two files into `~/.ssh/telepy/` (move that folder with `TELEPY_SSH_DIR`):

- `<alias>.conf`: the generated config, whose ProxyCommand points back at that file;
- `known_hosts-<server>`: Telepy's gateway host key, pinned.

Then it starts OpenSSH with `-F`. Your own `~/.ssh/config` stays untouched.

### Web port or SSH port

`telepy ssh`, `scp` and `sftp` reach Telepy through its **web port** by default. `telepy` itself is the ProxyCommand for the hop to Telepy and carries the SSH inside a WebSocket (`/ws/gateway/`; no python3 needed).

The SSH inside is the same: your key, the pinned host key, the device's own sshd. The difference is that Telepy now records your real address, which whatever sits in front of the SSH port (OrbStack's or Docker's port forwarding, a NAT) often hides.

The SSH hop sends a keepalive every 30 s, so a proxy in front of the web port (a CDN, a load balancer) doesn't close an idle session.

```sh
telepy ssh box --via ssh                   # straight to Telepy's SSH port instead of the web port
telepy config fallback always              # this server: use the SSH port without asking when the web port can't be reached
```

When the web port can't be reached, `telepy` uses the SSH port only with your consent:

| `--fallback` / `telepy config fallback` | What happens |
| --- | --- |
| `ask` (default) | Asks in the terminal: **y** this time, **a** always for this server (saved), **N** no. Without a terminal (CI, scripts) it doesn't fall back, and says how to allow it. |
| `always` | Uses the SSH port and says so on stderr. |
| `never` | Fails with the reason. |

The choice is saved per server in `<config dir>/prefs.json`, and `telepy config fallback` without a value shows it. `--fallback` or `TELEPY_SSH_FALLBACK` overrides it for one run. `--via ssh` or `TELEPY_SSH_VIA=ssh` skips the web port altogether. `telepy doctor` shows both.

### Your `~/.ssh/config`

To put Telepy's blocks into your own config, the way the web's SSH config dialog does:

```sh
telepy config install box nas              # the web dialog's install command, done for you (~/.ssh/config, marked blocks, backup)
telepy config install --all --print        # every tunnel you can use; print the blocks instead of writing (--file <path> writes elsewhere)
```

It keeps a `config.bak` and saves the host keys to `~/.ssh/telepy_known_hosts`. Like the web dialog, it leaves alone same-named devices that belong to another Telepy server. To have both, set a name prefix in the SSH config dialog ("Several Telepy servers on this computer?").

`config tidy` simplifies the config you already have:

```sh
telepy config tidy                         # simplify ~/.ssh/config: shows what changes + the diff, asks, keeps config.bak
telepy config tidy --check                 # report only; exit 1 when it could be simpler or has lines worth a look (dotfiles CI)
```

It needs no sign-in and never sends the file anywhere. It follows the rules of the web's **SSH config editor** (same engine, kept identical by shared test cases):

- Lines that several hosts share are written once, in a `Host a b c` block after them. A host that sets its own value keeps it.
- `HostName web1.example.com` under `Host web1` becomes `HostName %h.example.com`.
- Repeats that ssh never reads are dropped.

Every name in the file is then resolved again and must read exactly as before. Nothing is moved across `Match` or `Include`, and Telepy's own blocks keep their markers. It also lists lines that never take effect and options ssh doesn't know.

`--wildcards` allows `Host web-*` where no other name in the file would match. `--yes` writes without asking (a backup is still made). `--file <path>` simplifies another file.

### Run commands

```sh
telepy exec box -- systemctl is-active nginx
telepy exec --label env=prod -- uptime     # every tunnel with the label, in parallel, "name | " prefixes
telepy exec --group Lab -u root --timeout 300 -- apt-get -y upgrade   # a tunnel group of yours, one account, timeout ≤ 600 s
telepy exec box nas --json -- df -h /
telepy exec box --wait-approval -- sudo reboot   # keep waiting while a command rule holds it for approval
```

`exec` opens a short-lived session per tunnel through Telepy, runs the command and closes the session (`POST /api/ai/sessions`, then `POST /api/ai/sessions/{id}/exec`). These sessions are treated like an MCP agent's: the same cleanup, command rules and audit. The timeout is 60 s unless you say otherwise.

The commands show up on the **AI activity** page under the token's name, or under the CLI's app name after a browser sign-in.

### Copy files

```sh
telepy cp box@pi:/var/log/syslog ./syslog
telepy cp ./config.yml box@pi:/etc/app/
```

`cp` copies over SFTP through Telepy's API and needs the `ssh:files` scope. `scp` is the OpenSSH way and needs your personal SSH key.

### Sessions, recordings and snippets

```sh
telepy sessions                            # live sessions on your tunnels
telepy sessions end 42
telepy recordings ls --tunnel box
telepy recordings play 17 --speed 2        # with its timing, pauses capped at 2 s (--idle-limit 0 keeps every pause)
telepy snippets ls --tunnel box
telepy run "restart service" box --var svc=nginx   # -y skips the "ask first" confirmation
```

Ending a session is not a revoke: the person can reconnect.

### LAN hosts

```sh
telepy lan ls box                          # the LAN hosts Telepy knows behind a device
telepy lan add box 192.168.1.20 --label nas --user pi --port 22
telepy lan rm box nas                      # by id, address or label
```

Listing needs `tunnels:read`. Adding and removing need `tunnels:manage`, which only API tokens can carry.

### A browser on the device's network

```sh
ID=$(telepy browse box http://192.168.1.1/)   # a browser on the device's network (browser:use); prints its id
telepy browse text "$ID" --selector main
telepy browse shot "$ID" -o router.png
telepy browse click "$ID" --text "Status"
telepy browse type "$ID" "#q" "uptime" --enter
telepy browse go "$ID" http://192.168.1.1/logs
telepy browse ls
telepy browse close "$ID"
```

`browse` drives a **scripted browser**: a real Chromium that browses as if it sat on the device. It sees the device's LAN, its localhost and its public IP, so it can reach a router's admin page, an intranet dashboard, or a site that only allows that IP or region.

- One action at a time, each limited to 30 s.
- Each browser is a full Chromium and counts against your per-person session limit (**AI Sessions per User** in Site settings). It suits scripted checks, screenshots and small scraping jobs. It is not a crawler, and the server would like to keep it that way.
- Browsers close themselves when idle.
- Every action is in the AI activity log. Typed text is logged by its length only, unless you add `--show`.
- Tunnels that ask for step-up refuse them.

## Command reference

Every command also takes `--server <url>` and `--token tpt_…` (or `TELEPY_URL` and `TELEPY_TOKEN`) to choose the server and the credential for that run.

<details>
<summary>Every command, what it does and the scope it needs</summary>

| Command | What it does | Scope |
| --- | --- | --- |
| `telepy login <url>` | Sign in through the browser; `--token` / `--with-token` signs in with a token, `--scope` and `--no-browser` as above | — |
| `telepy logout` | Forget the sign-in; a browser sign-in is also revoked on the server | — |
| `telepy whoami` | Who you are, with which token or app, scopes, tunnels and expiry | — |
| `telepy ls` | Tunnels with health, latency, accounts, labels and group; `--label`, `--group`, `--online`, `--json` | `tunnels:read` |
| `telepy status <tunnel>` | One tunnel: health, uptime, device facts and warnings | `tunnels:read` |
| `telepy ssh <target>` | SSH into the device; `-L`, `-D`, `-i`, `--ssh-opt`, `--via`, `--fallback`, a command after `--` | `tunnels:read` + your SSH key |
| `telepy scp [-r] <from>… <to>` | Copy with scp; the remote side is `<tunnel>[@account]:<path>` | `tunnels:read` + your SSH key |
| `telepy sftp <target>` | Open sftp to the device | `tunnels:read` + your SSH key |
| `telepy config install` | Put Telepy's blocks into `~/.ssh/config`; tunnels or `--all`, `--print`, `--file` | `tunnels:read` |
| `telepy config fallback` | Show or set what to do when the web port can't be reached: `ask`, `always`, `never` | — |
| `telepy config tidy` | Simplify an ssh config; `--check`, `--wildcards`, `--yes`, `--file`; no sign-in needed | — |
| `telepy exec <targets> -- <command>` | Run a command on one or more devices; `--label`, `--group`, `-u`, `--timeout` (default 60, at most 600), `--wait-approval`, `--json` | `ssh:exec` |
| `telepy cp <from> <to>` | Copy a file to or from a device over SFTP | `ssh:files` |
| `telepy sessions` | Live sessions on your tunnels | `tunnels:read` |
| `telepy sessions end <id>` | End one live session | `tunnels:manage` |
| `telepy recordings ls` | List recordings, newest first; `--tunnel` | `ssh:exec` |
| `telepy recordings play <id>` | Play one in this terminal; `--speed` (default 1), `--idle-limit` (default 2 s) | `ssh:exec` |
| `telepy snippets ls` | Your snippets, the site's, and a tunnel's with `--tunnel` | `ssh:exec` |
| `telepy run <snippet> <target>` | Run a toolbox snippet; `--var name=value`, `-y`, `--timeout` | `ssh:exec` |
| `telepy lan ls <tunnel>` | The LAN hosts Telepy knows behind a device | `tunnels:read` |
| `telepy lan add <tunnel> <address>` | Add a host by hand; `--label`, `--user`, `--port` | `tunnels:manage` |
| `telepy lan rm <tunnel> <host>` | Remove a host by id, address or label | `tunnels:manage` |
| `telepy browse <target> [url]` | Open a scripted browser and print its id (same as `browse open`) | `browser:use` |
| `telepy browse ls` / `go` / `text` / `shot` / `click` / `type` / `close` | List the browsers this sign-in has open, or act on one by its id | `browser:use` |
| `telepy api tokens` | Your tokens with their call summary | — |
| `telepy api activity` | Calls made with your tokens and CLI sign-ins (see [The call log](#the-call-log)) | — |
| `telepy doctor` | Check the server, the sign-in, scopes, expiry, the local ssh tools and the version | — |
| `telepy update` | Update telepy; `--check`, `--to <version>` | — |

</details>

### Exit codes

- `exec` and `run` on a single target exit with the remote command's code. It is 124 when the command timed out and was killed, and 255 when Telepy refused it or couldn't run it.
- With several targets, `exec` exits 1 when any of them failed.
- `ssh`, `scp` and `sftp` exit with OpenSSH's code.
- Any other error from Telepy exits 1 and prints the server's message.

## Tokens and scopes

### Four ways in, four keys

![Four ways in: revoking one lane leaves the others working](images/en/ways-in.gif)

```
 this browser ───────────────── web sign-in session ─────────────────────┐
                                                                         │
 scripts / CI ───────────────── API token (scopes · tunnels · expiry) ───┤
                                                                         │
 telepy on your computer ────── CLI sign-in (OAuth, one per computer) ───├──▶ Telepy ──── SSH through the tunnel ───▶ your devices
                                                                         │
 an MCP app ─────────────────── OAuth grant (you approved this app) ─────┘

 Revoke the API token:
 scripts / CI ─────────────✂── (refused at once; its open exec sessions close)
 this browser, CLI sign-ins, MCP apps ── keep working
```

The live version of this picture is behind the **Four ways in** button on the API page. Its **What if I…** switch shows that revoking a token, signing a CLI out, disconnecting an app or signing out of the web each cuts only its own lane. Each token has its own version under **Your tokens → How it works**.

### What a token can and can't do

- **A token is you.** Your tunnels, the accounts you may use on them, the feature switches an admin set for you and command rules all apply. It never gets more than you have.
- **It can't manage your account.** It can't sign in to the web, change your password or two-step settings, or create more tokens. Only the REST routes on an allow-list are open to it, each needing one scope. The **What a token can call** tab is built from that same list (`GET /api/auth/tokens/routes`), so it can't disagree with the server.
- **Step-up tunnels refuse it.** Tunnels that ask you to confirm it's you refuse tokens, exactly like MCP agents.
- **It expires.** Every token expires, at most a year after it was created. Revoking takes effect at once.
- **Admins can switch it off.** Admins can turn the **API tokens** feature off for everyone, a user group or one person (**Admin → Users & access → Feature permissions**), and that person's tokens stop working. Other features turned off for you (web terminal, file manager, …) are refused to your tokens too, with 403 `feature_disabled`.
- **A disabled account suspends it.** If an admin disables your account, your tokens and CLI sign-ins are suspended, not revoked. They are refused while the account is off and work again once it is enabled.

### Scopes

| Scope | Lets the token | CLI commands |
| --- | --- | --- |
| `tunnels:read` | list tunnels, status, uptime, accounts, the generated ssh config, live sessions | `ls`, `status`, `ssh`, `scp`, `sftp`, `config install`, `sessions`, `lan ls` |
| `ssh:exec` | open exec sessions and run commands (command rules apply), read recordings and snippets | `exec`, `run`, `recordings`, `snippets` |
| `ssh:files` | every SFTP operation | `cp` |
| `network:scan` | LAN scans (MCP `lan_scan`, the scan REST route) | — |
| `browser:use` | scripted browsers through a device: the MCP browser tools and `/api/browser/sessions*` | `browse` |
| `tunnels:manage` | create / change / delete / share tunnels, labels, LAN hosts, end sessions (tokens only) | `sessions end`, `lan add` / `rm` |

`tunnels:read` covers the LAN hosts behind a device too (`telepy lan ls`, `GET /api/reverse/lan/topology`).

`ssh`, `scp` and `sftp` only need `tunnels:read`. Telepy hands over the ssh config, and from there your system's OpenSSH logs in with your personal SSH key through the gateway.

## Scripts, CI and other clients

### In CI

Create a token on the API page (**Your tokens → New token**) with the scopes the job needs. Then set two variables instead of signing in:

```sh
export TELEPY_URL=https://telepy.example.com
export TELEPY_TOKEN=tpt_…
telepy exec --label env=prod -- uptime
```

`--server` and `--token` do the same per command. Nothing is stored on the runner, and with `CI` set the CLI doesn't look for updates.

### With curl

```sh
curl -H "Authorization: Bearer $TELEPY_TOKEN" https://telepy.example.com/api/reverse/server/dashboard
```

The **What a token can call** tab gives a `curl` for every endpoint, with the base URL filled in and the secret as `$TELEPY_TOKEN`. Export it once: the page never shows a real secret again. Path variables are shell variables too (`$TUNNEL_ID`, `$ID`, `$HOST_ID`).

### In an MCP client

```json
{ "mcpServers": { "telepy": { "url": "https://telepy.example.com/mcp", "headers": { "Authorization": "Bearer tpt_…" } } } }
```

On `/mcp` a token works like an OAuth app's token, with the same tools, scopes and tunnel limit. That holds as long as both the **API tokens** and the **MCP apps** features are on for you. See [mcp.md](mcp.md) for the tools.

## The call log

Every REST request made with a personal API token or with the CLI's browser sign-in is logged, reads included. So is every MCP tool call made with a personal token; the tool calls of MCP apps are already in the AI activity log.

Refused requests are logged as well: `token_route`, `token_scope`, and `404` for tunnels outside the token's list.

Each row holds the time, the person, the token or app, the method and **route template** (never the query string), the tunnel, status, duration and IP. MCP rows read `MCP <tool>`, with status 200, or 400 plus the start of the error when the tool returned one.

### In the web

- **API → Activity** shows your own calls, day by day. Filter by token or CLI sign-in (the **Calls** button on either jumps here), by status (OK / 4xx / 5xx), by method, or search.
- **Your tokens** shows each token's calls in the last 24 h and 7 days, its errors and its total. The total (`call_count`) keeps counting after old log rows are gone.
- Admins see everyone's calls in the admin section under **Site activity → API activity**, with a filter by person. The Manage-user dialog links there.

Scripts can read the same list: `GET /api/auth/tokens/calls?scope=mine|all&token_id=&grant_id=&user_id=&username=&status=&method=&limit=&before=`.

### In the terminal

```sh
telepy api tokens                          # your tokens: scopes, expiry, last use, calls 24 h / 7 d, errors
telepy api activity                        # the last 50 calls made with your tokens and CLI sign-ins
telepy api activity --api-token ci --status 4xx --since 2h
telepy api activity --method DELETE --limit 200 --json
telepy api activity --follow               # like tail -f: new calls every 2 s, Ctrl+C stops
telepy api activity --all --user bob       # admins: everyone's, or one person's
```

`telepy api activity` prints the list newest first: the time in your local zone, token or app, method, route, tunnel, status, duration and IP. Its filters:

- `--api-token <name|id|prefix>`: one token's calls. The global `--token` is already the sign-in override, hence the different name.
- `--status ok|4xx|5xx|error` and `--method GET…|MCP`.
- `--since 30m|2h|7d|<RFC 3339>`.
- `--limit N`: 50 by default, at most 1000. Older pages are fetched with `before`.
- `--all` / `--user <name|id>`: the admin view. Anyone else gets "Only admins can see other people's API activity".
- `--follow`: prints the recent calls oldest first, then each new one as it arrives (every 2 s; with `--json`, one object per line). Its own polling is left out, so it doesn't spend the afternoon watching itself.

`telepy api tokens` lists your tokens with the same per-token summary. Tokens and the CLI's browser sign-in may read these two endpoints (`GET /api/auth/tokens`, `GET /api/auth/tokens/calls`) without any extra scope. Creating and revoking tokens stays in the web.

### What else is recorded, and for how long

- Writes made with a token (sharing, labels, LAN hosts, ending sessions…) also leave a `token_call` entry in the tunnel's **Logs**.
- Log rows are written in batches in the background. If the queue is full, calls are dropped and counted; requests never wait.
- Rows are kept for 90 days, 200,000 rows at most, and go with a deleted user.
- The call log is not hash-chained: it is high-volume, and deleting one person's rows would break a chain. The `token_call` events in **Logs** are chained.

## Environment variables

| Variable | What it does |
| --- | --- |
| `TELEPY_URL` | The Telepy server, like `--server` |
| `TELEPY_TOKEN` | A personal API token, like `--token`; for CI |
| `TELEPY_CONFIG_DIR` | The config directory (default `$XDG_CONFIG_HOME/telepy` or `~/.config/telepy`; Windows `%APPDATA%\telepy`) |
| `TELEPY_NO_KEYRING=1` | Keep the sign-in in `credentials.json` instead of the system keyring |
| `TELEPY_SSH_DIR` | Where `ssh` / `scp` / `sftp` write their config and known_hosts (default `~/.ssh/telepy`) |
| `TELEPY_SSH_VIA=ssh` | Go straight to Telepy's SSH port, like `--via ssh` |
| `TELEPY_SSH_FALLBACK` | `ask`, `always` or `never` for this run, like `--fallback` |
| `TELEPY_NO_UPDATE_CHECK=1` | No daily look for a newer release |
| `TELEPY_RELEASES_URL` | A mirror of the releases page, for the update check and `telepy update` |
| `TELEPY_RELEASE_KEYS` | Release public keys to trust instead of the built-in ones (for a re-signing mirror) |
| `TELEPY_NO_MASCOT=1` | No Tapi next to `login` and `doctor` |
| `NO_COLOR` | Tapi without colour |
| `CI` | When set, no update check |
| `TELEPY_VERSION` | At build time: the version to stamp into the binary |

## Troubleshooting

Start with `telepy doctor`:

```sh
telepy doctor                              # server, sign-in, scopes, expiry, ssh / scp / sftp
```

It checks the server, your sign-in, its scopes and expiry, the local `ssh` / `scp` / `sftp`, the port settings, and whether a newer telepy is out.

- **macOS won't open the binary.** That happens after a browser download. Run `xattr -d com.apple.quarantine telepy` once.
- **`ssh`, `scp` or `sftp` can't start.** They need the system's OpenSSH client on your PATH.
- **The device turns your SSH key away.** `ssh`, `scp` and `sftp` log in with your personal SSH key. The tunnel's **SSH config** dialog in the web shows whether your key gets in ("Make sure your key gets you in") and can add it.
- **The web port can't be reached.** In a terminal, telepy asks before it uses the SSH port. Without a terminal it doesn't fall back: allow it with `--fallback always`, `TELEPY_SSH_FALLBACK=always` or `telepy config fallback always`, or go straight to the SSH port with `--via ssh`.
- **403 `token_scope`.** The token lacks the scope this command needs (see [Scopes](#scopes)). Create a token that has it, or sign in again with `--scope`.
- **403 `token_route`.** That endpoint isn't open to tokens at all: your account, two-step settings and the tokens themselves are managed in the web only.
- **404 for a tunnel you can see in the web.** The token is limited to other tunnels.
- **403 `feature_disabled`.** An admin turned that feature off for you, and your tokens get the same answer as the web.
- **A tunnel refuses your token or `browse`.** It asks for step-up. Tokens and scripted browsers can't confirm it's you, so use the web for that tunnel.
- **Everything is refused after your account was disabled.** Tokens and CLI sign-ins are suspended, not revoked. They work again once an admin enables the account.
- **`exec` stops at a command rule.** A rule holds the command for approval. Add `--wait-approval` to keep waiting (up to 10 minutes).
- **`telepy update` can't replace the binary.** It needs write access to telepy's folder (`sudo telepy update` for `/usr/local/bin`). Installed with `cargo install` or Homebrew? Update with those.
- **"Only admins can see other people's API activity."** Leave out `--all` / `--user` to see your own.

## For maintainers: release builds

<details>
<summary>How a GitHub release builds, signs and attaches the CLI</summary>

Publishing a GitHub release (`gh release create v2.7.0 …`) runs `.github/workflows/release-cli.yml`:

1. The five targets are built from that tag, with `TELEPY_VERSION` set to the tag without its `v`.
2. Each build is smoke-tested: `telepy --version` must print that version.
3. The files are attested and attached to the release with their `.sha256` files.
4. A `SHA256SUMS` is added, signed with the `RELEASE_SIGNING_KEY` secret (an OpenSSH ed25519 private key). Without that secret the release job fails.

You can also run the workflow by hand from the Actions tab. With a tag, it (re)attaches the files to that existing release. Without one, it is a trial build whose files stay as the run's artifacts.

A tag from before version stamping, such as `v2.8.0`, can be given builds the same way; its CLI reports Cargo.toml's `0.1.0`. Every Telepy release from `v2.8.0` on carries the CLI built from it, and there are no separate CLI tags.

</details>
