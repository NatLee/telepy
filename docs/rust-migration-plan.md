# Telepy → Rust 後端重構規劃

> 狀態：已拍板、實作中（2026-10-22）。對應程式碼版本：`bd7e29c`。追蹤：GitHub #80 與 sub-issues #81–#87。
> 本文是「看完現有程式碼後」的重構規劃，不是最終設計書；每個 Phase 開工前再各自細化。

---

## 0. 一句話結論

**把 Django 後端（REST + 5 條 WebSocket + 背景 worker）改寫成單一 Rust binary（axum + tokio），
沿用現有 SQLite 檔與 Django 的資料表結構、沿用前端的 API/WS 契約，**一次全切**（Rust 做到完整 parity、
golden tests 兩邊都綠後，compose 的 `backend` 直接換 image），前端 Next.js 原封不動，**Redis 移除**。**

速度上真正會變快的是：**每個 request/frame 的 Python 開銷、PTY 與 VNC 轉發的 per-byte 成本、
記憶體（3 個 gunicorn worker → 1 個 process）、冷啟動（30s → <1s）、sshd `AuthorizedKeysCommand`
的回應（登入路徑）**。不會變快的是 SSH 雙跳 handshake、KasmVNC 編碼、網路 RTT——這些不在 Python 裡。

---

## 1. 現況盤點（程式碼審閱摘要）

### 1.1 元件與規模

| 元件 | 位置 | 行數 | 職責 |
|---|---|---|---|
| WebSocket consumers | `tunnels/consumers.py` | 1 420 | 5 條 WS：terminal(PTY+ssh)、notifications、tunnel_connection、filemanager、remote-browser relay；共用「第一則訊息帶 JWT」認證基底 |
| REST（tunnels） | `tunnels/views.py` | 1 031 | 腳本/設定渲染、一次性 token、分享/權限 API |
| REST（keys） | `authorized_keys/views.py` + `browse_views.py` | 716 | tunnels CRUD / dashboard / usernames / service keys / `internal/keys`（sshd 用）/ remote-browser start-stop-ping |
| 背景 worker | `authorized_keys/management/commands/update_ports.py` | 398 | 每 5s 讀 Redis 的 `ss_output`/`ss_probe_latency`，去彈跳、節流、經 channel layer 廣播 |
| Remote browser 服務 | `authorized_keys/remote_browser_service.py` + `services/kasm_client.py` | 552 | `ssh -D` SOCKS、呼叫 kasm session-manager、Redis session store、GC |
| SFTP REST | `web_sftp/views.py` | 355 | 用 `shell=True` 拼字串呼叫 `ssh`/`scp` |
| 權限 | `tunnels/models.py` + `services/tunnel_permissions.py` | 741 | VIEW/EDIT/ADMIN 階層、allowed usernames |
| 認證 | `custom_jwt/`, `custom_auth/`, `login/` | ~420 | simplejwt、Google id_token 驗證、註冊 |
| 設定 | `user_management/`, `site_settings/` | ~450 | 使用者偏好、全站設定 |
| 腳本模板 | `tunnels/tunnel_script_renderer/` | ~450 | `string.Template` `$var` 置換 7 個模板 |
| **後端合計** | | **≈9 650** | 7 個 migration、約 65 個測試 |
| 前端 | `src/frontend/src` | ≈14 600 | Next.js 16、純 client component、xterm.js、vendored KasmVNC noVNC fork、三語 i18n |
| kasm session-manager | `docker/kasm-browser/session_manager.py` | 30 KB | 純 stdlib HTTP API，在 kasm 容器內起停 Xkasmvnc/chromium |
| SSH 容器腳本 | `ssh/` | — | `AuthorizedKeysCommand` → curl 後端；`update_ports.sh`/`probe_latency.sh` → `redis-cli SET` |

### 1.2 從 commit 與註解看得到的效能痛點（都是 Python/Django 架構層級的）

