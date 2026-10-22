# syntax=docker/dockerfile:1
# Telepy backend (Rust). Multi-stage: build with the official Rust image, run on a slim Debian with
# only the OpenSSH client (terminal / ssh -D), CA certs (Google JWKS), libssl3 (passkeys) and curl (healthcheck).
# 兩階段：builder 編譯，runtime 只裝 openssh-client / ca-certificates / curl / libssl3。

FROM rust:1-bookworm AS builder

# aws-lc-sys (rustls / russh crypto) builds its C sources; cmake + clang keep that build reliable.
# libssl-dev: webauthn-rs (passkeys) links OpenSSL.
# apt 的下載與索引放在 cache mount（重建這層不必重抓）。/ apt downloads and lists live in cache mounts.
RUN rm -f /etc/apt/apt.conf.d/docker-clean
RUN --mount=type=cache,id=telepy-backend-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=telepy-backend-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends cmake clang pkg-config libssl-dev

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY templates ./templates

# cargo 的 registry 與 target/ 放在 BuildKit cache mount（#54）：跨 build 保留（改程式或升一個依賴只重編有變的
# 部分），而且永遠不會進 image layer。cache mount 不屬於 layer，所以 binary 要在同一步複製出來。
# Cargo's registry and target/ live in BuildKit cache mounts (#54): they survive between builds, so a source
# edit or a dependency bump only recompiles what changed, and they never end up in a layer. The mount is
# not part of the layer, so the binary is copied out in the same step.
RUN --mount=type=cache,id=telepy-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=telepy-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=telepy-backend-target,target=/build/target,sharing=locked \
    cargo build --release --locked \
 && cp target/release/telepy-server /usr/local/bin/telepy-server

FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client ca-certificates curl libssl3 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /logs /config/ssh_host_keys /root/.ssh

COPY --from=builder /usr/local/bin/telepy-server /usr/local/bin/telepy-server

ENV BIND_ADDR=0.0.0.0:8000 \
    DATA_DIR=/data \
    LOG_ROOT=/logs \
    GATEWAY_BIND=0.0.0.0:2222

# 8000: HTTP/WebSocket (Traefik upstream); 2222: SSH gateway (published as REVERSE_SERVER_SSH_PORT).
EXPOSE 8000 2222

ENTRYPOINT ["telepy-server"]
CMD ["serve"]
