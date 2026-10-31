# Remote desktop (RDP / VNC / RustDesk in the browser)

<p align="center"><b>English</b> | <a href="./remote-desktop.zh-TW.md">繁體中文</a> | <a href="./remote-desktop.ja.md">日本語</a></p>

> View and control the RDP / VNC desktop of a device (or of a computer on its LAN) in the browser, and reach RustDesk through the tunnel. Nothing is installed on the device: the connection is relayed by the
> device's own sshd, guacd turns RDP / VNC pictures into the Guacamole protocol, and RustDesk is decoded by a RustDesk core running in the browser. Code:
> `src/backend-api/src/desktop/`, `api/desktop.rs`, `ws/desktop.rs` (RustDesk: `rustdesk/`, `api/rustdesk.rs`,
> `ws/rustdesk.rs`); frontend `app/tunnels/desktop/`, `components/desktop/`, `hooks/useDesktopPage.ts`, `lib/desktop.ts`;
> tests `tests/desktop_api.rs`, `tests/rustdesk_api.rs`.
>
> Entry point: `/tunnels/desktop?tunnel=<id>[&lanHost=<id>]` (sidebar, tunnel menu, LAN host panel, the Desktop button in the tunnel list). The form starts with the
> same path-diagram picker as the terminal page (`DesktopPathPicker`: target, protocol, and the port in the last node); below it come quality, clipboard, sound and login.
> The whole feature is governed by the feature permission `remote_desktop` (off = REST answers 403 `feature_disabled`, and the page shows an explanation instead).

## Architecture

```
Browser (guacamole-common-js)
  │ wss /ws/desktop/<session>/?ticket=…&width=&height=&dpi=   subprotocol guacamole; ticket valid 60 s, single use
  ▼
backend ws/desktop.rs
  │  browser→guacd: only key / mouse / touch / size / sync / nop / disconnect / clipboard / blob / end / ack pass
  │  guacd→browser: passed through (lengths re-encoded for each side: guacd counts code points, the browser counts UTF-16 units)
  │  TCP guacd:4822: the Guacamole handshake is done in the backend, credentials never reach the browser
  ▼
guacd container (telepy-desktop internal network, only backend and guacd)
  │  on connect it dials back to this session's own rendezvous port on the backend (accepts only guacd's source IP, closes after one connection)
  ▼
backend desktop/bridge.rs
  │  copy_bidirectional ⇄ russh direct-tcpip channel (a transport lease on the device connection from ssh::pool, takes no session slot)
  ▼
device sshd ──► 127.0.0.1:<port> (the device's own desktop) or <LAN address>:<port> (a LAN host, same mechanism as ssh -J / the LAN scan)
```

## Flow

![The live path of a remote desktop session and the streams on it](images/en/desktop-flow.png)

1. `POST /api/reverse/server/{id}/desktop/start` `{protocol, username?, port?, lan_host_id?, login?, password?, domain?, credential_id?, quality?, clipboard?, audio?}`:
   checks `desktop_enabled`, tunnel VIEW, step-up (sensitive tunnels), that `username` is in `permissions::allowed_usernames` (the account for the hop to the device;
   if omitted, `choose_username` picks the default), that the LAN host belongs to this tunnel, and `desktop_max_sessions`. It then **first** leases a pooled connection and opens a direct-tcpip
   channel to the target, so `device_offline` / `device_auth` / `host_key_changed` / `forwarding_disabled` / `target_unreachable` /
   `device_unreachable` are answered with 502 right here (`desktop_disabled` / `desktop_busy` are 503), without waiting for the WebSocket.
   It returns `{session_id, ws_path, ticket, expires_in, protocol, clipboard, clipboard_limit, quality, audio, target, username}`; credentials stay in memory only.
   `clipboard`: if omitted, the user's personal setting `desktop_clipboard` is used, then capped by the site setting of the same name (the narrower wins); the `clipboard` in the response is the direction actually used.
   With `credential_id`, the login / password / domain of that vault entry are used instead (see "Saved logins" below), and the credential fields in the request are ignored.
2. The browser opens the WS with the ticket. The backend re-checks permissions, opens a rendezvous, connects to guacd and does the handshake (`hostname` / `port` = the rendezvous);
   the connection guacd makes back is attached to the channel from step 1. After the handshake it first sends `0.,<uuid>;` (guacamole-common-js marks the tunnel open only when it receives this),
   then sends the instructions the parser already read during the handshake (guacd often puts `ready` and the first screen updates in the same packet).
3. The relay runs until either side ends. Reasons it ends: the user, guacd, idle (`desktop_session_idle_timeout`, the reaper looks every 10 seconds),
   `POST /api/reverse/server/desktop/{sid}/stop` (4014), ended from the live sessions page, loss of access (4009, see "Audit and visibility"),
   or the web sign-in that opened it being signed out (4010).

## Latency and stream health (`desktop/stats.rs`, frontend `lib/desktopStats.ts`, `components/desktop/DesktopStats.tsx`)

Every second the relay sends the browser two instructions of its own (guacamole-common-js ignores unknown opcodes; the frontend intercepts them before they reach the Client):

| Instruction | Direction | Content |
|---|---|---|
| `telepy-ping <n>` | relay → browser | the browser answers at once with `telepy-pong <n>`; the relay settles the network round trip and **does not forward it to guacd** |
| `telepy-stats <json>` | relay → browser | `{ms, frame_ms, net_ms, tunnel_ms, frames, merged, down, up, behind, audio}` (for `audio` see "Sound") |

- **Frame round trip `frame_ms`**: guacd ends every frame with `sync <ts>`, and the browser echoes `sync <ts>` only after it has drawn that frame; the time from sending to the echo
  = WebSocket round trip + browser decode and paint, which is the "lag" the user feels. With no new sample for 3 seconds it is null (the desktop is still).