- **多 process 才有併發**：gunicorn × 3 uvicorn worker，代價是 SQLite 寫鎖衝突（settings 裡一整段 WAL/timeout/IMMEDIATE 緩解）、remote-browser session 要靠 Redis 跨 worker 查、`ssh -D` Popen 只有 owner worker 能殺（孤兒 GC 一整套）。
- **event loop 被阻塞就全員斷線**：PTY non-blocking、`sync_to_async` 合併成單次 DB round-trip、batch `group_send` 共用 event loop……全是為了繞 Python 單執行緒 event loop。
- **channel layer（msgpack over Redis）是隱形炸彈**：int map key 讓同 worker 任意 consumer 一起炸；redis-py socket_timeout 與 BZPOPMIN 對撞造成全面斷線。
- **背景 worker 冷啟動**：`update_ports` 原本每 5s 冷啟整個 Django，改 `--loop` 才解掉 CPU 尖峰。
- **N+1**：序列化每列 4–6 次 TunnelSharing 查詢，靠預計算 context 修掉。
- **啟動慢**：`collectstatic` + `migrate` + import Django，compose 要 60s `start_period`。
- **fd 洩漏、孤兒 reader**：PTY fd 未關、例外逃出 handler 跳過 `disconnect()`。

這些在 Rust 單一 process + tokio 的模型下**大多直接消失**（不是「修好」，是問題本身不存在）。

### 1.3 已知的正確性/安全問題（重寫時順手解）

- `web_sftp/views.py` 以 `shell=True` 拼接使用者路徑 → **命令注入**。
- `SECRET_KEY` 硬編碼在 `settings.py`（`django-insecure-…`）且同時是 JWT 簽章金鑰。
- `CORS_ALLOW_ALL_ORIGINS = True`、`ALLOWED_HOSTS = ['*']`。
- `tunnels/views.py` 前 60 行的 Django template 頁面（`tunnels.html` 等）與 `static/js/*` 已是死碼（Traefik 把這些路徑導去前端）。

### 1.4 哪些東西不該動

- 裝置端契約：`ssh -NR '*:<port>:localhost:22' telepy@server -p 24242` 與產生的六種腳本，一個字都不改。
- SSH 容器：依 #86 的決策（§3.6）決定是保留 OpenSSH 容器＋Rust agent，還是由後端內建 gateway 取代。
- kasm-browser 容器與 session-manager（可選擇性之後再動）。
- 前端：API/WS 契約不變就零改動。
- `~/.ssh/config` 裡的 ControlMaster / `setsid` ProxyCommand 設計（註解記載了多個實測 bug，照抄）。

---

## 2. 目標與非目標

### 目標
1. 後端 100% Rust，單一 binary、單一 process；前端不改一行即可切換。
2. 不搬資料：直接讀寫現有 `/data/db.sqlite3`（Django 表名）；啟動時以冪等 DDL 補齊缺表/缺欄（新安裝與舊 DB 都能用）。
   切換失敗的回滾方式是 compose 換回 Django image（同一個 DB 檔，JWT 金鑰相同）。
3. 修掉 1.3 的問題；移除 supervisor / gunicorn / channels / collectstatic。
4. 建立 before/after 效能基線（§7），用數字證明值得。

### 非目標（這一輪刻意不做）
- **不**用 Rust（Leptos/Yew/Dioxus）重寫前端。理由：14.6k 行、xterm.js 與 vendored KasmVNC client 只有 JS 實作、瓶頸不在前端框架。後端完成後若仍想做再另案。
- terminal 繼續用 OpenSSH `ssh` 客戶端 binary（見 §3.4）；是否由後端內建 SSH **server**（gateway）見 §3.6，待決。
- **不**在第一輪引入 Postgres。

---

## 3. 目標架構

### 3.1 拓撲

