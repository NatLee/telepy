# KasmVNC 遠端瀏覽器遷移 —— 修正版計畫（取代原委託書的主線假設）

> 本文修正 `2026-07-03-kasmvnc-wsproxy-brief.md`。**原委託書有一個致命的錯誤假設**,本文說明
> 錯在哪、正確架構是什麼、已經實作了哪些(可測)、以及**還需要你在 Docker 環境完成的部分**。

---

## 0. TL;DR

- **原委託書假設「前端不動、stock noVNC 照連」——這是錯的。** 官方文件明講:KasmVNC 已脫離 RFB
  規範,**stock `@novnc/novnc` 連不上**,必須用 KasmVNC 自家 fork、baked 在它 server 裡的 web client。
- 因此正確架構 = **後端 WS↔WS 中繼(委託書這部分對的)** + **前端改用 KasmVNC 的 client(委託書這部分錯的)**。
- **已實作且在沙箱測綠(29 tests)**:後端 session 生命週期改 KasmVNC(回 ws_port)、consumer 改
  WS↔WS 中繼、Dockerfile 裝 KasmVNC 1.4.0 + kasmvnc.yaml(關 TLS)、chromium 三項(Google 首頁、
  反爬蟲旗標、保留共用設定檔)、Phase 0 探測腳本。
- **還需要你做(需活的 KasmVNC)**:①跑 Phase 0 探測確認 ws path/scheme;②前端改用 KasmVNC client
  (見 §4);③端到端驗收(見 §6)。**在②完成前別上 prod** —— 現況前端(stock noVNC)配 KasmVNC 後端
  會是黑畫面。回退隨時可用:`git checkout feat/vnc-remote-browser`(TigerVNC 版)。

---

## 1. Phase 0 結論(來自官方文件,決策級)

| 問題 | 結論 | 出處 |
|---|---|---|
| stock noVNC 能連 KasmVNC 嗎? | **不能。** KasmVNC 破壞 RFB 相容性,只認自家 fork 的 web client。 | KasmVNC README、Differences-From-TigerVNC wiki |
| TLS 怎麼關(純 ws)? | `kasmvnc.yaml` 的 `network.ssl.require_ssl: false`(**無可靠 CLI 旗標**,只能靠 yaml)。 | Configuration 文件 |
| Basic Auth 怎麼關? | Xkasmvnc 啟動旗標 `-disableBasicAuth`(**不在 yaml**)。 | KasmVNC issue #284 / #268 |
| websocket 埠? | `network.websocket_port: auto` = **8443 + display number**。 | Configuration 文件(network 表) |
| websocket path / subprotocol? | 文件未明列 → **用 Phase 0 探測腳本實測**(預設試 `/websockify`、`/` 等;subproto `binary`)。 | 本計畫 §3 |
| 剪貼簿 / 中文輸入? | KasmVNC 自家 client 有 **seamless + binary 剪貼簿**與 **IME 支援**(Chromium)→ 直接解你的需求。 | README「New Features」 |

**含義:** 遷移的唯一「免費午餐」(前端不動)不存在;換來的是要把前端接上 KasmVNC client。若你只是要
剪貼簿/中文輸入而非影片級串流,TigerVNC + vncconfig 其實更省(見原委託書的 no-go 分支)。你已選擇續作
KasmVNC,故本文往下走。

---

## 2. 正確架構

```
使用者瀏覽器（KasmVNC client）
   │ 1) POST …/remote-browser/start (JWT, 權限檢查)       → { session_id, ws_path }
   │ 2) WS /ws/remote-browser/<id>/ ；首則 {type:auth,token}（FirstMessageAuthConsumer 慣例）
   ▼
Django RemoteBrowserConsumer
   │ after_auth：重驗權限 → 連【上游】KasmVNC 的 websocket（async ws client）→ 送 {type:ready}
   │ 收前端 {type:begin} → 開始【上游→下游】逐訊息中繼（WS↔WS，保留邊界，consumer 不需懂協定）
   ▼ ws://kasm-browser:<ws_port><path>   （只在 telepy-network，不對外）
kasm-browser 容器（共用）
   │ session-manager API(:7000)：per-session 起 Xkasmvnc(-websocketPort=8443+display, -disableBasicAuth,
   │   TLS 由 kasmvnc.yaml 關) + openbox + chromium(--proxy-server=socks5://backend:<ssh -D 埠>,
   │   首頁 Google、反自動化旗標、--user-data-dir=/profiles/<server_id>)
   ▼ SOCKS5 → ssh -D（backend 內，不變）→ 反向隧道 → 目標裝置出口
```

