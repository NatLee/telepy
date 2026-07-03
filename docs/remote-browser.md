# Remote Browser(KasmVNC)

> 讓使用者在網頁上操作一個「經目標機器出口上網」的真實 Chromium 桌面。
> 本文是 KasmVNC 版的**最終架構文件**(2026-07-03 遷移完成;過程紀錄見
> `docs/articles/2026-07-03-kasmvnc-migration-warstory.md`)。

## 架構總覽

```
Browser (vendored KasmVNC noVNC-fork client)
   │  wss /ws/remote-browser/<session_id>/(JWT 首訊息認證)
   ▼
Django RemoteBrowserConsumer(tunnels/consumers.py)
   │  1. 驗 JWT + tunnel VIEW 權限(server_id 二次驗證)
   │  2. WS↔WS 透明中繼(逐訊息轉發,不解析協定)
   ▼
kasm-browser 容器 :<ws_port>(KasmVNC websocket,Basic Auth)
   ├─ Xkasmvnc :N(每 session 一個 display;ws_port = 8443 + N)
   ├─ openbox + chromium(respawn 迴圈包裹;每 session 專屬臨時 profile)
   └─ session-manager(:7000,X-Internal-Token 保護的 HTTP API)

chromium --proxy-server=socks5://backend:<port>
   ▲
   └─ backend 起的 `ssh -D`(經 reverse gateway 到目標機器)= 出口 IP
```

- **為什麼是 WS↔WS 而不是 raw-RFB TCP:** KasmVNC 已脫離 RFB 規範,只開
  websocket、不開傳統 VNC 埠,且 **stock noVNC 連不上**(黑畫面),必須用它
  自家 fork 的 client(已 vendor,見下)。
- **握手順序**(VNC 是 server 先說話,不能漏 greeting):前端 `auth` →
  後端連上游、回 `ready` → 前端把同一條 WS 交給 RFB client → 回 `begin` →
  後端才開始 pump 上游 bytes。

## 元件地圖

| 元件 | 位置 | 職責 |
|---|---|---|
| REST start/stop/ping | `authorized_keys/remote_browser_service.py` | ssh -D、呼叫 session-manager、Redis session store、idle GC |
| session-manager client | `services/kasm_client.py` | 對 kasm-browser :7000 的 HTTP client |
| WS 中繼 | `tunnels/consumers.py` `RemoteBrowserConsumer` | JWT+權限、上游連線(含 scheme/path 自動退回)、雙向 pump |
| session-manager | `docker/kasm-browser/session_manager.py` | 每 session:Xkasmvnc + openbox + chromium(respawn 迴圈、臨時 profile) |
| 前端面板 | `src/frontend/src/components/tunnels/RemoteBrowserPanel.tsx` | 握手、IME textarea、剪貼簿/IME/滑鼠設定 |
| Vendored client | `src/frontend/src/vendor/kasm-novnc/` | kasmtech/noVNC v1.3.0;**內嵌需求見該 README(必讀)** |

## KasmVNC 事實表(實測釘死,別重查)

| 項目 | 值 |
|---|---|
| stock noVNC 相容? | **否**。必須用 kasmtech/noVNC fork(server 1.4.0 ↔ client 1.3.0) |
| 傳輸 | 純 ws(`-sslOnly` 預設關);端點 **`/websockify`**;subprotocol `binary` |
| `Sec-WebSocket-Origin` | **必帶**(Hixie 時代 legacy header,值不驗)。缺了回 404 "failed websocket checks"(不是 401!) |
| Basic Auth | 預設開;`-disableBasicAuth` 在 1.4.0 無效 → 用 `kasmvncpasswd` 建使用者、連線帶 `Authorization: Basic` |
| 密碼檔 | 固定路徑 `-KasmPasswordFile /etc/kasmvnc/kasmpasswd`(**勿靠 `$HOME`**:build 與 runtime 的 HOME 不同 → 一律 401) |
| ws_port | `8443 + display`(`WS_BASE` 可調) |

## Session 生命週期

- **建立:** REST `/remote-browser/start` → ssh -D(等 SOCKS listen)→
  session-manager 起 Xkasmvnc/openbox/chromium → session 記錄進 Redis
  (跨 gunicorn worker 查詢用)。
