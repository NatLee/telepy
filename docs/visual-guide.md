# Telepy in pictures

<p align="center"><b>English</b> | <a href="./visual-guide.zh-TW.md">繁體中文</a> | <a href="./visual-guide.ja.md">日本語</a></p>

Most pages in Telepy have an info button that opens a diagram of what is happening — which path a connection takes,
which layer made a decision, where something stopped. This page collects those diagrams, plus a few recordings, so you
can see how the parts fit together before you open the app. Each picture says where to find it, and links to the
document with the details.

The pictures come from a demo server with made-up devices (see [how the screenshots are made](./screenshots/README.md)).
The diagrams in the app are live: they show your own devices, accounts and settings.

**Contents:** [Adding and removing devices](#adding-and-removing-devices) ·
[Working on a device](#working-on-a-device) · [Sharing and control](#sharing-and-control) ·
[Keys and SSH configs](#keys-and-ssh-configs) · [Notifications](#notifications) · [Automation](#automation) ·
[Signing in](#signing-in) · [Running the server](#running-the-server)

## Adding and removing devices

### Why a reverse tunnel

**Tunnels → Create Tunnel**, the diagram at the top. It plays a three-part story: the device sits in a private network
whose router drops every connection from outside; the device dials out to Telepy; you come in through the line the
device opened. No port is opened on the router, so the isolation stays — only people you allow in Telepy get through.

![The create page's network scene: without Telepy, the device dials out, you come in through the tunnel](images/en/setup-story.gif)

### One command, followed live

**Create Tunnel → One command → Create the command.** Paste the line on the device; the page lights up the script's
steps as they happen (what the device has, host keys, gateway check, registration, authorizing Telepy, the service)
and finishes once Telepy has logged in through the tunnel. Details: [One-command device join](./device-join.md).

![A device running the one command; the page follows each step until Telepy has logged in](images/en/join-live.gif)

### Device facts

A tunnel's menu → **Details & description → Device → How these are collected.** Once a day Telepy logs in to each
connected device with a read-only script (OS, uptime, memory, disk, load, pending reboot); the dialog shows the path,
the last and next run, the exact commands and the thresholds behind each warning.

![How device facts are collected: Telepy's daily read-only login and the commands it runs](images/en/device-facts.png)

### Deleting a tunnel

A tunnel's menu → **Delete tunnel.** Before anything happens the dialog maps who reaches the tunnel and what is on the
device — the tunnel service, the keys Telepy installed per account, the service key — with the outcome of each choice.

![The delete dialog's impact map and the steps Telepy will take](images/en/delete-impact.png)

Then it runs step by step, live: the device is cleaned while the tunnel is still up, Telepy waits for the device to drop
by itself and makes sure it stays down, and only then deletes the tunnel.

![Deleting a tunnel: each step lights up live until the report](images/en/delete-live.gif)

## Working on a device

### Terminal

**Terminal page → How it works** (header). Your browser ─ Telepy ─ the device's shell, with the round trip of each hop
and where a failed connection stopped. Details: [How the backend reaches devices](./device-connections.md),
[Latency deep dive](./latency-deep-dive.md).

![The terminal's path: browser, Telepy, the device's sshd, with round trips](images/en/terminal-flow.png)

### Shells that survive a dropped connection

**Preferences → Terminal → How it works** (next to keeping shells after a drop). Connected ─ drop ─ kept for N ─
reattach, or time's up; and which layer decides how long (your setting, the site's ceiling, the tunnel's policy).

![When the connection drops: how long the shell is kept and who decides](images/en/detach-timeline.png)

### Files

The file manager's **How files work here** button. Everything you do in the file manager goes through one shared SFTP
channel on the same login as your terminal; the dialog shows where an offline device or a missing confirmation stops it.

![How files reach the device: one shared SFTP channel through the tunnel](images/en/file-flow.png)

### Toolbox

**Toolbox → How the toolbox works.** A snippet's variables are filled in your browser, then typed into your shell
line by line — so command rules see every line, exactly as if you had typed it.

![How the toolbox works: snippet, variables, your shell, command rules, device](images/en/toolbox-flow.png)

### Remote desktop

**Remote desktop → How it works** while connected: browser ─ Telepy ─ device ─ desktop, with round trips, and below it
what travels on the connection — picture, input, clipboard, sound, files — each with its state and why.
Details: [Remote desktop](./remote-desktop.md).

![The remote desktop's live path and the streams on the connection](images/en/desktop-flow.png)

**Remote desktop → Ways to connect** compares RDP / VNC through guacd with RustDesk decoded in the browser: where the
picture is drawn, which layers encrypt what, and how to choose.

![Two ways to connect a remote desktop, side by side](images/en/desktop-ways.png)

### Remote browser

**Remote browser → Start Browser.** Starting shows its three steps — a proxy through the device, a fresh Chromium in
Telepy's browser container, the picture in this tab — then the browser, whose traffic leaves through the device.
Details: [Remote browser](./remote-browser.md).

![Starting a remote browser step by step](images/en/browser-start.gif)

## Sharing and control

### Login accounts on a device

A tunnel's menu → **Target Server Users → What are these accounts for?** Telepy users ─ the allow-list ─ OS accounts ─
the device's sshd. The device cannot tell Telepy users apart, so the allow-list is the boundary.

![Who may log in as which account, and why the allow-list is the boundary](images/en/target-users.png)

### Feature permissions

**Admin → Users & access → Feature permissions → How it works.** Two independent gates: which tools a person may use
(default → everyone → user groups → the person, the last word) and which tunnels they reach (sharing).

![Feature permissions vs sharing: two gates, both apply](images/en/access-lanes.png)

### How a command is decided

**Command rules → How a command is decided.** A command is split (sudo, `sh -c`, pipes are looked through), checked
against the site-wide and the personal rules in force on the tunnel, and ends in run / remind / approve / block. The
path of the last command you tried lights up. Details: [MCP](./mcp.md#command-rules-ssh_exec).

![How a command is decided: split, site-wide rules, personal rules, verdict](images/en/command-decision.png)

### Watching a terminal

**Live sessions → How watching works.** Their browser ─ Telepy ─ device, with your browser branching off Telepy: you
see their screen, they are told, and you type only once they hand you the keyboard.

![Watching someone's terminal and asking for control](images/en/watch-flow.png)

## Keys and SSH configs

### Device key lists

**Keys → How it works.** Your key → the device's key list → the accounts you may use there (and chose) → each account's
`authorized_keys`. Telepy only removes keys it added; losing access takes them off again.

![Where your public key goes: list, allowed accounts, authorized_keys](images/en/key-placement.png)

**Keys → Key groups → How key groups work.** One group of keys, given once to a device or a tunnel group, kept in step
as you add keys or tunnels.

![A key group granted to a tunnel group and the devices it reaches](images/en/key-groups.png)

### SSH config for your computer

A tunnel's menu → **SSH config.** Your computer ─ ssh ─ Telepy ═ tunnel ═ device: what the generated `Host` entry does,
how your key gets in, then `ssh <alias>`.

![The SSH config dialog: route map, the Host entry and its steps](images/en/config-route.png)

**SSH config → About these ways** (next to "Reach Telepy via"): your computer reaches Telepy on the SSH port or through
the web port, separately from how the device dials in. Details: [How the backend reaches devices](./device-connections.md).

![How your computer reaches Telepy, next to how the device connects](images/en/transport-info.png)

### SSH config editor

**SSH config editor → How it works.** Pick a name and follow how ssh reads the file for it, before and after the
simplification — first value wins, which options add up, what wildcards match. `telepy config tidy` does the same in a
terminal ([CLI](./cli.md)).

![How the simplified config reads the same for every name](images/en/tidy-info.png)

## Notifications

### In-app and desktop notifications

**Preferences → Notifications → How it works.** Event ─ site default ─ your default ─ this tunnel ─ result: which layer
decides whether a toast or desktop notification shows, and where an admin enforced it.

![How a notification is decided: site default, your default, this tunnel](images/en/notify-flow.png)

### Opting a tunnel out of a site-wide webhook

**Webhooks → site-wide webhooks → How opt-outs work.** Pick a webhook and a tunnel to see whether its events reach the
admins' channel, and who opted it out. Details: [Webhooks](./webhooks.md).

![Where a tunnel's events go: event, site-wide webhook, opt-out, channel](images/en/webhook-optout.png)

## Automation

### Four ways in

**API → Four ways in.** Web sign-in, API token, CLI sign-in and MCP app are four separate lanes into Telepy; "What if
I…" shows that revoking one cuts only its own lane. Details: [CLI and API tokens](./cli.md).

![Four ways in: revoking one lane leaves the others working](images/en/ways-in.gif)

### The `telepy` command line

**CLI → How it works.** Most commands go over HTTPS with your sign-in; `ssh` / `scp` / `sftp` use your system's
OpenSSH with your personal key through the gateway.

![How the CLI reaches your devices: the REST lane and the OpenSSH lane](images/en/cli-flow.png)

### MCP apps

**MCP → What can an app reach?** App ─ Telepy ─ device ─ LAN / internet, lit by the scopes of a connected app.
Details: [MCP](./mcp.md).

![What an MCP app can reach, by scope](images/en/agent-reach.png)

## Signing in

### Staying signed in

**Preferences → Security → How staying signed in works.** A sign-in renews itself while you use Telepy and ends after
a stretch of not using it; signing out elsewhere cuts that browser at once.

![How a web sign-in renews and ends](images/en/session-life.png)

### The discreet sign-in page

**Site settings → Sign-in → Sign-in page look → Discreet**: only "Telepy", a moving background and the lines you type,
for a server you would rather not advertise.

![The discreet sign-in page: the word Telepy, a moving field and typed lines](images/en/discreet-signin.gif)

## Running the server

### Server health

**Admin → Server health → How it works.** Visitor ─ proxy ─ Telepy backend ─ data on disk, with the companion services
beside it; each part is lit by its checks, and "Right now" names the first one that needs attention.

![Server health: the parts of a Telepy server and their checks](images/en/health-flow.png)

**Server health → Visitor addresses → How Telepy sees your address** walks the X-Forwarded-For chain of your own
request hop by hop and says what to fix when proxies hide the real address.

![How Telepy works out a visitor's address, hop by hop](images/en/client-ip.png)

### `.env` and Site settings

**Site settings → Server → How .env and this page combine.** For every setting that can also come from `.env`:
`.env` wins and locks the field, else the saved setting, else the built-in default.

![Where each server setting comes from: .env, this page or the default](images/en/setting-source.png)

**Site settings → Server → SSH host → Why two names?** When the web name goes through a proxy that only carries web
traffic, SSH needs a name of its own that points straight at the server.

![Why SSH can need its own name: the web lane and the SSH lane](images/en/ssh-host.png)