```
現況（6 容器）                              目標（Phase 5 後：5 容器；Phase 6 後可到 3 容器）
traefik ──/api,/ws,/tunnels/*──▶ backend      traefik ──/api,/ws,/tunnels/*──▶ telepy-server (Rust, 1 process)
        └──其餘──▶ frontend (node)                    └──其餘──▶ frontend (node)   [Phase 6: 由 Rust 直接服務靜態檔]
backend: supervisord                           telepy-server:
  ├─ gunicorn × 3 uvicorn workers                ├─ axum HTTP + WS（同一個 tokio runtime）
  └─ update_ports --loop                         ├─ tokio task: port monitor（取代 update_ports）
redis: cache + channel layer + session store     ├─ tokio task: remote-browser reaper
ssh, kasm-browser                                └─ in-process NotificationHub（取代 channel layer）
                                               （無 redis：ssh 側取樣改 HTTP push 到後端，或由內建 gateway 直接產生）
                                               ssh（依 §3.6 決策）, kasm-browser（不變）
```

### 3.2 Crate 選型

| 用途 | Crate | 備註 |
|---|---|---|
| HTTP / WS / 路由 | `axum` 0.8 + `tokio` + `tower-http`（compression, cors, trace, fs） | WS 用 axum 內建 `extract::ws` |
| DB | `sqlx`（sqlite, runtime-tokio, macros） | compile-time 查詢檢查；針對 Django 表名寫 SQL |
| JWT | `jsonwebtoken` | HS256，claims 與 simplejwt 相容（§3.3） |
| 密碼 | `pbkdf2` + `sha2` + `base64` | 驗證/產生 Django `pbkdf2_sha256$…` 格式 |
| Google 登入 | `reqwest` + `jsonwebtoken`（RS256, JWKS 快取） | 取代 `google-auth` |
| PTY | `nix`（`forkpty`）或 `portable-pty` + `tokio::io::unix::AsyncFd` | terminal |
| 子程序 | `tokio::process` | `ssh -D`、`ssh`（argv 形式，不經 shell） |
| 原生 SSH/SFTP | `russh` + `russh-sftp` | file manager（§3.5） |
| 上游 WS | `tokio-tungstenite` | KasmVNC relay |
| 模板 | 自寫 `$var` safe_substitute（30 行）或 `minijinja` | 7 個模板檔原樣搬 |
| API 文件 | `utoipa` + `utoipa-swagger-ui` | 維持 `/api/__hidden_swagger` 路徑 |
| 日誌 | `tracing` + `tracing-appender`（daily rolling） | 輸出 `/logs/telepy.log`、`error.log` |
| CLI | `clap` | `serve` / `migrate` / `create-superuser` / `seed-service-key` |
| 快取/TTL | `moka` 或 `DashMap` + 時間戳 | 一次性 token、script token、session |
| 壓縮下載 | `zip` + `async-compression` | 取代 spawn `zip` |

### 3.3 關鍵設計決策

1. **DB：沿用 Django schema，零搬遷。** Rust 直接對 `auth_user`、`authorized_keys_reverseserverauthorizedkeys`、`tunnels_tunnelsharing`… 下 SQL。單一寫入連線（`max_connections=1` 的 writer pool）+ 多讀連線，WAL、`busy_timeout=20s`、寫入一律 `BEGIN IMMEDIATE`。Django 退役後由 `sqlx migrate` 接手，第一個 migration 是空 baseline。
2. **JWT 相容。** HS256，claims `{token_type, exp, iat, jti, user_id}`，簽章金鑰改讀 env `SECRET_KEY`。切換當下把 settings.py 那把 key 放進 `.env` 即可做到既有 token 不失效；之後再輪替（使用者重新登入一次）。
3. **密碼。** 驗證並**繼續產生** `pbkdf2_sha256` 格式直到 Django 退役（保證可回滾）；之後可改 argon2id 並在登入時 rehash。
4. **Google 登入。** 驗 id_token（JWKS、iss、aud、exp），domain allowlist 讀 `site_settings`。**移除 session login**（只有 Django admin 需要）。
5. **通知 hub 在 process 內。** `DashMap<UserId, broadcast::Sender<Arc<str>>>` + `DashMap<TunnelId, …>`；單 process 不需要 channel layer。未來要多副本再加 Redis pub/sub（介面先抽 trait）。
6. **Port monitor 進 binary，Redis 移除。** 狀態與延遲由內建 gateway（§3.6）直接產生（連線事件 + keepalive 往返）；去彈跳（FLAP_THRESHOLD=2）與延遲節流（5ms / 6 輪 keep-alive）**移植成純函式並寫單元測試**；取樣超過 15s 沒更新視為「本輪不可用」（等同舊版的 None）。
7. **Remote browser session 在記憶體。** 單 process → `ssh -D` 的 child handle 與 session 同在一個 map；reaper task 取代「Redis TTL + 孤兒掃描」那一整套。另存一張 Rust 自有的小表 `telepy_remote_browser_session`，後端重啟時據此把 kasm 側的孤兒 session 收掉。`ssh -D` 的硬化參數（BatchMode / ExitOnForwardFailure / ControlMaster=no …）照搬。
8. **Terminal 保留 OpenSSH 客戶端。** 理由見 §3.4。
9. **File manager 改原生 SFTP。** 理由見 §3.5。
10. **Django admin 退役。** 使用者管理已有前端 Settings → Users；superuser 建立改 CLI；`tunnels/admin.py` 的 permission-group 頁面不保留（需確認無人在用）。
11. **錯誤訊息字串逐字保留。** 前端 `formatApiError` 讀 `detail`/`error`；remote-browser 靠 `code`；有些狀態碼由錯誤文字推導（例如 unshare 的 `'not found' in error`）。先逐字相容，之後再整理成 error code。

