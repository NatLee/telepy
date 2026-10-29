# Remote Browser(KasmVNC)

> 讓使用者在網頁上操作一個「經目標機器出口上網」的真實 Chromium 桌面。
> 本文是 KasmVNC 版的**架構文件**(2026-07-03 遷移完成;過程紀錄見
> [`articles/2026-07-03-kasmvnc-migration-warstory.md`](articles/2026-07-03-kasmvnc-migration-warstory.md))。
>
> **現況(2026-10):** 後端已改寫為 Rust 單一程序(見 [`rust-migration-plan.md`](rust-migration-plan.md)):
> - session store 在記憶體(另存一張小表 `telepy_remote_browser_session`,只給重啟後回收 kasm 側的孤兒用),
>   沒有 gunicorn 多 worker、沒有 Redis。
> - SOCKS 代理在**行程內**(`ssh/socks.rs`):每個 CONNECT 是連線池那條裝置連線上的一條 direct-tcpip channel,
>   由裝置的 sshd 連出去 —— 和以前的 `ssh -D` 同一個機制,但不再 spawn 子程序。
> - KasmVNC / Chromium / session-manager、WS 握手與反爬蟲旗標不變。
>
> 文中標「歷史」的段落描述 Django 版的 `ssh -D` / Redis / gunicorn,只留作設計脈絡。

## 架構總覽

```
Browser (vendored KasmVNC noVNC-fork client)
   │  wss /ws/remote-browser/<session_id>/(JWT 首訊息認證)
   ▼
backend ws/remote_browser.rs（Rust）
   │  1. 驗 JWT(首訊息)+ 功能權限 remote_browser(4012)+ tunnel VIEW 權限(session 的 server_id 二次驗證)
   │  2. WS↔WS 透明中繼(逐訊息轉發,不解析協定);ws::Heartbeat 每 20s Ping,40s 沒回應就當人走了
   ▼
kasm-browser 容器 :<ws_port>(KasmVNC websocket,Basic Auth)
   ├─ Xkasmvnc :N(每 session 一個 display;ws_port = 8443 + N)
   ├─ openbox + chromium(respawn 迴圈包裹;每 session 專屬臨時 profile)
   └─ session-manager(:7000,X-Internal-Token 保護的 HTTP API)

chromium --proxy-server=socks5://backend:<port> --proxy-bypass-list='<-loopback>'
   ▲
   └─ backend 行程內的 SOCKS5(ssh/socks.rs,只做 CONNECT、不認證,埠只在 docker network 內)
      每個 CONNECT = 連線池那條裝置連線上的 direct-tcpip,由裝置 sshd 連出去 = 出口 IP
      (localhost/127.0.0.1 亦經此送到目標機,見下方 --proxy-bypass-list 說明;
       名稱目標先經 ssh::resolve —— macOS 的 sshd 收到名稱的 direct-tcpip 會整條連線斷掉)
```

- **為什麼是 WS↔WS 而不是 raw-RFB TCP:** KasmVNC 已脫離 RFB 規範,只開
  websocket、不開傳統 VNC 埠,且 **stock noVNC 連不上**(黑畫面),必須用它
  自家 fork 的 client(已 vendor,見下)。
- **握手順序**(VNC 是 server 先說話,不能漏 greeting):前端 `auth` →
  後端連上游、回 `ready` → 前端把同一條 WS 交給 RFB client → 回 `begin` →
  後端才開始 pump 上游 bytes。
