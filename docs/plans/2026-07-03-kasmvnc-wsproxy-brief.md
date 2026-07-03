# 委託書：遠端瀏覽器改用 KasmVNC（WebSocket 直連）— 評估與實作

> **這份文件的用途：** 交給 AI 實作代理（Fable）**先評估、再實作**。目前 remote-browser 已用
> **TigerVNC（raw-RFB）正常運作**於分支 `feat/vnc-remote-browser`。本委託是想改用 **KasmVNC**
> 取得更好的串流效能（尤其影片/圖多的頁面）。但 KasmVNC 是 **web-native：只提供
> VNC-over-WebSocket、不開傳統 raw-RFB TCP 埠**，所以不能沿用現有的「raw-TCP 橋接」，必須把
> Django consumer 改成 **WebSocket-to-WebSocket 中繼**，並處理 KasmVNC 自己的 TLS / web 驗證。
> 文件自足（self-contained）：即使沒有先前對話脈絡也能據此行動。

---

## 0. 給評估者（Fable）的委託說明 — 先讀這段

**你的任務，依序：**

1. **先評估「值不值得」。** 現況：TigerVNC 版**已經可用**（raw-RFB + noVNC over `/ws`，架構乾淨、已測）。
   KasmVNC 的賣點是更佳的動態編碼（WebP/影片），但代價是要接它的 WebSocket 並馴服它的 **TLS + basic
   auth**。請先做 **Phase 0**（下方）：能不能讓一個「非 KasmVNC 自家前端」的 WebSocket client 連上
   KasmVNC 的 websocket、完成 RFB 交握、且**關掉/繞過它的 TLS 與 web 驗證**。**過不了就別往下**，
   誠實回報：維持 TigerVNC。
2. **確認可行後才逐 Task 實作**，用 TDD（此 repo 慣例：先寫失敗測試），每個 Phase 結束設檢查點。
3. **全程保留 TigerVNC 當 fallback。** 請開**新分支** `feat/kasmvnc-wsproxy`（從
   `feat/vnc-remote-browser` 切出），失敗能一鍵回退到可用的 TigerVNC 版。

**成功長怎樣：** 使用者在網頁點「Start Browser」→ 數秒內出現真桌面 Chromium、能滑鼠鍵盤操作、
中文可輸入；瀏覽器對外流量以**目標機器**身分出去（proxy 正確）；只走既有 `/ws`（不新增對外路由、
不需 docker.sock）；**且串流順暢度不低於 TigerVNC**（否則此遷移無意義 → 回 TigerVNC）。

---

## 1. 決策脈絡（讓你能挑戰這個決定）

**演進史：** Neko(WebRTC) → CDP screencast(整幀 JPEG，太慢) → **VNC**。VNC 版選了「共用容器 +
session-manager API + noVNC over 既有 /ws」的架構（不需 docker.sock）。VNC server 先試 KasmVNC，
但踩到「KasmVNC 只開 websocket」的雷，故**先落地 TigerVNC**（raw-RFB，直接吻合橋接設計）。

**為什麼還想要 KasmVNC：** KasmVNC 的編碼（動態 JPEG/WebP、多執行緒）對影片/圖多頁面優於 TigerVNC
的 Tight。若使用者的用途偏多媒體，KasmVNC 值得；若偏一般文字瀏覽，TigerVNC 其實已足夠——**這正是
你要在 Phase 0 後幫委託者判斷的取捨**。

**關鍵技術事實（已知 / 待你在 Phase 0 確認）：**
- KasmVNC 的 X server 二進位是 **`Xkasmvnc`**（不是 `Xvnc`）。
- 實測 log：`Xkasmvnc` 啟動後 `vncext: Listening for websocket connections on 0.0.0.0 ..., port 6800`
  —— 它**只開 websocket、不開 raw-RFB TCP**。故 `-rfbport` 對「TCP 連線」無效。
- KasmVNC 1.3+ 預設**開啟 TLS（wss，自簽憑證）與 basic auth**（web 層），需在 `kasmvnc.yaml` 或
  啟動旗標關掉（內網用），否則外部 WS client 連不上或被要求登入。**這是最大風險，Phase 0 要先破。**
- noVNC / websockify 慣例走 **binary** subprotocol（非 base64）；中繼時要確保端到端 binary。

---

## 2. 目標與硬約束（實作不可破壞）