- **Network round trip `net_ms`**: ping / pong, without painting; measurable even when the desktop is still.
- **Tunnel `tunnel_ms`**: the device sshd round trip the monitor measures every 15 seconds through the forwarded channel (`StatusState::latency`).
- `frames` = frames in this second; `merged` = how many logical frames one `sync` combined (guacd 1.6's second argument; > 1 = the browser cannot keep up and guacd is merging frames);
  `behind` = frames sent but not yet echoed; `down` / `up` = bytes in this second.
- The toolbar button: signal bars + frame round trip + a status word (streaming / lagging / no data / still; `streamHealth`). Opening it shows the number for each hop,
  the resolution and zoom, and "where the lag mostly comes from" (`laggingHop`: network, tunnel, or a frame round trip far above the network round trip = the browser itself paints slowly).
  The info dialog's path diagram labels the round trip on the two links, and the slowest one is marked yellow.
- The `desktop_close` event now says things like "12.3 MB to the browser, 2,340 frames, frame latency avg 48 ms (max 210 ms)".

## Quality presets (`Quality`, `quality` in start)

| Value | RDP | VNC | Frontend |
|---|---|---|---|
| `auto` (default) | as before (smooth fonts) | no parameters added | — |
| `speed` | `color-depth 16`, no font smoothing | `color-depth 16`, `compress-level 6`, `quality-level 5` | — |
| `sharp` | `color-depth 24`, `force-lossless` | `color-depth 24`, `quality-level 9`, `force-lossless` | — |

The remote desktop preference `desktop_display.quality` lives on the account (Preferences → Remote desktop edits the same value); the start response carries `quality`. `sharp` used to also ask for a HiDPI resolution; HiDPI is now its own switch under Display (next section).

## Display: zoom, resolution, HiDPI (frontend `lib/desktopDisplay.ts`, `lib/desktopZoom.ts`, `hooks/useDesktopZoom.ts`, `components/desktop/DisplayMenu.tsx` / `DisplaySettings.tsx`; backend `desktop::clamp_size`, `browser_size` in `ws/desktop.rs`)

**Why the picture used to be small (measured with OrbStack + a real guacd 1.6 + xrdp / x11vnc / Xvnc, 1440×900 window):**
1. The frame height was `100dvh − 15rem` and the page did not scroll on connect: at 1440×900 that is only about 1150×684, at 1280×800 it is 990×584, and the bottom of the frame sits at y = 815 (outside the window).
2. "Fit into the frame" was capped at 1:1, so a VNC / RustDesk picture smaller than the frame was never enlarged (a 1024×768 VNC screen in a 1540×864 frame stayed 1024×768).
3. With the `sharp` quality, on a HiDPI screen the cap became 1 / devicePixelRatio: on a Retina display an x11vnc 1024×768 picture was drawn at only 512×384 CSS px (measured).
   For RDP it asked xrdp for twice the pixels (2300×1555); xrdp ignores `dpi`, so text came out half as large.
4. The site limit `desktop_max_resolution` clamped width and height separately (3080×1916 under 2560 became 2560×1916, wrong aspect ratio, black borders), and the
   `size` the browser sends during a session never went through the limit at all.
5. The zoom buttons existed only on touch devices.

**Now:** the preferences live on the account (the personal setting `desktop_display`, one JSON object: `scale` / `percent` / `resolution` / `width` / `height` / `hidpi` / `vnc_resize` / `quality` / `audio`;
checked by the backend's `desktop::display::parse`; an unknown field or an out-of-range value = field error, percent clamped to 25–400; empty = never chosen. The localStorage key `telepy.desktopDisplay` is only a cache for the first paint;
at sign-in the account's value wins if it has one, otherwise this browser's value (including the old `telepy.desktopQuality` / `telepy.desktopAudio`) is uploaded).
Preferences → Remote desktop → Display, the Display field of the connect form, and the Display menu in the desktop page's toolbar all read and write the same one:
- Zoom: `fit` (fit into the frame, small pictures are enlarged too; default) / `shrink` (only shrinks, never enlarges = the old behaviour) / `actual` (1:1, one device pixel when HiDPI; move the mouse to the edge to scroll, drag with two fingers) /
  `custom` (25–400 %). Modes are sticky: when the window grows or shrinks, fit fits again and 1:1 stays; the toolbar − / % / + and pinch switch to a fixed scale.
- RDP resolution: follow the window (default, `resize-method display-update`, `size` is sent only after the frame has stayed put for 400 ms) or fixed (1280×720, 1600×900, 1920×1080, 2560×1440, custom).
  Fixed sends `resize: false` in start: guacd gets no resize-method and the relay drops the browser's `size`.
- HiDPI: asks for devicePixelRatio (≤ 2) times the pixels plus `dpi`; off by default. Toggling it or changing the resolution during a session immediately sends a new `size` for sessions that follow the window.
- VNC following the window (off by default): start with `resize: true` omits `disable-display-resize`, and guacd 1.6 asks the server to resize with SetDesktopSize
  (once at connect, then on every `size`); only virtual desktops (TigerVNC Xvnc, KasmVNC) comply, real screens (x11vnc, macOS Screen Sharing, most Windows servers)
  keep their resolution. It is off by default because changing the screen resolution of a real machine is not what the user asked for. guacd 1.6's VNC sends an initial size by default, so in the past this already resized Xvnc.
- RustDesk: the remote decides the resolution and the browser only scales; the web core's `change_resolution` is not implemented (`setByName change_resolution not implemented (phase 2)`).
  **Possible later:** like the files panel's `ReadEmptyDirs`, build a `Misc.change_resolution` ourselves and send it on the WebSocket the core tracks (RustDesk's Windows / Linux X11 side supports changing resolution),
  so RustDesk could follow the window too.
- "Fill the browser window": the card is `fixed inset-0` and covers the sidebar and the page header (this is not fullscreen; Esc still goes to the remote), and "Back to the page" in the toolbar leaves it.
- The frame height is now `100dvh − 8.5rem`, and on connect the card scrolls to just below the page header.
- Limit: `clamp_size` scales proportionally so the longer side = `desktop_max_resolution`; the handshake and every `size` during the session go through it (before, only the handshake was clamped, and each side separately). Start returns `resize` and `max_resolution`.

Measured (same setup, new frame height): RDP following the window 1116×764 (1440) → 1534×944 (1920) → 958×664 (1280) → fill 1280×751 → 958×664 (`xdpyinfo`);
HiDPI on Retina 2236×1528, and at a 1920 window 2560×1575 (proportional clamp), turning HiDPI off mid-session → 1534×944; fixed 1600×900 does not follow the window and the browser scales it to 70 % / 60 %;
Xvnc when asked to follow 1280×800 → 1118×764 → 958×664, when not asked it stays and the browser enlarges to 115 % / 142 %; x11vnc 1024×768 on Retina is drawn by default at
1019×764 (before, 512×384), and at 1:1 → 125 % moving the mouse to the right edge scrolls right.
Tests: `tests/desktop_api.rs` `desktop_resolution_follows_the_window_within_the_site_limit`; unit tests `clamp_size`, `browser_size`,
`lib/desktopZoom.test.ts`, `lib/desktopDisplay.test.ts`.

