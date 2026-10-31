# 後端效能測試：Django (a622634) vs Rust (main @ 464d207)

<p align="center"><a href="./benchmarks.md">English</a> | <b>繁體中文</b> | <a href="./benchmarks.ja.md">日本語</a></p>

> **狀態：** 這是 2026-10-22 的快照，在切換到 Rust 後端（#88–#91）之後立即量測，並於 #94 加入。它呈現的是這次遷移前後的對照，不是目前的量測結果：Django 版本已從儲存庫移除，Telepy 之後也有不少變動（compose 檔現在執行 5 個容器，其中 guacd 負責遠端桌面；網頁終端機改以 russh 的 PTY 通道運作，每個通道與帳號共用一條連線池中的連線，不再啟動 OpenSSH 用戶端）。這次遷移的規劃見 [`rust-migration-plan.md`](engineering/rust-migration-plan.md)。

量測於 2026-10-22，在同一台機器上進行（Apple Silicon、10 核心、24 GB、透過 OrbStack 執行 Docker）。兩套系統分別從不同的 worktree 並排執行，各有自己的連接埠與資料目錄；裝置是一個 `linuxserver/openssh-server` 容器，兩邊的通道都連到同一個裝置。數字取自所列各次執行的中位數，原始輸出在新增本檔案的 PR（#94）中。

## 摘要

| 指標 | Django | Rust | 變化 |
|---|---|---|---|
| 裝置 SSH 驗證（連線 → `Authenticated to`） | 54 ms | 12 ms | 快 4.5 倍 |
| 裝置連線 → 儀表板顯示上線 | 2.90 s | 0.16 s | 快 18.1 倍 |
| `GET /api/reverse/server/dashboard`，50 並行，直連後端 | 561 req/s，p50 84 ms，p99 235 ms | 4726 req/s，p50 10 ms，p99 27 ms | 吞吐量 8.4 倍，p99 低 8.7 倍 |
| `GET /api/auth/user/profile`，50 並行，直連後端 | 943 req/s，p50 50 ms，p99 105 ms | 5727 req/s，p50 8 ms，p99 26 ms | 吞吐量 6.1 倍 |
| dashboard，200 並行，直連 | 350 req/s，p50 546 ms，p99 895 ms | 4470 req/s，p50 32 ms，p99 78 ms | 吞吐量 12.8 倍 |
| 網頁終端機吞吐量（40 MB base64 資料流經 PTY） | 35.1 MB/s | 96.9 MB/s | 2.8 倍 |
| 網頁終端機，驗證後到第一筆 PTY 輸出的時間 | 103 ms | 123 ms | 差不多（主要耗在與裝置的 ssh 交握） |
| 冷啟動（`compose up --force-recreate backend` → `/api/auth/setup-status` 回應） | 14.2 s（各次：14.2、24.9、13.6） | 0.7 s（各次：1.69、0.71、0.49） | 快 20.1 倍 |
| 記憶體，閒置（backend + redis + ssh 容器 vs 僅 backend） | 329 MiB | 20 MiB | 小 16.5 倍 |
| 記憶體，負載與終端機測試之後 | 341 MiB | 23 MiB | 小 14.8 倍 |
| 容器數 | 6（traefik、frontend、backend、redis、ssh、kasm-browser） | 4 | — |
| 每個已連線裝置的處理程序 | 2 個 sshd，外加取樣腳本每 3–15 秒產生的子處理程序 | 0（一個 tokio task） | — |

## 經過 Traefik（瀏覽器實際看到的）

`ab` 每個請求都會開新的 HTTP/1.0 連線；在 50–200 並行連線經過 Traefik 時，兩套系統偶爾都會出現約 1 秒的離群值（accept 佇列短暫滿載時的 SYN 重傳），這對較快的那套而言主導了 p99。以下為 50 並行下三次執行的中位數：

| 端點 | Django | Rust |
|---|---|---|
| `/api/reverse/server/dashboard` | 268 req/s，p50 152 ms，p99 707 ms | 1340 req/s，p50 6 ms，p99 1006 ms |
| `/api/auth/user/profile` | 538 req/s，p50 83 ms，p99 203 ms | 1391 req/s，p50 6 ms，p99 1004 ms |

## 量測方法

- **裝置 SSH 驗證／轉發**：在裝置容器內執行 `ssh -v -N -R '*:<port>:localhost:2222' telepy@host`，取 `Connecting to`、`Authenticated to` 與 `remote forward success` 這幾行除錯訊息的時間戳。Django：sshd → `AuthorizedKeysCommand` → curl → `/api/reverse/internal/keys`。Rust：行程內的閘道，直接查資料庫。
- **儀表板顯示上線**：從 ssh 啟動到 `GET /api/reverse/server/dashboard` 回報該連接埠正在監聽的時間。Django：每 3 秒 `ss` → Redis → 請求時讀取。Rust：轉發註冊時直接更新狀態。
- **HTTP 負載**：ApacheBench 2.3，`-n 2000 -c 50`（三次）與 `-n 5000 -c 200`，帶 Bearer token；直連測試加上 `-l`。「直連」指從 compose 網路內的容器對 `backend:8000` 發送，繞過 Traefik。
- **終端機**：WebSocket 用戶端在 `/ws/terminal/` 驗證後等待提示符號，送出 `head -c 40M /dev/zero | base64 -w0`，並計算收到的文字位元組數直到結束標記。Django：PTY → asyncio reader → Channels。Rust：PTY → tokio → axum。
- **冷啟動**：`docker compose up -d --force-recreate --no-deps backend`，直到健康檢查端點回應為止（Django 在開始監聽前會先執行 collectstatic 與 migrate）。
- **記憶體**：`docker stats --no-stream`，加總屬於後端角色的各容器。

未量測：遠端瀏覽器中繼的 CPU（需要真實的 KasmVNC 工作階段與瀏覽器）、大量裝置的規模（只用了一個裝置）。另一項值得一提的 Django 時期限制：舊系統必須先在容器內產生兩份從未提交的 Django migration（`user_management`、`site_settings`），個人資料端點才能正常運作。