### 3.4 Terminal：為什麼不用 russh 而繼續 spawn `ssh`

現有設計把大量 hard-won 的行為放在 OpenSSH 的 ControlMaster/ControlPersist 與 `~/.ssh/config`：
- 第一條連線成為 master，後續分頁 0 次 handshake；
- ProxyCommand 用 `setsid` 脫離 PTY session，否則關第一個分頁會踢掉全部分頁；
- 斷線只能 `kill(pid)`、**絕不可 `killpg`**（會殺到 master 的 proxy）；
- 遠端 sshd `MaxSessions=10` → 分頁上限 6。

用 russh 自己做多工當然可以，但要重做這整套且沒有運維驗證過。Rust 版：`forkpty` → `execvp("ssh", argv)`（不經 bash）、master fd 以 `AsyncFd` 讀、保留增量 UTF-8 解碼（前端把 **binary frame 當 pong**，PTY 輸出必須走 text frame）、`TIOCSWINSZ` resize、`SIGTERM` → 500ms 輪詢 → `SIGKILL`。效益來自去掉 Python 的 per-chunk 開銷，不是換 SSH 實作。

### 3.5 File manager：改原生 SFTP（russh + russh-sftp）

現況：每個操作 spawn `ssh … 'ls -la <path>'` 再解析文字（Windows 走 PowerShell + JSON），下載用 `scp` 到暫存檔再整個讀進記憶體，而且 `shell=True`。
Rust 版：
- 連線池 key = `(tunnel_id, username)`：russh 連 `ssh:2222`（第一跳）→ `direct-tcpip` 到 `127.0.0.1:<reverse_port>` → 在該 channel 上再開一層 russh session（第二跳）→ `sftp` subsystem。
- `readdir` 直接拿到結構化 attrs（permissions/size/mtime），不再解析 `ls`。Win32-OpenSSH 預設有 SFTP subsystem，Windows 裝置也統一。
- 下載：串流（`StreamBody`），目錄打包用 `zip` crate 邊走邊壓；上傳：multipart 串流直接寫 SFTP。
- Fallback：SFTP subsystem 不存在時退回 exec `ls -la`（保留現有解析邏輯）。
- 主機金鑰策略與現況一致（不驗，`StrictHostKeyChecking no` 的等價物），安全邊界不變。

### 3.6 SSH 側：PID 上限問題與兩個選項（#86，**已決：B**）

現況 OpenSSH 容器會撞到 PID 上限。每條隧道在 sshd 固定是 2 個 process（privsep），這部分任何 sshd 都一樣；
真正造成尖峰的是腳本：`probe_latency.sh` 每 15s 對每個 port 同時 spawn `timeout`+`bash`+`awk`（N 條隧道 ≈ 3N 個短命
process 一次爆開）、`update_ports.sh` 每 3s spawn `ss`+`redis-cli`、`AuthorizedKeysCommand` 每次認證 spawn bash+curl+date+cat
（autossh 重連風暴時最兇）。

