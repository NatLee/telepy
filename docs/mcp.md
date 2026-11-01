# AI tools (MCP)

<p align="center"><b>English</b> | <a href="./mcp.zh-TW.md">繁體中文</a> | <a href="./mcp.ja.md">日本語</a></p>

Telepy is an MCP server. Connect an AI tool that speaks MCP (Claude Code, Claude Desktop / claude.ai, Cursor and others), and it can work on your devices with your own permissions, never more.

An agent can:

- check which tunnels are up and how the devices are doing,
- open an SSH session that closes by itself, and run commands in it,
- drive a TUI through an interactive shell,
- read and write files,
- scan the LAN behind a device,
- open a browser that goes online through a device.

You decide on an approval page which of these an app gets, and which tunnels it may touch.

## Connect a client

The MCP endpoint is `https://<your host>/mcp` (Streamable HTTP).

In production, set `PUBLIC_URL` in `.env` (for example `https://telepy.example.com`). The OAuth issuer and the MCP resource both come from it.

Without it, Telepy works them out from each request's `X-Forwarded-Proto` / `X-Forwarded-Host` / `Host` headers.

| Client | Setup |
| --- | --- |
| Claude Code | `claude mcp add --transport http telepy https://telepy.example.com/mcp`, then run `/mcp` in the conversation to finish authorization |
| Claude Desktop / claude.ai | Settings → Connectors → Add custom connector, and enter `https://telepy.example.com/mcp` as the URL |
| Cursor and others | `mcp.json`: `{"mcpServers": {"telepy": {"url": "https://telepy.example.com/mcp"}}}` |

There is no token to paste. The client's first call gets a 401, the client takes the hint, and it runs the sign-in described in [Approve the app](#approve-the-app) by itself.

Not sure which URL to enter? Open **AI → MCP** in the sidebar. It shows the exact endpoint (it follows `PUBLIC_URL`), copy-ready settings for the three clients above, what each permission unlocks, when sessions close, and your connected MCP apps.

### No browser? Use an API token

Agents and CI jobs that can't open a browser can send a personal API token (`tpt_…`) as a Bearer token instead. Create one on the **API** page in the sidebar:

```json
{"mcpServers": {"telepy": {"url": "https://telepy.example.com/mcp", "headers": {"Authorization": "Bearer tpt_…"}}}}
```

- On `/mcp` a token gets the same tools, scopes and tunnel limits as an OAuth app.
- The person needs both the **API tokens** and the **MCP apps** features turned on.
- Its sessions, shells and browsers belong to that token alone. In the audit, the app is called `API token "<name>"`.
- Each tool call also shows up under **Activity** on the API page, as `MCP <tool>` with status 200, or 400 when the tool returned an error.
- Revoking the token closes its open sessions at once.

## Approve the app

The first time a client connects, your browser opens Telepy's approval page.

If you aren't signed in, you get a sign-in page first. It deliberately looks different from the normal one, and it already shows which app is asking, where it will send you back to and what it wants. You can cancel right there, before signing in.

On the approval page you:

- check the app's name and the address it returns to,
- check which account you're signed in as (**Not you?** → **Switch account**),
- tick the permissions (scopes) the app gets, and untick any you don't want,
- allow all your tunnels, or only some,
- optionally **Replace the earlier connection** of the same app. The old one is revoked as soon as the client has picked up its new token.

The client then gets an access token (valid for 1 hour) and a refresh token (30 days, replaced on every exchange), and calls `/mcp` with it.

<details>
<summary>The OAuth 2.1 flow, step by step</summary>

```
MCP client ── POST /mcp ──────────────────────────────▶ 401 + WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"
           ── GET /.well-known/oauth-protected-resource/mcp   (RFC 9728: authorization_servers)
           ── GET /.well-known/oauth-authorization-server     (RFC 8414: endpoints, S256)
           ── POST /api/oauth/register                        (RFC 7591 dynamic registration, public)
           ── open the browser → /oauth/authorize (the frontend consent page; if not signed in, /oauth/login first, which looks different from the normal sign-in page,
                 and before sign-in it shows the app, the return address and the permissions through the public GET /api/oauth/authorize/preview, with a way to cancel)
                 the user approves with their web sign-in: check the app name and return address, the current account (not you? switch account), tick the permissions, limit which tunnels it may use;
                 an earlier connection of the same app can be ticked "replace", and it is revoked once the client has exchanged for the new token
                 the frontend POSTs /api/oauth/authorize → {redirect_to: <redirect_uri>?code=…&state=…&iss=…}
           ── POST /api/oauth/token  (authorization_code + PKCE S256) → access token (1 hour) + refresh token (30 days, rotated on every exchange)
           ── POST /mcp  Authorization: Bearer <access token>
```

