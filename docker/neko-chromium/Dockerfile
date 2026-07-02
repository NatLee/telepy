# Telepy custom Neko chromium image
# Base: official m1k1o/neko v3 chromium; only the supervisord chromium
# program is overridden to support env-driven SOCKS proxy injection.
FROM ghcr.io/m1k1o/neko/chromium:latest

# 明確標注 neko API 版本,讓 neko-rooms 的自動偵測(ImageInspect)永遠正確;
# service 端另會顯式送 api_version=3,雙保險。
LABEL net.m1k1o.neko.api-version=3

# proxy 由後端經 neko-rooms envs 注入;預設空字串 = 直連(image 可單獨啟動)
ENV PROXY_SERVER=""

# 覆寫官方 chromium 啟動設定,加入條件式 --proxy-server(含 openbox 段)
COPY chromium.conf /etc/neko/supervisord/chromium.conf