- **為什麼 chromium 要帶 `--proxy-bypass-list='<-loopback>'`:** chromium 對 loopback
  目的地(`localhost` / `127.0.0.1/8` / `::1` / `*.localhost`)**內建「一律直連、不走 proxy」的
  隱含規則**。少了這旗標,使用者在代理瀏覽器輸入 `http://localhost:PORT` 會被 chromium **直連**到
  kasm-browser **容器自己**的 loopback(空的),而非目標機器 → 回報「代理瀏覽器不能完全以目標機
  身分訪問,連 localhost 都連不到」。`<-loopback>` 是 chromium 專門用來**移除**該隱含 loopback
  bypass 的 token;移除後 loopback 目的地改由 `--proxy-server` 的 SOCKS 送到目標機、在目標機
  上 `connect(127.0.0.1:PORT)`(這條 SOCKS 的出口就是目標機 sshd,`127.0.0.1` = 目標機自己),代理
  瀏覽器才真正「完全以目標機身分」訪問其本機服務。**單引號不可省**:整條 `BROWSER_CMD` 最後經
  `open-browser.sh` 的 `sh -c "$BROWSER_CMD"` **二次** shell 解析,`<` / `>` 不引起來會被當成
  重導向 metacharacter。一般外網瀏覽照走 proxy(出口 IP)不變;`<-loopback>` 移除的是 chromium 對
  loopback **與 link-local** 的隱含 bypass(整組為 `localhost` / `*.localhost` / `[::1]` /
  `127.0.0.1/8` / `169.254/16` / `[FE80::]/10`),故這些「本地位址」一併改走 proxy → 目標機網路
  (對本用途無害,正合「以目標機身分」);VNC 傳輸(Xkasmvnc 自家 websocket,與 chromium 網路層
  無關)不受影響。

## 元件地圖

| 元件 | 位置 | 職責 |
|---|---|---|
| REST start/stop/ping | `src/backend-api/src/api/remote_browser.rs` + `remote_browser/mod.rs` | 借池的裝置連線、開行程內 SOCKS(含重試)、呼叫 session-manager、記憶體 session store（重啟回收用的小表）、reaper |
| 行程內 SOCKS5 | `src/backend-api/src/ssh/socks.rs` | 只做 CONNECT;每條連線 = 裝置連線上的 direct-tcpip(傳輸 lease,不占 session 額度) |
| session-manager client | `src/backend-api/src/remote_browser/kasm.rs` | 對 kasm-browser :7000 的 HTTP client(建立 / 停止 / CDP) |
| WS 中繼 | `src/backend-api/src/ws/remote_browser.rs` | JWT+功能+權限、上游連線(含 scheme/path 自動退回)、雙向 pump、presence、心跳 |
| agent / 腳本開的瀏覽器 | `src/backend-api/src/ai/browser.rs`、`mcp/`、`api/browser.rs` | MCP `browser_*` 工具與 REST `/api/browser/sessions*`(見下方「MCP agent 與腳本操作」) |
| session-manager | `docker/kasm-browser/session_manager.py` | 每 session:Xkasmvnc + openbox + chromium(respawn 迴圈、臨時 profile) |
| CDP 轉接 | `docker/kasm-browser/cdp.py` | session-manager 收到的動作 → 容器內 loopback 上的 Chromium DevTools |
| 前端面板 | `src/frontend/src/components/tunnels/RemoteBrowserPanel.tsx` | 終端機頁的 Browser 主畫面(通道列表的 Browser 按鈕);握手、IME textarea、剪貼簿/IME/滑鼠設定 |
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

- **建立:** `POST /api/reverse/server/{id}/remote-browser/start` `{username?}`:檢查功能權限 `remote_browser`、
  通道 VIEW、step-up(敏感通道)、`username` 在 `permissions::allowed_usernames` 裡(沒帶 = 通道預設帳號,否則第一個
  允許的)、`remote_browser_max_sessions` → 借連線池的裝置連線、開行程內 SOCKS → session-manager 起
  Xkasmvnc/openbox/chromium → session 進記憶體(並寫一列 `telepy_remote_browser_session`)→ 回 `{session_id, ws_path}`。