## Clipboard direction (each person chooses, the site setting is the ceiling)

- Three directions: `both` / `to_remote` (paste into the remote only) / `off`. The personal setting `desktop_clipboard` lives on the account
  (`/api/user/settings`; the same response carries the read-only `desktop_clipboard_limit` = the site setting), and can be changed in the desktop page's Clipboard field and in
  Preferences → Remote desktop (`hooks/useDesktopClipboard.ts`, one store shared by both). Options above the ceiling are disabled in the UI.
- Every start (RDP / VNC, RustDesk) may carry `clipboard` to override for that session; without it the personal setting is used. What applies is the narrower of it and the site `desktop_clipboard`
  (`desktop::Clipboard::within` / `effective`, frontend `clipboardWithin` in `lib/desktop.ts`), and the `clipboard` in the response is the actual value.
- Who enforces it: guacd with `disable-copy` / `disable-paste`; the backend cannot see RustDesk's stream, so the core in the browser applies it (off = that peer's
  `disable-clipboard`, to_remote = remote clipboard events are not accepted). Test `desktop_clipboard_is_the_users_choice_within_the_site_limit`.

## Sound (RDP through guacd; RustDesk in the next section)

- The Sound switch in the form (only RDP and RustDesk have it; guacd's VNC has no sound, since that would need a separate PulseAudio, which the device does not have, so VNC does not
  show it; the VNC protocol itself carries only picture and input. macOS "Screen Sharing" is VNC, so to hear a Mac use RustDesk) is stored in
  `desktop_display.audio` on the account (**off by default**: sound costs bandwidth; Preferences → Remote desktop edits the same value).
- RDP: `POST …/desktop/start` takes `audio: true` (VNC treats it as false even if sent; a non-boolean = field error) and the response carries `audio` (the value in effect).
  On: the handshake's `audio` instruction lists `audio/L8` and `audio/L16` (the raw PCM that guacamole-common-js's RawAudioPlayer can play),
  and guacd opens an audio stream (`audio` / `blob` / `end`). guacd → browser is passed through unchanged as before; the browser → guacd allowlist includes `ack` (accepting the stream),
  while an `audio` from the browser (= a microphone) is still dropped. Off: the connection parameter `disable-audio=true`, guacd does not load rdpsnd and the remote does not send anything at all.
  The `desktop_open` event says `Remote desktop (RDP, sound) …`.
- The sound button in the toolbar (`components/desktop/SoundButton.tsx`): muting drops the blobs in the browser (so unmuting does not release a flood at once).
  Its icon and text follow `lib/desktopSound.ts`: **playing**, **quiet** (channel open but silent), **waiting for the remote** (just connected),
  **sound blocked** (data arrived but the AudioContext is not running; an extra "Click to enable sound" button appears beside it), **no sound** (10 seconds after connecting the remote has still
  not opened a sound channel), muted, off. The tooltip and the sound line under "What travels on this connection" in the info dialog explain why.
- **Autoplay (the fix for "I turned sound on but hear nothing")**: browsers let an AudioContext make sound only if it was created or resumed inside a user gesture
  (Safari is strictest: a context created outside a gesture is always `suspended`). The guacamole-common-js player creates its context only when guacd opens the audio stream
  (inside a WebSocket message, no gesture), and used to resume it only on a click / key press on the picture, so someone who only watched never got sound, and
  the old "playing" state only checked whether blobs had arrived, so it said playing even while the context was blocked. Now the click on "Connect" (before the first await)
  runs `primeAudio()`, which creates and resumes one shared context and hands it to guacd as `Guacamole.AudioContextFactory.singleton`; the RustDesk core gets the same one through
  `installRustDeskTap`. When blocked, the state honestly says "sound blocked".
- The relay counts the audio stream volume (`desktop/stats.rs`: `blob` on the `audio` streams guacd opens): `telepy-stats` carries `audio` (null if no sound stream was ever opened),
  the stats panel gets a "Sound data" row, and the `desktop_close` event says `sound 1.2 MB`, or `no sound channel from the RDP server` when sound was requested but no channel opened (so Logs shows the remote is not sending).
- On the remote end: a Windows RDP host redirects sound by default unless a policy turns it off ("Allow audio and video playback redirection"); Linux xrdp needs
  `pulseaudio-module-xrdp` (not packaged for Debian / Ubuntu; build it from source following its instructions) or `pipewire-module-xrdp`, otherwise guacd gets no sound.
- Measured (OrbStack): a real guacd 1.6 + xrdp + a self-built pulseaudio-module-xrdp, with `module-sine` playing 440 Hz in the session:
  Chromium (`--autoplay-policy=document-user-activation-required`) and WebKit both queued non-silent buffers (peak 0.5) with the context
  `running`; the context WebKit created inside the click was `suspended` and only `primeAudio`'s resume got it going. Suspending the context → the button became "sound blocked"
  → clicking "Click to enable sound" → playing again. The test is `desktop_rdp_sound_is_offered_and_relayed` in `tests/desktop_api.rs` (a fake guacd
  checks the handshake format, `disable-audio`, stream pass-through, the microphone being blocked, and the sound amount and "no sound channel" in the close event).

## Multiple monitors: viewing one screen (`desktop/screens.rs`, `GET …/desktop/screens`, frontend `lib/desktopScreens.ts`)

A VNC server sends all monitors stitched into one big picture (macOS Screen Sharing, x11vnc and TightVNC all do), and guacd has no parameter for choosing a screen, so
"pick a screen" is a **crop in the browser**: the viewer's `viewport` moves the Guacamole.Display element into a clipping frame (coordinates stay those of the whole picture, so mouse
positions are unchanged). Where each screen sits inside that picture:

1. `GET /api/reverse/server/{id}/desktop/screens?username=` (the same gate as start: VIEW + allowed device account + step-up) asks the device through the pool:
   `uname -s` → on Darwin run `system_profiler SPDisplaysDataType -json` (sizes only, no positions); other POSIX run
   `xrandr --listmonitors` (trying `$DISPLAY`, `:0`, `:1`); with no `uname`, run PowerShell `[System.Windows.Forms.Screen]::AllScreens`.
   It returns `{os, source, screens: [{name, x, y, width, height, primary}], username}`; failing to find out is not an error (`screens: []`).
   It only makes sense when "the desktop is the device itself" (a LAN host has no SSH to ask). The parsers are pure functions (unit tests).