**Goal：** 把 VNC server 從 TigerVNC 換成 **KasmVNC**，並把 Django consumer 從「raw-TCP 橋接」改成
「**WebSocket 中繼**」：下游是使用者 noVNC 的既有 `/ws`，上游是 KasmVNC 的 websocket。

**硬約束（動到就是錯）：**
- **ssh `-D` SOCKS 段原封保留**：`remote_browser_service.start_remote_browser` 的 ssh 啟動 +
  `_wait_for_port` + `SSH_HOST="reverse"` 完全不動（這是「以目標身分上網」的核心，已在正式環境運作）。
- **既有 REST 三 URL 與權限判斷不變**：`/start`、`/stop`、`/ping`（`authorized_keys/browse_views.py`）；
  `start` 回 `{session_id, ws_path}` 的介面不變。
- **沿用 `FirstMessageAuthConsumer` 慣例**：首則訊息 `{"type":"auth","token":...}` 驗 JWT →
  `after_auth()` 內**重驗 tunnel 權限**（用 session 的 `server_id` 查 VIEW，不只驗身分）。JWT 只在
  WS payload、不進 URL/subprotocol。
- **多-worker 正確性**：沿用現有 Redis registry（`RedisSessionStore`）——`/start`（REST）與中繼 WS
  consumer 常落在不同 gunicorn worker，consumer 必須靠 `session_id` 跨 worker 反查上游連線資訊。
- **前端 noVNC 走既有 `/ws`、交握協定不變**（見 §5）：`auth → ready → (attach noVNC) → begin`。
- **不需 docker.sock、不新增對外路由**：KasmVNC 的 websocket 只在 telepy-network 內，**絕不 publish
  到 host**；使用者永遠只連 Django 的 `/ws`（由 consumer 代理到 KasmVNC）。

**環境事實：** 後端 Django 6 / DRF / Channels 4.3 / channels_redis；prod 用 gunicorn+uvicorn 多 worker，
dev 用 daphne。前端 Next.js / TypeScript，遠端瀏覽器已用 `@novnc/novnc` 1.6.0。**需新增一個 async WS
client 相依**（建議 `websockets`；此 repo 先前用過、後來移除，重加即可）或用 `aiohttp` 的 ws client。

---

## 3. 必須先解決的開放問題（Phase 0 要破，動工前於 PR 回覆）

**A. TLS：KasmVNC 的 websocket 是 ws 還是 wss？**
KasmVNC 預設自簽 wss。內網中繼有兩條路：(a) 在 `kasmvnc.yaml` 關掉 SSL（`network.ssl.require_ssl:
false` 或等效），讓它開純 `ws`；(b) 保持 wss，consumer 連上游時用 `ssl` context 且**不驗憑證**（內網、
自簽）。**建議 (a)**（純 ws 最單純）；若 KasmVNC 不允許關 SSL，走 (b)。請確認實際可行的做法。

**B. Web 驗證：如何關掉 KasmVNC 的 basic auth？**
KasmVNC 1.3+ 預設 web 層要 basic auth。RFB 層可 `-SecurityTypes None`，但 web/websocket 層是另一關。
請找出關閉方式（`kasmvnc.yaml` 的 `basic_auth.enabled: false` 或 `-disableBasicAuth` 之類），或改成
consumer 連上游時帶固定 Authorization header（帳密由 session-manager 產生並回傳）。**目標：使用者端
零額外登入**（驗證只發生在 Django 的 JWT）。

**C. WebSocket URL / path / subprotocol？**
KasmVNC websocket 服務在哪個路徑（`/`、`/websockify`、`/api/...`）?要不要帶 subprotocol（如
`binary`）才會送二進位 RFB？請用 Phase 0 腳本實測連上並完成 RFB `ProtocolVersion` 交握確認。

**D. Per-session websocket 埠。**
用 `-websocketPort <埠>` 給每個 session 專屬 websocket 埠（比照現在的 rfb_port 配法：`rfb_base +
display`）。確認該旗標會讓 KasmVNC 在該埠開 listener，且 backend 連得到（bind 0.0.0.0 / telepy-network）。

---

## 4. 現況架構（已完成的 TigerVNC 版；哪些要改）

分支 `feat/vnc-remote-browser`。關鍵檔案與現況行為：

