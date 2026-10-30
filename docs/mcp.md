# AI tool access (MCP)

<p align="center"><b>English</b> | <a href="./mcp.zh-TW.md">繁體中文</a> | <a href="./mcp.ja.md">日本語</a></p>

> Lets AI tools that speak MCP (Claude Code, Claude Desktop / claude.ai, Cursor and others) work in Telepy with the user's own permissions:
> check tunnel status, open an SSH session that **closes itself**, run commands, drive a TUI through an interactive shell, read and write files, and open a remote browser through a device.
> Tracking issues: #93, #107.
> Backend code: `oauth/`, `api/oauth.rs`, `db/oauth.rs`, `auth/mcp.rs` (OAuth 2.1 and personal API tokens); `mcp/` (the MCP server);
> `ai/` (SSH sessions and the reaper; `ai/shell.rs` for interactive shells, `ai/browser.rs` for the agent's browser); `api/ai.rs`, `api/browser.rs`,
> `db/ai_audit.rs` (session list, REST version and audit).

## Connecting

![What an MCP app can reach, by scope](images/en/agent-reach.png)

The MCP endpoint is `https://<your host>/mcp` (Streamable HTTP). In production set `PUBLIC_URL` in `.env`
(for example `https://telepy.example.com`); the OAuth issuer and the MCP resource both come from it. When it is not set, Telepy derives them from the request's
`X-Forwarded-Proto` / `X-Forwarded-Host` / `Host`.

| Client | Setup |
| --- | --- |
| Claude Code | `claude mcp add --transport http telepy https://telepy.example.com/mcp`, then run `/mcp` in the conversation to finish authorization |
| Claude Desktop / claude.ai | Settings → Connectors → Add custom connector, and enter `https://telepy.example.com/mcp` as the URL |
| Cursor and others | `mcp.json`: `{"mcpServers": {"telepy": {"url": "https://telepy.example.com/mcp"}}}` |

You don't create a token by hand: on the first call the client gets a 401 and runs the OAuth flow below by itself.

Agents and CI jobs without a browser can use a **personal API token** (`tpt_…`, created on the **API** page in the left sidebar) as a Bearer token:
`{"mcpServers": {"telepy": {"url": "https://telepy.example.com/mcp", "headers": {"Authorization": "Bearer tpt_…"}}}}`.
On `/mcp` a token gets the same tools, scopes and tunnel limits as an OAuth app (the person needs both the "API tokens" and the "MCP apps" feature turned on).
Its sessions, shells and browsers belong to that one token, and the app name in the audit is `API token "<name>"`. Besides the AI audit, each of its tool calls
is also recorded under Activity on the API page (`MCP <tool>`; 200, or 400 when the tool returned an error). Revoking the token closes its open sessions at once. The same actions also exist as
a REST version: `/api/ai/sessions*` (commands) and `/api/browser/sessions*` (remote browser, see below), which is what `telepy exec` / `telepy browse` use
(see [cli.md](cli.md)).

**AI → MCP** in the left sidebar (`/tunnels/mcp`) shows the endpoint URL you actually need to enter (taken from the `resource` in discovery, so it reflects
`PUBLIC_URL`), copy-ready settings for the three clients above, the tools each permission unlocks, when sessions close, and the connected MCP apps.
The "What an MCP app can reach" button at the top right opens a diagram: MCP app ─ Telepy ─ device ─ LAN / internet, with the branches lit according to the permissions of the connected app you pick
(`lib/aiAccess.ts` `reachFor`).

## Authorization flow (OAuth 2.1)

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

- The permissions (scopes) on the consent page:

  | scope | Allows |
  | --- | --- |
  | `tunnels:read` | `list_tunnels`, `tunnel_status`, `lan_hosts` |
  | `ssh:exec` | `ssh_session_open`, `ssh_exec`, `shell_open` / `shell_send` / `shell_read` / `shell_resize` / `shell_close` |
  | `ssh:files` | `ssh_session_open`, `sftp_list` / `sftp_read` / `sftp_write` |
  | `network:scan` | `lan_scan` (scans the LAN behind a device; only on tunnels you own or are ADMIN on) |
  | `browser:use` | `browser_open` / `browser_navigate` / `browser_read` / `browser_screenshot` / `browser_click` / `browser_type` / `browser_close` (a real browser that goes online through the device; the consent page marks it "can change things") |

  The user can untick any of them, and can limit the app to some of their tunnels.
- The access token is a JWT with `token_type: "mcp_access"`; a web token can't call `/mcp`. The REST API accepts it only for the routes on the token allow-list
  (`auth::api_tokens::ROUTES`, see [cli.md](cli.md)), which is how the `telepy` command line's browser sign-in uses it.
- Every `/mcp` request re-checks the grant and the user, so revoking on the **MCP page**, under **Preferences → MCP apps**, or under "Your MCP apps" on the AI activity page
  takes effect at once, and the SSH sessions, shells and browsers that app has open close immediately (an administrator can revoke anyone's from the Manage User dialog).
- When an account is disabled, its grants and personal API tokens are **suspended, not revoked**: `/mcp` refuses them at once and open sessions close, and everything works again after the account is re-enabled.
  When an administrator turns off the "MCP apps" feature for a person, all their apps get a 401 (as if revoked) and their open agent sessions end; turning the feature back on restores them.
- **`telepy login` doesn't count as an MCP app.** The command line's browser sign-in goes through the same OAuth (the consent page says it is the CLI asking), and each sign-in registers as
  `telepy CLI (<computer name>)`. These grants are listed under the "CLI sign-ins" tab of the API page (`/tunnels/api?tab=cli`); the MCP page, Preferences and
  the AI activity page leave them out of their MCP app lists. Signing in again from the same computer offers to replace the earlier one; each person keeps at most 10 CLI sign-ins, and the 11th
  signs out the least recently used one. CLI sign-ins also follow the "MCP apps" feature switch (see [cli.md](cli.md)). The name is reported by the client itself and is used only to sort what is shown.

## Tools

| Tool | Description |
| --- | --- |
| `list_tunnels` | The tunnels you can see: id, name, whether it is online, latency, my permission, the target usernames available, and the sessions this app has open |
| `tunnel_status(tunnel_id)` | Online / health state (online / degraded = the tunnel is up but the device's sshd doesn't answer / offline), latency, 24-hour uptime, the device's basic facts `facts` (OS, kernel, uptime in seconds, CPU, memory / root disk in KB, load, ssh version, whether a reboot is needed; only for people who can log in to the device) and `warnings`, and the last 10 gateway events |
| `ssh_session_open(tunnel_id, username?, idle_timeout_s?, max_lifetime_s?)` | Open a session and return `session_id`; if username is omitted, the tunnel's default is used (picked automatically when there is only one) |
| `ssh_exec(session_id, command, timeout_s?, max_output_bytes?)` | Run a command (no TTY): `exit_code`, `stdout`, `stderr`, `timed_out`, `truncated` |
| `ssh_session_list` | The sessions this app has open and the time left on each |
| `ssh_session_close(session_id)` | Close a session |
| `sftp_list(session_id, path?)` | List a directory (`~` = home directory) |
| `sftp_read(session_id, path, offset?, max_bytes?)` | Read a file; text comes back as UTF-8, anything else as base64; can be paged |
| `sftp_write(session_id, path, content, encoding?, append?)` | Write or append to a file (`encoding`: `utf-8` / `base64`) |
| `lan_hosts(tunnel_id)` | The LAN hosts behind a device (found by a scan or added by hand): address, name, open ports, SSH banner, labels, login account |
| `lan_scan(tunnel_id, username?, subnets?, ports?)` | Scan the LAN through the device's sshd (private ranges, up to 1024 addresses, about a minute) and save the result to the host list; needs `network:scan` and owner / ADMIN permission |
| `shell_open(session_id, cols?, rows?)` | Open an interactive shell on a session (PTY, `xterm-256color`, 120×40 by default) and return `shell_id`; at most 2 per session |
| `shell_send(shell_id, input, press_enter?)` | Type: sends the input as is (control characters allowed, `\u0003` = Ctrl+C, `\u001b` = Esc); `press_enter` adds an Enter. Up to 64 KiB each time |
| `shell_read(shell_id, timeout_ms?, max_bytes?, screen?)` | Read: `output` = raw output since the last read, `screen` = the current screen (a vt100 model, plain text one line per row), `cursor`, `size`, `more`, `exited`; when there is no new output it waits up to `timeout_ms` (default 1.5 seconds, at most 10 seconds). Output nobody has read is kept up to 256 KiB (beyond that the oldest is dropped and `dropped_bytes` is returned) |
| `shell_resize(shell_id, cols, rows)` / `shell_close(shell_id)` | Resize / close |
| `browser_open(tunnel_id, username?, url?, idle_timeout_s?, max_lifetime_s?)` | Open a remote browser through a device (Chromium; traffic leaves from the device, so it sees the device's LAN, localhost and public IP) and return `browser_id`; can open `url` at the same time |
| `browser_navigate(browser_id, url)` | Go to a URL (only http / https is accepted, `https://` is added if missing), wait for the page to load, and return the final URL and title |
| `browser_read(browser_id, selector?)` | Page text: title, URL, visible text (up to 100,000 characters), links; `selector` reads only part of the page |
| `browser_screenshot(browser_id)` | A PNG screenshot (scaled down to 1280 px wide at most), returned as an MCP image content block |
| `browser_click(browser_id, selector? \| text?)` | Click by CSS selector or by visible text (link, button, label), with real mouse events |
| `browser_type(browser_id, selector, text, press_enter?, sensitive?)` | Type into a field, optionally pressing Enter to submit; `sensitive` defaults to true = the audit records only the length |
| `browser_close(browser_id)` | Close the browser |

Permissions follow the web rules exactly: you need VIEW permission on the tunnel, and the target username must be on the allow-list (a shared tunnel can use only the
usernames allowed when it was shared, the same as the web terminal). In addition:

- **Feature permissions** (Admin → Users & access → Feature permissions, `/tunnels/admin/access`) apply too: when an administrator turns off a feature for a person, the matching tools return an error (`isError`) saying so.
  Tools under `ssh:exec` need "Web terminal", `ssh:files` needs "File manager", `lan_hosts` and `lan_scan` need "LAN discovery", and `browser:use`
  needs "Remote browser". When the scope itself wasn't granted, the error tells the agent to ask the user to reconnect and approve that scope.
- **Tunnels that require step-up** (the user must confirm with a second factor before every session) refuse agents opening SSH sessions, browsers and `lan_scan`;
  `requires_step_up` in `list_tunnels` tells the agent beforehand.

### Command rules (`ssh_exec`)

![How a command is decided: split, site-wide rules, personal rules, verdict](images/en/command-decision.png)

The rules on the web "Command rules" page (`/tunnels/commands`) govern an agent's commands too. There are two kinds of rule:

- **Personal rules**: everyone writes their own. When the audience is "Everyone" or "Only people it's shared with", the rule applies only on tunnels where the author is **currently** the owner or an ADMIN;
  "Only me" governs only the author's own commands, on any tunnel they use, for example a guard on their own MCP agent running on someone else's tunnel.
  Nobody else can see an "Only me" rule.
- **Site-wide rules**: written by administrators (admin area, "Rules & alerts → Command rules"). They can be overridden by default: a tunnel's owner / ADMIN can turn one off on the tunnels they manage;
  when an administrator turns off "Let people override", the rule is enforced and nobody can turn it off.

A rule can apply to MCP agents only (`via: agents`). When a command matches several rules, block beats needs approval, which beats remind. What each action does for an agent:

- **Block**: the command is not run and the tool returns an error (`isError`) naming the rule and its note.
- **Needs approval**: Telepy files an approval request (the approvers are the people the rule names, or the tunnel owner and ADMINs if none are named, or the author for an "Only me" rule;
  they see it at the bottom right of the web app and can also handle it on the Command rules page), and this tool call
  waits up to 45 seconds. If it is approved the command runs as usual and the result comes back; a denial or a timeout returns an error. If nobody has decided yet the error says "still waiting". Ask the agent to tell the user,
  and after approval to call **the exact same command** again; an approval can be used once within 10 minutes (same app, tunnel, account and command).
- **Remind**: the command runs as usual and the `ssh_exec` result carries an extra `reminder` (the rule's note, or the pattern if it has none), which the agent should pass on to the user;
  the REST `POST /api/ai/sessions/{id}/exec` does the same. It doesn't wait for anyone and doesn't appear under History on the Command rules page. It isn't enforced, and each person can mute it for themselves.
- **Allow (exception)**: lets matching commands skip the block / needs-approval rules of **the same author** (a site-wide exception exempts site-wide rules, a personal one exempts the same person's rules;
  in addition, a tunnel owner's / ADMIN's exception also exempts overridable site-wide rules on the tunnels they manage, but not enforced ones). Someone else's exception can't override your rules.
- When an agent runs as the tunnel owner, the owner still has to click approve (human in the loop).
- Blocked, waiting and denied commands are all recorded in the AI audit as failed `ssh_exec` calls, and the requests and their outcomes also appear under History on the Command rules page.
- **Interactive shells too**: for every Enter pressed at the shell prompt in `shell_send`, Telepy reads that line out the same way the web terminal does (`TerminalGuard`) and checks it.
  Block → Ctrl+C is sent instead and the tool returns an error; needs approval → like `ssh_exec` it waits up to 45 seconds, and on approval the Enter is sent; while it is still waiting the line
  stays at the prompt, and after approval the agent sends `input: ""`, `press_enter: true` to run it (again once within 10 minutes). Input typed after an Enter that wasn't sent is discarded
  (the tool says how many bytes). Lines that match a remind rule are sent as usual and the `shell_send` result carries `reminders` (one sentence per rule). Enter inside a full-screen program (vim, less) is not checked.

## Interactive shells

- A shell is one PTY channel on the connection an AI session already has. It shares the session's quota of 4 channels with `ssh_exec`, and at most 2 are allowed.
- Output is read in the background all the time (feeding the screen model and the recording), so an agent that isn't reading won't block the device.
- It closes on `shell_close`, when the session closes (for any reason), or when there has been no send / read for longer than the session's `idle_timeout` (the reaper runs every 30 seconds).
  Using a shell counts as the session being in use, so it won't let the session time out as idle.
- **Recording**: when the tunnel has "Record web terminal sessions" on, an agent's shell is recorded as asciicast too (`kind: agent`, labelled "MCP agent" on the Recordings page).
- On the Live sessions page, an agent session's row shows how many shells are open (`shells` in `/api/sessions` and in `/api/ai/sessions`).

## Remote browser (`browser:use`)

- It is an ordinary remote-browser session (`remote_browser/`: SOCKS through the device, Chromium in kasm-browser, counted against
  `remote_browser_max_sessions`), only operated by the agent through the session-manager's CDP endpoint (see "Driving it from an MCP agent or a script" in [remote-browser.md](remote-browser.md)).
  The backend never connects to Chromium's DevTools directly.
- It shares the per-person cap `ai_max_sessions_per_user` with SSH sessions, and the same idle / lifetime limits and reaper (it closes when the device goes offline, the grant is revoked, the permission or username
  is taken away, or the remote-browser session disappears); tunnels with step-up refuse it.
- It shows up in "who is using it" and on the Live sessions page (kind `browser`, client = app name) and can be ended from there: later tool calls then return "ended by <who>".
- Opening and closing write `browser_open` / `browser_close` gateway events (the tunnel's Logs), and notifications reuse `AI-SESSION-OPENED` / `AI-SESSION-CLOSED`
  (with an extra `kind: "browser"`; the data of the `mcp.session_*` webhooks carries `kind` too).
- Audit: the URL and selector; the text of `browser_type` records only the length by default (the content only with `sensitive: false`); the screenshot itself isn't stored.
- **REST version** (`api/browser.rs`, for scripts and `telepy browse`): `POST /api/browser/sessions {tunnel_id, username?, url?}` → `{id, …}`,
  `POST …/{id}/navigate {url}`, `GET …/{id}/text?selector=`, `GET …/{id}/screenshot` (image/png), `POST …/{id}/click {selector | text}`,
  `POST …/{id}/type {selector, text, press_enter?, sensitive?}`, `DELETE …/{id}`, `GET /api/browser/sessions`. It shares `ai::browser`
  (`open_at` / `lookup` / `run_action`), so limits, presence, live sessions, the reaper and the audit match MCP; a personal API token or an OAuth app's
  token needs `browser:use`, a web sign-in can call it too (client name "Telepy web sign-in"); a browser belongs only to the credential that opened it; a step-up tunnel returns 403
  `step_up_refused`.

## Session lifecycle

A session is one russh connection to the device, shared by all its commands (no new handshake per command). Each command opens its own exec channel,
and one session can have at most 4 at a time.

| Closes when | Reason (`reason` in notifications and the audit) |
| --- | --- |
| the agent calls `ssh_session_close` | `closed_by_agent` |
| the user, the tunnel owner or an administrator closes it on the web (the AI activity page or the Live sessions page, `DELETE /api/ai/sessions/{id}`); an administrator turns off the "MCP apps" feature for that person | `closed_by_user` |
| idle longer than `ai_session_idle_timeout` (600 seconds by default; a running command doesn't count as idle) | `idle` |
| alive longer than `ai_session_max_lifetime` (7200 seconds by default; always closed) | `max_lifetime` |
| the device goes offline, the connection drops | `device_offline` / `disconnected` |
| the grant or personal API token is revoked / expires, the account is disabled | `revoked` |
| the tunnel is deleted | `tunnel_deleted` |
| the permission or username is taken away (unshared, share expired, allow-list shrunk…) | `permission_removed` |

- The reaper checks every 30 seconds; revoking a grant / token closes at once, and changes such as unsharing or changing a permission also trigger an immediate re-check (`ai::recheck`).
- An agent can ask for a shorter `idle_timeout_s` / `max_lifetime_s`, but not beyond the site settings (10 seconds at the shortest).
- Each user can have at most `ai_max_sessions_per_user` open at once (3 by default, all apps together, SSH sessions and agent browsers counted together; 0 = AI may not open sessions).
- A command's timeout is 60 seconds by default and at most 600 seconds; on timeout `KILL` is sent and the channel closes. Each output stream keeps 64 KiB by default and at most 1 MiB,
  and beyond that it keeps the first 1/4 and the last 3/4.
- MCP version 2026-07-28 has no transport sessions, so an SSH session is tied to the credential (which OAuth grant or which personal API token),
  not to the MCP connection; different apps / tokens can't see each other's sessions.

All three limits are on the administrator's **Site settings → AI access (MCP)** tab (`/tunnels/settings?tab=ai`, which also shows the MCP endpoint URL), and a change applies to newly opened sessions.

## Notifications and audit

- When a session opens or closes, `/ws/notifications` sends `AI-SESSION-OPENED` / `AI-SESSION-CLOSED`
  (`details`, `tunnel_id`, `session_id`, `by`, `client`, plus `reason` on close) to the session's user and the tunnel owner —
  so when a user who was given a tunnel connects to someone else's tunnel with AI, the owner knows.
- Every tool call writes one `telepy_ai_audit_event` row (up to 100,000 rows are kept, deleted after 90 days, hash-chained against tampering): who, which app,
  which tunnel and username, the command or path (up to 2000 characters), exit code, duration, output bytes, error, source IP. **The command text is recorded**,
  so don't let an agent put passwords on a command line.
- `GET /api/ai/activity` and `GET /api/ai/sessions` default to `?scope=mine` (administrators too): your own, plus those on tunnels you own;
  `scope=all` = everything, administrators only (anyone else gets 403 `admin_only`). `activity` can also be filtered by `tunnel_id`, `user_id` and `grant_id`.
- On the web: **AI activity** (`/tunnels/activity`) is your own (including open sessions and your MCP apps); the administrators' site-wide version is **All AI activity**
  (`/tunnels/admin/activity`) in the admin area.

## Manual verification

```bash
# 401, and discovery points at the metadata
curl -si -X POST https://telepy.example.com/mcp -H 'content-type: application/json' -d '{}' | grep -i www-authenticate
curl -s https://telepy.example.com/.well-known/oauth-protected-resource/mcp
curl -s https://telepy.example.com/.well-known/oauth-authorization-server
```

Automated tests: `tests/oauth_api.rs` (the OAuth flow); `tests/mcp_api.rs` (end to end against a fake device sshd: exec / SFTP /
timeout / truncation / scope / limits / revocation / reaper / share notifications, interactive shells (a PTY echo shell: screen, control characters, recording, command rules),
and the agent browser against a fake session-manager); `tests/api_tokens.rs` (personal API tokens calling `/mcp` and REST), `tests/api_token_calls.rs`
(the call log); `tests/features.rs` (feature permissions blocking tools); `docker/kasm-browser/tests/test_cdp.py` (CDP actions, WebSocket
frames, the /cdp route).
