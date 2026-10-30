# Where Does That "ms" Come From? — Telepy's Latency Indicator

<p align="center"><b>English</b> | <a href="./latency-deep-dive.zh-TW.md">繁體中文</a> | <a href="./latency-deep-dive.ja.md">日本語</a></p>

> **Update, October 2026:** After the backend was rewritten in Rust, the "Bash probe → Redis → update_ports polling"
> supply chain described in sections 3, 4 and 5 was replaced by the built-in SSH gateway
> (those three sections are marked "Django era" and kept as design context). What it looks like now:
>
> - **Online / offline** is a connection event: when the gateway receives a `tcpip-forward` registration or release, it updates `StatusState` (`monitor/mod.rs`). It no longer samples `ss -tln`.
> - **Latency**: every 15 seconds (`GATEWAY_PROBE_INTERVAL_SECS`), `Gateway::probe_latency` (`gateway/mod.rs`) opens a
>   forwarded-tcpip channel on every forward and reads the first byte of the device's sshd banner. It is the same measurement with no child processes and no Redis. All probes run in parallel, each with a 4-second timeout.
>   The results go straight into memory through `StatusState::record_probes`.
> - **The resident broadcaster** is `monitor/runner.rs` (one round every 5 seconds, started from `main.rs`). The debounce and throttle rules are ported unchanged from `update_ports`
>   (`monitor/ports.rs`: `FLAP_THRESHOLD` 2, 5 ms / 6-round keep-alive).
> - **Not being able to measure is also information**: if the forward is still there but the banner fails to arrive 2 times in a row (`DEGRADED_AFTER`), the tunnel is **degraded** (see Bonus 2 at the end of section 5).
>
> Sections 1, 2 and 6, which describe the frontend and the ping/pong, are still accurate (file names updated).

> A byte's trip around the world, and how we time it.

That little badge in the Telepy terminal title bar:

```
You ●──23ms──● Telepy ●──87ms──● Device   Σ 110ms
```

Looks harmless, doesn't it? Behind it sits a whole supply chain that spans the browser, Django, Redis, the SSH container,
and a "poor man's ping" written in Bash.
(That was the Django era. Today the middle stops have shrunk into one Rust process and its built-in SSH gateway, but the byte takes the same road.)

---

## 1. The World Is Cut in Two