2. The frontend's `screenChoices`: screens with positions are shifted to (0,0), and if the total differs from the picture size but has the same aspect ratio it is scaled proportionally (Windows DPI scaling);
   size-only reports (macOS) infer the layout from the whole picture: widths summing to the picture width = side by side, heights summing to the picture height = stacked, and when the heights differ,
   the black regions of the picture are sampled to decide whether a screen sits at the top or bottom edge (`isBlack` reads the canvas); when the device reports nothing (LAN host, detection failed, Xvfb reporting one
   screen covering everything) **`guessScreens` guesses from the shape**: screens come in only a few aspect ratios (`SCREEN_RATIOS`: 16:9, 16:10, MacBook ≈1.545, 3:2,
   4:3, 5:4, 21:9), so it splits the picture width into 2–4 equal-height screens of common ratios (or the height into stacked ones) with total error ≤ 0.5%, preferring the closest fit, then equal ratios,
   then fewer screens; when the ratios differ it cannot tell which is left or right, so it tries every order, and uses the black regions to correct a screen shorter than the picture (`refineHeight`: measure the non-black extent in 9 columns
   across that span, and accept it only if all agree and the measured height together with the width makes a common ratio, so a black wallpaper does not fool it), and finally picks the layout whose ratios are the most common.
   When no equal-height combination fits (a MacBook 1728×1117 + 2560×1440), it tries "one equal-height + one shorter" and measures the shorter one with the black regions.
   A picture with a single common ratio (21:9 ultrawide included) is one screen and is not guessed at; 3840×1080 is treated as two 16:9. Guessed entries are marked "Guessed from the picture's shape" in the menu.
   If nothing can be worked out, the menu still offers even splits and drawing an area.
3. The toolbar "Screen" menu (VNC only): the whole desktop + each detected screen (name, size, primary) + **even splits** (left / right half,
   thirds, top / bottom half, `splitChoices`, independent of detection and always available) + a **custom area** ("Select an area…" enters selection mode: the viewer shows
   the whole picture with an `AreaSelector` overlay; drag a rectangle → `rectFromPoints` clamps it into the picture, minimum 64px; Esc or "Cancel" gives up; while selecting,
   keyboard and mouse are not sent to the remote) + detect again. The choice is remembered in localStorage `telepy.desktopScreen.<tunnel>.<lanHost|device>`, and
   a custom area in `telepy.desktopArea.<…>` (JSON, validated by `parseStoredArea` once the picture size is known). Detection runs once automatically on connect.

RDP does not need this: the size of an RDP session is decided by us (the browser's frame) and there is only one virtual screen.

## Touch zoom (`lib/desktopZoom.ts` pure + tests, `hooks/useDesktopZoom.ts`, `components/desktop/ZoomControl.tsx`)

Both picture components (guacd's `DesktopViewer` and `RustDeskViewer`) lay out through `useDesktopZoom().layout()`: a multiplier on top of the "fit into the frame" scale;
whatever sticks out of the frame is clipped by the frame and viewed by panning.

- Pinch with two fingers to zoom, drag with two fingers to pan; one finger is still the remote mouse (tap = click, long-press = right click).
- On touch devices (`pointer: coarse`) there is a small −  / zoom / + pill at the top right (tapping the zoom value = back to fit); the zoom stops at `ZOOM_STEPS`, with an upper limit of at least 4×.
- On phones (`(pointer: coarse) and (max-width: 639px)`), when the picture is shrunk (VNC / RustDesk with a fixed resolution) it opens at `PHONE_ZOOM`
  (1.5×, starting from the top-left corner) so the remote text is readable; RDP's resolution follows the frame and is not enlarged. It is re-applied for a new connection, when switching screen / area, and when the resolution changes.
- A browser with only a mouse sees no difference.

## RustDesk (in the browser, or forwarded through the tunnel to a native client)

RustDesk speaks its own protocol, which guacd does not understand. Telepy has two paths, **both through the tunnel**; when the desktop page's protocol is "RustDesk" the first one is the default:

> History: a mode where "Telepy acts as RustDesk's ID / relay server" (devices need no tunnel) was built in #201–#208 and removed again in #212, leaving only the through-the-tunnel path
> (terminal, files, sharing, live sessions, recording and the other features all take the same road). The research notes are in [`rustdesk-id-server.md`](engineering/rustdesk-id-server.md);
> the data migration `2026-10-26-drop-rustdesk-server-devices` deleted the logins and two tables it stored.

### Connecting in the browser (`rustdesk/`, `api/rustdesk.rs`, `ws/rustdesk.rs`; frontend `components/desktop/RustDeskViewer.tsx`, `lib/rustdesk.ts`)

The core of RustDesk's web client (a community TypeScript port, AGPL-3.0, vendored in `src/frontend/public/vendor/rustdesk-web-core/`,
with its source and version recorded in the `README.md` beside it) runs in the browser: it decodes video (WebCodecs), answers the password challenge, and sends keys and mouse. Telepy **does not run hbbs / hbbr**:
the core thinks it is connecting to an ID server and a relay, but both connections go to the same WebSocket; the backend looks at the first message to decide the role, then
re-frames the relay one into RustDesk's TCP wire format and attaches it to a `direct-tcpip` channel to the device's Direct IP port (21118). The research notes and measurements are in
[`rustdesk-spike.md`](engineering/rustdesk-spike.md) (1280×800 high motion: the core through the relay 28 fps / ~645 KB/s, guacd VNC 4–5 fps / 0.5–1.3 MB/s).

- `POST /api/reverse/server/{id}/rustdesk/start` (`{username?, port?, lan_host_id?, credential_id?, clipboard?}`; the same gate as desktop:
  `desktop_enabled`, VIEW, step-up, `choose_username` / `allowed_usernames`, and `desktop_max_sessions` counts guacd + RustDesk together):
  first `desktop::prepare` — a pool lease + a `direct-tcpip` to the target's Direct IP port already open (`device_offline` / `target_unreachable` … are
  502 right here) — then a 60-second single-use ticket: `{session_id, ws_path: "/ws/rustdesk/{sid}/", ticket, expires_in, target, username, clipboard,
  clipboard_limit, file_transfer}` (with `credential_id` there is one more field, `password`; see saved logins).
  **The password never goes through the backend**: the permanent password is handed only to the core in the browser, which answers RustDesk's hash challenge; Telepy only relays.
