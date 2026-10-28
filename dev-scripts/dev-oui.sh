#!/bin/bash
# 下載 IEEE 的 OUI 表（網卡廠商，公開資料）到 ./telepy-data/oui/oui.csv（容器內 = /data/oui = 預設 OUI_DIR）。
# 區網掃描到的 MAC 會顯示廠商（例如 Raspberry Pi、Synology）。後端只在啟動時讀；偶爾重跑後重啟 backend。
# Download IEEE's public OUI registry into ./telepy-data/oui/oui.csv (/data/oui in the container) so LAN hosts
# show their NIC vendor. The backend reads it at startup; lookups stay on the server.

source "$(dirname "$0")/common.sh"

DEST=$(data_host_dir OUI_DIR /data/oui) || exit 1
URL=https://standards-oui.ieee.org/oui/oui.csv
mkdir -p "$DEST"
tmp="$DEST/.oui.csv.tmp"
print_message "$BLUE" "Downloading the IEEE OUI registry into $DEST ..."
if curl -fsSL --max-time 120 "$URL" -o "$tmp" && head -1 "$tmp" | grep -q "^Registry,Assignment"; then
    mv -f "$tmp" "$DEST/oui.csv"
    print_message "$GREEN" "Done: $(($(wc -l < "$DEST/oui.csv") - 1)) vendors. Restart the backend to load them: docker compose restart backend"
    exit 0
fi
rm -f "$tmp"
print_message "$RED" "Download failed: $URL"
exit 1