- `docker/kasm-browser/session_manager.py` — 容器內 HTTP API。`SessionManager.create(proxy, geometry)`
  起 **Xvnc(TigerVNC) + openbox + chromium**，`_wait_for_rfb(rfb_port)` 等 RFB TCP 起來，回
  `{session_id, rfb_port}`。啟動指令用 env 樣板 `VNC_CMD`/`WM_CMD`/`BROWSER_CMD`；`_resolve_vnc_bin()`
  偵測二進位；VNC server 的 stderr 導到 per-session log（`_tail` 供診斷）。→ **改：改起 KasmVNC，改
  等 websocket 埠、回 `ws_port`。**
- `docker/kasm-browser/Dockerfile` — 現裝 `tigervnc-standalone-server`。→ **改：改裝 KasmVNC（`Xkasmvnc`，
  依架構抓 `kasmvncserver_bookworm_<ver>_<arch>.deb`），加 `kasmvnc.yaml` 關 TLS/auth（見 §3-A/B），
  build 階段驗證二進位。**
- `src/backend/services/kasm_client.py` — `create_session(proxy, geometry) -> {session_id, rfb_port}`；
  `stop_session(id)`。→ **改：回 `{session_id, ws_port}`（外加 auth 資訊，若走 §3-B 的 header 方案）。**
- `src/backend/authorized_keys/remote_browser_service.py` — **ssh -D 不動**；`start_remote_browser` 呼叫
  `_kasm.create_session` 取埠、寫進 `RedisSessionStore`（現存 `rfb_port`+`kasm_session_id`）；
  `get_session`/`ping`/`stop`/GC 皆在。→ **改：registry 存 `ws_port`（+ 選配 upstream auth）取代
  `rfb_port`；其餘骨架不動。**
- `src/backend/tunnels/consumers.py::RemoteBrowserConsumer(FirstMessageAuthConsumer)` — 現況：
  `after_auth` 取 session → 重驗權限 → `asyncio.open_connection(KASM_HOST, rfb_port)`（**raw TCP**）→
  送 `{"type":"ready"}`；`on_message` 收 `{"type":"begin"}` 起 `_pump_rfb_to_client`（TCP→WS binary）；
  收 binary → 寫進 TCP；`disconnect` → 停 pump、關 writer、`stop_remote_browser`。
  → **改：上游從 raw TCP 換成 WebSocket client（連 `ws(s)://kasm-browser:<ws_port><path>`）；雙向中繼
  改成 WS↔WS binary。交握協定（ready/begin）與權限重驗、斷線收尾全部保留。**
- `src/frontend/src/components/tunnels/RemoteBrowserPanel.tsx` — noVNC RFB over `/ws`，交握
  `auth→ready→attach→begin`。→ **不改**（前端仍只認 Django 的 `/ws`；上游是 TCP 還是 WS，前端無感）。
- `src/backend/tunnels/routing.py` — `ws/remote-browser/<session_id>/` → **不改**。
- `docker-compose.yml` — `kasm-browser` 服務（build `./docker/kasm-browser`），backend env
  `KASM_BROWSER_API`/`KASM_BROWSER_HOST`。→ **大致不改**（image 內容變、服務名沿用）。
- `site_settings` — `remote_browser_geometry`/`max_sessions`/`idle_timeout`。→ 不改（或加 KasmVNC 專屬項）。

**測試（TDD 對象）：** `services/tests/test_kasm_client.py`、`docker/kasm-browser/tests/test_session_manager.py`、
`authorized_keys/tests/test_remote_browser_service.py`、`tunnels/tests/test_remote_browser_consumer.py`
（現用一個 **asyncio mock RFB server** 端到端測 consumer；KasmVNC 版請改成 **mock WebSocket server**
——一連上就送 RFB greeting 並 echo，驗證 WS↔WS 中繼）。

---

## 5. 目標架構（KasmVNC WS-proxy）與交握（務必保留）

```
使用者瀏覽器（noVNC）
   │ 1) POST /start (JWT, 既有權限檢查) → { session_id, ws_path }
   │ 2) WS /ws/remote-browser/<id>/ ；首則 {type:auth,token}
   ▼        （FirstMessageAuthConsumer 慣例）
Django RemoteBrowserConsumer
   │  after_auth：重驗權限 → 連【上游】KasmVNC websocket（WS client）→ 送 {type:ready}
   │  收前端 {type:begin} → 開始【上游→下游】中繼
   │  下游(noVNC) binary ⇄ 上游(KasmVNC) binary   ← 純位元組中繼，consumer 不需懂 RFB
   ▼  ws(s)://kasm-browser:<ws_port><path>   （只在 telepy-network，不對外）
kasm-browser 容器（共用）
   │  session-manager API(:7000)：per-session 起 Xkasmvnc(-websocketPort <ws_port>, 關 TLS/auth)
   │                                + openbox + chromium(--proxy-server=socks5://backend:<ssh -D 埠>)
   ▼  SOCKS5 → ssh -D（backend 內，不變）→ 兩跳反向隧道 → 目標裝置出口
```