| | A. OpenSSH 容器 + Rust agent | B. 後端內建 SSH gateway（russh server） |
|---|---|---|
| 做法 | 一個常駐 agent：讀 `/proc/net/tcp` 取 LISTEN 埠、async TCP 做延遲探測（0 子程序）、HTTP push；`AuthorizedKeysCommand` 換成靜態 Rust 小程式 | 後端直接聽 24242；只接受公鑰認證 + `tcpip-forward`，其餘一律拒絕；每條隧道是 tokio task |
| PID | 2/隧道 + 1，尖峰消失 | 0/隧道（沒有 ssh 容器） |
| 上線/離線 | 仍是取樣（3s） | 事件驅動（連線建立/中斷即知） |
| 延遲 | 仍是 banner 探測 | SSH keepalive 往返（精準、免探測） |
| terminal/SFTP/SOCKS | 仍是雙跳 ProxyCommand | 單跳：後端在 loopback 綁 `127.0.0.1:<reverse_port>` 橋到 forwarded-tcpip channel，OpenSSH 客戶端照用 |
| 容器 | 5（backend/frontend/traefik/ssh/kasm） | 2–4（backend/kasm；frontend/traefik 視 Phase 6） |
| 工時 | +3–4 天 | +1.5–2 週 |
| 風險 | 低 | 中：安全敏感、需與各版 OpenSSH/autossh 互通驗證；但只實作 SSH server 的極小子集 |

**已採用 B**（2026-10-22）。正式切換時既有 TCP 連線會斷一次，autossh/systemd/Docker 腳本自動重連，與今天重啟 ssh 容器的影響相同；
gateway 沿用 `ssh/ssh_host_keys/` 的 host key；回滾 = 以 compose profile `legacy-sshd` 把 OpenSSH 容器開回來。
細節（協定原理、硬化、驗收矩陣）見 GitHub #86。

---

## 4. 必須 100% 相容的契約

### 4.1 REST（前端實際呼叫 + ssh 容器呼叫）

```
POST /api/auth/token | token/refresh | token/verify      GET /api/auth/setup-status | user/profile
POST /api/auth/google/token   POST /api/auth/register
GET  /api/reverse/server/dashboard                      GET /api/reverse/server/status/{ports,latency}
GET/POST/PUT/PATCH/DELETE /api/reverse/server/keys[/{id}]   /api/reverse/user/keys[/{id}]   /api/reverse/server/usernames[/{id}]
GET  /api/reverse/server/{id}/usernames                 PATCH /api/reverse/server/{id}/default-username
GET  /api/reverse/service/keys                          GET /api/reverse/internal/keys?key_type=&key=   (Bearer INTERNAL_API_TOKEN, text/plain)
GET  /api/reverse/issue/token   POST /api/reverse/create/key/{token}   POST /api/reverse/create/key/duplicate/{token}
POST /api/reverse/server/{id}/remote-browser/start      POST /api/reverse/server/remote-browser/{sid}/{stop,ping}
GET  /api/sftp/{shell,list,download}/{id}/{username}    POST /api/sftp/upload/{id}/{username}
GET  /api/log/ssh     GET/POST /api/user/settings     GET /api/user/users   POST /api/user/users/{id}     GET/POST /api/site/settings
GET  /tunnels/server/config/{id}?username_id=           GET /tunnels/server/script/{ssh,powershell,autossh,autossh-service,docker-run,docker-compose}/{id}/{ssh_port}?key_path=&username_id=
POST /tunnels/server/script/one-time/token              GET /tunnels/server/script/one-time/{token} (AllowAny, text/plain)
POST /tunnels/share/{id}   DELETE /tunnels/unshare/{id}/{uid}   PATCH /tunnels/update-permission/{id}/{uid}
GET  /tunnels/shared-users/{id}   GET /tunnels/available-users/{id}   PATCH /tunnels/share/{id}/{uid}/allowed-usernames
```
JSON 欄位名、`fields='__all__'` 的序列化形狀（含 `user`、`created_at`、`default_username`、`can_edit`…）、HTTP 狀態碼、`{error|detail}` 錯誤形狀都要對齊；用 §5 Phase 0 的 golden 測試鎖住。