- `/ws/rustdesk/{sid}/?ticket=`: the core connects twice (both `custom-rendezvous-server` and `relay-server` are set to this URL). The first binary
  message is a `RendezvousMessage`: `punch_hole_request` (field 8) = the hbbs role, to which the backend answers `relay_response` (field 19: uuid + relay_server =
  the same URL) and then just waits, answering again for each further punch; `request_relay` (field 18) = the relay role, which takes over the channel `prepare` set up, after which every binary
  WS message → `codec::encode_frame` (1–4 byte LE prefix, low 2 bits = prefix length − 1) → channel; bytes from the channel → `decode_frame`
  (limit 16 MiB) → one message each. Presence kind `rustdesk`, gateway events `rustdesk_open` / `rustdesk_close` (with duration, reason and
  the byte counts in both directions). Close codes: 4404 ticket invalid / expired, 4403 refused by permissions or the login guard, 4013 closed by the device, 4014 stopped by the server (`POST
  /api/reverse/server/rustdesk/{sid}/stop`; a files session also has "the screen session ended", "the site turned file transfer off" and "replaced by a newer one"), 4400 protocol error,
  4009 ended from the live sessions page or access lost, 4010 the web sign-in that opened it was signed out. RustDesk has no idle disconnect (`desktop_session_idle_timeout` covers guacd only).