與原委託書的**唯一**架構差異:前端不是 stock noVNC,而是 **KasmVNC 自家 client**(§4)。後端(consumer
的 WS↔WS 中繼 + ready/begin 握手 + 權限重驗 + Redis 跨 worker + ssh -D 全保留)完全依委託書。

---

## 3. 已實作(本分支的變更;沙箱已測綠 29 tests)

| 檔案 | 變更 | 測試 |
|---|---|---|
| `docker/kasm-browser/session_manager.py` | 起 **Xkasmvnc**(`-disableBasicAuth -websocketPort {8443+display}`),等 ws 埠,回 `{session_id, ws_port}`;chromium 加 **Google 首頁**、**反爬蟲旗標**(`--disable-blink-features=AutomationControlled`、`--lang`/`--accept-lang`)、**保留共用設定檔**(`--user-data-dir=/profiles/<server_id>`) | `tests/test_session_manager.py`(9) |
| `src/backend/services/kasm_client.py` | `create_session` 回 `ws_port`,帶 `profile_key` | `services/tests/test_kasm_client.py`(5) |
| `src/backend/authorized_keys/remote_browser_service.py` | store 存 `ws_port`;`profile_key=server_id`(同目標共用設定檔);ssh -D / GC 不動 | `.../tests/test_remote_browser_service.py`(8) |
| `src/backend/tunnels/consumers.py` | `RemoteBrowserConsumer` 上游改 **async websocket client**(`websockets`),WS↔WS 逐訊息中繼,送出加鎖;握手/權限/斷線收尾全保留 | `tunnels/tests/test_remote_browser_consumer.py`(7,mock WS server) |
| `docker/kasm-browser/Dockerfile` | 裝 **KasmVNC 1.4.0**(依 `dpkg --print-architecture` 抓 amd64/arm64 deb),build 階段驗 `Xkasmvnc` | build 時驗證 |
| `docker/kasm-browser/kasmvnc.yaml` | 關 TLS(`require_ssl:false`)、放行剪貼簿 | — |
| `docker-compose.yml` | kasm-browser 加 `/profiles` bind mount + 首頁/語系 env | — |
| `requirements.txt` | 重新加回 `websockets>=12.0` | — |
| `dev-scripts/phase0_kasmvnc_probe.py` | **stdlib-only** 的 WS 探測(§3 用) | 沙箱已驗:能連、讀 greeting、印出該設的 env |

> ⚠️ 沙箱無 Docker/Python3.12,測試是用 Django 5.2 跑後端邏輯(你的碼版本無關);**KasmVNC 本體、
> 前端 client、端到端**必須在你的 Docker 環境驗(見 §5/§6)。

### 執行測試(你的環境)
```bash
docker compose run --rm backend python manage.py test \
  services.tests.test_kasm_client \
  authorized_keys.tests.test_remote_browser_service \
  tunnels.tests.test_remote_browser_consumer -v 2
# session_manager 在 kasm-browser 容器內(stdlib):
docker compose exec kasm-browser python3 -m unittest discover -s /app/tests 2>/dev/null || \
  echo "把 docker/kasm-browser/tests 複製進 image 或本機 cd docker/kasm-browser && python3 -m unittest discover -s tests"
```

---

## 4. 前端 runbook —— 改用 KasmVNC 的 client(**需活的 server 驗**)

本分支的後端(WS↔WS 中繼在既有 `/ws`)直接支援下面的 **Option B**。先做 B;B 若卡在「client 需要
HTTP API」再退到 **Option A**。

### Option B(建議先試):vendor KasmVNC 的 noVNC fork,接到既有 `/ws`
KasmVNC 的 client 是 `github.com/kasmtech/noVNC`(fork)。它的 `RFB` 類別用法與 stock noVNC 近似。

1. 取得 fork(擇一):
   - `npm i 'github:kasmtech/noVNC#<tag>'`(git 相依),或
   - 從已 build 的 kasm-browser image 取 `/usr/share/kasmvnc/www`:
     `docker compose cp kasm-browser:/usr/share/kasmvnc/www ./src/frontend/vendor/kasmvnc-www`
2. 在 `src/frontend/src/components/tunnels/RemoteBrowserPanel.tsx`:把
   `import RFB from "@novnc/novnc/lib/rfb"` 換成 KasmVNC fork 的 `RFB`。**握手不動**
   (`auth → ready → new RFB(el, ws, {shared:true}) → begin`)。