**交握順序（沿用現況，避免漏 greeting／競速）：** RFB 是「server 先說話」。consumer 連上游 KasmVNC 後
**先送 `{type:ready}`、先不中繼**；前端收到 ready → 把「同一條已認證 WS」交給 noVNC（noVNC 1.6 對
raw channel 會**同步**接管 onmessage 並呼叫 `_socketOpen()`）→ 回 `{type:begin}`；consumer 收到 begin
才啟動「上游→下游」中繼。下游→上游方向不需等 begin（noVNC 本就等 server greeting）。

**關鍵決策：**
1. **consumer 變 WS↔WS 中繼**：上游用 async WS client（`websockets.connect(...)`，`max_size=None`,
   `ping_interval=None`；wss 時給不驗證的 ssl context）。中繼即 `async for msg in upstream: send(bytes)`
   與 `on_message(bytes) → upstream.send(bytes)`。並發送出建議加鎖（比照現有 CDP 版的教訓）。
2. **上游連線資訊放 Redis registry**（`ws_port`、path、選配 auth header），consumer 跨 worker 反查。
3. **安全**：KasmVNC websocket 不對外 publish；consumer `after_auth` 重驗 tunnel 權限。
4. **前端不動**：這是本方案的最大好處——只有「上游接法」從 TCP 變 WS。

---

## Phase 0：放行閘門（先做，過不了就回 TigerVNC）

- [ ] **起一顆 KasmVNC**（可先手動 `docker run` 一個裝了 KasmVNC 的 image），用
      `Xkasmvnc :10 -geometry 1280x720 -depth 24 -SecurityTypes None -websocketPort 6910 ...` 起一個
      session，並套用你在 §3-A/B 找到的「關 TLS + 關 basic auth」設定（`kasmvnc.yaml` 或旗標）。
- [ ] **（關鍵）用「非 KasmVNC 自家前端」的 WS client 連上並完成 RFB 交握。** 寫一支小腳本（Python
      `websockets` 或 `websocat`）連 `ws://<host>:6910<path>`，收到 RFB `ProtocolVersion`（`RFB 003.00x`）
      並能送回應、推進交握。**確認：不需登入、二進位 RFB、path/subprotocol 正確。**
  - ✅ 命中 → 採 KasmVNC WS-proxy（本委託主線）。
  - ❌ 過不了（TLS/auth 關不掉、或 path/subprotocol 兜不攏）→ **回報 no-go，維持 TigerVNC**。
- [ ] **（可選）粗量效能**：同一個影片頁面，主觀比較 KasmVNC vs 現行 TigerVNC 的順暢度，供委託者決定值不值得。
- [ ] **記錄決策**：TLS 做法（關 or 不驗證）、auth 關法、websocket path、subprotocol、per-session 埠公式，寫進 PR。
      把 Phase 0 腳本存到 `dev-scripts/`（供正式環境重跑）。

---

## Task 1：分支
- [ ] `git checkout feat/vnc-remote-browser && git checkout -b feat/kasmvnc-wsproxy`（保留 TigerVNC 當 fallback）。

## Task 2：session-manager 改起 KasmVNC（回 ws_port）
- [ ] **改測試**（`docker/kasm-browser/tests/test_session_manager.py`）：`create` 應以 KasmVNC 旗標起
      Xkasmvnc（帶 `-websocketPort`），等 **websocket 埠** listen，回 `{session_id, ws_port}`；proxy 注入
      chromium；停止整組 kill。把 `_wait_for_rfb` 換成 `_wait_for_ws_port`（TCP 層 listen 即可）。
- [ ] **改實作**：`VNC_CMD` 預設改 KasmVNC（`Xkasmvnc :{display} ... -websocketPort {ws_port} -SecurityTypes None`
      + 關 TLS/auth 的設定）；`_resolve_vnc_bin` 優先 `Xkasmvnc`；回 `ws_port = ws_base + display`；沿用
      per-session log 診斷。→ 測綠、commit。

