# Telepy documentation

<p align="center"><b>English</b> | <a href="./README.zh-TW.md">繁體中文</a> | <a href="./README.ja.md">日本語</a></p>

New here? The [project README](../README.md) covers what Telepy is and how to install it. The documents below go deeper, and each one comes in English, Traditional Chinese and Japanese.

## See it first

[**Telepy in pictures**](./visual-guide.md) collects the diagrams behind the app's info buttons, plus a few recordings. It covers adding a device, the terminal, files, remote desktop, sharing, command rules, keys, notifications, the CLI and server health.

## Using Telepy

| Document | What it covers |
| --- | --- |
| [Adding a device with one command](./device-join.md) | What the script does, which devices it supports, what it leaves behind, and what to do when it fails |
| [Remote desktop](./remote-desktop.md) | RDP, VNC and RustDesk in the browser: quality, clipboard, sound, screens and files |
| [Remote browser](./remote-browser.md) | A Chromium that goes online from the device, its limits, and troubleshooting |
| [The command line and API tokens](./cli.md) | Installing, signing in, every command, and what a token may do |
| [MCP](./mcp.md) | Connecting MCP clients, approving them, and what agents can and can't do |
| [Webhooks](./webhooks.md) | Personal and site-wide webhooks: events, formats, signatures and retries |

## How it works inside

| Document | What it covers |
| --- | --- |
| [How the backend reaches devices](./device-connections.md) | Shared connections, host-key checks, machine identity, and the two ways in (SSH and WebSocket) |
| [Where the latency number comes from](./latency-deep-dive.md) | How each hop is measured and shown |
| [Benchmark: Django vs Rust](./benchmarks.md) | Numbers from the backend rewrite |
| [How the README screenshots are made](./screenshots/README.md) | The demo server behind every picture |

## Engineering notes

Some notes are kept the way they were written, in Traditional Chinese only:

- [Rust backend migration plan](./engineering/rust-migration-plan.md)
- RustDesk research: [the first spike](./engineering/rustdesk-spike.md) and [Telepy as an ID / relay server](./engineering/rustdesk-id-server.md)
- [Articles](./engineering/articles/)

One fix is still waiting upstream: letting Dropbear clients through russh's strict key exchange ([issue #804](https://github.com/Eugeny/russh/issues/804), [PR #805](https://github.com/Eugeny/russh/pull/805)).

Release notes are on [GitHub Releases](https://github.com/NatLee/telepy/releases).