- **SOCKS 冷啟/重試:** 每次嘗試 = `ssh::pool` 借一個傳輸 lease(同一個 (通道, 帳號) 的終端機 / 檔案已經登入的話直接共用)
  + `SocksProxy::start`,整段以 `remote_browser_ssh_timeout` 為上限,失敗重試到 `remote_browser_ssh_attempts` 次
  (預設 30 秒 / 2 次;設定名稱沿用 `ssh -D` 時代)。gateway 上沒有這條通道的 forward(裝置離線)就秒失敗、不空等,
  回 500 + `code: device_offline`(前端翻成 `browser.*`)。
- **歷史(Django 版的 `ssh -D`):** `username@reverse` 是兩跳(ProxyCommand→telepy-ssh→反向通道到
  裝置 sshd)。`_spawn_socks_proxy` 帶硬化選項(`BatchMode`/`ExitOnForwardFailure`/
  `ConnectTimeout`/`ServerAlive`,不再無限卡在認證;不加 `-q` 以保留 stderr),
  `start_remote_browser` 自動重試(預設 2 次,`remote_browser_ssh_attempts`)。
  真正離線的裝置(reverse 埠不存在)會秒失敗、不會空等。失敗時 ssh stderr 會寫進 backend log。
- **歷史:那條 -D 必須 `ControlMaster=no` + `ControlPath=none`(實測血淚;行程內 SOCKS 沒有這個問題):** ssh config 對
  `Host reverse` 開了 `ControlMaster auto` + `ControlPersist`,冷啟時 ssh 會 fork 出**背景
  master** 後讓前景 client 立刻退出 → `Popen.poll()` 誤判「ssh 死了」→ attempt 1 永遠假失敗
  (log 一直出現 `attempt 1/2 did not bind ... no stderr` 但 0.2s 就放棄),而 master 稍後才把
  -D 綁上,變成**沒人管的孤兒 listener**(實測活了 16 小時)。停用 mux 後這條 -D 的生命週期
  = 該 Popen,poll()/terminate() 語義正確、session 互相隔離;ProxyCommand 的第一跳
  (telepy-ssh)仍走它自己的 mux,冷啟只慢在第二跳 handshake(由 `remote_browser_ssh_timeout`
  控制,慢通道可在站台設定調大)。
- **Profile:** 每 session `mkdtemp` 專屬目錄、**停止即刪**(不保留歷史)。
  絕不共用:Chromium SingletonLock 會讓第二個並發 session 的 chromium 委派給
  第一個後退出(log:`Opening in existing browser session.`),兩敗俱傷。
  瀏覽器行程的 `HOME` 也指到這個目錄(dotfile 等家目錄寫入隨 session 刪除)。
- **Chromium 關閉/縮小/消失:** 最小化的視窗可從**工作列**點回來;關掉視窗(chromium 行程
  仍在 background mode)可點面板的**「開啟瀏覽器」捷徑**(open-browser.sh)再開 —— 捷徑會先
  聚焦/還原既有視窗,沒有視窗才全新啟動(收掉 background mode 殘留主行程,避免只印
  「Opening in existing browser session」卻不開窗)。**chromium 行程完全消失**(崩潰/整個退出)
  時,session-manager 的 **watchdog** 每 10s 檢查(以 `--user-data-dir` 掃 /proc)並自動用同一
  支 open-browser.sh 重開(15s 建立寬限、30s 重啟冷卻;`REMOTE_BROWSER_RESPAWN=0` 可關)。
  實測有使用者回到 session 只剩空桌面以為功能整個壞掉 —— session 的意義就是那顆瀏覽器。
- **所有桌面啟動路徑都收斂到 open-browser.sh:** 右鍵桌面的 openbox 根選單已換成自訂
  `openbox-menu.xml`(Debian 預設選單的「Web browser」= 裸 `x-www-browser` → root 無沙箱秒退,
  使用者只覺得「點了沒反應」)。`BROWSER_CMD` 由 session-manager 以環境傳給 openbox/tint2/
  watchdog,另外落一份 **per-display env 檔** `/tmp/telepy-browser-<display>.env`(session 停止
  即刪):open-browser.sh 發現環境遺失時以 `$DISPLAY` source 它 —— 任何啟動路徑都開得起來
  (實測血淚:舊版 openbox 沒帶 env,使用者從桌面選單開瀏覽器 → `BROWSER_CMD not set`)。