- Frontend (desktop page): the form gains a "RustDesk password" field (it stays in the browser) and the main button is "Connect in the browser". `RustDeskViewer` loads the core (only one per page,
  because the core is a global on window), sets the two server options = `rustdeskWsUrl()`, calls `session_add_sync` + `session_start`,
  automatically confirms the "unencrypted direct connection" msgbox (the tunnel itself is encrypted), and draws `onVideoFrame` onto a canvas (scaled down proportionally, never up). Keyboard focus is in a hidden
  textarea (IME composition → `input_string`; key presses → `input_key`, with the key-name table in `lib/rustdesk.ts`), mouse coordinates are divided by the zoom factor, and the cursor is turned from
  `cursor_data` into a CSS cursor. Toolbar: a latency / stream button (fed by the core's `update_quality_status`: latency, fps, target bitrate),
  a Screen menu (the peer's `peer_info` displays → `switch_display`, RustDesk's native screen switching; quality best / balanced / low maps to Telepy's
  three presets), a Keyboard menu (type text, Ctrl+Alt+Del), fullscreen, help and disconnect. The info path diagram uses the `inBrowser` variant (three steps).
  Clipboard: the core itself reads the browser clipboard while the tab has focus and sends it; text copied on the remote is shown below the toolbar.
- **Setup checklist ("Get that computer's RustDesk ready", `components/desktop/RustDeskSetup.tsx`, pure `lib/rustdeskSetup.ts` + tests)**:
  as soon as RustDesk mode opens (or the target changes) it probes the Direct IP port from the device once. The checklist has four steps, each with a state and a flat little window mock-up (using RustDesk's own
  translated labels and marking where to click): ① RustDesk is open and "Enable direct IP access" is on (Settings → Security → Unlock security settings; a refused probe =
  `desktop.err.rdDirectIpOff`) ② a permanent password, and the password setting is not "Use one-time password" (a connect that answers `rdPassword` = failed) ③ on macOS, Screen Recording /
  Accessibility (`rdNoDisplay` = failed) ④ the system service (cannot be seen, only a reminder: without it, closing the app or rebooting makes the machine unreachable). Having connected in this page visit = the first three
  steps are fine and the checklist folds to one line. Only "the step to look at now" (the first failed one, otherwise the first still unknown one) expands its mock-up; the others are one line each, with "Show where" to click.
  Origin: a Mac mini had RustDesk open but IP direct access unchecked and the password setting on "only one-time password", and the page only said nothing was detected.
- Saved logins: the RustDesk password can be stored too (`protocol: rustdesk`); the form has a "Saved login" select and "Save this login". When start carries
  `credential_id` the backend decrypts it and puts it in the response for the core (see the Saved logins section); the `rustdesk_open` event notes with saved login '<label>'.
  Stats: the tunnel segment is filled in from the monitor's latency (read once from the dashboard at connect, then following `UPDATE-TUNNEL-LATENCY`); the panel does not show frame round trip /
  frames behind (the core decodes in the browser, so those two numbers do not exist), and "network round trip" is the browser ↔ device figure the core measures itself.
- Scope: picture, mouse and keyboard, clipboard text, switching screens, quality, **sound**, **file transfer**. No terminal, remote printing or microphone — for those use the app path below.
- **Sound**: the core decodes it itself (RustDesk sends Opus; WebCodecs `AudioDecoder` → `AudioContext`; a browser without WebCodecs audio has no sound,
  and the button is disabled with an explanation). Off = that peer's `disable-audio`: the login `OptionMessage` asks the device not to send it (the device does not start its audio service, which is more than muting);
  switching during a session from the toolbar goes through the core's `option:toggle` (sends the option to the device and mutes / unmutes). It shares `desktop_display.audio` on the account with RDP.
  What the device sends (from the RustDesk 1.5 source): **Linux** records the PulseAudio / PipeWire monitor, handled by the connection manager
  (`--cm`) process of the signed-in desktop session — no one signed in to the desktop means no sound; **Windows** records the WASAPI loopback of the default output; **macOS (Apple silicon)** records system sound through
  ScreenCaptureKit (using the "Screen Recording" permission it needs anyway); **macOS (Intel)** records only the "audio input device" (by default the
  microphone), so to hear what the Mac plays you need to install a loopback device such as BlackHole and pick it in RustDesk Settings → General → Audio input device. When sound is on and
  the last peer connected was a Mac, the checklist gains a "Sound from a Mac" step (with a mock-up of RustDesk's settings).
  Measured: RustDesk 1.5 for Linux in a container (a PulseAudio null sink + 440 Hz), with a fake `loginctl` and `sudo` added so it could start the connection manager,
  Chromium and WebKit both played non-silent Opus-decoded output; switching from off to on during a session also produced sound. The core's AudioContext is the one unlocked inside the click.
- **File transfer (the "Files" panel, `components/desktop/RustDeskFiles.tsx`, pure `lib/rustdeskFiles.ts`)**: RustDesk transfers files on a **separate
  connection** (the login carries `file_transfer`), so the panel asks `POST /api/reverse/server/rustdesk/{sid}/files` for a
  child session under the screen session (`rustdesk::Kind::Files`: same target, same account, its own ticket and direct-tcpip channel; only the person who opened the screen can open it; it does not count toward
  `desktop_max_sessions`, has no presence of its own and sends no webhook; at most two per screen, and opening another closes the oldest — a reload or React dev mode's
  double effect overlaps briefly; it ends together with the screen session). Error codes: 409 `not_connected`, 503 `file_transfer_disabled` /
  `desktop_disabled`, 502 as in start. The site setting `desktop_file_transfer` (default on) off → no child sessions, start answers
  `file_transfer: false` (the button is disabled with an explanation), and the reaper closes the open ones.
  - Why a second core: the core is a global on window, and inside one core only the "top" session gets video (`videoFrame` /
    `rgba` go only to the top one); opening the files session in the screen's core freezes the remote picture. So the panel loads a second copy of the core in a hidden same-origin iframe.
  - It uses the core's own file API: `read_remote_dir` (asked for once after login, an empty path = the home folder), `send_files {is_remote: true}` (download),
    `select_files` + `send_local_files` (upload), `confirm_override_file`, `cancel_job`; events `file_dir`, `job_progress`,
    `job_done`, `job_error`, `update_folder_files`, `override_file_confirm`, `selected_files`.
  - Dialogs need the user's gesture: the save dialog (`showSaveFilePicker`) is opened in this page's click and the handle is swapped into the iframe's core; file picking uses this page's
    `<input type=file>` (drag and drop works too), and the `click()` of the input the core creates inside the iframe is replaced by "put in the files already chosen in this page". Browsers without a save dialog
    (Firefox / Safari) have the core keep everything in memory and then download it, so each file is ≤ 2 GB (uploads have the same limit).
  - The panel: breadcrumbs (on Windows the top level = the drives), up one level, home folder, hidden files, new folder, upload folder, upload, a download button and a "⋯" menu on each row
    (download / rename / delete), multi-select to delete together, and a transfer list (progress, speed, cancel, "Skip / Replace" on a name clash, showing only the latest 4 with running ones first).
    On desktop widths it sits to the right of the picture (`lg:w-80`), on phones below it.
  - **Downloading a whole folder as a .zip** (pure `lib/rustdeskFileOps.ts`, `lib/zipStream.ts`; the zip is built with client-zip (MIT, streaming + ZIP64)):
    click download → save dialog (must be opened in the click) → `read_dir_to_remove_recursive` (= `ReadAllFiles`; the answer is a `file_dir` carrying an id, names are
    relative paths) to count files and size → ask again for empty folders (`ReadEmptyDirs`: a call the core handles the answer to (the `empty_dirs` event) but never sends; the panel
    builds this message itself and sends it on the iframe's WebSocket; older RustDesk does not answer, and after 4 seconds it counts as none) → over 500 files or 2 GB it asks first in the transfer list →
    `send_files {is_dir: true}`: the core asks `showDirectoryPicker()` for a folder handle and then calls `getFileHandle().createWritable()` per file; the panel substitutes
    a fake handle (`zipDirectoryHandle`), each file's content streams into the zip chunk by chunk, and the zip is streamed into the .zip the user picked; browsers without a save dialog collect it
    in memory (≤ 2 GB, refused up front). The core never opens a handle for a 0-byte file, so after it finishes the empty files and empty folders are added from the listing. Progress = which file / total + bytes.
  - **Delete**: files = `remove_file`; folders = first a recursive listing (hidden files included), a confirmation naming the folder and how many files and how large, then
    `remove_file` one by one (reusing the listing's id) and finally `remove_all_empty_dirs` (RustDesk only deletes "empty" trees). Multi-select is possible. **Rename** (`rename_file`):
    the device appends `new_name` to the original parent folder, so typing `../x/name` or an absolute path is a move within the same disk (the dialog shows the resulting path live,
    and when the folder changes the button becomes "Move"). **New folder** (`create_dir`). **Upload folder** (`webkitdirectory` or dragging in a folder; drag and drop keeps empty folders):
    the folders are created first in order ("already exists" is not an error) and then the files are uploaded. Each action waits for the device's `job_done` / `job_error` for that id, and an error shows the device's message verbatim.
  - **Audit (`rustdesk/file_audit.rs`, pure + unit tests)**: the relay sees the plaintext of the files session (encryption is refused), so it reads the browser's
    `file_action` (`ReadAllFiles` / `RemoveFile` / `RemoveDir` / `Rename`) and the device's `done` / `error`, and writes `rustdesk_file_delete`
    / `rustdesk_file_rename` events (paths and counts only, no content): deleting a folder is merged into one entry ("deleted folder /x (12 files)", with the count and the first error appended on failure),
    single files and renames get one entry each after the device answers, and anything still unanswered when the session ends is written out too.
  - Explainer diagram: the panel's info button (`RustDeskFilesFlow.tsx`) draws your browser (the second core) ─ Telepy relay ─ tunnel ─ RustDesk on the device ─ disk,
    lit by phase and by the action in progress, with the state of the four actions below; the page's streams diagram also lists the download / upload / rename / delete states under its Files row.
- **Login guard (`rustdesk::codec::LoginGuard`)**: the only thing the relay parses is the outermost layer of the browser → device peer `Message`:
  the oneof branch of `login_request` (field 7) decides what this connection logs in as (remote control / file transfer / port forwarding / camera / terminal). A screen session may only do remote control,
  a files session only file transfer; anything else → 4403, and the `rustdesk_close` event says `refused: a file transfer login on a remote control session`.
  A `public_key` with content (field 4, = asking for encryption) is refused too: Telepy's fake hbbs never hands out the device's key, our core always uses unencrypted Direct IP
  (the whole thing is inside TLS + SSH), so only a modified client would encrypt, and once encrypted we could no longer see what it logs in as. More than 32 messages before login are refused as well.
  A `file_action` / `file_response` on a screen session (the core's file API only uses the file-transfer connection, so only a modified client would send these) is also refused.
  So the site setting `desktop_file_transfer` is enforced by the server, not just by hiding a button.
- Measured (OrbStack: Debian + RustDesk 1.5.0): opening "Files" while a screen session is open, the remote picture keeps updating; the RustDesk in the container has no
  connection manager UI (Linux file operations and audio capture are left to it), so file transfer was verified through a test front proxy (remote control forwarded as is, file transfer served by the proxy):
  listing, downloading a text file and a 3 MB binary (same md5), upload, replacing on name clash, the streams diagram, no horizontal scroll at phone width. The later folder / delete / rename work
  was verified with the same proxy (plus `ReadAllFiles`, `ReadEmptyDirs`, multi-file `send`, `remove_*`, `create`, `rename`): folder zip (both the streaming
  and the in-memory path, empty folders and 0-byte files present, same md5), 501 files asking first, rename and `../` move, new folder, upload folder, multi-select delete
  (the confirmation counts hidden files), device errors shown verbatim, the two kinds of events in Logs. Sound: with it on the device enters the audio
  service, with it off at login it does not, and switching it off mid-session makes it leave (real sound is under "Sound" above).
- A pitfall: the core's `confirmInsecure()` fires the msgbox event synchronously and **only afterwards** records the resolver that waits for the answer, so answering
  `continue-insecure-connection` synchronously inside the event handler is dropped (the connection hangs, the device side closes after 30 seconds, and the relay stats show "0 B to the device") — the viewer
  answers in the next tick with `setTimeout(…, 0)`. When RustDesk on the device runs in the C locale (no `LANG`), xdo refuses multibyte text (log
  `Invalid multi-byte sequence encountered`) and Chinese in `input_string` cannot be typed — that is the device's environment, not Telepy.
- Measured (Debian + RustDesk 1.5.0 + Xvfb in OrbStack, headless Chrome): connected in < 1 s, clicks / wheel / movement landed on the device at exactly
  the right coordinates (`xev`), typing reached xterm, the live sessions page listed `rustdesk`, and Logs had two events. (This browser-side E2E script is not in the
  repo; what is in the repo is the fake-device test in `tests/rustdesk_api.rs`.)

### Using the RustDesk app (port forwarding)

The "Prefer the RustDesk app?" section on the desktop page expands to forward the device's **Direct IP Access** (TCP 21118) to the user's computer, where the app connects to `127.0.0.1`.
Switching between multiple screens, file transfer and sound are all RustDesk's own features.

- "Check from the device" (`GET /api/reverse/server/{id}/desktop/probe?port=&username=&lan_host_id=`: the same gate and path as start —
  a pool lease + a direct-tcpip channel, closed at once when it connects; it does not look at `desktop_enabled`; error codes as in start) → `ssh -L 21118:<host>:21118 <alias>`
  (the `rustdesk` recipe of the command sheet, the alias coming from `/tunnels/server/config/{id}`) → in the app, type `127.0.0.1` as the ID (`127.0.0.1:<port>` if the local port is not 21118).
  After a probe, when no browser connection is active, the info path diagram shows this route (your computer ─ssh─ Telepy ─tunnel─ device ─ RustDesk).
- The command sheet has a "Use RustDesk" scenario (`-L`, fields: host `localhost` = the device itself, RustDesk port, local port); the LAN scan probes
  21118 by default, `lib/lanConnect.ts` shows it as RustDesk, and the Network page's Commands tab lists its `-L` too.

## Input methods (IME) and cross-OS keyboards

- The picture puts keyboard focus on the hidden textarea of a `Guacamole.InputSink` rather than a div: an input method only composes in editable elements, so a Windows browser
  can type Chinese or Japanese into a macOS / Linux VNC too (composed text is sent as the Unicode keysym `0x01000000 + codepoint`; RDP turns it into a unicode keyboard
  event, VNC sends the keysym directly, and macOS Screen Sharing, x11vnc, TigerVNC and TightVNC all accept it).
- "Keyboard → Type text…": type with your own input method in a dialog, and each character is sent as one key press (8 ms between characters; a newline = Enter). This is the fallback for when the remote desktop
  still ignores composed text; as a last resort there is also "Paste" (sent to the remote clipboard).
- "Send Ctrl as ⌘ Command": Control_L/R → Meta_L/R (Command). On by default when the device is detected as Darwin and the browser is not a Mac (`telepy.desktopCtrlAsCmd`
  = auto / on / off); it remembers the keysym actually sent on key down and uses the same one on release, so switching midway never leaves a modifier stuck.

## Close codes

When the WebSocket closes, the code is also put in the reason (guacamole-common-js's WebSocketTunnel takes `parseInt(reason)` as the status code;
a custom code itself would be turned into a generic SERVER_ERROR).

| Code | Meaning |
|---|---|
| 4404 | session / ticket invalid or expired |
| 4403 | access is gone (VIEW or the device account) |
| 4011 | guacd unreachable or the handshake failed |
| 4013 | guacd disconnected or sent a bad instruction |
| 4014 | ended by the server (idle, `…/desktop/{sid}/stop`) |
| 4400 | the browser sent an instruction that could not be parsed |
| 4009 | ended from the live sessions page (reason = who), or access lost (reason = `Telepy (access changed)`) |
| 4010 | the web sign-in that opened it was signed out ("this browser has been signed out"; reason = user / admin / logout / reuse / disabled) |

The table above is for the guacd path (`/ws/desktop/`); for RustDesk (`/ws/rustdesk/`) see the RustDesk section above. Neither socket has an auth frame
(a one-time `?ticket=`), and the feature permission and step-up are already enforced at the REST start, so 4012 / 4008 never appear.

guacd's own errors reach the browser as Guacamole `error` instructions (for example 0x0203 / 0x0301 = RDP login refused),
and `sessionFailure` in the frontend's `lib/desktop.ts` maps them to a translation and to "which hop it got stuck on".

## Saved logins (credential vault)

`vault.rs`, `db/credentials.rs`, `api/credentials.rs`; tests `tests/credentials_api.rs` and the vault part of `tests/desktop_api.rs`.

- Each user's own: `GET /api/credentials` (filter with `tunnel_id` / `lan_host_id` / `protocol`), `POST`,
  `PATCH /api/credentials/{id}`, `DELETE`. Only the owner can see or use them; admins are no exception.
- Each entry is bound to one desktop: `protocol` (`rdp` / `vnc` / `rustdesk`) + `tunnel_id` + an optional `lan_host_id` / `port`, plus `label`, `login`, `domain`
  (RustDesk has only a permanent password, so `login` is left empty). The same vault also stores `ssh` rows (the login for the LAN host hop on the Network page: a password and / or a private key),
  which belong to the terminal and are outside the scope of this document.
  If the `credential_id` passed to `start` is not for the same target (tunnel, LAN host, protocol) it answers a `credential_id` field error,
  so a Windows password is never used to log in to another machine.
- Passwords are sealed with AES-256-GCM using a key derived from `SECRET_KEY` (prefix `telepy-vault-v1:`), with AAD =
  `telepy-credential:{user_id}:{id}`: moving the ciphertext to another person or another entry makes it undecryptable. The API returns only `has_password` (`ssh` rows also have `has_key`) and never the password;
  decryption happens only at `start`, and the result stays in session memory just like a typed one. Rotating `SECRET_KEY` makes old entries undecryptable (save them again).
  **RustDesk is the only exception**: the challenge response is made by the core in the browser, and the backend cannot answer for it, so when `POST …/rustdesk/start` carries `credential_id`
  the backend decrypts it and puts it in the response's `password` (only this once, over TLS, not logged), and the frontend hands it to the core without keeping it in page state.
- When a tunnel or LAN host is deleted, the credentials bound to it go too. `last_used_at` is updated on use; the `desktop_open` event notes
  "with saved login '<label>'" (the name only, no credentials).
- Frontend: the desktop page's "Saved login" select (`hooks/useSavedLogins.ts`) and the "Save this login" checkbox (saved before connecting, then connecting with
  `credential_id`); the Saved logins tab in Preferences (`components/layout/SavedLogins.tsx`) lists and deletes them.
  Adding or deleting in either place fires `telepy:saved-logins-changed`, and the other views reload.

## Audit and visibility

- The gateway events `desktop_open` / `desktop_close` (with duration, end reason, stream summary and guacd's last error), `rustdesk_open` /
  `rustdesk_close` (with byte counts in both directions) and `rustdesk_file_delete` / `rustdesk_file_rename` appear in that tunnel's Logs.
- Presence kinds `desktop` / `rustdesk` (carrying the device account used to log in): owners / ADMIN see who has one open under "N using" in the tunnel list,
  and the live sessions page (`/tunnels/sessions`, for admins `/tunnels/admin/sessions`) lists them and can end them (4009, reason = who ended it).
- **Losing access ends the session** (`access_recheck.rs`, the same mechanism as the terminal, files and remote browser): unsharing / share expiry, a smaller permission or allow-list,
  a device account renamed or deleted, the feature `remote_desktop` turned off, an account disabled and so on trigger `access_recheck::kick` at once, and `run` every 10 seconds catches the rest;
  the decision is the pure `lost()` (VIEW + the device account this session uses is still on the allow-list). Ending goes through the live session path: the socket gets 4009 with the reason
  `Telepy (access changed)`, `desktop_close` / `rustdesk_close` gain `ended by …: <why>`, and the person receives `SESSION-ENDED`.
  The desktop / RustDesk reapers no longer re-check access. Tests `desktop_ends_when_access_is_lost`, `rustdesk_ends_when_access_is_lost`.
- When the web sign-in that opened it is revoked (signed out from "Your devices", signed out by an admin, account disabled): the web session recorded at start gets 4010 as soon as it is revoked.

## Site settings (Settings → Remote desktop)

| key | Default | Description |
|---|---|---|
| `desktop_enabled` | true | When off, no new sessions can be opened |
| `desktop_max_sessions` | 4 | Site-wide concurrent limit (including tickets not yet claimed), 0 = unlimited |
| `desktop_session_idle_timeout` | 900 | How long without keyboard / mouse / clipboard input before disconnecting (seconds), 0 = never |
| `desktop_clipboard` | both | **Ceiling**: both / to_remote / off. Each person picks a direction on the desktop page or in Preferences (the personal setting `desktop_clipboard`), and the narrower of the two applies; guacd enforces it with disable-copy / disable-paste, RustDesk is applied by the core in the browser (off = that peer's `disable-clipboard`) |
| `desktop_max_resolution` | 2560 | Upper limit of the requested remote size (longer side, in pixels), scaled down proportionally if exceeded; the handshake and the `size` during a session are both clamped |
| `desktop_file_transfer` | true | The "Files" panel of in-browser RustDesk (upload / download / rename / delete); when off the relay also refuses file-transfer logins and closes open ones |

## What travels on this connection (the info dialog's streams diagram)

`lib/desktopStreams.ts` (pure + tests) → `components/desktop/DesktopStreams.tsx`, placed below the `DesktopFlow` path diagram: picture, keyboard and
mouse, clipboard, sound and files as five parallel straight lines (left = your browser, right = the desktop, arrows = direction), each with a state: on / oneWay (clipboard to_remote) /
off (turned off by you, RDP muted in this tab) / blocked (site ceiling) / unsupported (this way of connecting does not have it: guacd's VNC has no sound, RDP / VNC pictures do not carry files,
the browser has no WebCodecs audio), and a one-line reason beside it. The sound line follows `lib/desktopSound.ts` (waiting for the remote / blocked / no sound),
and the Files row lists the states of download / upload / rename / delete under RustDesk.

The info dialog (`DesktopInfoDialog`) has the `DesktopFlow` path diagram in its upper half: your browser ─ Telepy ─ device ─ desktop, each point waiting / active /
ok / failed (`spotStates` in `lib/desktop.ts`; a failure is mapped by `sessionFailure` to the hop it got stuck on), with round trips labelled on the two links while connected; in-browser RustDesk
uses the `inBrowser` variant, and with the app it draws the port-forwarding route.

## Comparing the ways to connect (`components/desktop/ConnectionWays.tsx`, pure `lib/connectionWays.ts` + tests)

![The two ways to connect, side by side](images/en/desktop-ways.png)

One dialog compares side by side the two ways of connecting, both through the tunnel: RDP / VNC through guacd (Telepy turns the screen into images) and RustDesk (decoded by the core in the browser).
The two paths are aligned in columns (browser ─ Telepy ─ device ─ desktop; tunnel = double line, the device-to-desktop hop = dashed line), under each is a ruler of "who encrypts which hop"
(TLS / SSH / the protocol's own, `layerColumns`), marking where the picture is drawn; next comes a fact table (cards on phones, `ROWS`: including sound and files)
and how to choose. The one in use (`wayFor(protocol)`) is marked. It can be opened from the desktop page's title bar, the hint on the protocol field and the footer of the info dialog.
When a fact changes, update `ROWS`.

## Deployment

The `guacd` service in `docker-compose.yml` (`guacamole/guacd:1.6.0`) is only on the internal network `telepy-desktop-${PROJECT_NAME}`;
the backend is on both `telepy-network` and that one. Environment variables: `GUACD_ADDR` (default `guacd:4822`), `DESKTOP_CALLBACK_HOST`
(the name guacd uses to connect back to the backend, `backend` in compose; if unset, `HOSTNAME` is used).

## Device requirements

- sshd allows TCP forwarding (`AllowTcpForwarding`, on by default in OpenSSH and Win32-OpenSSH).
- A desktop server: Windows Remote Desktop (3389), macOS Screen Sharing (5900; set a password under "VNC viewers may control screen with password"),
  TigerVNC / x11vnc (5900 + display, for example :1 = 5901), xrdp (3389).
- RDP uses `security=any` + `ignore-cert=true`; NLA needs the correct Windows credentials (domain included).
