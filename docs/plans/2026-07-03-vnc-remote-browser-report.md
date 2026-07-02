# 遠端瀏覽器改用 VNC 方案(KasmVNC)：實作完成報告

> 前一版(CDP screencast)報告：`docs/plans/2026-07-02-cdp-implementation-report.md`
> 改道原因：CDP 的整幀 JPEG-over-WS 回應速度/效能低於預期。
> 分支：`feat/vnc-remote-browser`　日期：2026-07-03

## 一句話

把「畫面傳輸 + 瀏覽器執行」層從 CDP screencast 換成 **共用 KasmVNC 容器 + 每 session 一組
Xvnc+Chromium**,畫面走 **VNC(RFB)**、經 Django consumer 橋接到**既有 /ws**。
ssh `-D`、REST 三 URL、`FirstMessageAuthConsumer`、多-worker Redis registry 全數保留。
**不需 docker.sock**。後端 29 測試 + session-manager 5 測試綠。

## 為什麼 VNC 會比較快 / 比較好

- **增量式編碼**:VNC 只送「有變動的 tile」(Tight/ZRLE),不像 CDP 每幀都是整張 JPEG;
  以文字為主的瀏覽延遲與頻寬都明顯較低。
- **真桌面**:使用者看到的是**真正的 Chromium**(自帶分頁、網址列),而且 **CJK 顯示、
  中文輸入(IME)、剪貼簿、resize 幾乎免費**——這些正是 CDP 版最難補的地方。
- 前端從「自建 canvas + 分頁列 + keymap + IME」大幅簡化為「一個 noVNC RFB」。

## 兩個關鍵決策(已與委託者確認)

- **架構:共用容器 + session-manager API**(非「一 session 一容器 + docker.sock」)。
  一顆長命 `kasm-browser` 容器內跑一支小 HTTP API,per-session 起 Xvnc+chromium。避免把
  CDP 遷移好不容易移除的 docker.sock 與動態路由又請回來。
- **VNC:KasmVNC**(web-native 的現代 VNC,TigerVNC fork,編碼較佳)。

## 架構

```
使用者瀏覽器(noVNC)
   │ 1) POST /start (JWT, 既有權限檢查) → { session_id, ws_path }
   │ 2) WS /ws/remote-browser/<id>/ ；首則 {type:auth,token}
   ▼        → 後端連 RFB、回 {type:ready} → 前端把「同條已認證 WS」交給 noVNC → 回 {type:begin}
Django RemoteBrowserConsumer(FirstMessageAuthConsumer)
   │  透明位元組雙向轉發(WS binary ↔ RFB TCP);RFB 由 noVNC↔KasmVNC 端到端處理
   ▼  TCP: kasm-browser:<rfb_port>
kasm-browser 容器(共用)
   │  session-manager API(:7000, INTERNAL_API_TOKEN):POST/DELETE /sessions
   │  每 session:Xvnc :N(RFB=5900+N, SecurityTypes None) + openbox + chromium
   │            chromium --proxy-server=socks5://backend:<ssh -D 埠>
   ▼  SOCKS5
ssh -D(backend 容器內,維持現狀)→ 兩跳反向隧道(不變)→ 目標裝置出口
```

## 各元件與測試

| 元件 | 檔案 | 測試 |
|---|---|---|
| backend→session-manager client | `services/kasm_client.py` | `services/tests/test_kasm_client.py`(5)✅ |
| 容器內 session-manager API | `docker/kasm-browser/session_manager.py` | `docker/kasm-browser/tests/test_session_manager.py`(5)✅ |
| service(保 ssh -D + registry) | `authorized_keys/remote_browser_service.py` | `authorized_keys/tests/test_remote_browser_service.py`(7)✅ |
| VNC bridge consumer | `tunnels/consumers.py::RemoteBrowserConsumer` | `tunnels/tests/test_remote_browser_consumer.py`(7,**對真 asyncio mock RFB server 端到端**)✅ |
| 前端 noVNC | `components/tunnels/RemoteBrowserPanel.tsx` + `types/novnc.d.ts` | tsc 0 錯 ✅ |
| 容器 image | `docker/kasm-browser/Dockerfile` | 需正式環境 build/smoke |
| compose / SiteSettings | `docker-compose.yml` / `site_settings/*` | django check ✅ |

