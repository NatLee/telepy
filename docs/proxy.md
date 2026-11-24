# Device proxy

<p align="center"><b>English</b> | <a href="./proxy.zh-TW.md">繁體中文</a> | <a href="./proxy.ja.md">日本語</a></p>

The device proxy turns a tunnel into a network proxy. A program connects to Telepy with a token, and the device's own SSH server opens the connection to the destination. The destination sees the device's address, and `localhost` means the device.

Nothing is installed or run on the device. It is the same forward its sshd already makes for `ssh -D` and for the [remote browser](./remote-browser.md); the proxy only gives it a door that apps can use.

## What it's good for

- **Your own browser, leaving from the device.** `telepy proxy box --browser` opens Chrome through the device. It does the job of the remote browser without a browser running on the server, and it is as fast as your own machine.
- **Tools that take a proxy.** `curl`, package managers, database clients, anything that reads `HTTPS_PROXY` or speaks SOCKS5.
- **Apps you connect.** An app signs in with OAuth, the person picks which tunnels it may use, and the app then opens connections through them.

The remote browser is still the one to use when nothing can be installed on the computer in front of you, and for scripted browsing (`telepy browse`, MCP agents), which needs a browser Telepy can drive.

## Turning it on

It is off until an administrator turns it on: **Site settings → Features → Device proxy → Allow the device proxy**.

After that, a person can use it when all of these hold:

| Check | Where it is set |
| --- | --- |
| The **Device proxy** feature is on for them | Users & access → Feature access |
| Their token or app holds `proxy:use` | the API page, or the approval page of the app |
| The tunnel is one the token or app was given | chosen when the token is created or the app approved |
| They may see the tunnel and use a device account on it | the tunnel's sharing and accounts |
| The tunnel does not ask for verification before every session | the tunnel's settings (step-up tunnels are refused) |

## From your own computer

```sh
telepy login https://telepy.example.com --scope "tunnels:read ssh:exec ssh:files proxy:use"
telepy proxy                       # the tunnels you may proxy through
telepy proxy box                   # a proxy on 127.0.0.1:8118, HTTP and SOCKS5 on the same port
telepy proxy box --browser         # the same, plus Chrome using it (a separate profile)
curl -x http://127.0.0.1:8118 https://ifconfig.me     # the device's address
```

`telepy proxy` needs no SSH key and no admin rights. It only uses the web port, so it works wherever the Telepy web page opens. Each connection your programs make becomes one WebSocket to Telepy.

`--browser` looks for Chrome, Chromium, Edge or Brave and starts it with the proxy and its own profile folder, so your everyday browser and its settings are untouched. With any other browser, set its proxy to `http://127.0.0.1:8118` yourself.

Compared with the other ways to reach a device's network:

| | Needs | Carries | Good for |
| --- | --- | --- | --- |
| `telepy proxy` | a token with `proxy:use` | TCP, through a proxy setting | a browser, curl, tools with a proxy option |
| `telepy forward` / `ssh -L` | your SSH key on the device | one port | one service at a fixed local port |
| `telepy vpn` | your SSH key and admin rights here | every address, no proxy setting | programs that can't use a proxy |
| Remote browser | nothing on your computer | a browser's picture | a computer you can't install on |

## From an app

### Getting a token

- **OAuth** (an app other people connect): the same authorization server MCP clients use, described in [MCP](./mcp.md). Ask for the scope `proxy:use`. On the approval page the person chooses **All tunnels** or **Only selected**, and the app can list and use only those.
- **A personal API token** (your own scripts): the API page → **Your tokens** → create one with `proxy:use`, optionally limited to some tunnels.

### Listing tunnels

```sh
curl -H "Authorization: Bearer $TELEPY_TOKEN" https://telepy.example.com/api/proxy/tunnels
```

The answer lists the tunnels this token may proxy through, the device accounts on each, whether each is usable right now (`blocked` is `null`, or `step_up` / `no_account` / `offline`), and the endpoints.

### Opening a connection

One WebSocket is one TCP connection:

```
wss://telepy.example.com/ws/proxy/?tunnel=<id or name>&host=<host>&port=<port>[&account=<device account>]
Authorization: Bearer <token>
```

Telepy checks everything and has the device connect **before** it upgrades. So a failure is an ordinary HTTP answer with `{error, code}`, and a `101` means the device reached the destination. From then on binary frames are the connection's bytes, and either side closing ends it.

| Status | `code` | Meaning |
| --- | --- | --- |
| 401 | `token_required`, `token_invalid` | no token, or it is invalid, expired or revoked |
| 403 | `proxy_disabled`, `token_scope`, `feature_disabled`, `step_up_refused`, `no_account` | one of the checks above said no |
| 404 | `tunnel_not_found` | no such tunnel for this token |
| 400 | `bad_request`, `bad_target`, `username` | a missing parameter, a host that isn't a plain name or address, or an account you may not use |
| 429 | `proxy_busy` | too many connections at once |
| 502 | `device_offline`, `device_login_failed`, `resolve_failed`, `connect_failed` | the device is away, or it could not reach the destination |

The API page's **Proxy** tab shows these endpoints for your server with examples filled in.

## What Telepy checks and records

All connections of one token (or app) through one tunnel as one device account form a **proxy session**.

- Opening and closing a session each write one line to the tunnel's log. The closing line says how many connections there were, how much was sent and received, and where they went (the first 20 destinations).
- Open sessions are listed on the API page's Proxy tab, where the person, the tunnel's owner or an administrator can end one. Ending it cuts every connection at once.
- Telepy looks again every 10 seconds. A revoked token, a disabled account, a removed share, an account taken off the tunnel, the feature or the site switch turned off: any of these cuts the session.
- Telepy never looks inside the connections. An HTTPS connection stays encrypted between your program and the site.

## Limits

- TCP only. No UDP and no ping.
- **64 connections at once** per token and tunnel by default (Site settings → Device proxy), and 8 tunnels at once per token.
- A session with no connections closes after 60 seconds; the next connection opens a new one.
- Names are looked up by the device. On a Mac device Telepy resolves the name on the device first, because Apple's sshd ends the whole connection when it is handed a name.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `proxy_disabled` | An administrator turns it on in Site settings → Device proxy |
| `token_scope` | Sign in again with `--scope "… proxy:use"`, or make a token that has it |
| `step_up_refused` | That tunnel asks for verification before every session. Use the web or ssh for it |
| `connect_failed` on every destination | The device's sshd may forbid forwarding. Set `AllowTcpForwarding yes` in its `sshd_config` |
| A page loads its text but not its pictures | The page needs more connections than the limit allows. Raise it in Site settings → Device proxy |
| `telepy proxy` says the port is taken | Pick another with `--port`, or `--port 0` for any free one |
