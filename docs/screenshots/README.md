# README screenshots

The README in each language shows the screenshots in `en/`, `zh-TW/` and `ja/` — the same eleven screens, each taken
with the interface in that language.

| File           | Screen                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------- |
| `tunnels.png`  | Tunnels page, one list sorted by status (degraded first; pinned tunnels lead)            |
| `terminal.png` | Web terminal on `web-01` with the file manager side panel                                 |
| `network.png`  | Network page, `office-gw`'s LAN with the NAS selected                                    |
| `desktop.png`  | Remote desktop: a VNC session to `design-ws` (XFCE)                                       |
| `browser.png`  | Remote browser through `office-gw`                                                       |
| `create.png`   | Create Tunnel → One command, with a fresh command waiting for the device                 |
| `commands.png` | Command rules for `db-primary` with the tester                                           |
| `sessions.png` | Live sessions                                                                            |
| `access.png`   | Site settings → Access, one person's feature permissions                                 |
| `api.png`      | API page → Your tokens                                                                   |
| `activity.png` | Agent activity (MCP tool calls)                                                          |

## How they are made

Everything on them is a throwaway demo, not real data: a separate Telepy stack built from the repository (its own
`PROJECT_NAME`, ports and data directory), nine Debian containers as devices that joined with the real one-command join,
an `office.lan` network of small containers with real vendor MAC prefixes (IEEE OUI list) scanned through `office-gw`,
and users, labels, groups, shares, rules, snippets, API tokens, MCP calls and terminal sessions created through the
REST API, the MCP endpoint and the terminal WebSocket. Public addresses come from the documentation range
`203.0.113.0/24` (a fake lookup answers the devices' public-IP question), the server is called `telepy.example.com`,
and each device reports its own memory, uptime and load through bind-mounted `/proc` files, so the device facts are
not the host's.

Shots are taken with headless Chromium (Playwright) at 1680 × 1050 (the tunnels page at 1680 × 1260) and a device
scale factor of 2, light theme, time zone Asia/Taipei, then resized to 1920 px wide and saved as palette PNGs.

When the interface changes enough that a screenshot is misleading, retake all three languages of it so the READMEs
stay in step.