- The access token is a JWT with `token_type: "mcp_access"`. A web sign-in token can't call `/mcp`.
- The REST API accepts an MCP access token only on the routes a token may call (see [cli.md](cli.md)). That is how the `telepy` command line's browser sign-in uses it.

</details>

### Scopes

| Scope | On the approval page | Unlocks |
| --- | --- | --- |
| `tunnels:read` | See your tunnels | `list_tunnels`, `tunnel_status`, `lan_hosts` |
| `ssh:exec` | Run commands on your devices | `ssh_session_open`, `ssh_exec`, `shell_open` / `shell_send` / `shell_read` / `shell_resize` / `shell_close` |
| `ssh:files` | Read and write files on your devices | `ssh_session_open`, `sftp_list` / `sftp_read` / `sftp_write` |
| `network:scan` | Discover machines on your devices' networks | `lan_scan` (only on tunnels you own or are ADMIN on) |
| `browser:use` | Browse the web as your devices | `browser_open` / `browser_navigate` / `browser_read` / `browser_screenshot` / `browser_click` / `browser_type` / `browser_close` |

`ssh:exec`, `ssh:files` and `browser:use` carry a **Can make changes** tag on the approval page. The other two are marked **Read only**.

### `telepy login` is not an MCP app

The `telepy` command line's browser sign-in goes through the same OAuth, and the approval page says it's the CLI asking. Telepy still keeps it apart from your MCP apps:

- Each sign-in registers as `telepy CLI (<computer name>)`. The client reports that name itself, and Telepy only uses it to sort the lists.
- These sign-ins are listed on the API page under **CLI sign-ins**. The MCP page, Preferences and the AI activity page leave them out of their MCP app lists.
- Signing in again from the same computer offers to replace the earlier sign-in.
- Each person keeps at most 10 CLI sign-ins. The 11th signs out the one used least recently.
- CLI sign-ins also follow the **MCP apps** feature switch. More in [cli.md](cli.md).

## What an agent can do

![What an MCP app can reach, by scope](images/en/agent-reach.png)

The tools below are grouped by the scope that unlocks them. On the MCP page, the **What can an app reach?** button draws this picture for one of your connected apps: app ─ Telepy ─ device ─ LAN / internet, with the branches its scopes allow lit up.

### See tunnels (`tunnels:read`)

| Tool | What it does |
| --- | --- |
| `list_tunnels` | The tunnels you can see: id, name, online or not, latency, your permission, the target usernames you may use, and the sessions this app has open |
| `tunnel_status(tunnel_id)` | Health, latency, 24-hour uptime, the device's `facts` and `warnings`, and the last 10 gateway events |
| `lan_hosts(tunnel_id)` | The LAN hosts behind a device (found by a scan or added by hand): address, name, open ports, SSH banner, labels, login account |

- Health is online, degraded (the tunnel is up but the device's sshd doesn't answer) or offline.
- `facts` covers the OS, kernel, uptime in seconds, CPU, memory and root disk in KB, load, ssh version, and whether a reboot is needed. Only people who can log in to the device get it.

### Run commands (`ssh:exec`)

Everything starts with a session. `ssh_session_open` returns a `session_id`, and the other tools take it.

