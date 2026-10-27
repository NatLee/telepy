# The `telepy` command line and personal API tokens

`telepy` is Telepy from your terminal: list tunnels, `ssh` / `scp` / `sftp` straight into a device, run a command
on one device or on every device with a label, copy files, see and end live sessions, play terminal recordings and
run toolbox snippets. Scripts and CI use the same commands with a **personal API token** instead of a browser sign-in.

Source: `src/cli/` (a crate of its own; the server build does not depend on it). Backend: `auth/api_tokens.rs`,
`api/api_tokens.rs`, `db/api_tokens.rs`, the REST exec routes in `api/ai.rs`.

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

The same picture, live, is behind **Preferences → API tokens → How it works** (click a token to see its own scopes
and tunnels on the token lane).

- A token **is you**: your tunnels, the accounts you may use on them, the feature switches an admin set for you and
  command rules all apply. It never gets more than you have.
- It can't sign in to the web, change your password or two-step settings, or create more tokens: only the REST routes
  listed in `auth::api_tokens::rest_route` are open to it, each needing one scope.
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
| `browser:use` | the MCP browser tools | — |
| `tunnels:manage` | create / change / delete / share tunnels, labels, end sessions (tokens only) | `sessions end` |

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
telepy login https://telepy.example.com --token tpt_…   # a personal API token (Preferences → API tokens)
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

telepy doctor                              # server, sign-in, scopes, expiry, ssh / scp / sftp
```

`ssh` / `scp` / `sftp` write `~/.ssh/telepy/<alias>.conf` (the generated config with the ProxyCommand pointing back at
that file) and `~/.ssh/telepy/known_hosts-<server>` (Telepy's gateway host key, pinned), then run the system OpenSSH
with `-F`. Your own `~/.ssh/config` is untouched unless you run `telepy config install`.

`exec` opens a short-lived session per tunnel through the backend (`POST /api/ai/sessions`, then
`POST /api/ai/sessions/{id}/exec`, then closes it): the same reaper, command rules and audit as MCP agents. The
calls appear on the **AI activity** page under the token's name, and REST writes made with a token leave a
`token_call` entry in the tunnel's Logs.

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