3. `npm run build` 確認可編譯;連上活的 KasmVNC 驗:**畫面出來、滑鼠鍵盤、中文可貼(seamless 剪貼簿)、IME**。
4. 打開 DevTools Network:若 client 對 same-origin 發 **HTTP** 請求(如 `/api/...`、settings、
   `websockify` 以外的資源)且 404 → 表示它不只靠 ws → **改走 Option A**。

### Option A(fallback):反向代理 KasmVNC 內建 web UI + iframe
若 B 不成(client 綁死自家 HTTP 端點),就把 KasmVNC 內建 web app 整包(HTTP + WS)經 Django 代理:
1. 加一個 **session-cookie / 短期簽章 token** 保護的反向代理路由,把
   `…/remote-browser/<id>/app/*`(HTTP)與其 websocket 都轉到 `kasm-browser:<ws_port>`。
   - HTTP 用 ASGI streaming proxy(如 `httpx`),WS 沿用本 consumer 的中繼即可。
   - 注意 KasmVNC 送 `Cross-Origin-Embedder-Policy: require-corp` / `COOP: same-origin`:iframe 內嵌
     要嘛同源、要嘛在代理層改寫這兩個 header。
2. 前端 `RemoteBrowserPanel` 改成把該代理路徑放進 `<iframe>`。
3. 權限:代理層用既有 session/JWT 驗 + tunnel 權限重驗(比照 consumer 的 `_verify_access`)。
> A 較穩(用的是 KasmVNC 原封的 client),但工程較大、且引入「代理整個 web app」的安全面 —— 與委託書
> 「只走 /ws、不新增對外路由」的硬約束有張力,務必只在 telepy-network 內、加權限閘。

---

## 4b. 已知運行問題:上游 ws 連不上(路徑對了、但要 Basic Auth)

實測兩輪 log 把事實釘死了(consumer 的自動退回會把每個候選的失敗原因印出來):

| 候選 | 結果 | 解讀 |
|---|---|---|
| `wss://…/*` | `ConnectionResetError` | 埠**不是 TLS** → `-sslOnly` 預設關,是**純 ws**(先前以為要 wss,錯了) |
| `ws://…/websockify`、`/`、`/websocket` | `did not receive a valid HTTP response` | 這些是 ws 端點,**缺 auth 時 KasmVNC 直接 RST**(不回乾淨 401) |
| `ws://…/api/vnc` | **HTTP 401** `Server: KasmVNC/4.0` | REST 路由,缺 auth 回乾淨 401 → 證明**整台要 Basic Auth** |

**根因:** KasmVNC web 層**預設要 HTTP Basic Auth**,而 `-disableBasicAuth` 在此 build **沒生效**
(直接起 `Xkasmvnc`、繞過 `vncserver`)。真正的 ws 端點是 **`ws://…/websockify`**,缺帳密時被 RST,
看起來像「沒有 HTTP 回應」。chromium 的 `Missing X server` 是**連帶症狀**:上游連不上 → 4011 → WS 關 →
`disconnect` 收掉 session → Xkasmvnc 被殺 → chromium 看到 X 消失。修好上游 auth,這串就消失。

**修法(已內建):**
1. **kasm-browser image** 用 `kasmvncpasswd` 建一個讀寫使用者(build args `KASMVNC_USER/PASSWORD`,
   預設 `telepy` / `telepyvnc`,寫到 `/root/.kasmpasswd`,Xkasmvnc 預設讀它)。
2. **consumer** 連上游 ws 時帶 `Authorization: Basic …`(env `KASM_WS_USER/PASSWORD`,預設同上;
   兩者由 `docker-compose.yml` 同一組 `.env` 控制)。預設 scheme 改回 **ws**、path **`/websockify`**,
   仍保留 scheme/path 自動退回。

**套用:**
```bash
docker compose up -d --build kasm-browser backend   # kasm-browser 必須重 build(建帳密);backend 重建以套新 env
```
成功後 log 會出現 `remote-browser(vnc): upstream connected ws://kasm-browser:8453/websockify`。

> dbus 的 `Failed to connect to /run/dbus/system_bus_socket` 是**非致命警告**,不影響顯示;要消掉可
> 之後用 `dbus-run-session -- chromium …` 包一層,先不急。

## 5. Phase 0 探測(要固定 ws 值、或仍連不上時跑,一次確認 ws 事實)

