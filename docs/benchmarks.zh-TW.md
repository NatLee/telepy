# 後端效能測試：Django 對 Rust

<p align="center"><a href="./benchmarks.md">English</a> | <b>繁體中文</b> | <a href="./benchmarks.ja.md">日本語</a></p>

> [!NOTE]
> 這是 2026-10-22 的快照，在切換到 Rust 後端（#88–#91）之後馬上量測，並在 #94 加入。它呈現的是這次遷移的前後對照，不是目前的量測結果。
>
> 之後 Django 版本已從儲存庫移除，Telepy 也持續在變：Compose 現在跑 5 個容器，多了負責遠端桌面的 guacd；網頁終端機改用 russh 的 PTY channel，每條通道加帳號共用連線池裡的一條連線，不再啟動 OpenSSH 用戶端。這次遷移的規劃見 [`rust-migration-plan.md`](engineering/rust-migration-plan.md)。

同一台機器、同一個裝置，兩套後端並排跑。Rust 幾乎每一列都贏。例外有兩個：一是終端機的第一筆輸出，兩邊都在等同一個連到裝置的 SSH 交握（裝置才不管是哪種語言在等它）；二是經過 Traefik 的 p99，下面另有一節說明。

## 測試環境

- **版本**：Django 是 `a622634`，Rust 是 `main` @ `464d207`。
- **機器**：一台 Apple Silicon，10 核心、24 GB，透過 OrbStack 執行 Docker。量測日期 2026-10-22。
- **並排執行**：兩套系統同時從不同的 worktree 執行，各有自己的連接埠和資料目錄。
- **裝置**：一個 `linuxserver/openssh-server` 容器，兩邊的通道都連到這同一個裝置。
- **數字**：取所列各次執行的中位數。原始輸出在新增本檔案的 PR（#94）裡。

## 結果

### 裝置與通道

| 指標 | Django | Rust | 變化 |
|---|---|---|---|
| 裝置 SSH 驗證（連線 → `Authenticated to`） | 54 ms | 12 ms | 快 4.5 倍 |
| 裝置連線 → 儀表板顯示上線 | 2.90 s | 0.16 s | 快 18.1 倍 |
| 每個已連線裝置的程序數 | 2 個 sshd，外加取樣腳本每 3–15 秒產生的子程序 | 0（一個 tokio task） | — |

### HTTP API，直連後端

| 請求 | Django | Rust | 變化 |
|---|---|---|---|
| `GET /api/reverse/server/dashboard`，50 並行 | 561 req/s，p50 84 ms，p99 235 ms | 4726 req/s，p50 10 ms，p99 27 ms | 吞吐量 8.4 倍，p99 低 8.7 倍 |
| `GET /api/auth/user/profile`，50 並行 | 943 req/s，p50 50 ms，p99 105 ms | 5727 req/s，p50 8 ms，p99 26 ms | 吞吐量 6.1 倍 |
| `GET /api/reverse/server/dashboard`，200 並行 | 350 req/s，p50 546 ms，p99 895 ms | 4470 req/s，p50 32 ms，p99 78 ms | 吞吐量 12.8 倍 |

### 網頁終端機

| 指標 | Django | Rust | 變化 |
|---|---|---|---|
| 吞吐量（40 MB base64 資料流經 PTY） | 35.1 MB/s | 96.9 MB/s | 2.8 倍 |
| 驗證後到第一筆 PTY 輸出的時間 | 103 ms | 123 ms | 差不多（主要耗在連到裝置的 ssh 交握） |

### 啟動與資源用量

| 指標 | Django | Rust | 變化 |
|---|---|---|---|
| 冷啟動（`compose up --force-recreate backend` → `/api/auth/setup-status` 回應） | 14.2 s（各次：14.2、24.9、13.6） | 0.7 s（各次：1.69、0.71、0.49） | 快 20.1 倍 |
| 記憶體，閒置（backend + redis + ssh 容器 vs 只有 backend） | 329 MiB | 20 MiB | 小 16.5 倍 |
| 記憶體，負載與終端機測試之後 | 341 MiB | 23 MiB | 小 14.8 倍 |
| 容器數 | 6（traefik、frontend、backend、redis、ssh、kasm-browser） | 4 | — |

## 經過 Traefik（瀏覽器實際看到的）

`ab` 每個請求都開一條新的 HTTP/1.0 連線。經過 Traefik、50–200 並行連線時，兩套系統偶爾都會出現約 1 秒的離群值：accept 佇列短暫滿了，SYN 只好重傳。對較快的那套來說，p99 就是這些離群值決定的，所以下面 Rust 的 p99 剛好落在 1 秒左右。

50 並行下三次執行的中位數：

| 端點 | Django | Rust |
|---|---|---|
| `/api/reverse/server/dashboard` | 268 req/s，p50 152 ms，p99 707 ms | 1340 req/s，p50 6 ms，p99 1006 ms |
| `/api/auth/user/profile` | 538 req/s，p50 83 ms，p99 203 ms | 1391 req/s，p50 6 ms，p99 1004 ms |

## 量測方法

- **裝置 SSH 驗證／轉發**：在裝置容器裡執行 `ssh -v -N -R '*:<port>:localhost:2222' telepy@host`，取 `Connecting to`、`Authenticated to` 和 `remote forward success` 這幾行除錯訊息的時間戳。Django：sshd → `AuthorizedKeysCommand` → curl → `/api/reverse/internal/keys`。Rust：程序內的 gateway，直接查資料庫。
- **儀表板顯示上線**：從 ssh 啟動，到 `GET /api/reverse/server/dashboard` 回報該連接埠正在監聽的時間。Django：每 3 秒跑 `ss` → Redis → 請求時讀取。Rust：轉發註冊時直接更新狀態。
- **HTTP 負載**：ApacheBench 2.3，`-n 2000 -c 50`（三次）和 `-n 5000 -c 200`，帶 Bearer token；直連的測試加上 `-l`。「直連」是指從 Compose 網路裡的容器對 `backend:8000` 發送，繞過 Traefik。
- **終端機**：WebSocket 用戶端在 `/ws/terminal/` 驗證，等到提示符號出現後送出 `head -c 40M /dev/zero | base64 -w0`，計算收到結束標記前的文字位元組數。Django：PTY → asyncio reader → Channels。Rust：PTY → tokio → axum。
- **冷啟動**：`docker compose up -d --force-recreate --no-deps backend`，直到健康檢查端點回應為止。Django 在開始監聽前，會先跑 collectstatic 和 migrate。
- **記憶體**：`docker stats --no-stream`，加總屬於後端角色的各個容器。

## 沒有量的項目

- 遠端瀏覽器中繼的 CPU。這需要真的 KasmVNC 工作階段和瀏覽器。
- 大量裝置時的表現。這次只用了一個裝置。

另外值得一提的 Django 時期限制：舊系統得先在容器裡產生兩份從未提交的 Django migration（`user_management`、`site_settings`），個人資料端點才能正常運作。
