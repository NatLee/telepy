# Remote Browser (KasmVNC)

<p align="center"><b>English</b> | <a href="./remote-browser.zh-TW.md">繁體中文</a> | <a href="./remote-browser.ja.md">日本語</a></p>

> Lets a user drive a real Chromium desktop in the web UI, with its traffic leaving through the target machine.
> This is the **architecture document** for the KasmVNC version (migration finished 2026-07-03; for the story of how it went, see
> [`articles/2026-07-03-kasmvnc-migration-warstory.md`](engineering/articles/2026-07-03-kasmvnc-migration-warstory.md)).
>
> **Current state (2026-10):** the backend was rewritten as a single Rust process (see [`rust-migration-plan.md`](engineering/rust-migration-plan.md)):
> - The session store lives in memory (plus one small table, `telepy_remote_browser_session`, used only to clean up orphaned kasm-side sessions after a restart).
>   There are no gunicorn workers and no Redis.
> - The SOCKS proxy runs **in-process** (`ssh/socks.rs`): every CONNECT is a direct-tcpip channel on the pooled device connection,
>   opened by the device's sshd — the same mechanism as the old `ssh -D`, but without spawning a child process.
> - KasmVNC, Chromium, the session-manager, the WS handshake and the anti-detection flags are unchanged.
>
> Paragraphs marked "History" describe the Django-era `ssh -D` / Redis / gunicorn setup and are kept only as design context.

## Architecture overview

```
Browser (vendored KasmVNC noVNC-fork client)
   │  wss /ws/remote-browser/<session_id>/ (JWT in the first message)
   ▼
backend ws/remote_browser.rs (Rust)
   │  1. verify JWT (first message) + feature permission remote_browser (4012) + tunnel VIEW permission (second check on the session's server_id)
   │  2. transparent WS↔WS relay (forwards message by message, does not parse the protocol); ws::Heartbeat pings every 20s, no answer in 40s = the peer is gone
   ▼
kasm-browser container :<ws_port> (KasmVNC websocket, Basic Auth)
   ├─ Xkasmvnc :N (one display per session; ws_port = 8443 + N)
   ├─ openbox + chromium (wrapped in a respawn loop; a temporary profile per session)
   └─ session-manager (:7000, HTTP API protected by X-Internal-Token)

chromium --proxy-server=socks5://backend:<port> --proxy-bypass-list='<-loopback>'
   ▲
   └─ in-process SOCKS5 in the backend (ssh/socks.rs, CONNECT only, no auth, port reachable only inside the docker network)
      every CONNECT = a direct-tcpip on the pooled device connection, opened by the device's sshd = the exit IP
      (localhost/127.0.0.1 also go to the target machine this way, see the --proxy-bypass-list note below;
       name targets go through ssh::resolve first — macOS sshd drops the whole connection on a direct-tcpip to a name)
```

- **Why WS↔WS and not raw-RFB TCP:** KasmVNC has moved away from the RFB spec. It only opens a
  websocket, not the traditional VNC port, and **stock noVNC cannot connect** (black screen); you must use its
  own fork of the client (vendored, see below).
- **Handshake order** (VNC is server-speaks-first, so the greeting must not be missed): the frontend sends `auth` →
  the backend connects upstream and answers `ready` → the frontend hands the same WS to the RFB client and replies `begin` →
  only then does the backend start pumping upstream bytes.
