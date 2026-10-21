# Telepy backend (Rust). Multi-stage: build with the official Rust image, run on a slim Debian with
# only the OpenSSH client (terminal / ssh -D), CA certs (Google JWKS) and curl (healthcheck).
# 兩階段：builder 編譯，runtime 只裝 openssh-client / ca-certificates / curl。

FROM rust:1-bookworm AS builder

# aws-lc-sys (rustls / russh crypto) builds its C sources; cmake + clang keep that build reliable.
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake clang pkg-config \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# 先只拿 manifest 編譯依賴，讓程式碼變更不必重抓/重編所有 crate。
# Warm the dependency cache with a stub crate so source edits don't rebuild every dependency.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src templates \
 && echo 'fn main() {}' > src/main.rs \
 && touch src/lib.rs \
 && cargo build --release --locked \
 && rm -rf src templates

COPY src ./src
COPY templates ./templates
RUN touch src/main.rs src/lib.rs && cargo build --release --locked

FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /logs /config/ssh_host_keys /root/.ssh

COPY --from=builder /build/target/release/telepy-server /usr/local/bin/telepy-server

ENV BIND_ADDR=0.0.0.0:8000 \
    DATA_DIR=/data \
    LOG_ROOT=/logs \
    GATEWAY_BIND=0.0.0.0:2222

# 8000: HTTP/WebSocket (Traefik upstream); 2222: SSH gateway (published as REVERSE_SERVER_SSH_PORT).
EXPOSE 8000 2222

ENTRYPOINT ["telepy-server"]
CMD ["serve"]
