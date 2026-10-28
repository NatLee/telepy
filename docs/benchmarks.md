# Backend benchmark: Django (a622634) vs Rust (main @ 464d207)

> **Status:** a snapshot from 2026-10-22, taken right after the cutover to the Rust backend (#88–#91) and added in #94. It is the before / after of that migration, not a current measurement: the Django stack is gone from the repo, and Telepy has changed since (the compose file now runs 5 containers, with guacd for remote desktop; web terminals run as russh PTY channels on one pooled connection per tunnel and account instead of spawning the OpenSSH client). The plan behind it is [`rust-migration-plan.md`](rust-migration-plan.md).

Measured 2026-10-22 on one machine (Apple Silicon, 10 cores, 24 GB, Docker via OrbStack), both stacks running side by side from separate worktrees with their own ports and data directories, one `linuxserver/openssh-server` container as the device, both tunnels into the same device. Numbers are medians of the runs listed; the raw outputs are in the PR that added this file (#94).

## Summary

| Metric | Django | Rust | Change |
|---|---|---|---|
| Device SSH auth (connect → `Authenticated to`) | 54 ms | 12 ms | 4.5× faster |
| Device connect → dashboard shows online | 2.90 s | 0.16 s | 18.1× faster |
| `GET /api/reverse/server/dashboard`, 50 concurrent, direct to backend | 561 req/s, p50 84 ms, p99 235 ms | 4726 req/s, p50 10 ms, p99 27 ms | 8.4× throughput, 8.7× lower p99 |
| `GET /api/auth/user/profile`, 50 concurrent, direct to backend | 943 req/s, p50 50 ms, p99 105 ms | 5727 req/s, p50 8 ms, p99 26 ms | 6.1× throughput |
| dashboard, 200 concurrent, direct | 350 req/s, p50 546 ms, p99 895 ms | 4470 req/s, p50 32 ms, p99 78 ms | 12.8× throughput |
| Web terminal throughput (40 MB base64 stream through the PTY) | 35.1 MB/s | 96.9 MB/s | 2.8× |
| Web terminal, time to first PTY output after auth | 103 ms | 123 ms | ≈ same (dominated by the ssh handshake to the device) |
| Cold start (`compose up --force-recreate backend` → `/api/auth/setup-status` answers) | 14.2 s (runs: 14.2, 24.9, 13.6) | 0.7 s (runs: 1.69, 0.71, 0.49) | 20.1× faster |
| Memory, idle (backend + redis + ssh containers vs backend only) | 329 MiB | 20 MiB | 16.5× smaller |
| Memory after the load + terminal run | 341 MiB | 23 MiB | 14.8× smaller |
| Containers | 6 (traefik, frontend, backend, redis, ssh, kasm-browser) | 4 | — |
| Processes per connected device | 2 sshd + the sampling scripts' subprocesses every 3–15 s | 0 (one tokio task) | — |

## Through Traefik (what the browser sees)

`ab` opens a new HTTP/1.0 connection per request; at 50–200 concurrent connections through Traefik both stacks show occasional ~1 s outliers (SYN retransmit when the accept queue is briefly full), which dominates p99 for the fast stack. Medians of three runs at 50 concurrent:

| Endpoint | Django | Rust |
|---|---|---|
| `/api/reverse/server/dashboard` | 268 req/s, p50 152 ms, p99 707 ms | 1340 req/s, p50 6 ms, p99 1006 ms |
| `/api/auth/user/profile` | 538 req/s, p50 83 ms, p99 203 ms | 1391 req/s, p50 6 ms, p99 1004 ms |

## Method

- **Device SSH auth / forward**: `ssh -v -N -R '*:<port>:localhost:2222' telepy@host` from the device container; timestamps taken on the `Connecting to`, `Authenticated to` and `remote forward success` debug lines. Django: sshd → `AuthorizedKeysCommand` → curl → `/api/reverse/internal/keys`. Rust: in-process gateway, DB lookup.
- **Dashboard online**: time from the ssh start until `GET /api/reverse/server/dashboard` reports the port as listening. Django: `ss` every 3 s → Redis → read on request. Rust: forward registration updates the status state directly.
- **HTTP load**: ApacheBench 2.3, `-n 2000 -c 50` (three runs) and `-n 5000 -c 200`, Bearer token, `-l` for the direct runs; "direct" = run from a container inside the compose network against `backend:8000`, bypassing Traefik.
- **Terminal**: a WebSocket client authenticates on `/ws/terminal/`, waits for the prompt, sends `head -c 40M /dev/zero | base64 -w0`, and measures received text bytes until the sentinel. Django: PTY → asyncio reader → Channels. Rust: PTY → tokio → axum.
- **Cold start**: `docker compose up -d --force-recreate --no-deps backend` until the health endpoint answers (Django runs collectstatic + migrate before listening).
- **Memory**: `docker stats --no-stream`, summed over the containers that belong to the backend role.

Not measured: remote-browser relay CPU (needs a real KasmVNC session and a browser), many-device scale (one device only). The remaining Django-era limitation worth noting: the old stack needed the two Django migrations that had never been committed (`user_management`, `site_settings`) to be generated inside the container before its profile endpoint worked.