## 握手為何這樣設計(避免漏包/競速)

RFB 是「server 先送 greeting」。若一連上 RFB 就把 greeting 送給前端、而 noVNC 還沒接上 socket,
greeting 會漏、handshake 壞。故:consumer 連上 RFB 後只送 `{type:"ready"}`;前端把**已認證的
同一條 WS**交給 noVNC 的 `RFB`(已驗證 noVNC 1.6 對 raw channel 會**同步**接管 `onmessage`
並直接呼叫 `_socketOpen()`,不依賴 `onopen` 事件),再回 `{type:"begin"}`;consumer 收到 begin
才開始 pump RFB→client。零漏包、零競速。client→RFB 方向不需等 begin(RFB client 本就等 greeting)。

## 相對於一般做法的重點(保留 CDP 版的正確性修正)

1. **多 worker 正確性**:沿用 CDP 版的 Redis registry —— `ACTIVE_SESSIONS`(本行程)只留 ssh
   Popen;跨 worker 要查的 `rfb_port`/`kasm_session_id`/`server_id` 放 Redis。prod 多 worker 下
   `/start` 與 WS consumer 常不同 worker,consumer 靠 session_id 反查 rfb_port 並重驗權限。
2. **權限重驗**:consumer `after_auth` 用 session 的 server_id 再查一次 VIEW 權限(不只驗 JWT)。
3. **fail-safe 收尾**:WS 斷即 `stop_remote_browser`(收 ssh + 呼叫 session-manager DELETE);
   非 owner worker 也能收 kasm session(經 API)與 Redis;idle GC 當後備。
4. **不需 docker.sock**:session-manager 只在「一顆容器內起/停行程」,每個 session 的行程開新
   process group,停止時整組 kill(含 chromium 的子行程)。

## 驗證做了什麼(證據)

- **後端**:kasm_client 5 + remote_browser_service 7 + VNC bridge consumer 7 + 既有(含
  renderer,需容器慣例 `PYTHONPATH=…/tunnels`)= **29 綠**;session-manager **5 綠**(獨立)。
- **VNC bridge 端到端**:consumer 對一個**真的 asyncio mock RFB server**(server 先送 greeting +
  echo)測試:after_auth 連上並送 ready、begin 後把 greeting pump 給 client、client 二進位寫進
  RFB 並收到 echo、未知 session→4404、無權限→4403、斷線收 session。
- **前端**:`tsc --noEmit` 全專案 **0 錯**(含 noVNC import + 型別宣告);noVNC 模組圖在 node
  下可完整解析(僅止於瀏覽器 global `window`,屬預期),bundler 可打包。
- **compose / django check**:皆通過;無 docker.sock、無 publish 任何埠、無 neko/CDP 殘留。

## 誠實範圍聲明(哪些要在你的環境驗)

沙箱**無 Docker、無 root、無 X/VNC/headful 瀏覽器**,故 `kasm-browser` 這顆 image 的實體行為
(KasmVNC `Xvnc` 的確切旗標、chromium 在 X 下、openbox、CJK 字型、Dockerfile build)**只能在你
的正式環境驗**。已備:
- `dev-scripts/kasm-smoke.sh`:build 後在正式環境跑,驗 session-manager 起 session + RFB 埠可達 +
  收到 RFB greeting。
- session-manager 的啟動指令**全用環境變數樣板化**(`VNC_CMD`/`WM_CMD`/`BROWSER_CMD`),若你的
  KasmVNC build 的 `Xvnc` 路徑/旗標不同,改 env 即可,不必改碼。若 KasmVNC 的 raw-RFB 路徑有狀況,
  把 `VNC_CMD` 換成 TigerVNC 的 `Xvnc` 是一個 env 的事(fallback)。