### 4.2 WebSocket

| 路徑 | 認證第一則訊息 | 之後的協定 | 關閉碼 |
|---|---|---|---|
| `/ws/notifications/` | `{type:"auth",token}` | `{type:"ping"}`→`{type:"pong"}`；推播 `{message:{action,…}}` | 4000/4001 |
| `/ws/terminal/` | `+server_id,username` | `{action:"pty_input",payload:{input}}`、`pty_resize {size:{rows,cols,height,width}}`、`{action:"ping"}`→**binary** `pong`；輸出為 text frame | 4000/4001/4002/4003/4004/4005/4006 |
| `/ws/tunnel_connection/{id}/` | `+tunnel_id` | 連上即送 `connection_status`；推 `latency_update` | 4000/4001/4004 |
| `/ws/filemanager/` | `+server_id,username` | `list_files {path}`、`shell_detect`；回 `{action,data}`、錯誤 `{action:"error"}` | 同 terminal |
| `/ws/remote-browser/{sid}/` | `{type:"auth",token}` | 後端回 `{type:"ready"}` → 前端 `{type:"begin"}` → 之後純 binary 雙向轉發 | 4403/4404/4011/4013 |

通知 action 名稱：`UPDATE-TUNNEL-STATUS-DATA`、`UPDATE-TUNNEL-STATUS`、`UPDATE-TUNNEL-LATENCY`（port 為**字串** key）、`TUNNEL-SHARED/UNSHARED/PERMISSION-UPDATED/USERNAMES-UPDATED`、`UPDATED-TUNNELS`、`CREATED/DELETED-USER-KEYS`。未認證 10 秒逾時關 4001（auth 進行中再寬限一輪）。

---

## 5. 里程碑（一次全切；每個里程碑一個 PR，對應 sub-issue）

全部在 `src/backend-api/` 完成、golden contract tests 對 Django 與 Rust 都綠之後，才動 compose。期間 Django 不動（後端功能凍結）。

| 里程碑 | Issue | 範圍 |
|---|---|---|
| M0 | #81 | golden contract tests（錄 Django 回應當 fixture）+ §7 效能基線 |
| M1 | #82 | 骨架、config、冪等 schema、JWT/pbkdf2/Google、`/api/auth/*` |
| M2 | #83 | 其餘 REST（§4.1）；錯誤字串與 JSON 形狀逐字相容 |
| M3 | #84 | 五條 WS、通知 hub、terminal PTY、port monitor（push 端點 + 去彈跳/節流） |
| M4 | #85 | 原生 SFTP file manager、remote browser（session/`ssh -D`/kasm client/relay） |
| M5 | #86 | 後端內建 SSH gateway（russh server），移除 OpenSSH 容器與所有取樣腳本 |
| M6 | #87 | Dockerfile/compose 切換、移除 redis/supervisor/Django、CLI、Swagger、文件 |

```
src/backend-api/src/
  main.rs            clap: serve | migrate | create-superuser | seed-service-key
  config.rs          env → Config（DEBUG, SECRET_KEY, REVERSE_SERVER_SSH_PORT, SERVER_DOMAIN, INTERNAL_API_TOKEN, KASM_*）
  app.rs             Router 組裝 + layers（compression、cors、trace）
  db/                sqlx：pool、schema（冪等 DDL）、users, tunnels, usernames, sharing, keys, settings（Django 表名）
  auth/              jwt.rs, password.rs(pbkdf2_sha256), google.rs(JWKS), extractor.rs(Bearer → User)
  permissions.rs     VIEW/EDIT/ADMIN、allowed_usernames（純函式 + 測試）
  api/               auth, tunnels, sharing, usernames, scripts, settings, users, logs, sftp, remote_browser, internal
  ws/                auth.rs(first-message + timeout), terminal, notifications, tunnel_connection, filemanager, remote_browser
  hub.rs             NotificationHub（per-user / per-tunnel broadcast）
  monitor/           port_monitor.rs（debounce/throttle 純函式）、sampling（push 或 gateway 餵入）
  ssh/               process.rs(openssh argv builder), sftp.rs(russh 連線池), gateway.rs(選 B 時)
  remote_browser/    session.rs(in-memory + reaper), socks.rs(ssh -D), kasm_client.rs
  scripts/           模板渲染（$var safe_substitute；templates/ 原檔搬過來）
```