- **下載:** Chromium 管理策略(`/etc/chromium/policies/managed/telepy.json`)
  `DownloadRestrictions: 3` **全面封鎖**——容器裡下載的檔案使用者本來就拿不到
  (沒有取檔通道),只會累積吃掉容器磁碟。要開放需同時設計配額與取檔機制。
- **停止:** WS 斷線即收整個 session(SOCKS 代理 + 還 lease、kasm session、那一列記錄);
  `POST /api/reverse/server/remote-browser/{sid}/stop`(面板關閉、分頁 `beforeunload`)同一條路;reaper 為後備。
  kasm 那邊的行程用 `killpg(p.pid)` 整組收(`start_new_session` ⇒ pgid == pid;不可用
  `getpgid`,group leader 先死會 raise 而漏殺孤兒)。
- **續命與健康檢查:** WS 連著時中繼自己每 20s 續命一次(伺服器端計時,不受背景分頁節流影響),前端面板另每 15s
  打 `POST …/remote-browser/{sid}/ping`。ping 先探測該 session 的 SOCKS 埠(`127.0.0.1:proxy_port`)——**埠沒在聽 =
  代理已死** → 就地回收並回 404,前端收到即收畫面顯示「session 已結束」。reaper 每 10s:底下的裝置連線斷了
  (`SocksProxy::alive`)或超過 `remote_browser_session_idle_timeout` + 30s 沒有續命 → 回收。
- **重啟後的孤兒:** 單一程序,重啟時記憶體裡的 session 與代理都沒了;啟動時 `cleanup_orphans` 依那張小表把 kasm 側
  留下的 session 全部停掉、刪記錄。
- **歷史(gunicorn 多 worker + Redis):** ping 探測 SOCKS 埠靠「各 worker 共用 netns」;idle GC 另掃「Redis 有記錄、
  不屬於本行程、埠沒在聽」的孤兒(擁有者 worker 已重啟,沒人持有 ssh handle)代為收掉 kasm session + Redis 記錄。
- **誰在用、可以被結束:** WS 中繼加入 presence(kind `browser`,帶它用的裝置帳號),擁有者 / ADMIN 在通道列表的使用中按鈕與
  即時 session 頁(`/tunnels/sessions`)看得到,可以結束(4009,reason = 誰);gateway 事件 `browser_open` / `browser_close`
  (含時長)寫進該通道的 Logs;開始時對擁有者與 ADMIN(不含本人)發 `session.started` webhook。
- **失去權限就結束**(`access_recheck.rs`,和終端機 / 檔案 / 桌面同一套):取消分享、允許清單變小、功能 `remote_browser`
  被關、帳號停用等 → 4009,reason `Telepy (access changed)`,`browser_close` 附上為什麼,本人收到 `SESSION-ENDED`;中繼收尾
  時照樣停掉 kasm session。測試 `remote_browser_ends_when_access_is_lost`。