```bash
# 1) 起一顆 KasmVNC session,拿 ws_port(擇一,詳見腳本 docstring):
docker compose exec kasm-browser bash -lc \
 'Xkasmvnc :10 -geometry 1280x720 -depth 24 -SecurityTypes None -disableBasicAuth \
  -websocketPort 8453 -interface 0.0.0.0 -desktop telepy & sleep 3'
# 2) 探測:
docker compose cp dev-scripts/phase0_kasmvnc_probe.py kasm-browser:/tmp/probe.py
docker compose exec kasm-browser python3 /tmp/probe.py --port 8453 --both
```
- **PASS** → 把它印出的 `KASM_WS_SCHEME / KASM_WS_PATH / KASM_WS_SUBPROTOCOL` 設進 backend 環境
  (`docker-compose.yml` 的 backend `environment:`)。consumer 已讀這三個 env。
- **NO-GO** → 依委託書維持 TigerVNC。

---

## 6. 端到端驗收清單(Task 7,你的環境)

- [ ] `docker compose up -d --build kasm-browser backend frontend` 起得來;`Xkasmvnc` 起得來、ws 埠可達。
- [ ] Phase 0 探測 PASS;env 設好。
- [ ] 前端(Option B 或 A)完成:UI Start → **真桌面 Chromium 直接開 Google 首頁**。
- [ ] 滑鼠鍵盤可操作;**中文可輸入**(KasmVNC seamless 剪貼簿貼上、或 IME)。
- [ ] **剪貼簿雙向**:本機 ↔ 遠端可互貼(含中文)。
- [ ] proxy 走目標出口:遠端瀏覽器開 IP 查詢頁,公網 IP == 目標機器 IP。
- [ ] 反爬蟲:多刷幾個常擋機器人的站,較不會一直跳驗證(保留設定檔:同目標第二次進更少驗證)。
- [ ] per-session 隔離:兩 session 各開 → 各自桌面、各走各 proxy。
- [ ] 斷線/idle → session 被收(ssh + kasm + Redis 清空);多 worker(`GUNICORN_WORKERS≥2`)不會 "session not found"。

---

## 7. 反爬蟲:做了什麼、界線在哪

**最強的兩個條件你本來就有**:真人操作(非 CDP/webdriver → `navigator.webdriver` 為 false)+ 走**目標
機器出口 IP**(住宅型 IP)。本次再加:
- `--disable-blink-features=AutomationControlled`(移除自動化訊號)。
- `--lang` + `LANG/LANGUAGE/LC_ALL`(讓 `navigator.languages` / `Accept-Language` 非空;空值是機器人特徵)。
- **保留共用設定檔**(`--user-data-dir=/profiles/<server_id>`):cookie/登入跨 session 累積 → 通過一次
  後較不會一直重跳。(代價:同一目標的並發 session 會共用設定檔;Chromium 對同 profile 有 SingletonLock,
  同目標「同時」開第二個會卡 —— remote-browser 通常一目標一人,可接受。)

**界線(誠實說):**
- **WebGL renderer = SwiftShader/llvmpipe**(容器無 GPU、軟體渲染)是已知的 VM/bot 指紋,無 GPU 難根治。
- UA 是 **Chromium** 而非 Chrome;**不建議硬改 UA 字串**——會與 Client Hints(Sec-CH-UA)不一致,反而更可疑。
  amd64 上若要更強,可改裝真正的 `google-chrome-stable`(arm64 無官方桌面版)。
- Cloudflare/reCAPTCHA 是軍備競賽,**無法保證完全免除**。

---

## 8. 回退 / Rollback

- 前端未完成前:**別上 prod**。要回可用版:`git checkout feat/vnc-remote-browser`(TigerVNC,raw-RFB,
  stock noVNC,已測可用)。
- session_manager 對 VNC server 以 env 樣板解耦(`VNC_CMD`/`VNC_SERVER_BIN`/`BROWSER_CMD` 可覆寫),
  必要時同一顆 image 可同時裝 TigerVNC + KasmVNC 做灰度。

## 附:確認過的官方出處
- KasmVNC README(broke from RFB;自家 client): https://github.com/kasmtech/KasmVNC
- Differences From TigerVNC: https://github.com/kasmtech/KasmVNC/wiki/Differences-From-TigerVNC
- Configuration(require_ssl / websocket_port / clipboard): https://kasmweb.com/kasmvnc/docs/latest/configuration.html
- Disable basic auth(-disableBasicAuth): https://github.com/kasmtech/KasmVNC/issues/284
- Releases(1.4.0): https://github.com/kasmtech/KasmVNC/releases