| Tool | What it does |
| --- | --- |
| `ssh_session_open(tunnel_id, username?, idle_timeout_s?, max_lifetime_s?)` | Opens a session and returns `session_id`. Without `username` it uses the tunnel's default (or the only one there is) |
| `ssh_exec(session_id, command, timeout_s?, max_output_bytes?)` | Runs a command without a TTY. Returns `exit_code`, `stdout`, `stderr`, `timed_out`, `truncated` |
| `ssh_session_list` | This app's open sessions and the time left on each |
| `ssh_session_close(session_id)` | Closes a session |
| `shell_open(session_id, cols?, rows?)` | Opens an interactive shell (PTY, `xterm-256color`, 120×40 by default) and returns `shell_id`. At most 2 per session |
| `shell_send(shell_id, input, press_enter?)` | Types `input` as is, control characters included (`\u0003` = Ctrl+C, `\u001b` = Esc). `press_enter` adds an Enter. Up to 64 KiB per call |
| `shell_read(shell_id, timeout_ms?, max_bytes?, screen?)` | Returns the new raw `output`, the current `screen`, `cursor`, `size`, `more`, `exited`. Waits up to `timeout_ms` for new output (default 1.5 seconds, at most 10) |
| `shell_resize(shell_id, cols, rows)` / `shell_close(shell_id)` | Resizes / closes the shell |