![The terminal's info diagram shows the round trip of each hop](images/en/terminal-flow.png)

End-to-end latency is split into two hops, each measured and owned separately:

| Hop | What it measures | Measured by | How often |
|---|---|---|---|
| You → Telepy | WebSocket RTT between browser and server | Frontend `useTerminalPage` | Every 5 seconds |
| Telepy → Device | Tunnel RTT between the SSH gateway and the remote device's sshd | Backend `Gateway::probe_latency` (Django era: `probe_latency.sh` in the SSH container) | Every 15 seconds |

Why not measure end to end?
Because we can't: the browser can't reach the device, and the device doesn't know the browser exists.
So we do what an accountant does: keep separate books and add them up at the end (Σ).
Both numbers are **round-trip** RTT, not one-way. Please don't argue with the speed of light about them.

---

## 2. Hop 1: ping/pong, and Why the Pong Is Binary

Every 5 seconds the frontend throws one line at the terminal WebSocket:

```json
{ "action": "ping" }
```

The backend (`src/backend-api/src/ws/terminal.rs`; in the Django era `tunnels/consumers.py`) answers with a `pong`. Note that it is a **binary frame**, not text.

This is not engineers being quirky.
The terminal's `onmessage` has an iron rule:
> **Every text frame goes into the screen through `term.write()`**, because that is the highway for PTY output.
If the pong came back as text, a `pong` would appear out of nowhere in your vim every 5 seconds, as if the machine were haunted.
With binary, the frontend sees "oh, that's not characters, it's a control message", checks its watch, computes `Date.now() - pingSentAt`, updates state, and the screen is left untouched.

One frame type has saved countless code reviews.

The "binary = control message" rule was later reused by other features: the `shell` message for kept-alive disconnected sessions, the `command` notices from command rules,
and the `watchers` message for "who is watching" are all binary JSON. The frontend (`parseTerminalFrame` in `lib/commandRules.ts`) first checks whether the content is exactly `pong`,
and only then parses it as JSON. Text frames still all go to `term.write()`.

The application-level ping on the other WebSockets (notifications, single-tunnel status, file manager) is answered with the text `{"type":"pong"}`, because there is no xterm to protect there.
The terminal, file manager and remote browser also have a server-side WebSocket Ping heartbeat (`ws::Heartbeat`, every 20 seconds, dropped after 40 seconds without a reply) that catches connections
whose peer left without sending a close. That is liveness detection, not a latency measurement.

---

## 3. Hop 2: The Day the Kernel Lied

The most intuitive approach is to ask the kernel: `ss -ti` already reports the RTT of every TCP connection, free and instant.
That is what we thought at first.

Then docker-proxy showed up.

When the device's control TCP connection is **terminated** up front by docker-proxy or an L4 load balancer,
the "peer" the kernel sees is actually the proxy on the same machine. So it confidently reports:

> RTT ≈ 0ms. This device lives next door!

In reality the device is in a data center hundreds of kilometers away, waving at you through three layers of NAT. Measuring latency with the kernel's RTT
is like estimating "your house to the train station" from the distance "your house to your front door": a precise measurement of the wrong thing.

### The fix: Active Probe, starring Bash (Django era)

`ssh/custom_scripts/custom-services.d/probe_latency.sh` does it in a rascally but correct way:

1. Use `ss -tln` to find all reverse-tunnel ports (the `-R` forwarding ports sshd binds on `127.0.0.1`).
2. For each port, open a TCP connection directly with Bash's hidden trick `/dev/tcp`. No nc to install, no ICMP;
   Bash itself is the network tool.
3. Check the watch with `$EPOCHREALTIME` (microsecond resolution), then **read just 1 byte**.

```bash
s=$EPOCHREALTIME
exec 3<>/dev/tcp/127.0.0.1/$port
IFS= read -r -N1 _b <&3        # wait for the first byte of the target device's sshd banner
e=$EPOCHREALTIME
```
That 1 byte is the banner of the remote device's sshd (the `S` of `SSH-2.0-...`).
The point is this:
the connection request travels along the **already established reverse tunnel** to the device, and the banner swims back along the tunnel. One trip out and one trip back is a real network round trip.

docker-proxy can fool the kernel, but it can't conjure the device's banner.
The byte has to really make the whole trip, and physics doesn't take bribes.

### Parallelism: a slow device only slows itself down

Probes are fired in parallel (`&` + `wait`), each with a 4-second timeout. A dead-asleep device only burns its own 4 seconds; it doesn't take the other 20 down with it. Total time ≈ the slowest one, not the sum of all.

That is also why this script is deliberately kept **separate** from the 3-second monitoring script that updates port usage (the update_ports mentioned below): however much the latency probe times out, it must never block the online/offline decision. One nurse takes the pulse and another takes the blood pressure.

### Now: the same trick, with the gateway knocking itself

The Rust gateway is itself the other end of the reverse tunnels, so there is no need to go around through ports on `127.0.0.1` any more. `Gateway::probe_latency`
(`src/backend-api/src/gateway/mod.rs`) opens a forwarded-tcpip channel directly on every forward, the kind `ssh -R` opens when it receives an outside connection.
The ssh client on the device connects it to its own sshd, and the probe again **reads just 1 byte**, timed to 0.1 ms.

- Parallel (`join_all`), a 4-second timeout per probe (`PROBE_TIMEOUT`), one round every 15 seconds (`GATEWAY_PROBE_INTERVAL_SECS`).
- Taking the pulse and taking the blood pressure are still two nurses: online / offline comes from forward register / release events, and no amount of probe timeouts will take a tunnel offline.
  But consecutive failures make it **degraded** (Bonus 2 in section 5).
- It stays accurate with an L4 proxy in front, or with Docker rewriting the source address: the byte travels inside the tunnel, not over the TCP connection the kernel sees.

---

## 4. Redis: The Handover Counter Between Two Worlds (Django Era)

The script aggregates the results into multiple lines of `port rtt_ms` and overwrites them into Redis in one go:

```bash
cat "$TMPDIR"/* | redis-cli -x SET ss_probe_latency
```

There is a small trap on the backend side: this key is written raw by `redis-cli`, **without** the Django cache key prefix, so `cache.get("ss_probe_latency")` only ever returns an honest `None`.
Our code therefore reads it with a direct redis-py connection (which also saves the cost of spawning a `redis-cli` subprocess every round, as we used to).

> Returning `None` when it can't be read is fine, but know that "this round's sample is unavailable" and "latency is 0" are two different things. A system that conflates them will eventually wake you up in the middle of the night.

**Now:** there is no handover counter. Probe results go straight into memory through `StatusState::record_probes` (`monitor/mod.rs`), and a port that couldn't be measured
is simply absent from the table (not 0). The distinction between "unavailable" and "0" survives: when the gateway isn't running, `StatusState::latency()` returns `None` and that round isn't broadcast.

---

## 5. update_ports --loop: The Resident Broadcaster (Django Era; Now `monitor/runner.rs`)

> **Now:** `monitor::runner::run` is the Rust version of the same broadcaster, one round every 5 seconds. The steps, throttling and two-way broadcast below are carried over as they were,
> except that step 1 no longer needs to collect from Redis and reads `StatusState` directly.

`update_ports` is a resident Django management command that runs one round every 5 seconds (`--loop` mode; it used to cold-start a whole Django every 5 seconds, which gave the CPU a regular arrhythmic spike).

Each round goes like this:
1. Read `ss_probe_latency` from Redis and write it into the cache as `ports_latency`.
2. Broadcast the latency, and deliberately do so **before the "return early if nothing changed" exit**.
   > Otherwise a tunnel with a stable connection (whose state never changes) would have its latency stuck at the first number forever, a museum exhibit.

### Throttling: not every heartbeat deserves a press release

RTT naturally jitters a few milliseconds: 87, 89, 86, 88... If every round were broadcast, every frontend would re-render every 5 seconds
for a number nobody can tell apart. So:

- If any port changes by **≥ 5ms**, or a port appears or disappears → broadcast.
- Otherwise stay silent, but hold back for at most 6 rounds before forcing a broadcast (keep-alive), to look after a frontend that just connected and missed the last train.

### Two broadcast routes

- **Main page**: push latency to every user, with a payload that contains only the ports **that user has permission for** (owner + people it is shared with).
  Today this is the notification `UPDATE-TUNNEL-LATENCY {latency: {"<port>": rtt_ms}}`, delivered over `/ws/notifications/`.
  > You can't see the latency of other people's tunnels. That is privacy, and also politeness.
- **Terminal page**: real-time updates for a single tunnel. In the Django era this was pushed to the web terminal group; now it is the hub's `tunnel_update` →
  `latency_update {tunnel_id, reverse_port, rtt_ms}` on `/ws/tunnel_connection/{id}/` (both the terminal page and the create wizard subscribe to it).

### Aside: an int as a key takes the whole site down

The ports in the payload must be converted to **string** keys. The channel layer serializes with msgpack, and newer versions default to `strict_map_key=True`: an int as a map key blows up with `ValueError` on the **unpacking side**.

Even better, channels_redis's shared receive loop lets this landmine go off in **any** consumer on the same worker, including innocent users in the middle of a terminal session: everyone disconnected.

> One `str(port)` is the difference between "working fine" and "a paranormal mass-disconnect incident".

There is no channel layer any more (notifications go through the in-process hub, serialized as JSON), but the keys are still strings, because that is what the frontend and JSON expect anyway.

### Bonus 2: Not Being Able to Measure Is Also a Measurement

The Rust version computes one more thing: the forward is still there, but the banner never comes back, because the device's sshd has stopped, is firewalled, or is hung.
The tunnel looks online but nothing can actually get through. So every round `StatusState::record_probes` records "how many failures in a row" for each port (reset on success),
and `DEGRADED_AFTER` (2) consecutive failures means **degraded** (`monitor::health`: online / degraded / offline / never, after Cloudflare Tunnel):

- The gateway writes `degraded` / `recovered` events (visible on the tunnel's Logs page).
- Before the "return early if nothing changed" exit, the runner compares the degraded ports; on a change it pushes `UPDATE-TUNNEL-HEALTH {tunnel_id, name, port, health}` to the people who can see it,
  and also feeds the webhooks subscribed to status events (each with its own delay timer).
- List items carry `health`, and the frontend's `lib/tunnelHealth.liveHealth` merges it with the live port state: an amber dot, an open button that looks offline,
  and a warning toast when a tunnel degrades.

A single failure doesn't count: a device that is occasionally too busy to return the banner within 4 seconds is perfectly normal.

---

## 6. Frontend: Dressing the Number

- **Home page** (the tunnel list) uses one REST call (`/api/reverse/server/dashboard`, a single request returning `{tunnels, ports, latency}`; it used to be three parallel requests,
  one of which was the still-existing `/api/reverse/server/status/latency`) to get a `{port: rtt_ms}` baseline, and after that it is fed entirely by `UPDATE-TUNNEL-LATENCY`.
  When sampling is unavailable, `latency` is `{}`, and the home page just shows no numbers.
- **`LatencyIndicator`**: a 4-bar indicator in the style of a phone signal. <60ms is four green bars (excellent), 60–150 three green (good), 150–300 two amber (fair), >300 one red (poor; consider checking whether you deployed the device on the moon). Can't measure? Gray bars plus `—`, never a made-up 0ms.
- **`TerminalLatencyBadge`**: the two-hop flow path in the terminal page title bar (`TerminalHeader`):
      `You ●──● Telepy ●──● Device`, with data-flow dots animating along the lines. You → Telepy is this tab's own ping/pong,
      Telepy → Device comes from the `rtt_ms` on `/ws/tunnel_connection/{id}/`; hover or tap for the per-hop breakdown.
- **Path diagram**: the terminal page's info dialog (`TerminalFlow`) labels the same two round-trip times on the "you ─ Telepy" and "Telepy ─ device" lines;
  the remote desktop stream stats ([`remote-desktop.md`](./remote-desktop.md)) also use the tunnel latency measured by the monitor as one segment (`tunnel_ms`).
- **Health status**: the status dot / label in the list is online (green), degraded (amber), offline (gray) or never (dashed ring); see Bonus 2 in section 5.
- **Layout-shift OCD**: every number that changes lives in a fixed-width cell with `tabular-nums`.
  When `72ms` grows into `115ms` the layout doesn't budge. Nothing is more ironic than a latency badge that jumps around because the latency went up.

---

## 7. Summary: A Byte's Résumé

1. Every 15 seconds the gateway sends a "knock" down every reverse tunnel (a forwarded-tcpip channel) and starts the stopwatch, waiting for the first byte of the banner to swim back.
2. The score goes straight into memory (`StatusState`); a port that fails twice in a row is recorded as degraded.
3. The resident `monitor/runner.rs` collects it every 5 seconds, throttles it, and distributes it through the in-process hub to the people with permission (keys are still strings).
4. The frontend draws it as signal bars and a flow path, and separately measures the browser-to-server segment with its own ping/pong (binary!).
5. The two segments added up ≈ the real-world distance between you and your device.

(The Django-era version: step 1 was Bash in the SSH container, step 2 was Redis's `ss_probe_latency`, step 3 was `update_ports` + the channel layer.)

The design philosophy in one sentence: **trust no hearsay (kernel, proxy); trust only the byte that ran the whole way itself.**
