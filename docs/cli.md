# The `telepy` command line and personal API tokens

`telepy` is Telepy from your terminal: list tunnels, `ssh` / `scp` / `sftp` straight into a device, run a command
on one device or on every device with a label, copy files, see and end live sessions, play terminal recordings and
run toolbox snippets. Scripts and CI use the same commands with a **personal API token** instead of a browser sign-in.

Source: `src/cli/` (a crate of its own; the server build does not depend on it). Backend: `auth/api_tokens.rs`,
`api/api_tokens.rs`, `db/api_tokens.rs`, `db/api_calls.rs` + `api_calls.rs` (the call log), the REST exec routes in
`api/ai.rs`, the scripted-browser routes in `api/browser.rs`.

Tokens are managed on the **API** page (`/tunnels/api`, sidebar "API"): your tokens, every endpoint a token can call
(with copy-ready `curl` and the matching `telepy` command), and the **Activity** log of what your tokens did.

## Three ways in, three keys

```
 your laptop / script / CI ──── API token (scopes · tunnels · expiry) ────┐
                                                                         │
 this browser ───────────────── web sign-in session ─────────────────────┼──▶ Telepy ──── SSH through the tunnel ───▶ your devices
                                                                         │
 an MCP app ─────────────────── OAuth grant (you approved this app) ─────┘

 Revoke the API token:
 your laptop / script / CI ──✂── (refused at once; its open exec sessions close)
 this browser ───────────────── keeps working
 an MCP app ─────────────────── keeps working
```

The same picture, live, is at the top of the **API** page ("Three ways into Telepy", with a "What if I…" switch:
revoking a token, disconnecting an app or signing out each cuts only its own lane), and per token behind **Your
tokens → How it works**.

- A token **is you**: your tunnels, the accounts you may use on them, the feature switches an admin set for you and
  command rules all apply. It never gets more than you have.
- It can't sign in to the web, change your password or two-step settings, or create more tokens: only the REST routes
  in the allow-list `auth::api_tokens::ROUTES` are open to it, each needing one scope. The API page's **What a token
  can call** tab is built from that same table (`GET /api/auth/tokens/routes`), so it can't disagree with the server.
- Tunnels that ask you to confirm it's you (**step-up**) refuse tokens, exactly like MCP agents.
- Every token expires (at most a year). Revoking takes effect at once.
- Admins can turn the **API tokens** feature off (Site settings → Access): existing tokens then stop working.

## Scopes

| Scope | Lets the token | CLI commands |
| --- | --- | --- |
| `tunnels:read` | list tunnels, status, uptime, accounts, the generated ssh config | `ls`, `status`, `ssh`, `scp`, `sftp`, `config install` |
| `ssh:exec` | open exec sessions and run commands (command rules apply), read recordings and snippets | `exec`, `run`, `recordings`, `snippets` |
| `ssh:files` | every SFTP operation | `cp` |
| `network:scan` | LAN scans (MCP `lan_scan`, the scan REST route) | — |
| `browser:use` | scripted browsers through a device: the MCP browser tools and `/api/browser/sessions*` | `browse` |
| `tunnels:manage` | create / change / delete / share tunnels, labels, LAN hosts, end sessions (tokens only) | `sessions end`, `lan add` / `rm` |

`tunnels:read` also lists the LAN hosts behind a device (`telepy lan ls`, `GET /api/reverse/lan/topology`).

`ssh` / `scp` / `sftp` only need `tunnels:read`: they fetch the ssh config and then your system OpenSSH logs in
with **your personal SSH key** through the gateway, as the web's SSH config dialog does.

## Install

Release builds are attached to the `cli-v*` releases on GitHub (macOS arm64 / x86_64, Linux x86_64 / arm64 (static,
musl), Windows x86_64), each with a `.sha256`:

```sh
# macOS / Linux: pick your target from the release page
VER=cli-v0.1.0
TARGET=aarch64-apple-darwin   # x86_64-apple-darwin, x86_64-unknown-linux-musl, aarch64-unknown-linux-musl
curl -fsSL "https://github.com/NatLee/telepy/releases/download/$VER/telepy-${VER#cli-}-$TARGET.tar.gz" | tar xz
sudo install -m 755 telepy /usr/local/bin/telepy
```

