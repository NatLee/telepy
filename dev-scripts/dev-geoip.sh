#!/bin/bash
# 下載 DB-IP Lite（國家 + ASN，CC BY 4.0）到 ./telepy-data/geoip（容器內 = /data/geoip = 預設 GEOIP_DIR）。
# 後端只在啟動時讀；每月更新一次後重啟 backend。查詢完全在本機，IP 不會送出去。
# Download the DB-IP Lite country + ASN databases (CC BY 4.0) into ./telepy-data/geoip (/data/geoip in the
# container, the default GEOIP_DIR; a GEOIP_DIR elsewhere under /data moves it to the matching ./telepy-data
# folder). The backend reads them at startup; lookups never leave the server.

source "$(dirname "$0")/common.sh"

DEST=$(data_host_dir GEOIP_DIR /data/geoip) || exit 1
mkdir -p "$DEST"

fetch() {
    local kind=$1 month url tmp
    for month in "$(date -u +%Y-%m)" "$(date -u -v-1m +%Y-%m 2>/dev/null || date -u -d '1 month ago' +%Y-%m)"; do
        url="https://download.db-ip.com/free/dbip-${kind}-lite-${month}.mmdb.gz"
        tmp="$DEST/.dbip-${kind}-lite.mmdb.tmp"
        if curl -fsSL "$url" | gunzip > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
            mv -f "$tmp" "$DEST/dbip-${kind}-lite.mmdb"
            print_message "$GREEN" "  ${kind}: ${month}"
            return 0
        fi
        rm -f "$tmp"
    done
    print_message "$RED" "  ${kind}: download failed"
    return 1
}

print_message "$BLUE" "Downloading DB-IP Lite databases into $DEST ..."
ok=0
fetch country || ok=1
fetch asn || ok=1
if [ $ok -eq 0 ]; then
    print_message "$GREEN" "Done. Restart the backend to load them: docker compose restart backend"
    print_message "$YELLOW" "IP geolocation by DB-IP (https://db-ip.com), CC BY 4.0. Re-run monthly for fresh data."
fi
exit $ok
