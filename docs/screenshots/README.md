# README screenshots

<p align="center"><b>English</b> | <a href="./README.zh-TW.md">繁體中文</a> | <a href="./README.ja.md">日本語</a></p>

Each README shows the same thirteen screens, taken with the interface in that README's language. There is one folder per language here, and the file names are the same in all three.

| File            | Screen                                                                 |
| --------------- | ---------------------------------------------------------------------- |
| `tunnels.png`   | Tunnels page, list view, sorted by status (pinned first, then degraded) |
| `terminal.png`  | Web terminal on `web-01` with the file panel open                      |
| `network.png`   | Network page: the LAN behind `office-gw`, with the NAS selected        |
| `desktop.png`   | Remote desktop: VNC to `design-ws`                                     |
| `browser.png`   | Remote browser through `office-gw`                                     |
| `create.png`    | Create Tunnel → One command, with a fresh command                      |
| `commands.png`  | Command rules in force on `db-primary`, with the tester                |
| `sessions.png`  | Live sessions                                                          |
| `access.png`    | Feature permissions for someone in the Contractors group               |
| `sshconfig.png` | SSH config editor with its example config, Simplify tab                |
| `health.png`    | Server health, overview                                                |
| `api.png`       | API page, Your tokens                                                  |
| `activity.png`  | Agent activity (MCP tool calls)                                        |

## How they are made

Nothing on them is real data. They come from a throwaway demo:

- A separate Telepy stack built from this repository, with its own ports and data.
- Nine Debian containers playing devices, each added with the real one-command join.
- A small office network of containers with real vendor MAC prefixes, scanned through `office-gw`.
- Users, labels, groups, shares, rules, snippets, tokens, MCP calls and terminal sessions, all created through the API, MCP and the terminal, the same way a person would.

The addresses come from the ranges reserved for documentation: `203.0.113.x` for devices, `198.51.100.x` for visitors, and `telepy.example.com` for the server. Each device reports made-up memory, uptime and load, so the device health isn't just the demo machine's. The disk numbers on Server health are real, though. We didn't have the heart to fake those.

## Taking them

- Headless Chromium (Playwright), light theme, time zone Asia/Taipei.
- 1680 × 1050 at 2× scale (the tunnels page 1680 × 1260), then resized to 1920 px wide and saved as palette PNGs.
- When a screen changes enough to be misleading, retake it in all three languages so the READMEs stay in step.

## Diagrams and recordings in the docs

The pictures inside the documents come from the same demo server:

- Info dialogs (path diagrams, timelines, impact maps) are opened by a script, captured 1440 px wide at 2× scale, then resized to at most 1200 px.
- The GIFs are timed screenshots of real runs, such as a device running the one command, a tunnel being deleted, or a remote browser starting. They play at about 8 to 10 frames a second.
- File names are the same in every language, so a changed dialog gets retaken in all three.