## 6. 風險與對策

| 風險 | 對策 |
|---|---|
| PTY/ControlMaster 行為退化（分頁互踢、孤兒 proxy、fd 洩漏） | §3.4 的規則寫成測試：開 3 分頁→關第 1 個→其餘存活；關閉後 `ps` 無殘留；fd 計數不增長 |
| 回滾（切換後發現問題） | compose 換回 Django image；同一個 DB 檔、同一把 `SECRET_KEY`；Rust 不改既有表的既有欄位 |
| JWT/密碼不相容 → 全員登出 | Phase 1 雙向 token 驗證測試；`SECRET_KEY` 先沿用舊值 |
| 序列化形狀微差（日期格式、`null` vs 缺欄位、int/str key） | golden contract tests 逐欄比對；日期統一 RFC3339 含 `+08:00` |
| 錯誤字串被前端/狀態碼邏輯依賴 | 逐字搬；集中在一個 `errors.rs` 方便日後改 error code |
| Windows 裝置無 SFTP subsystem | 保留 exec `ls`/PowerShell fallback（Phase 4） |
| Google JWKS 外連失敗 | 快取 + 過期寬限；啟動不依賴它 |
| Django admin 消失 | 確認 `tunnels/admin.py` 的 permission-group 檢視無人使用；其餘功能前端/CLI 已覆蓋 |
| 單 process 掛掉 = 全站掛 | 與現況相同（supervisor/compose `restart: always`）；panic 以 `catch_unwind` per-connection 隔離；加 `/healthz` |
| 遷移期間兩套 code 並存、功能新增要寫兩次 | 後端功能凍結到 M6 切換為止 |

---

## 7. 效能量測（Phase 0 先量現況，每個 Phase 結束再量）

| 指標 | 方法 | 預期方向 |
|---|---|---|
| `GET /api/reverse/server/dashboard` p50/p99（50 併發） | `oha` | 5–20× |
| terminal 吞吐（`base64 /dev/urandom \| head -c 100M`）與後端 CPU | `websocat` + `docker stats` | 3–10× 吞吐、CPU 大降 |
| remote-browser 播 1080p 影片時後端 CPU% | `docker stats` | 明顯下降（per-frame 零複製） |
| 裝置 SSH 登入延遲（`AuthorizedKeysCommand` → internal/keys） | `time ssh -T` × 20 | ms 級 |
| 冷啟動到 healthy | compose up → healthcheck | 30–60s → <2s |
| 常駐 RSS（閒置 / 10 條 terminal） | `docker stats` | 300–400MB → 30–60MB |
| port 狀態翻轉 → 前端收到通知延遲 | 時間戳對比 | 持平或更好 |
| notifications fan-out 100 使用者 | 模擬 | 持平或更好 |

---

## 8. 工時估算（一位熟 Rust 的工程師全職）

M0 ~0.7 週、M1 ~1 週、M2 ~1.5 週、M3 ~1.75 週、M4 ~2 週、M5 A ~0.7 週 / B ~2 週、M6 ~0.7 週 → **約 8–10 週**。
最不確定的是 M4（russh 雙跳 + SFTP 邊界案例）、M3（PTY 細節）與 M5-B（SSH server 互通）。

## 9. 已拍板的決策（2026-10-22）

1. 前端維持 Next.js，前後端分離，API/WS 契約為相容邊界。
2. Django admin 退役。
3. 一次全切（非 strangler）。
4. Redis 移除；ssh 側取樣改 HTTP push（或由內建 gateway 產生）。
5. 目錄名 `src/backend-api/`。
6. SSH 側採 B：後端內建 russh gateway（§3.6、#86）。