- **SSH -D 冷啟/重試:** `username@reverse` 是兩跳(ProxyCommand→telepy-ssh→反向隧道到
  裝置 sshd),且 browser 用**獨立**的 ControlMaster(與終端機的 `/tmp/ssh_fm_*` 不共用),
  所以每個 target 的**第一次**連線是冷的,穿隧道到裝置 + 建 SOCKS 可能 >30s 而逾時。修法:
  `_spawn_socks_proxy` 帶硬化選項(`BatchMode`/`ExitOnForwardFailure`/`ConnectTimeout`/
  `ServerAlive`,不再無限卡在認證;不加 `-q` 以保留 stderr),`start_remote_browser` **自動
  重試**(預設 2 次,`remote_browser_ssh_attempts`)——第二次因 hop1 master 與裝置路由已暖而
  通常成功。真正離線的裝置(reverse 埠不存在)會秒失敗、不會空等。失敗時 ssh stderr 會寫進
  backend log 供偵錯。
- **Profile:** 每 session `mkdtemp` 專屬目錄、**停止即刪**(不保留歷史)。
  絕不共用:Chromium SingletonLock 會讓第二個並發 session 的 chromium 委派給
  第一個後退出(log:`Opening in existing browser session.`),兩敗俱傷。
  瀏覽器行程的 `HOME` 也指到這個目錄(dotfile 等家目錄寫入隨 session 刪除)。
- **Chromium 關閉/crash:** `browser_watchdog.sh` 以「**可見視窗數**」(xdotool
  `--onlyvisible`)判斷、約 10–15 秒內重開(同 profile 同 proxy)。**不能用
  行程級 respawn**:background mode 讓使用者關掉最後一個視窗後主行程依然活著
  (`--disable-background-mode` 等旗標實測壓不住),行程級迴圈永遠等不到 → 黑畫面。
- **下載:** Chromium 管理策略(`/etc/chromium/policies/managed/telepy.json`)
  `DownloadRestrictions: 3` **全面封鎖**——容器裡下載的檔案使用者本來就拿不到
  (沒有取檔通道),只會累積吃掉容器磁碟。要開放需同時設計配額與取檔機制。
- **停止:** WS 斷線即收整個 session(ssh + kasm + Redis);idle GC 為後備。
  行程用 `killpg(p.pid)` 整組收(`start_new_session` ⇒ pgid == pid;不可用
  `getpgid`,group leader 先死會 raise 而漏殺孤兒)。
- **殭屍:** kasm-browser 以 `init: true`(tini)當 PID 1 回收 reparent 的孤兒。
- **視窗:** openbox 以 `--config-file /app/openbox-rc.xml` 啟動(build 時由預設
  rc.xml 併入 applications 規則):`<decor>no</decor>` 移除標題列 + `<maximized>true</maximized>`
  填滿 display。chromium 自己的 `--start-maximized` 實測只給 1050×720、留邊且帶標題列。
- **sandbox:** `--no-sandbox` 是容器內以 root 跑的必要之惡(Docker 預設
  seccomp 擋 unprivileged userns);`--test-type` 壓掉黃色警告條。要開真
  sandbox 需 compose 掛自訂 seccomp profile(未做,隔離邊界=容器)。實測 `--test-type`
  對 JS 指紋(webdriver/chrome/languages/plugins/vendor)零影響、警告列網頁也看不到。

## 反爬蟲(anti-detection)

真人透過 VNC 操作 + 經目標機出口 IP,本身就是最強的反偵測條件。旗標是加分:

- `--disable-blink-features=AutomationControlled` → `navigator.webdriver = false`。
- 語系:`--lang` + `--accept-lang` 給非空、一致的語系(空的 `navigator.languages`
  是機器人特徵)。
- **`--accept-lang` 必須傳乾淨語言標籤、不能帶 q-value**(`_accept_lang` 回 `zh-TW,zh,en`)。
  chromium 用這個值同時決定 HTTP `Accept-Language` header **與** `navigator.languages`,
  且會自己算 header 的 q-value。若我們先塞 q 進去(舊 bug):
  - `Accept-Language` header 疊成 `zh-TW,zh;q=0.9,zh;q=0.9;q=0.8,en;q=0.8;q=0.7`(雙重 q)
  - `navigator.languages` 變成 `['zh-TW','zh;q=0.9','en;q=0.8']`(q 洩漏)

  兩者都是真瀏覽器絕不會有的鐵特徵 → 到處被 CAPTCHA。乾淨標籤 → header 正確為
  `zh-TW,zh;q=0.9,en;q=0.8`、`navigator.languages` 為 `['zh-TW','zh','en']`。