```powershell
# Windows
$ver = "cli-v0.1.0"
Invoke-WebRequest "https://github.com/NatLee/telepy/releases/download/$ver/telepy-$($ver -replace 'cli-','')-x86_64-pc-windows-msvc.zip" -OutFile telepy.zip
Expand-Archive telepy.zip -DestinationPath "$env:LOCALAPPDATA\telepy"   # then add that folder to PATH
```

Or build it yourself: `cargo install --git https://github.com/NatLee/telepy telepy-cli`.

Maintainers: push a `cli-v<version>` tag; `.github/workflows/release-cli.yml` builds the five targets and creates the
release (it runs on those tags only).

## Sign in

```sh
telepy login https://telepy.example.com                 # browser: OAuth + PKCE, loopback callback
telepy login https://telepy.example.com --scope "tunnels:read ssh:exec ssh:files network:scan"
telepy login https://telepy.example.com --token tpt_…   # a personal API token (the API page → Your tokens)
telepy whoami
telepy logout
```

The browser sign-in registers the CLI as an MCP-style OAuth app (it shows up under **Connected apps**, where you can
revoke it) and stores the access + refresh tokens. Credentials live in the macOS Keychain or the Windows Credential
Manager; on Linux (and with `TELEPY_NO_KEYRING=1`) in `~/.config/telepy/credentials.json` with mode 0600.

In CI there is nothing to store: set `TELEPY_URL` and `TELEPY_TOKEN` (or pass `--server` / `--token`).

## Commands

```sh
telepy ls                                  # NAME  HEALTH  LATENCY  ACCOUNTS  LABELS  GROUP  SEEN
telepy ls --label env=prod --online --json
telepy ls --group "Lab"
telepy status box                          # health, uptime, device facts and warnings

telepy ssh box                             # the tunnel's default account
telepy ssh box@pi -- uname -a              # <tunnel>@<account> (pi@box works too)
telepy ssh box -L 8080:localhost:80        # forward a port; -D 1080 for SOCKS
telepy ssh box -i ~/.ssh/id_work           # a specific key for both hops
telepy scp ./build.tar.gz box@pi:/tmp/
telepy sftp box@pi
telepy config install box nas              # the web dialog's install command, done for you (~/.ssh/config, marked blocks, backup)

telepy exec box -- systemctl is-active nginx
telepy exec --label env=prod -- uptime     # every tunnel with the label, in parallel, "name | " prefixes
telepy exec box nas --json -- df -h /
telepy exec box --wait-approval -- sudo reboot   # keep waiting while a command rule holds it for approval

telepy cp box@pi:/var/log/syslog ./syslog
telepy cp ./config.yml box@pi:/etc/app/

telepy sessions                            # live sessions on your tunnels
telepy sessions end 42
telepy recordings ls --tunnel box
telepy recordings play 17 --speed 2        # with its timing, pauses capped at 2 s
telepy snippets ls --tunnel box
telepy run "restart service" box --var svc=nginx

telepy lan ls box                          # the LAN hosts Telepy knows behind a device
telepy lan add box 192.168.1.20 --label nas --user pi --port 22
telepy lan rm box nas                      # by id, address or label

ID=$(telepy browse box http://192.168.1.1/)   # a browser on the device's network (browser:use); prints its id
telepy browse text "$ID" --selector main
telepy browse shot "$ID" -o router.png
telepy browse click "$ID" --text "Status"
telepy browse type "$ID" "#q" "uptime" --enter
telepy browse go "$ID" http://192.168.1.1/logs
telepy browse ls
telepy browse close "$ID"

telepy api tokens                          # your tokens: scopes, expiry, last use, calls 24 h / 7 d, errors
telepy api activity                        # the last 50 calls made with your tokens and connected apps
telepy api activity --api-token ci --status 4xx --since 2h
telepy api activity --method DELETE --limit 200 --json
telepy api activity --follow               # like tail -f: new calls every 2 s, Ctrl+C stops
telepy api activity --all --user bob       # admins: everyone's, or one person's

telepy doctor                              # server, sign-in, scopes, expiry, ssh / scp / sftp
```