- **Why chromium needs `--proxy-bypass-list='<-loopback>'`:** for loopback
  destinations (`localhost` / `127.0.0.1/8` / `::1` / `*.localhost`) chromium has an **implicit built-in rule: always connect directly, never via the proxy**. Without this flag,
  a user typing `http://localhost:PORT` in the proxied browser would be connected **directly** to the loopback of the
  kasm-browser **container itself** (which is empty), not the target machine — reported as "the proxied browser can't act fully
  as the target machine, not even localhost". `<-loopback>` is the token chromium provides to **remove** that implicit loopback
  bypass; once removed, loopback destinations go through the `--proxy-server` SOCKS to the target machine, where
  `connect(127.0.0.1:PORT)` happens (this SOCKS exits at the target's sshd, so `127.0.0.1` = the target machine itself), and the proxied
  browser really acts "fully as the target machine" for its local services. **The single quotes are required:** the whole `BROWSER_CMD` is parsed by the shell a **second time**
  through `sh -c "$BROWSER_CMD"` in `open-browser.sh`, and unquoted `<` / `>` would be taken as
  redirection metacharacters. Ordinary internet browsing still goes through the proxy (exit IP) as before; what `<-loopback>` removes is chromium's implicit bypass for
  loopback **and link-local** (the full set is `localhost` / `*.localhost` / `[::1]` /
  `127.0.0.1/8` / `169.254/16` / `[FE80::]/10`), so these "local addresses" now also go through the proxy → the target machine's network
  (harmless for this purpose, in fact exactly "as the target machine"); the VNC transport (Xkasmvnc's own websocket, unrelated to
  chromium's network stack) is not affected.

## Component map

| Component | Location | Responsibility |
|---|---|---|
| REST start/stop/ping | `src/backend-api/src/api/remote_browser.rs` + `remote_browser/mod.rs` | Borrow the pooled device connection, open the in-process SOCKS (with retries), call the session-manager, in-memory session store (plus the small table for restart cleanup), reaper |
| In-process SOCKS5 | `src/backend-api/src/ssh/socks.rs` | CONNECT only; each connection = a direct-tcpip on the device connection (a transport lease, takes no session slot) |
| session-manager client | `src/backend-api/src/remote_browser/kasm.rs` | HTTP client for kasm-browser :7000 (create / stop / CDP) |
| WS relay | `src/backend-api/src/ws/remote_browser.rs` | JWT + feature + permission, upstream connection (with automatic scheme/path fallback), two-way pump, presence, heartbeat |
| Browsers opened by agents / scripts | `src/backend-api/src/ai/browser.rs`, `mcp/`, `api/browser.rs` | MCP `browser_*` tools and REST `/api/browser/sessions*` (see "MCP agents and scripting" below) |
| session-manager | `docker/kasm-browser/session_manager.py` | Per session: Xkasmvnc + openbox + chromium (respawn loop, temporary profile) |
| CDP adapter | `docker/kasm-browser/cdp.py` | Turns actions received by the session-manager into Chromium DevTools calls on the container's loopback |
| Frontend panel | `src/frontend/src/components/tunnels/RemoteBrowserPanel.tsx` | Main view of the Browser on the terminal page (the Browser button in the tunnel list); handshake, IME textarea, clipboard / IME / mouse settings |
| Vendored client | `src/frontend/src/vendor/kasm-novnc/` | kasmtech/noVNC v1.3.0; **see that README for the embedding requirements (required reading)** |

## KasmVNC fact table (measured and pinned, don't look them up again)

| Item | Value |
|---|---|
| Stock noVNC compatible? | **No.** You must use the kasmtech/noVNC fork (server 1.4.0 ↔ client 1.3.0) |
| Transport | Plain ws (`-sslOnly` is off by default); endpoint **`/websockify`**; subprotocol `binary` |
| `Sec-WebSocket-Origin` | **Required** (a legacy Hixie-era header; the value is not checked). Without it you get 404 "failed websocket checks" (not 401!) |
| Basic Auth | On by default; `-disableBasicAuth` has no effect in 1.4.0 → create a user with `kasmvncpasswd` and send `Authorization: Basic` on connect |
| Password file | Fixed path `-KasmPasswordFile /etc/kasmvnc/kasmpasswd` (**don't rely on `$HOME`**: HOME differs between build and runtime → 401 every time) |
| ws_port | `8443 + display` (adjustable with `WS_BASE`) |

## Session lifecycle

![Starting a remote browser step by step](images/en/browser-start.gif)

- **Create:** `POST /api/reverse/server/{id}/remote-browser/start` `{username?}`: checks the `remote_browser` feature permission,
  tunnel VIEW, step-up (sensitive tunnels), that `username` is in `permissions::allowed_usernames` (omitted = the tunnel's default account, otherwise the first
  allowed one), and `remote_browser_max_sessions` → borrows the pooled device connection, opens the in-process SOCKS → the session-manager starts
  Xkasmvnc/openbox/chromium → the session goes into memory (and one row into `telepy_remote_browser_session`) → returns `{session_id, ws_path}`.
- **SOCKS cold start / retry:** each attempt = borrow a transport lease from `ssh::pool` (shared directly if the terminal / files of the same (tunnel, account) are already logged in)
  + `SocksProxy::start`, the whole thing capped by `remote_browser_ssh_timeout`, retried up to `remote_browser_ssh_attempts` times
  (defaults 30 seconds / 2 attempts; the setting names are kept from the `ssh -D` days). If the gateway has no forward for this tunnel (device offline) it fails at once instead of waiting,
  returning 500 + `code: device_offline` (the frontend translates it to a `browser.*` message).
- **History (the Django `ssh -D`):** `username@reverse` was two hops (ProxyCommand → telepy-ssh → reverse tunnel to
  the device's sshd). `_spawn_socks_proxy` used hardened options (`BatchMode` / `ExitOnForwardFailure` /
  `ConnectTimeout` / `ServerAlive`, so it no longer hung forever on authentication; no `-q`, to keep stderr),
  and `start_remote_browser` retried automatically (default 2 times, `remote_browser_ssh_attempts`).
  A truly offline device (reverse port absent) failed at once instead of waiting. On failure, ssh's stderr was written to the backend log.
- **History: that -D needed `ControlMaster=no` + `ControlPath=none` (learned the hard way; the in-process SOCKS doesn't have this problem):** the ssh config
  had `ControlMaster auto` + `ControlPersist` for `Host reverse`, so on a cold start ssh would fork a **background
  master** and let the foreground client exit immediately → `Popen.poll()` wrongly decided "ssh died" → attempt 1 always failed falsely
  (the log kept showing `attempt 1/2 did not bind ... no stderr` but gave up after 0.2s), while the master bound
  -D a bit later, leaving an **unmanaged orphan listener** (observed alive for 16 hours). With mux disabled, the lifetime of that -D
  = that Popen, poll()/terminate() mean the right thing and sessions are isolated from each other; the first hop of ProxyCommand
  (telepy-ssh) still uses its own mux, and a cold start is only slow in the second hop's handshake (controlled by `remote_browser_ssh_timeout`,
  which can be raised in the site settings for slow tunnels).
- **Profile:** each session gets its own `mkdtemp` directory, **deleted on stop** (no history is kept).
  Never shared: Chromium's SingletonLock makes the chromium of a second concurrent session hand over to the
  first one and exit (log: `Opening in existing browser session.`), and both fail.
  The browser process's `HOME` also points into this directory (dotfiles and other home-directory writes are deleted with the session).
- **Chromium closed / minimised / gone:** a minimised window can be restored from the **taskbar**; if the window was closed (the chromium process
  still lives in background mode), click the panel's **"Open browser" shortcut** (open-browser.sh) to open it again — the shortcut first
  focuses/restores an existing window and only starts a fresh one if there is none (it also cleans up the leftover background-mode main process, to avoid just printing
  "Opening in existing browser session" without opening a window). When the **chromium process is gone entirely** (crash / full exit),
  the session-manager's **watchdog** checks every 10s (scanning /proc by `--user-data-dir`) and relaunches it with the same
  open-browser.sh (15s grace after creation, 30s cooldown between restarts; `REMOTE_BROWSER_RESPAWN=0` turns it off).
  A real user once came back to a session with an empty desktop and thought the whole feature was broken — the browser is the whole point of the session.
- **Every way to launch on the desktop converges on open-browser.sh:** the openbox root menu (right-click on the desktop) was replaced with a custom
  `openbox-menu.xml` (the Debian default menu's "Web browser" = a bare `x-www-browser` → no sandbox as root, exits at once,
  and the user only sees "nothing happens when I click"). `BROWSER_CMD` is passed by the session-manager to openbox/tint2/
  watchdog through the environment, and a **per-display env file** `/tmp/telepy-browser-<display>.env` is also written (deleted
  when the session stops): when open-browser.sh finds the environment lost it sources that file by `$DISPLAY` — so any launch path works
  (learned the hard way: an older openbox didn't pass the env, and a user opening the browser from the desktop menu got `BROWSER_CMD not set`).
- **Downloads:** Chromium's managed policy (`/etc/chromium/policies/managed/telepy.json`)
  `DownloadRestrictions: 3` **blocks them entirely** — files downloaded inside the container are unreachable for the user anyway
  (there is no way to fetch them), they would only pile up and eat the container's disk. Allowing downloads would need both a quota and a way to fetch files.
- **Stop:** a WS disconnect tears down the whole session (the SOCKS proxy + returning the lease, the kasm session, that record);
  `POST /api/reverse/server/remote-browser/{sid}/stop` (panel closed, tab `beforeunload`) takes the same path; the reaper is the fallback.
  On the kasm side, processes are killed as a group with `killpg(p.pid)` (`start_new_session` ⇒ pgid == pid; don't use
  `getpgid`, it raises when the group leader dies first and would leave orphans behind).
- **Keep-alive and health check:** while the WS is connected the relay renews the session itself every 20s (server-side timer, unaffected by background-tab throttling), and the frontend panel additionally calls
  `POST …/remote-browser/{sid}/ping` every 15s. The ping first probes the session's SOCKS port (`127.0.0.1:proxy_port`) — **a port that isn't listening =
  the proxy is dead** → it is reclaimed on the spot and 404 is returned, and the frontend closes the screen and shows "session ended". The reaper runs every 10s: if the underlying device connection dropped
  (`SocksProxy::alive`) or there has been no renewal for more than `remote_browser_session_idle_timeout` + 30s → reclaim.
- **Orphans after a restart:** it is a single process, so a restart loses the in-memory sessions and proxies; at startup `cleanup_orphans` stops every session
  left on the kasm side according to that small table and deletes the records.
- **History (gunicorn workers + Redis):** the ping probe of the SOCKS port relied on "all workers share one netns"; the idle GC also swept for orphans "recorded in Redis,
  not owned by this process, port not listening" (the owning worker had restarted and nobody held the ssh handle) and reclaimed their kasm session + Redis record.
- **Who is using it, and ending it:** the WS relay joins presence (kind `browser`, carrying the device account it uses); the owner / ADMIN can see it in the tunnel list's in-use button and on the
  live sessions page (`/tunnels/sessions`) and can end it (4009, reason = who); the gateway events `browser_open` / `browser_close`
  (with duration) are written to that tunnel's Logs; at start a `session.started` webhook is sent to the owner and ADMINs (not the person themselves).
- **Losing access ends it** (`access_recheck.rs`, the same mechanism as terminal / files / desktop): unsharing, a smaller allow-list, the `remote_browser` feature
  turned off, an account disabled, etc. → 4009, reason `Telepy (access changed)`, `browser_close` records why, and the person receives `SESSION-ENDED`; the relay
  still stops the kasm session on teardown. Test `remote_browser_ends_when_access_is_lost`.
- **Disconnect detection:** the relay reads the socket through `ws::Heartbeat` (a WebSocket Ping every `WS_PING_INTERVAL_SECS` = 20s; if nothing at all is received within
  `WS_PEER_TIMEOUT_SECS` = 40s after a ping, the peer is considered gone), so a laptop going to sleep, a network switch or a dropped proxy no longer leaves the session and presence hanging forever.
- **Zombies:** kasm-browser runs with `init: true` (tini) as PID 1 to reap reparented orphans.
- **Window:** openbox starts with `--config-file /app/openbox-rc.xml` (at build time the applications rules are merged into the default
  rc.xml): `<decor>no</decor>` removes the title bar and `<maximized>true</maximized>`
  fills the display. Chromium's own `--start-maximized` measured only 1050×720, with margins and a title bar.
- **Sandbox:** `--no-sandbox` is a necessary evil when running as root in a container (Docker's default
  seccomp blocks unprivileged userns); `--test-type` suppresses the yellow warning bar. A real
  sandbox would need a custom seccomp profile mounted by compose (not done; the isolation boundary = the container). Measured: `--test-type`
  has zero effect on JS fingerprints (webdriver/chrome/languages/plugins/vendor) and the warning bar is not visible to web pages either.

## Anti-detection

A real person driving over VNC and exiting through the target machine's IP is already the strongest anti-detection condition. The flags are a bonus:

- `--disable-blink-features=AutomationControlled` → `navigator.webdriver = false`.
- Language: `--lang` + `--accept-lang` give a non-empty, consistent language (an empty `navigator.languages`
  is a bot signature).
- **`--accept-lang` must be a clean language tag with no q-values** (`_accept_lang` returns `zh-TW,zh,en`).
  chromium uses this value to decide both the HTTP `Accept-Language` header **and** `navigator.languages`,
  and computes the header's q-values itself. If we put q in first (the old bug):
  - the `Accept-Language` header stacks up as `zh-TW,zh;q=0.9,zh;q=0.9;q=0.8,en;q=0.8;q=0.7` (double q)
  - `navigator.languages` becomes `['zh-TW','zh;q=0.9','en;q=0.8']` (q leaks)

  Both are dead giveaways no real browser has → CAPTCHAs everywhere. With clean tags the header is correctly
  `zh-TW,zh;q=0.9,en;q=0.8` and `navigator.languages` is `['zh-TW','zh','en']`.
- **WebGL (`--enable-unsafe-swiftshader`, and **only** this one)**: the container has no GPU, and headed chromium on a GPU-less
  X display fails GPU initialisation → `canvas.getContext("webgl")` returns **null** (measured). "No
  WebGL at all" is a strong bot signal (YouTube's "sign in to confirm you're not a bot" checks it). `--enable-unsafe-swiftshader`
  **only** lets the WebGL context fall back to SwiftShader without touching the compositor → WebGL works (`OK ANGLE (SwiftShader...)`).
  **A mine we stepped on:** we once added `--use-gl=angle --use-angle=swiftshader` to make sure WebGL worked, which forced the whole GL **compositor**
  onto software SwiftShader too → **YouTube video would not play smoothly**. Measured (real VP9 decode, 640x480): forced-swiftshader
  dropped 4 frames, `--enable-unsafe-swiftshader` alone and the baseline both dropped 0, and WebGL was just as fine with the single flag. At 720p/1080p
  the forced version drops so many frames it can't play. **Conclusion: keep only `--enable-unsafe-swiftshader`, never add `--use-gl`.**
  Note: the renderer shows SwiftShader (not a real GPU), which is still a weak signal; looking more like a real machine would require spoofing the renderer string of
  `getParameter` on the client side (not done).

### Limits (honestly)

The flags only deal with the **browser fingerprint**. For blocks like YouTube's, the deciding factors are two other things the flags can't solve:

1. **Exit IP reputation**: traffic leaves via the target machine's IP (through the SOCKS over the device's sshd). If the target is a datacenter / cloud / VPN IP, or the IP
   has been polluted by lots of automated access, YouTube/Cloudflare will block it outright — **nothing to do with the browser fingerprint**. The only way around
   it is a target machine with a residential IP.
2. **No cookie / sign-in trust**: the profile is brand new every session (a privacy requirement, no history kept). YouTube trusts sessions that are
   signed in or have browsing history far more; a fresh session is naturally more likely to be asked to verify. This conflicts
   directly with "keep no history".

   > **Decided (2026-07-04): keep a fresh profile per session, privacy first.** A "YouTube asks you to sign in"
   > regression showed up; the investigation confirmed the regression point was 967ea75 (profile made ephemeral) — with no cookies accumulating YouTube treats every
   > visit as a suspicious new visitor. A possible compromise is to "persist only cookies/sign-in and still keep no browsing history", but the user chose privacy first
   > and accepts being asked to sign in now and then (the deciding factor is the exit IP anyway). **To cut down blocking later, switch to a residential-IP target machine first rather than
   > touching the profile.** Do not add profile persistence back without the user's consent.

## MCP agents and scripting (CDP)

MCP agents (scope `browser:use`) can open a browser and operate it themselves, see [`mcp.md`](mcp.md); the same actions also exist as REST
`/api/browser/sessions*` (`api/browser.rs`: open `{tunnel_id, username?, url?}`, `navigate`, `text?selector=`, `screenshot` (image/png),
`click`, `type`, `DELETE`, list), for personal API tokens (scope `browser:use`), the `telepy browse` command (see [`cli.md`](cli.md)) and web sign-ins.
They are all ordinary remote-browser sessions (same SOCKS, same kasm session, counted in `remote_browser_max_sessions` too),
just with nobody connected over VNC:

- A browser belongs to the credential that opened it (an OAuth app, an API token or a web sign-in); it is counted together with the agent's SSH sessions in
  `ai_max_sessions_per_user`, and idle / lifetime / revocation / lost access / device offline are handled by the `crate::ai` reaper (its rules include the OAuth grant and do not go through the access recheck above; the same triggers also call `ai::recheck` to run it at once).
- presence kind `browser`, client = the app name; it shows on the live sessions page and can be ended there (later actions answer "ended by whom");
  opening and closing write `browser_open` / `browser_close` events, and every action writes an AI audit entry (the text of `browser_type` is recorded as a length only, unless `sensitive: false`).
- Tunnels with step-up always refuse (403 `step_up_refused` / tool error); with the `remote_browser` feature off, opening and actions are not allowed (listing and closing still work).

```
MCP tool (browser_navigate / read / click / type / screenshot) or REST /api/browser/sessions/{id}/…
  → backend ai/browser.rs → remote_browser::RemoteBrowser::cdp
  → session-manager POST /sessions/<id>/cdp (X-Internal-Token)
  → cdp.py → ws://127.0.0.1:<CDP_BASE + display> (chromium --remote-debugging-port, listening only on the container's loopback)
```

- The DevTools port is only on 127.0.0.1 inside the container, and the backend never connects to CDP directly; each action is capped at 30 seconds (`CDP_ACTION_TIMEOUT`).
- Actions: `navigate` (only http / https; the backend also blocks things like `file:` so the container's own files can't be read), `screenshot` (scaled with CDP clip.scale to
  ≤ 1280 px wide), `read` (innerText + links, optionally with a selector), `click` (a selector or visible text; a real mouse event,
  `Input.dispatchMouseEvent`), `type` (focus + `Input.insertText`, can press Enter).
- The tab that is operated = the first ordinary web page in `/json/list`; if all are closed, an `about:blank` is opened.
- `cdp.py` uses only the standard library (with its own minimal WebSocket client); tests are in `tests/test_cdp.py`.

## WS close codes (`/ws/remote-browser/<sid>/`)

| Code | Meaning |
|---|---|
| 4000 / 4001 | First-message authentication failed (format / token) |
| 4007 | The site requires two-step sign-in and this account hasn't set it up |
| 4012 | The `remote_browser` feature is turned off for this person (reason = feature id) |
| 4404 | The session doesn't exist (or isn't ready yet) |
| 4403 | No VIEW on this tunnel |
| 4011 | Cannot reach KasmVNC's websocket on kasm-browser |
| 4013 | Upstream (KasmVNC) closed or could not be written to |
| 4009 | Ended from the live sessions page, or lost access (reason = who / `Telepy (access changed)`) |
| 4010 | This browser's web sign-in was signed out (reason = user / admin / logout / reuse / disabled) |

The frontend `RemoteBrowserPanel` maps 4403 / 4404 / 4011 / 4013 to `browser.*` translations.

## Site settings (Settings → Remote browser)

| key | Default | Description |
|---|---|---|
| `remote_browser_session_idle_timeout` | 60 | How long without a renewal (plus 30s grace) before the session is reclaimed (seconds) |
| `remote_browser_max_sessions` | 10 | Site-wide concurrent limit (including those opened by agents / scripts), 0 = unlimited |
| `remote_browser_geometry` | `1280x720` | Resolution of each browser desktop |
| `remote_browser_ssh_timeout` / `remote_browser_ssh_attempts` | 30 / 2 | Timeout (seconds) and number of attempts for each SOCKS proxy start (names kept from the `ssh -D` days) |
| `remote_browser_kasm_create_timeout` | 30 | Timeout (seconds) waiting for the session-manager to bring up Xkasmvnc + chromium |
| `remote_browser_homepage` / `remote_browser_language` | Google / `zh-TW` | Homepage / language (takes effect the next time a browser is opened; if empty, falls back to the kasm-browser environment variables) |

## Environment variables (all have defaults, usually no need to set)

On the backend: `KASM_BROWSER_API` (default `http://kasm-browser:7000`, the session-manager), `KASM_BROWSER_HOST` (default `kasm-browser`,
used to connect to the KasmVNC websocket), `INTERNAL_API_TOKEN` (the `X-Internal-Token` from backend → session-manager). The kasm-browser container and those shared by both sides:

| Variable | Default | Purpose |
|---|---|---|
| `KASM_WS_USER` / `KASM_WS_PASSWORD` | `telepy` / `telepyvnc` | Basic Auth for the KasmVNC web layer (sent by the backend on connect, created when kasm-browser is built; controlled by the same .env) |
| `KASM_WS_SCHEME` / `KASM_WS_PATH` / `KASM_WS_SUBPROTOCOL` | `ws` / `/websockify` / `binary` | Preferred upstream ws values (the backend relay still falls back to other combinations automatically) |
| `KASM_PASSWORD_FILE` | `/etc/kasmvnc/kasmpasswd` | Fixed path of the password file |
| `REMOTE_BROWSER_HOMEPAGE` / `REMOTE_BROWSER_LANG` | Google / `zh-TW` | Homepage / language (the language affects navigator.languages, i.e. anti-detection) |
| `REMOTE_BROWSER_PROFILE_TMP` / `WS_BASE` | `/tmp` / `8443` | Parent directory of temporary profiles / ws port base |
| `CDP_BASE` / `CDP_ACTION_TIMEOUT` | `9300` / `30` | DevTools port base for MCP agents (port = `CDP_BASE + display`, listening on 127.0.0.1 only) / per-action time limit in seconds |

## Troubleshooting

```bash
# Backend tests (real stack):
(cd src/backend-api && cargo test)   # includes tests/remote_browser_api.rs: end to end with a real device on the SSH lab (in-process SOCKS) + a fake session-manager + a fake KasmVNC ws; tests/socks_e2e.rs tests the SOCKS itself
# session-manager tests (pure stdlib):
cd docker/kasm-browser && python3 -m unittest discover -s tests -p "test_*.py"

# Can't reach the upstream ws? Start a standalone Xkasmvnc + a probe script (it won't be reclaimed like a session):
docker compose exec kasm-browser bash -lc \
  'Xkasmvnc :20 -geometry 1280x720 -depth 24 -SecurityTypes None \
   -KasmPasswordFile /etc/kasmvnc/kasmpasswd -websocketPort 8463 \
   -httpd /usr/share/kasmvnc/www -interface 0.0.0.0 & sleep 3'
docker compose cp dev-scripts/phase0_kasmvnc_probe.py kasm-browser:/tmp/probe.py
docker compose exec kasm-browser python3 /tmp/probe.py --port 8463 \
  --user telepy --password telepyvnc
```

- **Chromium vanishes silently right after starting (SIGTRAP/exit 133, the watchdog respawns it every 30s and it dies again at once)** →
  a packaging bug in Debian chromium 150.0.7871.46 ([#1141488](https://bugs.debian.org/1141488), 2026-07):
  the ungoogled-style patch removed the handling of the `{google:searchSource}` token, but the built-in prepopulated Google
  search template still contains it → expanding it hits `NOTREACHED()` and a silent SIGTRAP (not even a FATAL with `--v=1`).
  What triggers it in this container: **`--no-first-run` + a fresh profile always crashes** (every session has a fresh profile!),
  `--headless=new` crashes too, and so does a user switching the default search back to the built-in Google and then searching. The fix applied (harmless for later
  versions; keep it after a fixed version ships): (1) `DEFAULT_BROWSER_CMD` **drops `--no-first-run`** (measured: the
  Debian build has no first-run wizard, so the flag had zero benefit and was fatal — don't add it back); (2) chromium-policy.json pins the default search to a **clean-template Google**
  with `DefaultSearchProvider*` (using only `{searchTerms}`, bypassing the prepopulated template; it also moves that build's default DuckDuckGo back to Google, and locks
  the user out of switching to the built-in Google entry that crashes — **do not remove this policy set**). Emergency fallback: pin back to
  149.0.7827.196-1~deb12u1 (snapshot.debian.org 20260703T000000Z), but that freezes security updates and is not recommended.
- `404 failed websocket checks` → the `Sec-WebSocket-Origin` header is missing (both the probe and the backend relay already send it).
- `401` → a credentials or password-file problem: check with `ls -l /etc/kasmvnc/kasmpasswd; wc -c` that it is not empty.
- Black screen in the frontend although the ws is up → the client isn't the Kasm fork, or the vendor README's embedding requirements
  (mouseButtonMapper, compositionend reset) weren't done.
- When looking for live processes note that `pgrep -f` matches the cmdline of your own outer shell; use the
  `ps ax | grep "[c]hromium"` bracket trick.