- **斷線偵測:** 中繼讀 socket 經 `ws::Heartbeat`(每 `WS_PING_INTERVAL_SECS` = 20s 送 WebSocket Ping,ping 後
  `WS_PEER_TIMEOUT_SECS` = 40s 內什麼都沒收到就當人走了),所以筆電睡著、換網路、proxy 掉線不再讓 session 與 presence 永遠掛著。
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
- **WebGL(`--enable-unsafe-swiftshader`,且**只**這一個)**:容器無 GPU,headed chromium 在無
  GPU 的 X display 上 GPU 初始化失敗 → `canvas.getContext("webgl")` 回 **null**(實測)。「完全
  沒有 WebGL」是強烈機器人特徵(YouTube 的「登入確認你不是機器人」會查)。`--enable-unsafe-swiftshader`
  **只**允許 WebGL context 回退 SwiftShader,不動合成器 → WebGL 正常(`OK ANGLE (SwiftShader...)`)。
  **踩過的雷**:曾加 `--use-gl=angle --use-angle=swiftshader` 想確保 WebGL,結果把整個 GL **合成器**
  也強制走軟體 SwiftShader → **YouTube 影片播不動**。實測(真 VP9 解碼 640x480):forced-swiftshader
  掉 4 幀、`--enable-unsafe-swiftshader` 單獨與 baseline 皆掉 0 幀,且單獨版 WebGL 一樣正常。720p/1080p
  下 forced 版的掉幀會嚴重到播不動。**結論:只留 `--enable-unsafe-swiftshader`,絕不加 `--use-gl`。**
  註:renderer 顯示 SwiftShader(非真 GPU),仍是弱訊號;要更像真機需在 client 端 spoof
  `getParameter` 的 renderer 字串(未做)。

### 極限(誠實說明)

旗標只處理**瀏覽器指紋**。YouTube 這類的封鎖,主宰因素是另外兩個,本專案無法用旗標解決:

1. **出口 IP 信譽**:流量走目標機 IP(經裝置 sshd 的 SOCKS)。目標機若是資料中心/雲端/VPN IP,或該 IP
   已被大量自動化存取汙染,YouTube/Cloudflare 會直接擋 —— **與瀏覽器指紋完全無關**。要繞開
   只能換一台住宅 IP 的目標機。
2. **無 cookie/登入信任**:設定檔每 session 全新(privacy 需求,不留歷史)。YouTube 對「有登入/
   有瀏覽歷史」的 session 信任度高很多;全新 session 天生更容易被要求驗證。這與「不保留歷史」
   直接衝突。

   > **已決策(2026-07-04):維持每 session 全新 profile,隱私優先。** 曾出現「YouTube 要求登入」
   > 回歸,調查確認回歸點是 967ea75(profile 改為 ephemeral)——沒有 cookie 累積 → YouTube 把每次
   > 都當可疑新訪客。可選的折衷是「只持久化 cookie/登入、仍不留瀏覽歷史」,但使用者選擇隱私優先、
   > 接受偶爾被要求登入(反正主宰因素是出口 IP)。**若日後要降低攔截,優先換住宅 IP 目標機,而非
   > 動 profile。** 不要在未取得使用者同意下重新加回 profile 持久化。

## MCP agent 與腳本操作(CDP)

MCP agent（scope `browser:use`）可以開一個瀏覽器自己操作，見 [`mcp.md`](mcp.md)；同一組動作也有 REST 版
`/api/browser/sessions*`（`api/browser.rs`：開 `{tunnel_id, username?, url?}`、`navigate`、`text?selector=`、`screenshot`（image/png）、
`click`、`type`、`DELETE`、列出），給個人 API token（scope `browser:use`）、`telepy browse` 指令（見 [`cli.md`](cli.md)）與網頁登入用。
它們都是一般的 remote-browser session（同一個 SOCKS、同一個 kasm session、同樣算進 `remote_browser_max_sessions`），
只是沒有人連 VNC：

- 一個瀏覽器屬於開它的那個憑證（OAuth app、API token 或網頁登入）；和 agent 的 SSH session 一起算進
  `ai_max_sessions_per_user`，閒置 / 壽命 / 撤銷 / 失去權限 / 裝置離線由 `crate::ai` 的 reaper 收（規則含 OAuth grant，不走上面的 access recheck；同一批觸發點另叫 `ai::recheck` 立刻跑一次）。
- presence kind `browser`、client = app 名稱，即時 session 頁看得到、可以結束（之後的動作回「被誰結束」）；
  開關寫 `browser_open` / `browser_close` 事件，每個動作寫 AI 稽核（`browser_type` 的文字只記長度，除非 `sensitive: false`）。