`ssh` / `scp` / `sftp` write `~/.ssh/telepy/<alias>.conf` (the generated config with the ProxyCommand pointing back at
that file) and `~/.ssh/telepy/known_hosts-<server>` (Telepy's gateway host key, pinned), then run the system OpenSSH
with `-F`. Your own `~/.ssh/config` is untouched unless you run `telepy config install`.

`exec` opens a short-lived session per tunnel through the backend (`POST /api/ai/sessions`, then
`POST /api/ai/sessions/{id}/exec`, then closes it): the same reaper, command rules and audit as MCP agents. The
calls appear on the **AI activity** page under the token's name, and REST writes made with a token leave a
`token_call` entry in the tunnel's Logs.

`browse` drives a **scripted browser**: a real Chromium that browses as if it sat on the device, so it sees the
device's LAN, its localhost and its public IP — a router's admin page, an intranet dashboard, a site that only allows
that IP or region. One action at a time, each bounded to 30 s; each browser is a full Chromium counted against your
per-person session limit (`ai_max_sessions_per_user`), so it suits scripted checks, screenshots and small scraping
jobs, not a high-volume crawler. Browsers close themselves when idle; every action is in the AI activity log (typed
text by its length unless `--show`), and step-up tunnels refuse them.

Exit codes: a single target exits with the remote command's code; several targets exit 1 when any failed; errors
from Telepy exit 1 with the server's message.

## Using a token with curl or an MCP client

```sh
curl -H "Authorization: Bearer $TELEPY_TOKEN" https://telepy.example.com/api/reverse/server/dashboard
```

```json
{ "mcpServers": { "telepy": { "url": "https://telepy.example.com/mcp", "headers": { "Authorization": "Bearer tpt_…" } } } }
```

On `/mcp` a token works like an OAuth app token (same tools, scopes and tunnel limit) as long as the **MCP apps**
feature is on for you.

The **What a token can call** tab gives a `curl` for every endpoint with the base URL filled in and the secret as
`$TELEPY_TOKEN` (export it once; the page never shows a real secret again). Path variables are shell variables too
(`$TUNNEL_ID`, `$ID`, `$HOST_ID`).

## The call log

Every REST request made with a personal API token or an OAuth app's token (the CLI's browser sign-in) is logged —
reads included — and so is every MCP tool call made with a personal token (connected apps' MCP calls are already in
the AI activity log). A row is: when, who, which token / app, method + **route template** (never the query string),
tunnel, status, duration, IP; MCP rows are `MCP <tool>` with 200 or 400 (the tool returned an error) and the start of
the error. Refused requests (`token_route`, `token_scope`, `404` outside the token's tunnels) are logged too.

- **API → Activity** shows your own calls, day by day, filtered by token (a token's **Calls** button jumps there),
  status (OK / 4xx / 5xx), method and search. Admins see everyone's on **Admin → All API activity** (filter by person;
  the Manage-user dialog links there). `GET /api/auth/tokens/calls?scope=mine|all&token_id=&user_id=&username=&status=&method=&limit=&before=`.
- **`telepy api activity`** prints the same list in the terminal (newest first: time in your local zone, token or app,
  method, route, tunnel, status, duration, IP). Filters: `--api-token <name|id|prefix>` (the global `--token` is the
  sign-in override, so the filter has its own name), `--status ok|4xx|5xx|error`, `--method GET…|MCP`,
  `--since 30m|2h|7d|<RFC 3339>`, `--limit N` (default 50, at most 1000; older pages are fetched with `before`).
  `--all` / `--user <name|id>` is the admin view (anyone else gets "Only admins can see other people's API
  activity"). `--follow` prints the recent calls oldest first, then each new one as it arrives (every 2 s; with
  `--json` one object per line); its own polling of the log is left out. `telepy api tokens` is the token list with
  the same per-token summary. Tokens and the CLI's browser sign-in may read these two endpoints (`GET /api/auth/tokens`,
  `GET /api/auth/tokens/calls`) without any extra scope; creating and revoking tokens stays in the web app.
- **Your tokens** shows calls in the last 24 h / 7 days, errors and the total for each token (`call_count` keeps
  counting after the log rows age out).
- Writes are batched in the background (a full queue drops calls and counts them; requests never wait). Rows are kept
  90 days and 200,000 rows at most, and go with a deleted user. The log is not hash-chained (it is high-volume and
  per-user deletion would break a chain); writes made with a token still leave a chained `token_call` gateway event
  in the tunnel's Logs.
