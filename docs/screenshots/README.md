# README screenshots

<p align="center"><b>English</b> | <a href="./README.zh-TW.md">繁體中文</a> | <a href="./README.ja.md">日本語</a></p>

The README in each language shows the screenshots in `en/`, `zh-TW/` and `ja/` — the same thirteen screens, each taken
with the interface in that language.

| File            | Screen                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------- |
| `tunnels.png`   | Tunnels page in the list view, one list sorted by status (degraded first; pinned tunnels lead) |
| `terminal.png`  | Web terminal on `web-01` with the file manager side panel                                 |
| `network.png`   | Network page, `office-gw`'s LAN with the NAS selected                                    |
| `desktop.png`   | Remote desktop: a VNC session to `design-ws` (XFCE)                                       |
| `browser.png`   | Remote browser through `office-gw`                                                       |
| `create.png`    | Create Tunnel → One command, a fresh command and what the script does                    |
| `commands.png`  | Command rules in force on `db-primary` (personal and site-wide) with the tester          |
| `sessions.png`  | Live sessions                                                                            |
| `access.png`    | Admin → Users & access → Feature permissions for a person in the Contractors group        |
| `sshconfig.png` | SSH config editor with its example config, Simplify tab                                  |
| `health.png`    | Admin → Server health, overview                                                          |
| `api.png`       | API page → Your tokens                                                                   |
| `activity.png`  | Agent activity (MCP tool calls)                                                          |

## How they are made

Everything on them is a throwaway demo, not real data: a separate Telepy stack built from the repository (its own
`PROJECT_NAME`, ports and data directory), nine Debian containers as devices that joined with the real one-command join,
an `office.lan` network of small containers with real vendor MAC prefixes (IEEE OUI list) scanned through `office-gw`,
and users, labels, groups, shares, rules, snippets, API tokens, MCP calls and terminal sessions created through the
REST API, the MCP endpoint and the terminal WebSocket. Public addresses come from the documentation ranges: devices
get `203.0.113.0/24` (a fake lookup answers their public-IP question) and visitors `198.51.100.0/24` (sent as
X-Forwarded-For, which the default `auto` proxy rule takes as the visitor), the server is called `telepy.example.com`,
and each device reports its own memory, uptime and load through bind-mounted `/proc` files, so the device facts are
not the host's. The Server health screen's storage numbers are the demo machine's real disk.

Shots are taken with headless Chromium (Playwright) at 1680 × 1050 (the tunnels page at 1680 × 1260) and a device
scale factor of 2, light theme, time zone Asia/Taipei, then resized to 1920 px wide and saved as palette PNGs.

When the interface changes enough that a screenshot is misleading, retake all three languages of it so the READMEs
stay in step.

## The diagrams and recordings in the docs

`docs/images/<lang>/` holds what the documents embed, from the same demo server: each info dialog (path diagrams,
timelines, impact maps) opened by a script and captured at 1440 px wide with a device scale factor of 2, then resized to
at most 1200 px; the GIFs are timed screenshots of a real run (a device running the one command, a tunnel being deleted,
a remote browser starting, the create page's network scene, the API page's "Four ways in", the discreet sign-in page),
assembled with sharp at about 8–10 frames a second. The file names are the same in every language, so a changed dialog
is retaken in all three.