- step-up 的通道一律拒絕（403 `step_up_refused` / tool error）；功能 `remote_browser` 關掉時不能開、不能動作（列出與關閉照常）。

```
MCP tool (browser_navigate / read / click / type / screenshot) 或 REST /api/browser/sessions/{id}/…
  → backend ai/browser.rs → remote_browser::RemoteBrowser::cdp
  → session-manager POST /sessions/<id>/cdp(X-Internal-Token)
  → cdp.py → ws://127.0.0.1:<CDP_BASE + display>(chromium --remote-debugging-port,只聽容器內 loopback)
```

- DevTools 埠只在容器內的 127.0.0.1，backend 從不直接連 CDP；每個動作上限 30 秒（`CDP_ACTION_TIMEOUT`）。
- 動作：`navigate`（只收 http / https；後端也擋 `file:` 之類，免得讀到容器自己的檔案）、`screenshot`（CDP clip.scale 縮到
  ≤ 1280 px 寬）、`read`（innerText + 連結，可用 selector）、`click`（selector 或看得到的文字；真的滑鼠事件
  `Input.dispatchMouseEvent`）、`type`（focus + `Input.insertText`，可按 Enter）。
- 操作的分頁 = `/json/list` 裡第一個一般網頁；全部關掉時開一個 `about:blank`。
- `cdp.py` 只用標準函式庫（自帶最小的 WebSocket client），測試在 `tests/test_cdp.py`。

## WS 關閉碼(`/ws/remote-browser/<sid>/`)

| 代碼 | 意思 |
|---|---|
| 4000 / 4001 | 首訊息認證失敗(格式 / token) |
| 4007 | 站台要求兩步驟登入,這個帳號還沒設定 |
| 4012 | 功能 `remote_browser` 對這個人關著(reason = 功能 id) |
| 4404 | session 不存在(或還沒就緒) |
| 4403 | 沒有這條通道的 VIEW |
| 4011 | 連不上 kasm-browser 的 KasmVNC websocket |
| 4013 | 上游(KasmVNC)關閉或送不出去 |
| 4009 | 從即時 session 頁被結束,或失去權限(reason = 誰 / `Telepy (access changed)`) |
| 4010 | 這個瀏覽器的網頁登入被登出(reason = user / admin / logout / reuse / disabled) |

前端 `RemoteBrowserPanel` 把 4403 / 4404 / 4011 / 4013 對到 `browser.*` 的翻譯。

## 站台設定(Settings → Remote browser)

| key | 預設 | 說明 |
|---|---|---|
| `remote_browser_session_idle_timeout` | 60 | 沒有續命多久(再加 30s 寬限)就回收(秒) |
| `remote_browser_max_sessions` | 10 | 整站同時上限(含 agent / 腳本開的),0 = 不限 |
| `remote_browser_geometry` | `1280x720` | 每個瀏覽器桌面的解析度 |
| `remote_browser_ssh_timeout` / `remote_browser_ssh_attempts` | 30 / 2 | 每次開 SOCKS 代理的逾時(秒)與嘗試次數(名稱沿用 `ssh -D` 時代) |
| `remote_browser_kasm_create_timeout` | 30 | 等 session-manager 起好 Xkasmvnc + chromium 的逾時(秒) |
| `remote_browser_homepage` / `remote_browser_language` | Google / `zh-TW` | 首頁 / 語系(下次開瀏覽器時生效;沒填退回 kasm-browser 的環境變數) |

## 環境變數(都有預設,通常不用設)

backend 這邊:`KASM_BROWSER_API`(預設 `http://kasm-browser:7000`,session-manager)、`KASM_BROWSER_HOST`(預設 `kasm-browser`,
連 KasmVNC websocket 用)、`INTERNAL_API_TOKEN`(backend → session-manager 的 `X-Internal-Token`)。kasm-browser 容器與兩邊共用的:

| 變數 | 預設 | 用途 |
|---|---|---|
| `KASM_WS_USER` / `KASM_WS_PASSWORD` | `telepy` / `telepyvnc` | KasmVNC web 層 Basic Auth(backend 連線帶、kasm-browser build 時建;同一 .env 控制) |
| `KASM_WS_SCHEME` / `KASM_WS_PATH` / `KASM_WS_SUBPROTOCOL` | `ws` / `/websockify` / `binary` | 上游 ws 優先嘗試值(後端中繼仍會自動退回其他組合) |
| `KASM_PASSWORD_FILE` | `/etc/kasmvnc/kasmpasswd` | 密碼檔固定路徑 |
| `REMOTE_BROWSER_HOMEPAGE` / `REMOTE_BROWSER_LANG` | Google / `zh-TW` | 首頁 / 語系(語系影響 navigator.languages,反爬蟲) |
| `REMOTE_BROWSER_PROFILE_TMP` / `WS_BASE` | `/tmp` / `8443` | 臨時 profile 父目錄 / ws 埠基數 |
| `CDP_BASE` / `CDP_ACTION_TIMEOUT` | `9300` / `30` | MCP agent 用的 DevTools 埠基數(埠 = `CDP_BASE + display`,只聽 127.0.0.1)/ 每個動作的秒數上限 |

## 疑難排解

```bash
# 後端測試(真 stack):
(cd src/backend-api && cargo test)   # 含 tests/remote_browser_api.rs：SSH lab 上的真裝置(行程內 SOCKS)+ 假 session-manager + 假 KasmVNC ws 的端到端;tests/socks_e2e.rs 測 SOCKS 本身
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

- **Chromium 一開就無聲消失(SIGTRAP/exit 133,watchdog 每 30s 重生又立刻死)** →
  Debian chromium 150.0.7871.46 打包 bug([#1141488](https://bugs.debian.org/1141488),2026-07):
  ungoogled 系 patch 刪了 `{google:searchSource}` token 的處理,但內建 prepopulated Google
  搜尋模板仍含該 token → 展開即 `NOTREACHED()` 無聲 SIGTRAP(`--v=1` 也沒有 FATAL)。
  在本容器的觸發面:**`--no-first-run` + 全新 profile 必炸**(每 session 都是全新 profile!)、
  `--headless=new` 也炸、使用者把預設搜尋切回內建 Google 再搜尋也會炸。已套的修法(對後續
  版本無害,修復版出來後可保留):(1) `DEFAULT_BROWSER_CMD` **移除 `--no-first-run`**(實測
  Debian build 沒有 first-run 精靈,零效益純致命,勿加回);(2) chromium-policy.json 以
  `DefaultSearchProvider*` 把預設搜尋釘成**乾淨模板的 Google**(只用 `{searchTerms}`,不經
  prepopulated 模板;順帶把該 build 預設的 DuckDuckGo 拉回 Google,並鎖住不讓使用者切到會
  閃退的內建 Google 項目 —— **勿移除這組 policy**)。緊急備案:pin 回
  149.0.7827.196-1~deb12u1(snapshot.debian.org 20260703T000000Z),但會凍結安全更新,不建議。
- `404 failed websocket checks` → 缺 `Sec-WebSocket-Origin`(probe 與後端中繼都已內建)。
- `401` → 帳密或密碼檔問題:`ls -l /etc/kasmvnc/kasmpasswd; wc -c` 檢查非空。
- 前端黑畫面但 ws 有通 → client 不是 Kasm fork,或 vendor README 的內嵌需求
  (mouseButtonMapper、compositionend 歸零)沒做。
- 查活行程時注意 `pgrep -f` 會匹配到你自己外層 shell 的 cmdline,用
  `ps ax | grep "[c]hromium"` 括號技巧。
