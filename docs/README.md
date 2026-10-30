# Telepy documentation

<p align="center"><b>English</b> | <a href="./README.zh-TW.md">繁體中文</a> | <a href="./README.ja.md">日本語</a></p>

Start with the [project README](../README.md) for what Telepy is and how to install it. The documents below go deeper;
each one is available in English, Traditional Chinese and Japanese.

## See it first

- **[Telepy in pictures](./visual-guide.md)** — the diagrams behind the app's info buttons and a few recordings: adding
  and removing a device, the terminal, files, remote desktop and browser, sharing, command rules, keys and SSH configs,
  notifications, the CLI, API and MCP, sign-in and server health.

## Using Telepy

| Document | What it covers |
| --- | --- |
| [One-command device join](./device-join.md) | What the join script does, which devices it supports (Linux, macOS, OpenWrt), what it leaves behind, how to diagnose it |
| [Remote desktop](./remote-desktop.md) | RDP / VNC through guacd and RustDesk in the browser: quality, display, clipboard, sound, screens, files, saved logins |
| [Remote browser](./remote-browser.md) | Chromium in KasmVNC whose traffic leaves through the device; sessions, limits, troubleshooting |
| [The `telepy` command line and API tokens](./cli.md) | Installing and signing in, every command, tokens and scopes, the call log |
| [MCP](./mcp.md) | Connecting MCP clients, the approval flow, tools, interactive shells, browsers, command rules, audit |
| [Webhooks](./webhooks.md) | Personal and site-wide webhooks, events, formats, signatures, retries, opt-outs |

## How it works inside

| Document | What it covers |
| --- | --- |
| [How the backend reaches devices](./device-connections.md) | Shared connections, ports, host-key pinning, machine identity, per-tunnel service keys, TCP / WebSocket / PROXY protocol, install names |
| [Where the latency number comes from](./latency-deep-dive.md) | How each hop's round trip is measured and shown |
| [Benchmark: Django vs Rust](./benchmarks.md) | Numbers from the backend rewrite |
| [How the README screenshots are made](./screenshots/README.md) | The demo server behind every picture in these documents |

## Engineering notes

Kept as they were written, in Traditional Chinese: the [Rust backend migration plan](./rust-migration-plan.md), the
RustDesk research ([spike](./rustdesk-spike.md), [ID / relay server](./rustdesk-id-server.md)), the
[russh strict-kex patch for Dropbear](./russh-dropbear-strict-kex.patch) and the [articles](./articles/).

Release notes are on [GitHub Releases](https://github.com/NatLee/telepy/releases).