## Task 3：Dockerfile 改裝 KasmVNC
- [ ] 依架構抓 `kasmvncserver_bookworm_<ver>_<arch>.deb`（`dpkg --print-architecture`），裝好；放一份
      `kasmvnc.yaml`（關 TLS + 關 basic auth，依 Phase 0 結論）到正確位置（`/etc/kasmvnc/` 或使用者
      `~/.vnc/`）；build 階段 `command -v Xkasmvnc || exit 1` 驗證。→ commit。

## Task 4：kasm_client 回 ws_port
- [ ] 改測試 + 實作：`create_session` 回 `{session_id, ws_port}`（+ 選配 upstream auth）。→ commit。

## Task 5：remote_browser_service 存 ws_port
- [ ] `RedisSessionStore` payload 的 `rfb_port` → `ws_port`（+選配 auth）；`start/get_session/stop` 對應調整；
      **ssh -D 與 GC 骨架不動**。改測試 + 實作。→ commit。

## Task 6：consumer 改成 WS↔WS 中繼
- [ ] **改測試**（`tunnels/tests/test_remote_browser_consumer.py`）：用一個 **mock WebSocket server**
      （aiohttp/websockets 起一個 ws server，一連上送 `b"RFB 003.008\n"` 並 echo）取代現在的 mock RFB TCP
      server；斷言：`after_auth` 連上上游 ws + 送 `ready`；`begin` 後把 greeting 中繼給 client；client binary
      寫到上游並收到 echo；未知 session→4404；無權限→4403；斷線收 session。
- [ ] **改實作**：`after_auth` 用 `websockets.connect(upstream_url, ...)`（wss 時不驗證 ssl；帶 auth header
      若走 §3-B header 方案）取代 `asyncio.open_connection`；`_pump`（上游→下游）改 `async for msg in upstream`；
      `on_message(bytes)` 改 `await upstream.send(bytes)`；`disconnect` 關上游 + `stop_remote_browser`。
      交握（ready/begin）、權限重驗、KASM_HOST/ws_port 由 `get_session` 取得，全部保留。→ 測綠、commit。

## Task 7：端到端驗收（成功標準）
- [ ] stack 起：`kasm-browser` 內 `Xkasmvnc` 起得來、websocket 埠可達、Phase 0 腳本連得上。
- [ ] UI Start → 真桌面 Chromium；滑鼠鍵盤可操作、**中文可輸入**；順暢度 ≥ TigerVNC。
- [ ] proxy 走目標出口：瀏覽器內開 IP 查詢頁，公網 IP == 目標機器 IP。
- [ ] per-session 隔離：兩 session 各開 → 各自桌面、各走各 proxy。
- [ ] 斷線/idle → session 被收（ssh + kasm session + Redis 清空）；多 worker（`GUNICORN_WORKERS≥2`）不會
      「session not found」。
- [ ] `docker compose run --rm backend python manage.py test -v 2` 全綠。→ merge。

---

## Rollback / 過渡
- 未合併：`git checkout feat/vnc-remote-browser` 即回可用的 **TigerVNC** 版。
- session-manager 對 VNC server 無耦合（`VNC_CMD`/`VNC_SERVER_BIN` 可 env 覆寫）：必要時同一顆 image
  可同時裝 TigerVNC 與 KasmVNC，用 env 切換灰度驗證。

## 已知風險（實作前再確認一次）
- **KasmVNC 的 TLS + basic auth 關不乾淨（最高）** → Phase 0 閘門；過不了就回 TigerVNC。
- **websocket path / subprotocol / binary framing 兜不攏** → Phase 0 用真 client 實測交握。
- **上游 WS 斷線／背壓** → consumer 偵測上游關閉即收 session + 前端可重啟；並發送出加鎖。
- **多 worker 反查** → 沿用 Redis registry 存 ws_port。
- **效能未達預期** → 這是遷移的唯一動機；Phase 0/Task 7 若不比 TigerVNC 順，直接回 TigerVNC。

## 附：現行前端交握（不變，供你對照）
1. 開 WS `/ws/remote-browser/<id>/` → 送 `{type:"auth", token}`。
2. 後端 `after_auth` 連上游、送 `{type:"ready"}`。
3. 前端收到 `ready` → `new RFB(el, ws, {shared:true})`（把已認證的同一條 WS 交給 noVNC）→ 送 `{type:"begin"}`。
4. 後端收到 `begin` → 開始「上游→下游」中繼。之後 RFB 由 noVNC ↔ KasmVNC 端到端處理。
