# Where does that "ms" come from?

<p align="center"><b>English</b> | <a href="./latency-deep-dive.zh-TW.md">繁體中文</a> | <a href="./latency-deep-dive.ja.md">日本語</a></p>

The title bar of the terminal page carries a small latency badge:

```
You ●──23ms──● Telepy ●──87ms──● Device   Σ 110ms
```

It looks simple. This page explains where each number comes from, how often it is measured, and why Telepy goes to some trouble to make sure it is real.

## Two hops, measured separately

![The terminal's info diagram shows the round trip of each hop](images/en/terminal-flow.png)

Nothing can time the whole trip in one go: your browser can't reach the device, and the device doesn't know your browser exists. So Telepy times each hop on its own and adds them up at the end (the Σ).

| Hop | What it measures | Measured by | How often |
|---|---|---|---|
| You → Telepy | WebSocket round trip between your browser and the server | The terminal page, in your browser | Every 5 seconds |
| Telepy → Device | Round trip through the tunnel to the device's SSH server | The backend's built-in SSH gateway | Every 15 seconds |

Both numbers are round-trip times (RTT), not one-way. Added up, they come close to the real round trip between you and your device.

## Hop 1: your browser to Telepy

Every 5 seconds the terminal page sends one line over its WebSocket:

```json
{ "action": "ping" }
```

The backend answers with `pong` in a binary frame, not a text frame. The page checks how long that took and updates the badge.

Why binary? The terminal page writes every text frame straight to the screen, because text frames carry the shell's output. A text pong would make the word `pong` appear in your vim every 5 seconds, like a very punctual ghost. A binary frame tells the page "this is a control message, not output", and the screen stays untouched.

Other control messages on the terminal socket follow the same rule. The message about a shell kept alive after a disconnect, command-rule notices and the list of who is watching are all binary JSON. The page first checks whether a binary frame is exactly `pong`, and only then reads it as JSON.

Two more things worth knowing:

- The other WebSockets (notifications, a single tunnel's status, the file manager) answer their ping with the text `{"type":"pong"}`. They have no terminal screen to protect.
- The server also sends a WebSocket Ping to the terminal, file manager and remote browser every 20 seconds, and closes a connection that stays silent for 40 seconds. That catches browsers that left without saying goodbye. It is a liveness check, not a latency measurement.

## Hop 2: Telepy to the device

### Why not just ask the kernel?

The obvious shortcut is the kernel: `ss -ti` already reports an RTT for every TCP connection, for free. That was the first idea, too.

The trouble starts when docker-proxy or an L4 load balancer sits in front of the server. The device's TCP connection then ends at that proxy, on the same machine, and the kernel confidently reports an RTT of about 0 ms.

Meanwhile the device is in a data center hundreds of kilometers away, waving through three layers of NAT. The kernel's number is precise; it just measures the wrong distance.

### Knock, and read one byte

So Telepy measures through the tunnel itself:

1. The gateway opens a channel down the device's reverse tunnel, the same kind `ssh -R` opens when someone connects to a forwarded port.
2. The ssh client on the device connects that channel to the device's own SSH server.
3. The gateway starts a stopwatch and reads exactly one byte: the first byte of the SSH server's banner (the `S` in `SSH-2.0-...`).

That byte has to travel out through the tunnel and back, so the result is a real network round trip. A proxy can fool the kernel, but it can't conjure up the device's banner. Physics doesn't take bribes.

That is also why the number stays accurate behind an L4 proxy, or when Docker rewrites the source address: the byte travels inside the tunnel, not over the connection the kernel sees.

The details:

- One round every 15 seconds. The advanced backend variable `GATEWAY_PROBE_INTERVAL_SECS` changes that.
- All tunnels are probed in parallel, each with a 4-second timeout. A device that has dozed off only costs its own 4 seconds and doesn't hold up the others.
- The stopwatch reads to 0.1 ms.

Probes only measure. Whether a tunnel is online or offline comes from the tunnel itself: the device registering or releasing its forward. No number of probe timeouts will mark a tunnel offline. Repeated failures do change one thing, though, as the next section explains.

## When nobody answers the knock: Degraded

Sometimes the forward is still there, but the banner never comes back: the device's sshd has stopped, a firewall blocks it, or it hangs. The tunnel looks online, yet nothing can actually get through.

So Telepy counts failed probes for each tunnel. Two failures in a row mark the tunnel Degraded, and one success resets the count. A single failure doesn't count: a busy device occasionally misses the 4-second window, and that's fine.

The tunnel list shows four states:

| State | Shown as | Meaning |
|---|---|---|
| Online | Green dot | The tunnel is up and the device's sshd answers through it |
| Degraded | Amber dot | The tunnel is up, but sshd hasn't answered two probes in a row |
| Offline | Grey dot | The device connected before, but has no tunnel now |
| Never connected | Dashed ring | No connection on record |

When a tunnel degrades or recovers:

- The tunnel's Logs page records an "SSH not answering" or "SSH answering again" event.
- Everyone who can see the tunnel is notified. The list shows the amber dot and the tunnel's open buttons look offline. A degrade also brings a warning toast.
- Webhooks subscribed to status events hear about it as well, each after its own delay.

"Couldn't measure" is never shown as zero. A tunnel whose probe failed simply has no number, and the badge shows grey bars and `—` instead of a made-up 0 ms. When the gateway isn't running at all, no latency is sent that round.

## Getting the number to your screen

A loop in the backend runs every 5 seconds. It picks up the latest probe results and sends them to the browsers that may see them.

- **Only when it matters:** RTT jitters by a few milliseconds all the time (87, 89, 86, 88…). Re-rendering every page every 5 seconds for that would be a waste, so an update goes out only when a tunnel moved by 5 ms or more, or a tunnel appeared or disappeared. Otherwise the loop stays quiet, but for at most 6 rounds before it sends anyway, so a page that just connected doesn't wait long.
- **Even when nothing else changed:** latency is sent before the loop's "nothing changed, stop here" check. Otherwise a perfectly stable tunnel would show its first number forever.
- **Online / offline is debounced:** a tunnel's state has to look different two rounds in a row before the change is announced.
- **Only your tunnels:** each person gets latency only for tunnels they own or that are shared with them. The latency of other people's tunnels stays private.

The numbers travel two ways:

- The tunnel list gets them over the notification socket, `/ws/notifications/`.
- The terminal page and the Create Tunnel wizard subscribe to that one tunnel's status socket, `/ws/tunnel_connection/{id}/`, and get its number in real time.

## How the number is drawn

The tunnel list loads once from `GET /api/reverse/server/dashboard`, which returns tunnels, ports and latency in a single request, and then follows the live updates. When no sample is available, `latency` is `{}` and the list simply shows no number. The older `/api/reverse/server/status/latency` endpoint still exists and returns `{"<port>": rtt_ms}`.

Latency is shown as four bars, like a phone's signal:

| Round trip | Bars | Label |
|---|---|---|
| Under 60 ms | 4 green | Excellent |
| 60–150 ms | 3 green | Good |
| 150–300 ms | 2 amber | Fair |
| Over 300 ms | 1 red | Poor (worth checking that nobody installed the device on the Moon) |
| Couldn't measure | Grey bars and `—` | — |

On the terminal page:

- The title-bar badge draws both hops as a path, `You ●──● Telepy ●──● Device`, with dots flowing along the lines. The first hop is this tab's own ping/pong; the second is the tunnel's number from the status socket. Hover or tap it for the per-hop breakdown and the total.
- The info dialog, "How the terminal works", writes the same two round trips on its "you ─ Telepy" and "Telepy ─ device" lines (the picture at the top of this page).

The remote desktop's stream stats reuse the tunnel latency as one of their segments, too. See [Remote desktop](./remote-desktop.md).

Every number that changes sits in a fixed-width cell with tabular figures, so `72ms` growing into `115ms` doesn't shift the layout.

## The whole trip in five steps

1. Every 15 seconds the gateway knocks down every reverse tunnel and times how long the first byte of the device's SSH banner takes to come back.
2. The result goes straight into the backend's memory. Two missed knocks in a row mark the tunnel Degraded.
3. Every 5 seconds a backend loop picks the results up, holds back the boring ones and sends the rest to the people allowed to see them.
4. Your browser draws the signal bars and the path badge, and times its own hop to the server with ping/pong (binary!).
5. The two hops added up come close to the real-world distance between you and your device.

The design in one sentence: don't trust hearsay (the kernel, a proxy); trust only the byte that made the whole trip itself.

## Under the hood

These two sections are for people reading the source or curious about the history. Nothing in them changes how Telepy behaves for you.

<details>
<summary>Names in the code, for contributors</summary>

- The probe is `Gateway::probe_latency`, with a 4-second `PROBE_TIMEOUT` and the interval from `GATEWAY_PROBE_INTERVAL_SECS` (default 15). Results go into `StatusState::record_probes`, which keeps the RTT and the consecutive-failure count per port.
- A port that couldn't be measured is absent from the latency table, not 0. When the gateway isn't running, `StatusState::latency()` returns `None` and that round isn't broadcast.
- The broadcast loop is the backend's port monitor (one round every 5 seconds). Its constants: `FLAP_THRESHOLD` 2 (online / offline debounce), a 5 ms change threshold, a 6-round keep-alive, and `DEGRADED_AFTER` 2.
- Messages: `UPDATE-TUNNEL-LATENCY {latency: {"<port>": rtt_ms}}` on `/ws/notifications/`; `latency_update {tunnel_id, reverse_port, rtt_ms}` on `/ws/tunnel_connection/{id}/`; `UPDATE-TUNNEL-HEALTH {tunnel_id, name, port, health}` for health changes.
- Health is `online` / `degraded` / `offline` / `never`, modelled on Cloudflare Tunnel. The gateway writes `degraded` / `recovered` events. List items carry `health`, and the frontend merges it with the live port state.
- On the frontend, the title-bar badge, the signal bars and the info diagram are `TerminalLatencyBadge`, `LatencyIndicator` and `TerminalFlow`. The remote desktop's stream stats call the tunnel segment `tunnel_ms`.
- Ports are always string keys in these payloads. See the int-key story below for why.

</details>

<details>
<summary>The Django-era version</summary>

Before the backend was rewritten in Rust (October 2026), the same idea took more moving parts: a Bash script in the SSH container, Redis in the middle, and a Django command doing the broadcasting. The measurement itself was the same.

**The probe:** the script used `ss -tln` to find the reverse-tunnel ports sshd had bound on `127.0.0.1`. For each one it opened a TCP connection with Bash's built-in `/dev/tcp` (no nc, no ICMP), took the time with `$EPOCHREALTIME` (microsecond resolution) and read one byte:

```bash
s=$EPOCHREALTIME
exec 3<>/dev/tcp/127.0.0.1/$port
IFS= read -r -N1 _b <&3        # wait for the first byte of the target device's sshd banner
e=$EPOCHREALTIME
```

Probes ran in parallel (`&` + `wait`) with a 4-second timeout each, so the total time was roughly the slowest device, not the sum. The script was deliberately kept apart from the 3-second sampling that tracked port usage, so a slow probe could never hold up the online / offline decision.

**The handover:** the script collected the results as `port rtt_ms` lines and overwrote them in Redis in one go:

```bash
cat "$TMPDIR"/* | redis-cli -x SET ss_probe_latency
```

That key was written raw, without the Django cache's key prefix, so `cache.get("ss_probe_latency")` only ever returned `None`. The backend read it over a direct redis-py connection instead, which also saved starting a `redis-cli` subprocess every round.

**The broadcaster:** `update_ports --loop`, a resident Django management command running every 5 seconds. An earlier version cold-started a whole Django process every 5 seconds. The rules above (latency before the no-change exit, the 5 ms threshold, the 6-round keep-alive, the two routes) come from it unchanged.

**The int-key incident:** the channel layer serialized messages with msgpack, and newer msgpack versions default to `strict_map_key=True`, which raises `ValueError` on the unpacking side when a map key is an integer. Because channels_redis shares one receive loop per worker, a single latency payload with integer port keys could break every consumer on that worker, including people in the middle of a terminal session. One `str(port)` fixed it.

The channel layer is gone now (notifications go through an in-process hub as JSON), but the keys are still strings, because that is what the frontend and JSON expect anyway.

</details>
