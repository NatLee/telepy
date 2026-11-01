# Backend benchmark: Django vs Rust

<p align="center"><b>English</b> | <a href="./benchmarks.zh-TW.md">繁體中文</a> | <a href="./benchmarks.ja.md">日本語</a></p>

> [!NOTE]
> This is a snapshot from 2026-10-22, taken right after the cutover to the Rust backend (#88–#91) and added in #94. It shows the before and after of that migration; it is not a current measurement.
>
> The Django stack has since left the repository, and Telepy has kept changing. Compose now runs 5 containers, with guacd added for remote desktop. Web terminals now run as russh PTY channels on one pooled connection per tunnel and account, instead of spawning the OpenSSH client. The plan behind the migration is [`rust-migration-plan.md`](engineering/rust-migration-plan.md).

Same machine, same device, two backends side by side. Rust wins nearly every row. The exceptions are the terminal's first output, where both backends wait on the same SSH handshake to the device (and the device couldn't care less which language is waiting), and the p99 through Traefik, which has its own section below.

## Setup

- **Versions:** Django at `a622634`, Rust at `main` @ `464d207`.
- **Machine:** one Apple Silicon machine, 10 cores, 24 GB, Docker via OrbStack. Measured on 2026-10-22.
- **Side by side:** both stacks ran at the same time from separate worktrees, each with its own ports and data directory.
- **Device:** one `linuxserver/openssh-server` container, with both tunnels going into that same device.
- **Numbers:** medians of the runs listed. The raw outputs are in the PR that added this file (#94).

## Results

### Devices and tunnels

| Metric | Django | Rust | Change |
|---|---|---|---|
| Device SSH auth (connect → `Authenticated to`) | 54 ms | 12 ms | 4.5× faster |
| Device connect → dashboard shows online | 2.90 s | 0.16 s | 18.1× faster |
| Processes per connected device | 2 sshd + the sampling scripts' subprocesses every 3–15 s | 0 (one tokio task) | — |

### HTTP API, direct to the backend

| Request | Django | Rust | Change |
|---|---|---|---|
| `GET /api/reverse/server/dashboard`, 50 concurrent | 561 req/s, p50 84 ms, p99 235 ms | 4726 req/s, p50 10 ms, p99 27 ms | 8.4× throughput, 8.7× lower p99 |
| `GET /api/auth/user/profile`, 50 concurrent | 943 req/s, p50 50 ms, p99 105 ms | 5727 req/s, p50 8 ms, p99 26 ms | 6.1× throughput |
| `GET /api/reverse/server/dashboard`, 200 concurrent | 350 req/s, p50 546 ms, p99 895 ms | 4470 req/s, p50 32 ms, p99 78 ms | 12.8× throughput |

### Web terminal

| Metric | Django | Rust | Change |
|---|---|---|---|
| Throughput (40 MB base64 stream through the PTY) | 35.1 MB/s | 96.9 MB/s | 2.8× |
| Time to first PTY output after auth | 103 ms | 123 ms | ≈ same (dominated by the ssh handshake to the device) |

### Startup and footprint

| Metric | Django | Rust | Change |
|---|---|---|---|
| Cold start (`compose up --force-recreate backend` → `/api/auth/setup-status` answers) | 14.2 s (runs: 14.2, 24.9, 13.6) | 0.7 s (runs: 1.69, 0.71, 0.49) | 20.1× faster |
| Memory, idle (backend + redis + ssh containers vs backend only) | 329 MiB | 20 MiB | 16.5× smaller |
| Memory after the load + terminal run | 341 MiB | 23 MiB | 14.8× smaller |
| Containers | 6 (traefik, frontend, backend, redis, ssh, kasm-browser) | 4 | — |

## Through Traefik (what the browser sees)

`ab` opens a new HTTP/1.0 connection per request. At 50–200 concurrent connections through Traefik, both stacks show the occasional outlier of about 1 s: a SYN retransmit while the accept queue is briefly full. For the fast stack, those outliers decide the p99, which is why Rust's p99 below sits right around a second.

Medians of three runs at 50 concurrent:

| Endpoint | Django | Rust |
|---|---|---|
| `/api/reverse/server/dashboard` | 268 req/s, p50 152 ms, p99 707 ms | 1340 req/s, p50 6 ms, p99 1006 ms |
| `/api/auth/user/profile` | 538 req/s, p50 83 ms, p99 203 ms | 1391 req/s, p50 6 ms, p99 1004 ms |

## Method

- **Device SSH auth / forward:** `ssh -v -N -R '*:<port>:localhost:2222' telepy@host` from the device container, with timestamps taken on the `Connecting to`, `Authenticated to` and `remote forward success` debug lines. Django: sshd → `AuthorizedKeysCommand` → curl → `/api/reverse/internal/keys`. Rust: in-process gateway, DB lookup.
- **Dashboard online:** time from the ssh start until `GET /api/reverse/server/dashboard` reports the port as listening. Django: `ss` every 3 s → Redis → read on request. Rust: the forward registration updates the status state directly.
- **HTTP load:** ApacheBench 2.3, `-n 2000 -c 50` (three runs) and `-n 5000 -c 200`, with a Bearer token, and `-l` for the direct runs. "Direct" means run from a container inside the Compose network against `backend:8000`, bypassing Traefik.
- **Terminal:** a WebSocket client authenticates on `/ws/terminal/`, waits for the prompt, sends `head -c 40M /dev/zero | base64 -w0`, and measures the text bytes received until the sentinel. Django: PTY → asyncio reader → Channels. Rust: PTY → tokio → axum.
- **Cold start:** `docker compose up -d --force-recreate --no-deps backend` until the health endpoint answers. Django runs collectstatic and migrate before it listens.
- **Memory:** `docker stats --no-stream`, summed over the containers that belong to the backend role.

## Not measured

- Remote-browser relay CPU. That needs a real KasmVNC session and a browser.
- Scale with many devices. Only one device was used.

One more Django-era limitation worth noting: before its profile endpoint worked, the old stack needed two Django migrations that had never been committed (`user_management`, `site_settings`) to be generated inside the container.