- **WebGL(`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`)**:容器無
  GPU,headed chromium 在無 GPU 的 X display 上 GPU 初始化失敗 → `canvas.getContext("webgl")`
  回 **null**(實測)。「完全沒有 WebGL」是強烈機器人特徵(YouTube 的「登入確認你不是機器人」
  會查)。這三個旗標強制 SwiftShader 軟體渲染 → WebGL 正常。實測 headed:baseline `NO_WEBGL`
  → 加旗標 `OK ANGLE (SwiftShader...)`。註:renderer 顯示 SwiftShader(非真 GPU),仍是弱訊號;
  要更像真機需在 client 端 spoof `getParameter` 的 renderer 字串(未做)。

### 極限(誠實說明)

旗標只處理**瀏覽器指紋**。YouTube 這類的封鎖,主宰因素是另外兩個,本專案無法用旗標解決:

1. **出口 IP 信譽**:流量走目標機 IP(`ssh -D`)。目標機若是資料中心/雲端/VPN IP,或該 IP
   已被大量自動化存取汙染,YouTube/Cloudflare 會直接擋 —— **與瀏覽器指紋完全無關**。要繞開
   只能換一台住宅 IP 的目標機。
2. **無 cookie/登入信任**:設定檔每 session 全新(privacy 需求,不留歷史)。YouTube 對「有登入/
   有瀏覽歷史」的 session 信任度高很多;全新 session 天生更容易被要求驗證。這與「不保留歷史」
   直接衝突,目前站在 privacy 這邊。

## 環境變數(都有預設,通常不用設)

| 變數 | 預設 | 用途 |
|---|---|---|
| `KASM_WS_USER` / `KASM_WS_PASSWORD` | `telepy` / `telepyvnc` | KasmVNC web 層 Basic Auth(backend 連線帶、kasm-browser build 時建;同一 .env 控制) |
| `KASM_WS_SCHEME` / `KASM_WS_PATH` / `KASM_WS_SUBPROTOCOL` | `ws` / `/websockify` / `binary` | 上游 ws 優先嘗試值(consumer 仍會自動退回其他組合) |
| `KASM_PASSWORD_FILE` | `/etc/kasmvnc/kasmpasswd` | 密碼檔固定路徑 |
| `REMOTE_BROWSER_HOMEPAGE` / `REMOTE_BROWSER_LANG` | Google / `zh-TW` | 首頁 / 語系(語系影響 navigator.languages,反爬蟲) |
| `REMOTE_BROWSER_PROFILE_TMP` / `WS_BASE` | `/tmp` / `8443` | 臨時 profile 父目錄 / ws 埠基數 |

## 疑難排解

```bash
# 後端測試(真 stack):
docker compose exec backend sh -c 'cd /src && python manage.py test --noinput'
# session-manager 測試(純 stdlib):
cd docker/kasm-browser && python3 -m unittest discover -s tests -p "test_*.py"

# 上游 ws 連不上?起一顆 standalone Xkasmvnc + 探測腳本(不會被 session 回收):
docker compose exec kasm-browser bash -lc \
  'Xkasmvnc :20 -geometry 1280x720 -depth 24 -SecurityTypes None \
   -KasmPasswordFile /etc/kasmvnc/kasmpasswd -websocketPort 8463 \
   -httpd /usr/share/kasmvnc/www -interface 0.0.0.0 & sleep 3'
docker compose cp dev-scripts/phase0_kasmvnc_probe.py kasm-browser:/tmp/probe.py
docker compose exec kasm-browser python3 /tmp/probe.py --port 8463 \
  --user telepy --password telepyvnc
```

- `404 failed websocket checks` → 缺 `Sec-WebSocket-Origin`(probe/consumer 已內建)。
- `401` → 帳密或密碼檔問題:`ls -l /etc/kasmvnc/kasmpasswd; wc -c` 檢查非空。
- 前端黑畫面但 ws 有通 → client 不是 Kasm fork,或 vendor README 的內嵌需求
  (mouseButtonMapper、compositionend 歸零)沒做。
- 查活行程時注意 `pgrep -f` 會匹配到你自己外層 shell 的 cmdline,用
  `ps ax | grep "[c]hromium"` 括號技巧。