How shells behave is in [Interactive shells](#interactive-shells).

### Read and write files (`ssh:files`)

These also work inside a session, opened with `ssh_session_open`.

| Tool | What it does |
| --- | --- |
| `sftp_list(session_id, path?)` | Lists a directory (`~` = the home directory) |
| `sftp_read(session_id, path, offset?, max_bytes?)` | Reads a file: text comes back as UTF-8, anything else as base64. Can be read in pieces |
| `sftp_write(session_id, path, content, encoding?, append?)` | Writes or appends to a file (`encoding`: `utf-8` / `base64`) |

### Scan the LAN (`network:scan`)

| Tool | What it does |
| --- | --- |
| `lan_scan(tunnel_id, username?, subnets?, ports?)` | Scans the LAN through the device's sshd and saves what it finds to the host list |

- Private ranges only, up to 1024 addresses. A scan takes about a minute.
- Only on tunnels you own or are ADMIN on.
- Read the results with `lan_hosts`.

### Use a browser (`browser:use`)

| Tool | What it does |
| --- | --- |
| `browser_open(tunnel_id, username?, url?, idle_timeout_s?, max_lifetime_s?)` | Opens a remote browser (Chromium) through a device and returns `browser_id`. Can open `url` straight away |
| `browser_navigate(browser_id, url)` | Goes to a URL (http / https only, `https://` is added if missing), waits for the page to load, and returns the final URL and title |
| `browser_read(browser_id, selector?)` | Page text: title, URL, visible text (up to 100,000 characters), links. `selector` reads only part of the page |
| `browser_screenshot(browser_id)` | A PNG screenshot (scaled down to 1280 px wide at most), returned as an MCP image content block |
| `browser_click(browser_id, selector? \| text?)` | Clicks by CSS selector or by visible text (link, button, label), with real mouse events |
| `browser_type(browser_id, selector, text, press_enter?, sensitive?)` | Types into a field, optionally pressing Enter to submit. `sensitive` defaults to true, so the audit records only the length |
| `browser_close(browser_id)` | Closes the browser |

The browser's traffic leaves from the device, so it sees the device's LAN, its localhost and its public IP. More in [The agent's browser](#the-agents-browser).

## Sessions and limits

A session is one SSH connection to the device, shared by all its commands, so there's no new handshake per command. Each command opens its own channel, and one session can have at most 4 at a time.

Agents don't always remember to hang up, so every session closes by itself.

### Limits

| Limit | Default | Notes |
| --- | --- | --- |
| Idle timeout (`ai_session_idle_timeout`) | 600 seconds | A running command doesn't count as idle |
| Maximum lifetime (`ai_session_max_lifetime`) | 7200 seconds | Always closed when it's reached |
| Sessions per user (`ai_max_sessions_per_user`) | 3 | All apps together, SSH sessions and agent browsers counted together. 0 = agents may not open sessions |
| Command timeout | 60 seconds | At most 600. On timeout Telepy sends `KILL` and closes the channel |
| Output per stream | 64 KiB | At most 1 MiB. Past the limit it keeps the first quarter and the last three quarters |

- An agent may ask for a shorter `idle_timeout_s` / `max_lifetime_s`, but never more than the site settings, and never under 10 seconds.
- Admins set the first three on **Site settings → AI access (MCP)** (the same page shows the MCP endpoint URL). Changes apply to newly opened sessions.
- A session belongs to a credential, not to an MCP connection: MCP version 2026-07-28 has no transport sessions. So each session is tied to one OAuth grant or one personal API token, and different apps and tokens can't see each other's sessions.

### When a session closes

| Closes when | Reason (`reason` in notifications and the audit) |
| --- | --- |
| the agent calls `ssh_session_close` | `closed_by_agent` |
| the user, the tunnel owner or an admin closes it on the web (AI activity or Live sessions, `DELETE /api/ai/sessions/{id}`), or an admin turns off the **MCP apps** feature for that person | `closed_by_user` |
| it has been idle longer than `ai_session_idle_timeout` | `idle` |
| it has been open longer than `ai_session_max_lifetime` | `max_lifetime` |
| the device goes offline, or the connection drops | `device_offline` / `disconnected` |
| the grant or personal API token is revoked or expires, or the account is disabled | `revoked` |
| the tunnel is deleted | `tunnel_deleted` |
| the permission or username is taken away (unshared, share expired, allow-list shrunk…) | `permission_removed` |

Telepy checks every 30 seconds. Revoking a grant or token closes its sessions at once, and changes such as unsharing or a new permission trigger an immediate re-check.

## Interactive shells

A shell lets an agent work the way you would in a terminal: answer prompts, drive a TUI, watch a screen change.

- A shell is one PTY channel on the session's existing connection. It shares the session's 4 channels with `ssh_exec`, and a session can have at most 2 shells.
- Telepy keeps reading the output in the background (for the screen model and the recording), so an agent that stops reading doesn't stall the device.
- `screen` in `shell_read` comes from a vt100 model of the terminal: plain text, one line per row.
- Output nobody has read is kept up to 256 KiB. Past that the oldest goes, and `dropped_bytes` says how much.
- A shell closes on `shell_close`, when its session closes for any reason, or when the session's `idle_timeout` passes with no send or read (checked every 30 seconds).
- Using a shell counts as using the session, so the session won't idle out underneath it.
- **Recording**: if the tunnel has **Record web terminal sessions** on, agent shells are recorded too, as asciicast (`kind: agent`, labelled "MCP agent" on the Recordings page).
- On **Live sessions**, an agent session's row shows how many shells are open (`shells` in `/api/sessions` and in `/api/ai/sessions`).

Every Enter at a shell prompt also goes through the command rules, see [Shells are checked too](#shells-are-checked-too).

## The agent's browser

The agent's browser is an ordinary remote-browser session: Chromium in the browser container, going online through the device, counted against `remote_browser_max_sessions`. The only difference is who drives it.

- The agent drives it through the session manager inside the browser container. The backend never connects to Chromium's DevTools itself. More in [remote-browser.md](remote-browser.md).
- It shares the per-person limit `ai_max_sessions_per_user` with SSH sessions, and the same idle and lifetime limits.
- It closes when the device goes offline, the grant is revoked, the permission or username is taken away, or the remote-browser session disappears.
- Tunnels that require step-up refuse it.
- It shows up in the tunnel's "who is using it" list and on **Live sessions** (kind `browser`, client = the app's name), and can be ended there. Later tool calls then answer "ended by <who>".
- Opening and closing write `browser_open` / `browser_close` events to the tunnel's Logs.
- Notifications reuse `AI-SESSION-OPENED` / `AI-SESSION-CLOSED` with an extra `kind: "browser"`. The data of the `mcp.session_*` webhooks carries `kind` too.
- The audit records URLs and selectors. Text typed with `browser_type` is recorded only as a length, unless the agent passes `sensitive: false`. Screenshots are never stored.

## Guard rails

### Same rules as the web

An agent gets exactly what you would get in the web app:

- You need VIEW permission on the tunnel.
- The target username must be on your allow-list. On a shared tunnel, that means only the usernames allowed when it was shared, the same as the web terminal.
- **Feature permissions** (Admin → Users & access → Feature permissions) apply too. If an admin turns a feature off for someone, the matching tools return an error (`isError`) that says so.

| Tools | Need the feature |
| --- | --- |
| `ssh:exec` tools | Web terminal |
| `ssh:files` tools | File manager |
| `lan_hosts`, `lan_scan` | LAN discovery |
| `browser:use` tools | Remote browser |

If the app simply wasn't given a scope, the error tells the agent to ask you to reconnect and approve it.

### Tunnels that require step-up

Some tunnels ask everyone to confirm with a second factor before every session. An agent can't do that, so on those tunnels it can't open SSH sessions or browsers, or run `lan_scan`.

`list_tunnels` shows `requires_step_up`, so the agent knows before it tries.

### Command rules (`ssh_exec`)

![How a command is decided: split, site-wide rules, personal rules, verdict](images/en/command-decision.png)

The rules on the **Command rules** page cover agents' commands too. A rule can also apply to MCP agents only (`via: agents`).

#### Two kinds of rule

- **Personal rules**: everyone writes their own. With **Everyone** or **Shared users only**, a rule applies only on tunnels where its author is *currently* the owner or an ADMIN.
  - **Only me** covers just the author's own commands, on any tunnel they use. Handy as a guard on your own agent while it works on someone else's tunnel. Nobody else can see an "Only me" rule.
- **Site-wide rules**: written by admins (Admin → Rules & alerts → Command rules). By default, a tunnel's owner or ADMIN may turn one off on the tunnels they manage. With **Let people override** off, the rule is enforced and nobody can turn it off.

#### What each action does

When a command matches several rules, Block beats Needs approval, which beats Remind.

- **Block**: the command doesn't run. The tool returns an error (`isError`) naming the rule and its note.
- **Needs approval**: Telepy files an approval request, and the tool call waits up to 45 seconds. Approved: the command runs and the result comes back. Denied, or the request expired with nobody approving it: an error.
- **Remind**: the command runs as usual, and the `ssh_exec` result carries an extra `reminder` (the rule's note, or its pattern if there's no note). The agent should pass it on to you. The REST `POST /api/ai/sessions/{id}/exec` does the same.
- **Allow (exception)**: matching commands skip the Block and Needs approval rules of the same author.

More about approvals:

- The approvers are the people the rule names. If it names nobody, it's the tunnel's owner and ADMINs, and for an "Only me" rule it's the author.
- Approvers see the request at the bottom right of the web app, and can also handle it on the Command rules page.
- If nobody has decided within the 45 seconds, the error says it's still waiting. The agent should tell you, then call **the exact same command** again once it's approved.
- An approval can be used once within 10 minutes (same app, tunnel, account and command).
- When an agent runs as the tunnel owner, the owner still has to click approve. Nobody grades their own homework, agents included.

More about reminders and exceptions:

- A reminder doesn't wait for anyone and doesn't appear under **History** on the Command rules page. Each person can mute a reminder for themselves, unless an admin has enforced it.
- A site-wide exception exempts site-wide rules; a personal one exempts only the same person's rules.
- A tunnel owner's or ADMIN's exception also exempts overridable site-wide rules on the tunnels they manage, but not enforced ones.
- Someone else's exception never overrides your rules.

Blocked, waiting and denied commands are all recorded in the AI audit as failed `ssh_exec` calls. The requests and their outcomes also appear under **History** on the Command rules page.

#### Shells are checked too

For every Enter an agent presses at a shell prompt with `shell_send`, Telepy reads that line off the screen the same way the web terminal does, and checks it.

- **Block**: Telepy sends Ctrl+C instead, and the tool returns an error.
- **Needs approval**: like `ssh_exec`, it waits up to 45 seconds and sends the Enter once approved. While it's still waiting, the line stays at the prompt. After approval the agent sends `input: ""` with `press_enter: true` to run it (again, once within 10 minutes).
- Input typed after an Enter that wasn't sent is discarded, and the tool says how many bytes.
- **Remind**: the line is sent as usual, and the `shell_send` result carries `reminders` (one sentence per rule).
- An Enter inside a full-screen program (vim, less) is not checked.

## Notifications and audit

When a session opens or closes, `/ws/notifications` sends `AI-SESSION-OPENED` / `AI-SESSION-CLOSED` to the session's user and the tunnel owner. It carries `details`, `tunnel_id`, `session_id`, `by`, `client`, plus `reason` on close.

So if someone you shared a tunnel with points an agent at it, you'll know.

Every tool call writes one audit row:

- who, which app, which tunnel and username,
- the command or path (up to 2000 characters),
- exit code, duration, output bytes, error, and source IP.

Up to 100,000 rows are kept, each for 90 days, and they're hash-chained against tampering.

> [!WARNING]
> The command text is recorded in full. The audit log has a perfect memory and no tact, so don't let an agent put passwords on a command line.

Where to read it:

- **AI activity**: your own calls, open sessions and MCP apps.
- **All AI activity**: everyone's, in the admin area.
- The API: `GET /api/ai/activity` and `GET /api/ai/sessions` default to `?scope=mine`, admins included. That means yours, plus those on tunnels you own.
- `scope=all` returns everything and is for admins only (anyone else gets 403 `admin_only`). `activity` can also be filtered by `tunnel_id`, `user_id` and `grant_id`.

## Revoking access

- Revoke an app on the **MCP** page, under **Preferences → MCP apps**, or in **Your MCP apps** on the AI activity page. Admins can revoke anyone's from the **Manage User** dialog.
- Every `/mcp` request re-checks the grant and the user, so a revoke takes effect at once. The app's open SSH sessions, shells and browsers close immediately.
- Revoking a personal API token closes its open sessions at once, too.
- **Disabled account**: its grants and personal API tokens are suspended, not revoked. `/mcp` refuses them at once and open sessions close. Re-enable the account and they work again.
- **MCP apps feature turned off** for someone: all their apps get a 401, as if revoked, and their open agent sessions end. Turn the feature back on and the apps work again.

## Without MCP: REST and the CLI

The same actions exist as a REST API. That's what `telepy exec` and `telepy browse` use (see [cli.md](cli.md)).

- Commands: `/api/ai/sessions*`.
- Remote browser: `/api/browser/sessions*`, listed below.

| Request | Does |
| --- | --- |
| `POST /api/browser/sessions {tunnel_id, username?, url?}` | Opens a browser → `{id, …}` |
| `POST …/{id}/navigate {url}` | Goes to a URL |
| `GET …/{id}/text?selector=` | Page text |
| `GET …/{id}/screenshot` | Screenshot (image/png) |
| `POST …/{id}/click {selector \| text}` | Clicks |
| `POST …/{id}/type {selector, text, press_enter?, sensitive?}` | Types |
| `DELETE …/{id}` | Closes it |
| `GET /api/browser/sessions` | Lists open browsers |

- Limits, presence, Live sessions, automatic closing and the audit all work the same as over MCP.
- A personal API token or an OAuth app's token needs `browser:use`. A web sign-in can call these too (client name "Telepy web sign-in").
- A browser belongs only to the credential that opened it.
- A tunnel that requires step-up answers 403 `step_up_refused`.

## Security notes

A short list of what to keep in mind before you approve an app:

- An app never gets more than you have, and only the scopes and tunnels you approved.
- `ssh:exec`, `ssh:files` and `browser:use` can change things. A browser opened through a device reaches that device's LAN and localhost.
- The full command text goes into the audit log. Keep passwords off command lines.
- Command rules check `ssh_exec` and every Enter at a shell prompt, but not Enter inside a full-screen program such as vim or less.
- Tunnels that require step-up are off limits to agents.
- When someone's agent connects to a tunnel you own, you're notified.
- The `telepy CLI (<computer name>)` name is reported by the client itself, so treat it as a label, not proof.

## Check it by hand

```bash
# 401, and discovery points at the metadata
curl -si -X POST https://telepy.example.com/mcp -H 'content-type: application/json' -d '{}' | grep -i www-authenticate
curl -s https://telepy.example.com/.well-known/oauth-protected-resource/mcp
curl -s https://telepy.example.com/.well-known/oauth-authorization-server
```

<details>
<summary>Automated tests (for contributors)</summary>

- `tests/oauth_api.rs`: the OAuth flow.
- `tests/mcp_api.rs`: end to end against a fake device sshd. Covers exec, SFTP, timeouts, truncation, scopes, limits, revocation, automatic closing, share notifications, interactive shells (screen, control characters, recording, command rules), and the agent browser against a fake session manager.
- `tests/api_tokens.rs` and `tests/api_token_calls.rs`: personal API tokens calling `/mcp` and REST, and the call log.
- `tests/features.rs`: feature permissions blocking tools.
- `docker/kasm-browser/tests/test_cdp.py`: the browser actions on the session manager's side.

</details>