- `next build` 因沙箱 45s 行程上限跑不完(冷啟),但 tsc 0 錯 + 模組可解析;請在正式環境
  `npm ci && npm run build` 覆核一次。

## 部署步驟

```bash
docker compose up -d --build kasm-browser backend frontend
./dev-scripts/kasm-smoke.sh          # 煙霧測試
```
UI 按「Start Browser」→ 數秒內看到真桌面 Chromium;在其中開 IP 查詢頁,公網 IP 應 == 目標機器。

## 端到端驗收清單(正式 stack)

- [ ] stack 起:`traefik/frontend/backend/redis/ssh/kasm-browser` 皆 Up,無 chromium(CDP)/neko。
- [ ] session-manager 健康:`docker compose exec backend python -c "import requests;print(requests.get('http://kasm-browser:7000/healthz').status_code)"` → `200`。
- [ ] `dev-scripts/kasm-smoke.sh` 全過(session 起得來、RFB 埠可達、收到 greeting)。
- [ ] UI Start → 真桌面 Chromium 出現;滑鼠鍵盤可操作;**中文可輸入、不再方塊字**;回應明顯比 CDP 順。
- [ ] proxy 走目標出口:瀏覽器內開 IP 查詢頁,公網 IP == 目標機器 IP。
- [ ] per-session 隔離:兩個 session 各開 → 各自桌面、cookie/登入互不影響、各走各 proxy。
- [ ] 斷線/idle:關 UI 或斷 WS → session-manager session 被收、ssh 收掉、Redis 清空。
- [ ] 多 worker(`GUNICORN_WORKERS≥2`):反覆 start/操作/stop,consumer 不會「session not found」。
- [ ] `docker compose run --rm backend python manage.py test -v 2` 全綠。

## 已知限制 / 後續

- **資源**:VNC 是「一 session 一 Xvnc + 一 headful chromium」,每 session 記憶體高於 CDP 的共用
  Chrome context;用 SiteSettings `remote_browser_max_sessions` 控管併發。
- **硬 kill worker 的孤兒**:若某 worker 被 SIGKILL,其 kasm session 需靠 idle GC / 重啟回收
  (session-manager 未做 per-session TTL 自我回收;可列後續)。
- **KasmVNC 進階編碼**:目前用標準 noVNC(標準 RFB 編碼,已足夠且比 CDP 好)。若要 KasmVNC 的
  turbo 編碼,需改用 KasmVNC 自家 web client,屬後續增強。

## 部署後修正記錄

- **前端 `Module not found: @novnc/novnc/lib/rfb`**:Docker build 的 `npm install` 以現有
  `package-lock.json` 為準,而 novnc 只加進 package.json、沒進 lock → 被略過。已重生 lockfile
  (novnc 鎖 1.6.0)。重建:`docker compose up -d --build frontend`。
- **`FileNotFoundError: 'Xvnc'`**:KasmVNC 的 X server 二進位其實叫 **`Xkasmvnc`**(不是 Xvnc)。
  已修:(a) session-manager 啟動時自動偵測二進位(`VNC_SERVER_BIN` env 可覆寫,優先 Xkasmvnc);
  (b) Dockerfile 依架構(amd64/arm64)抓 deb、把 Xkasmvnc symlink 成 Xvnc、並在 **build 階段就
  驗證二進位存在**(沒裝好就讓 build 失敗、附 dpkg 內容,不再等 runtime);(c) VNC server 的
  stderr 導到 per-session log,RFB 若起不來,API 錯誤會**帶出 KasmVNC 自己的錯誤訊息**以便診斷。
  重建:`docker compose up -d --build kasm-browser`。
  > 若 KasmVNC 的 raw-RFB 啟動還有版本相關的旗標問題,診斷 log 會直接顯示原因;可用 `VNC_CMD`
  > env 微調旗標,或把 `VNC_SERVER_BIN` 指到 TigerVNC 的 `Xvnc`(需在 image 裝 tigervnc)當 fallback。

## Rollback
- 回 CDP:`git checkout feat/cdp-remote-browser`。
- 回 Neko:`git checkout main`(或該分支)。
