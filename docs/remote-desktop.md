# Remote desktop（RDP / VNC in the browser）

> 在瀏覽器裡看、操作裝置（或它區網裡電腦）的 RDP / VNC 桌面。裝置上不裝任何東西：連線由裝置自己的 sshd
> 轉接，畫面由 guacd 轉成 Guacamole 協定。程式：`src/backend-api/src/desktop/`、`api/desktop.rs`、
> `ws/desktop.rs`；前端 `app/tunnels/desktop/`、`components/desktop/`、`hooks/useDesktopPage.ts`、`lib/desktop.ts`；
> 測試 `tests/desktop_api.rs`。

## 架構

```
瀏覽器（guacamole-common-js）
  │ wss /ws/desktop/<session>/?ticket=…&width=&height=&dpi=   子協定 guacamole；票證 60 秒、只能用一次
  ▼
backend ws/desktop.rs
  │  瀏覽器→guacd：只放行 key / mouse / touch / size / sync / nop / disconnect / clipboard / blob / end / ack
  │  guacd→瀏覽器：透傳（長度單位依兩端重編碼：guacd 數碼點，瀏覽器數 UTF-16）
  │  TCP guacd:4822：Guacamole 握手在後端做完，帳密不經瀏覽器
  ▼
guacd 容器（telepy-desktop internal 網路，只有 backend 與 guacd）
  │  connect 時連回 backend 上這個 session 專屬的 rendezvous 埠（只收 guacd 的來源 IP，收到一條就關）
  ▼
backend desktop/bridge.rs
  │  copy_bidirectional ⇄ russh direct-tcpip 通道（ssh::pool 那條裝置連線上的一個傳輸 lease，不占 session 額度）
  ▼
裝置 sshd ──► 127.0.0.1:<port>（裝置自己的桌面）或 <LAN 位址>:<port>（區網主機，和 ssh -J / 區網掃描同一個機制）
```

## 流程

1. `POST /api/reverse/server/{id}/desktop/start` `{protocol, username, port?, lan_host_id?, login?, password?, domain?, quality?, clipboard?}`：
   檢查 `desktop_enabled`、隧道 VIEW、`username` 在 `permissions::allowed_usernames` 裡（裝置那一跳的帳號）、
   區網主機屬於這條隧道、`desktop_max_sessions`；接著**先**借池的連線並開 direct-tcpip 通道到目標，所以
   `device_offline` / `device_auth` / `target_unreachable` 在這一步就回 502，不必等 WebSocket。
   回 `{session_id, ws_path, ticket, expires_in, protocol, clipboard, clipboard_limit, quality, target, username}`；帳密只留在記憶體。
   `clipboard`：沒帶就用使用者的個人設定 `desktop_clipboard`，再套上站台的同名上限（取較窄的）；回應的 `clipboard` 是實際用的方向。
   帶 `credential_id` 時改用憑證庫裡那筆的 login / password / domain（見下方「憑證庫」），請求裡的帳密欄位被忽略。
2. 瀏覽器用票證開 WS。後端重驗權限、開 rendezvous、連 guacd 握手（`hostname` / `port` = rendezvous），
   guacd 連回來的那條接到第 1 步的通道。握手完成後先送 `0.,<uuid>;`（guacamole-common-js 收到才把 tunnel 標成開啟），
   再把握手期間已讀進解析器的指令送出（guacd 常把 `ready` 和第一批畫面放在同一個封包）。
3. 中繼直到任一端結束。結束原因：使用者、guacd、閒置（`desktop_session_idle_timeout`）、`/desktop/{sid}/stop`、
   權限被收回（reaper 每 10 秒重驗）。

## 延遲與串流狀況（`desktop/stats.rs`、前端 `lib/desktopStats.ts`、`components/desktop/DesktopStats.tsx`）

中繼每秒給瀏覽器兩個自家指令（guacamole-common-js 不認得的 opcode 會被忽略，前端在交給 Client 前攔下）：

| 指令 | 方向 | 內容 |
|---|---|---|
| `telepy-ping <n>` | 中繼 → 瀏覽器 | 瀏覽器立刻回 `telepy-pong <n>`；中繼結算網路往返，**不轉給 guacd** |
| `telepy-stats <json>` | 中繼 → 瀏覽器 | `{ms, frame_ms, net_ms, tunnel_ms, frames, merged, down, up, behind}` |

- **畫面往返 `frame_ms`**：guacd 每一幀結尾送 `sync <ts>`，瀏覽器把那一幀畫完才回 `sync <ts>`；中繼從送出到收到回音的時間
  = WebSocket 來回 + 瀏覽器解碼繪製，就是使用者感覺到的「卡」。3 秒沒有新樣本就回 null（桌面靜止）。
- **網路往返 `net_ms`**：ping / pong，不含繪製，靜止時也量得到。
- **隧道 `tunnel_ms`**：monitor 每 15 秒經轉發通道量到的裝置 sshd 往返（`StatusState::latency`）。
- `frames` = 這一秒的幀數；`merged` = 一次 `sync` 併了幾個邏輯幀（guacd 1.6 的第二個參數；> 1 = 瀏覽器跟不上，guacd 在併幀）；
  `behind` = 送出但還沒回音的幀；`down` / `up` = 這一秒的 bytes。
- 工具列的按鈕：訊號格 + 畫面往返 + 狀態字（串流中 / 延遲中 / 沒有資料 / 靜止；`streamHealth`），點開是每一段的數字、
  解析度與縮放，以及「延遲主要在哪一段」（`laggingHop`：網路、隧道，或畫面往返遠大於網路往返 = 瀏覽器自己畫得慢）。
  info 對話框的路徑圖在兩段線上標往返時間，最慢的那段標黃。
- `desktop_close` 事件多了「12.3 MB to the browser, 2,340 frames, frame latency avg 48 ms (max 210 ms)」。

## 畫質預設（`Quality`，start 的 `quality`）

| 值 | RDP | VNC | 前端 |
|---|---|---|---|
| `auto`（預設） | 和以前一樣（平滑字型） | 不加參數 | — |
| `speed` | `color-depth 16`、不平滑字型 | `color-depth 16`、`compress-level 6`、`quality-level 5` | — |
| `sharp` | `color-depth 24`、`force-lossless` | `color-depth 24`、`quality-level 9`、`force-lossless` | 向 guacd 要 devicePixelRatio 倍（≤ 2）的解析度、`dpi` 同倍，縮回 CSS 大小 |

記在 localStorage `telepy.desktopQuality`；start 回應帶 `quality`。

## 多螢幕：只看一個螢幕（`desktop/screens.rs`、`GET …/desktop/screens`、前端 `lib/desktopScreens.ts`）

VNC 伺服器把所有螢幕拼成一張大畫面送來（macOS 螢幕共享、x11vnc、TightVNC 都是），guacd 沒有選螢幕的參數，所以
「指定畫面」是**瀏覽器裁切**：viewer 的 `viewport` 把 Guacamole.Display 的元素挪到裁切框裡（座標仍是整張畫面的，滑鼠
位置照舊）。螢幕在那張畫面裡的位置：

1. `GET /api/reverse/server/{id}/desktop/screens?username=`（和 start 同一道門：VIEW + 允許的裝置帳號 + step-up）經連線池
   問裝置：`uname -s` → Darwin 跑 `system_profiler SPDisplaysDataType -json`（只有大小、沒有位置）、其他 POSIX 跑
   `xrandr --listmonitors`（試 `$DISPLAY`、`:0`、`:1`）、沒有 `uname` 跑 PowerShell `[System.Windows.Forms.Screen]::AllScreens`。
   回 `{os, source, screens: [{name, x, y, width, height, primary}], username}`；問不到不是錯誤（`screens: []`）。
   只有「桌面就是裝置自己」時有意義（區網主機沒有 SSH 可問）。解析器是純函式（單元測試）。
2. 前端 `screenChoices`：有位置的螢幕平移到 (0,0)，整體和畫面大小不符但比例一樣時等比縮放（Windows 的 DPI 縮放）；
   只有大小的（macOS）用整張畫面推排列 —— 寬相加 = 畫面寬就是側排、高相加 = 畫面高就是疊排，高度不同時取樣畫面裡的
   黑色區域判斷貼上緣還是下緣（`isBlack` 讀 canvas）；裝置什麼都沒回報（區網主機、偵測失敗、Xvfb 只回報一顆蓋住
   整張的）就 **`guessScreens` 靠形狀猜**：螢幕比例就那幾種（`SCREEN_RATIOS`：16:9、16:10、MacBook ≈1.545、3:2、
   4:3、5:4、21:9），把畫面寬拆成 2–4 顆等高的常見比例（或高拆成疊放的），加總誤差 ≤ 0.5%，最準優先、其次同比例、
   再其次少顆；比例不同的幾顆誰左誰右看不出來，每種排列都試，用黑色區域修正比畫面矮的那顆（`refineHeight`：在那
   一段取 9 欄量非黑範圍，全部一致且量出的高度和寬度湊成常見比例才採用 —— 黑色桌布就不會被騙），最後取比例最常見
   的排列。等高組合都湊不出時（MacBook 1728×1117 + 2560×1440），試「一顆等高 + 一顆較矮」並用黑色區域量那顆矮的。
   單一常見比例的畫面（含 21:9 超寬）就是一顆、不猜；3840×1080 當成兩顆 16:9。猜的項目在選單裡標「依畫面形狀推測」。
   都推不出來，選單還有等分切法與框選。
3. 工具列「螢幕」選單（只有 VNC）：整個桌面 + 每個偵測到的螢幕（名稱、大小、主螢幕）+ **等分切法**（左 / 右半、
   三等分、上 / 下半，`splitChoices`，不靠偵測、隨時可選）+ **自訂區域**（「框選區域…」進入框選模式：viewer 顯示
   整張畫面、蓋一層 `AreaSelector`，拖一個矩形 → `rectFromPoints` 夾進畫面、最小 64px；Esc 或「取消」放棄；框選中
   鍵盤滑鼠不送往遠端）+ 重新偵測。選擇記在 localStorage `telepy.desktopScreen.<tunnel>.<lanHost|device>`，
   自訂區域記在 `telepy.desktopArea.<…>`（JSON，`parseStoredArea` 在畫面大小知道後驗證）。連上就自動偵測一次。

RDP 不需要：RDP session 的大小由我們（瀏覽器的框）決定，只有一個虛擬螢幕。

## RustDesk（瀏覽器裡連，或經隧道轉發給原生 client）

RustDesk 用自己的協定，guacd 不認得。Telepy 有兩條路，桌面頁協定選「RustDesk」時預設走第一條：

### 瀏覽器裡連（`rustdesk/`、`api/rustdesk.rs`、`ws/rustdesk.rs`；前端 `components/desktop/RustDeskViewer.tsx`、`lib/rustdesk.ts`）

RustDesk 的 web client 核心（社群的 TypeScript 移植，AGPL-3.0，vendored 在 `src/frontend/public/vendor/rustdesk-web-core/`，
來源與版本記在旁邊的 `README.md`）在瀏覽器裡跑：解碼影像（WebCodecs）、做密碼挑戰、送鍵鼠。Telepy **不架 hbbs / hbbr**：
核心以為自己在連 ID 伺服器與 relay，其實兩條都連到同一個 WebSocket，後端看第一則訊息分角色，然後把 relay 那條
重新分框成 RustDesk 的 TCP 線路格式，接到裝置 Direct IP 埠（21118）的 `direct-tcpip` 通道。研究紀錄與量測在
`docs/rustdesk-spike.md`（1280×800 高動態：核心經中繼 28 fps / ~645 KB/s，guacd VNC 4–5 fps / 0.5–1.3 MB/s）。

- `POST /api/reverse/server/{id}/rustdesk/start`（`{username?, port?, lan_host_id?}`；和桌面同一道門：`desktop_enabled`、VIEW、
  step-up、`choose_username` / `allowed_usernames`、`desktop_max_sessions` 算的是 guacd + RustDesk 的總數）：先 `desktop::prepare`
  —— 池的 lease + 對目標 Direct IP 埠開好 `direct-tcpip`（`device_offline` / `target_unreachable` … 在這裡就是 502）——
  再發 60 秒單次票證：`{session_id, ws_path: "/ws/rustdesk/{sid}/", ticket, expires_in, target, username}`。
  **密碼不經後端**：固定密碼只交給瀏覽器裡的核心，它用 RustDesk 的雜湊挑戰回應；Telepy 只中繼。
- `/ws/rustdesk/{sid}/?ticket=`：核心會連兩次（`custom-rendezvous-server` 與 `relay-server` 都設成這個網址）。第一則 binary
  訊息是 `RendezvousMessage`：`punch_hole_request`（欄位 8）= hbbs 角色，後端回 `relay_response`（欄位 19：uuid + relay_server =
  同一網址）後只等著、再有 punch 就再回；`request_relay`（欄位 18）= relay 角色，接過 `prepare` 好的通道，之後 WS 的每則
  binary 訊息 → `codec::encode_frame`（1–4 byte LE 前綴，低 2 bits = 前綴長 − 1）→ 通道；通道的 bytes → `decode_frame`
  （上限 16 MiB）→ 一則一訊息。presence kind `rustdesk`，gateway events `rustdesk_open` / `rustdesk_close`（含時長、原因、
  兩個方向的 byte 數）。關閉碼：4404 票證無效 / 過期、4403 權限、4013 裝置端關閉、4014 被停止（`POST
  /api/reverse/server/rustdesk/{sid}/stop`、reaper 收權限、閒置）、4400 協定錯、4009 從即時 session 頁結束。
- 前端（桌面頁）：表單多「RustDesk 密碼」欄（留在瀏覽器），主要按鈕「在瀏覽器裡連線」；`RustDeskViewer` 載入核心（一頁
  同時只能有一個，核心是 window 上的全域物件），設兩個 server 選項 = `rustdeskWsUrl()`、`session_add_sync` + `session_start`，
  自動確認「不加密的直連」msgbox（隧道本身加密），`onVideoFrame` 畫到 canvas（等比縮小、不放大），鍵盤焦點在隱藏的
  textarea（輸入法組字 → `input_string`；按鍵 → `input_key`，鍵名表在 `lib/rustdesk.ts`），滑鼠座標除以縮放比例，游標從
  `cursor_data` 轉成 CSS cursor。工具列：延遲 / 串流按鈕（吃核心的 `update_quality_status`：延遲、fps、目標位元率）、
  螢幕選單（對方 `peer_info` 的 displays → `switch_display`，RustDesk 原生切螢幕；畫質 best / balanced / low 對應 Telepy
  的三個預設）、鍵盤選單（送出文字、Ctrl+Alt+Del）、全螢幕、說明、中斷。info 路徑圖用 `inBrowser` 變體（三步）。
  剪貼簿：核心自己在分頁有焦點時讀瀏覽器剪貼簿送過去；遠端複製的文字顯示在工具列下方。
- 憑證庫：RustDesk 密碼也能存（`protocol: rustdesk`）；表單有「已存的登入」選單與「儲存這組登入」。start 帶
  `credential_id` 時後端解開、放進回應交給核心（見憑證庫一節）；`rustdesk_open` 事件註明 with saved login '<label>'。
  統計：隧道那一段由 monitor 的延遲補上（連線時讀一次 dashboard，之後跟 `UPDATE-TUNNEL-LATENCY`）；面板不顯示畫面往返 /
  待畫幀（核心在瀏覽器解碼，沒有這兩個數字），「網路往返」是核心自己量的瀏覽器 ↔ 裝置。
- 範圍（MVP）：畫面、鍵鼠、剪貼簿文字、切螢幕、畫質。沒有傳檔、聲音、終端機 —— 要這些用下面的 app 路。
- 踩過的坑：核心的 `confirmInsecure()` 先同步發 msgbox 事件、**之後**才記下等答案的 resolver，所以在事件處理器裡同步回
  `continue-insecure-connection` 會被丟掉（連線卡住、30 秒後裝置端關閉、relay 統計「0 B to the device」）—— viewer 用
  `setTimeout(…, 0)` 下一個 tick 再答。裝置端 RustDesk 跑在 C locale（沒有 `LANG`）時 xdo 拒絕多位元組文字（log
  `Invalid multi-byte sequence encountered`），`input_string` 的中文打不進去 —— 那是裝置的環境，不是 Telepy。
- 實測（OrbStack 裡的 Debian + RustDesk 1.5.0 + Xvfb，headless Chrome）：連上 < 1 s，點擊 / 滾輪 / 移動落在裝置上的座標
  分毫不差（`xev`），打字到達 xterm，即時 session 頁列出 `rustdesk`，Logs 有兩個事件。腳本：scratchpad 的
  `pw/rd-browser-e2e.js`（見記憶 `rustdesk-browser`）。

### 不經隧道：Telepy 當 RustDesk 伺服器（`rustdesk/idserver.rs`、`api/rustdesk_devices.rs`、`ws/rustdesk.rs`、`db/rustdesk_devices.rs`；前端 `/tunnels/rustdesk`）

研究與 PoC 見 `docs/rustdesk-id-server.md`。沒有 Telepy 隧道的電腦，把 RustDesk 的 ID / API 伺服器指到 Telepy，打開
WebSocket，就會**主動往外**連 Telepy 的 443；Telepy 自己實作 hbbs / hbbr 需要的那一小部分（不跑官方伺服器、不開新埠）。

- **登記（RustDesk 內建的 deploy）**：「RustDesk 裝置」頁 → 新增裝置 → `POST /api/rustdesk/enroll {name?}` 發一次性權杖
  （`tpr_…`，記憶體、30 分鐘、每人 10 張）與指令（`unix` = Linux / macOS 共用一行 `sudo sh -c '…'`，`windows` = PowerShell）：
  `rustdesk --option custom-rendezvous-server <位址>`、`--option api-server <Telepy>`、`--option allow-websocket Y`、
  `rustdesk --deploy --token <權杖>`。裝置 `POST /api/devices/deploy`（`Authorization: Bearer`，`{id, pk, uuid}`），
  Telepy 存一列 `telepy_rustdesk_device`（RustDesk ID 全站唯一；同一個擁有者再登記 = 換 uuid / 公鑰）並回
  `{"result": "OK"}` —— RustDesk 1.5 只認 `result`（`OK` / `INVALID_INPUT` / `ID_TAKEN` / `NOT_ENABLED`），其他內容原樣印出、
  結束碼 1，所以權杖問題回一行純文字。OK 之後裝置通知自己的服務，1 秒內就註冊。
- **Linux / macOS 共用一條指令**（`idserver::device_commands`）：macOS 的 RustDesk 不在 PATH 上（以前「Linux」那條在 Mac 上是
  `command not found: rustdesk`），所以先找 PATH 上的 `rustdesk`、找不到再用 `/Applications/RustDesk.app/Contents/MacOS/RustDesk`，
  都沒有就說「沒裝」並停下。**接著要求 RustDesk 的背景服務（`--server` 行程，`pgrep`，沒有就 `ps`）在跑**，沒有就什麼都不寫、
  說明怎麼裝（macOS：打開 RustDesk 按「安裝」系統服務、允許輔助使用與螢幕錄製）。原因（Mac mini 實際發生）：RustDesk 1.5 的
  `set_options` 在 IPC 連不上時照樣把設定寫進本機設定檔，讀取也退回那份檔案，所以沒服務時讀回一樣會過；macOS 的 sudo 又保留
  `$HOME`，root 把**使用者的** `RustDesk2.toml` 寫成 root 擁有、0600，RustDesk 下次啟動讀不到（`Failed to load config`）就換成
  預設值，Telepy 的設定全沒了、又回到公用伺服器。指令也在結束時（`trap … EXIT`）把 `$HOME` 那份設定目錄裡 root 寫過的
  `RustDesk*.toml` 還給 `$SUDO_USER`（只在 `$HOME` 屬於那個人時；`/root` 是 root 自己的服務設定，不動）。
  設完三個選項後讀回 `api-server`：沒裝好或服務沒在跑時 RustDesk 只印
  `Installation and administrative privileges required!` 或什麼都不做，讀回不對就停下來說原因。最後一步是等設定出現在
  `--deploy` 會讀的那份設定檔（RustDesk 1.5 原始碼）：root 跑的 `--option` 經 IPC 寫進**使用者的** `--server`
  （`UserMainIpcScope`），但 `--deploy` 讀的是**自己行程**的設定（`$HOME` 那份；macOS 的服務以使用者身分跑，每 0.3 秒同步給
  root）—— 沒等就 deploy，權杖會被送到 RustDesk 自己的 API 伺服器。最多等 15 秒，等不到就說「服務沒收到設定」。
- **位址規則（RustDesk 1.5）**：伺服器是網域 → 連 `ws(s)://網域/ws/id`，**埠固定 443 / 80**（`api-server` 是 https 才用 wss）；
  是 IP → `ws://IP:<設定的埠+2>/`（根路徑、不加密）。所以 `device_settings()` 依 Telepy 對外網址（`PUBLIC_URL`，否則轉送標頭）
  給 `網域` 或 `IP:埠−2`，並標出 RustDesk 連不到的情況（網域配非標準埠、IP 配 https、localhost）——頁面上有警告。
  後端在 `/ws/id` 與根路徑 `/`（只接 WebSocket 升級，其他還是 404）都收裝置；Traefik 多一條 `backend-rustdesk-root`
  （``Path(`/`) && HeaderRegexp(`Upgrade`, `(?i)^websocket$`)``）。
- **註冊**：第一則 `register_pk {id, uuid, pk}`。登記過、uuid 與公鑰都對得上、站台開關開著 → 先登記為在線再回
  `RegisterPkResponse OK, keep_alive 30`；其他一律 `NOT_DEPLOYED`（裝置停著、每 30 秒重試；連線最多留 5 分鐘、同時最多 256 條）。
  換公鑰（重裝）也是 `NOT_DEPLOYED`，要重新登記。`--set-id`（帶 `old_id`）回 `NOT_SUPPORT`。伺服器每 10 秒送空訊息當心跳。
  裝置的 `/api/sysinfo`（uuid 要對）存主機名稱、系統、版本，登記沒取名就用主機名稱；`/api/heartbeat`、`/api/audit/{kind}`
  只回空 / `{}`（審計要空 body，否則裝置會重送）；`/api/devices/cli`（`--assign`）不支援。
- **連線**：`POST /api/rustdesk/devices/{id}/start`（擁有者或管理員；`desktop_enabled`、站台開關、在線、`desktop_max_sessions`
  與 guacd / 隧道 RustDesk 合計）→ `{session_id, ws_path, ticket, peer_id = RustDesk ID, key = 伺服器公鑰}`。瀏覽器核心照舊連
  `/ws/rustdesk/<session>/`：punch → Telepy 在裝置的註冊連線推 `request_relay {uuid, socket_addr, relay_server, secure}`
  （中繼網址取自**裝置自己連進來**的位址；`socket_addr` 每次不同，否則裝置當成重複丟掉），回瀏覽器 `relay_response`
  附 Telepy 簽的 `IdPk{id, 裝置公鑰}`；裝置開 `/ws/relay` 送 `request_relay {uuid}`，兩條 WS 以 uuid 配對、逐則轉送。
  伺服器金鑰是由 `SECRET_KEY` 衍生的 ed25519（不另存；裝置在 WS 模式不驗它，只有瀏覽器核心用）。核心驗過金鑰就和裝置做
  RustDesk 的金鑰交換 → **端對端加密**，不會出現「不安全連線」。
- **管理**：`GET /api/rustdesk/devices`（自己的；管理員看全部；每台帶 `last_used {username, at}`）、`PATCH` 改名、`DELETE` 移除
  （踢掉註冊連線、結束 session、刪掉綁它的已存密碼與連線紀錄，之後回 `NOT_DEPLOYED`）。通知 `RUSTDESK-DEVICES-UPDATED`
  （登記、上下線、改名、移除、session 開關；帶 `enroll_id` 時給新增對話框）。事件 `rustdesk_enrolled` / `rustdesk_removed` /
  `rustdesk_open` / `rustdesk_close` 沒有隧道 → 只有管理員在 Logs 看得到，所以擁有者看下面的連線紀錄。
- **已存的密碼**：憑證庫的列可以綁一台裝置（`telepy_credential.rustdesk_device_id`，`tunnel_id` = 0，協定只能 `rustdesk`；
  建立時要能用那台 = 擁有者或管理員）。`GET /api/credentials?rustdesk_device_id=` 列出；start 帶 `{credential_id}` 時只有綁
  **這台**的解得開（否則欄位錯誤 `credential_id`），解開的密碼只放進這次回應的 `password`，交給瀏覽器裡的核心回挑戰 ——
  和隧道版 RustDesk 一樣是「憑證庫不回傳密碼」的唯一例外。手打的密碼仍然只留在分頁裡。
- **即時 session 與連線紀錄**：連上時加入 presence（種類 `rustdesk`，隧道 0 ＋ `device {id, name, owner_id}`），
  `GET /api/sessions` 給本人、裝置擁有者與管理員看（`device {id, name}`），擁有者可以結束別人的（關閉碼 4009、原因 = 誰；
  通知 `SESSION-ENDED` 帶 `device_id`、事件 `session_ended`）。每次連線一列 `telepy_rustdesk_session`（誰、IP、開始 / 結束、
  兩個方向的位元組、結束原因 user / device / ended / stopped / removed / revoked / restart），每台最多 200 列、含 IP 所以保留
  90 天（`db::retention`），重啟時沒收尾的記成 `restart`；`GET /api/rustdesk/devices/{id}/sessions`（擁有者或管理員）回最近 20 筆。
- **前端**：`/tunnels/rustdesk`（`hooks/useRustDeskDevices.ts`、`components/rustdesk/EnrolDialog.tsx` + `hooks/useRustDeskEnrol.ts`，
  純函式 `lib/rustdeskDevices.ts`）；卡片顯示「最後使用」、使用中連到即時 session 頁（`?device=<id>`），選單「最近的連線」開
  `components/rustdesk/DeviceSessionsDialog.tsx`。遠端桌面頁的「裝置」選單多一組 RustDesk 裝置（`?rustdesk=<id>`，表單是
  已存的密碼 / 密碼＋「存起來」與畫質，和隧道版共用 `SavedLoginSelect` / `RustDeskSecret`），`RustDeskViewer` 帶 `key` 與
  `peer_id`；info 路徑圖是三節點版（瀏覽器 ─ Telepy ─ 裝置自己的 HTTPS 連線 ─ 裝置）。即時 session 頁依「地點」分組
  （隧道或 RustDesk 裝置，`lib/liveSessions.ts` 的 `Place`），篩選 `?tunnel=` / `?device=`。
- **還沒有的**：分享給別人（只有擁有者與管理員）、Telepy 配發的號碼（RustDesk 的 `--deploy --id <號碼>` 可以做到）。實測：Linux（Debian 容器、RustDesk 1.5.0）
  真機（含服務停掉）；Linux / macOS 那條指令的流程另外在 macOS 的 `/bin/sh` 用假 RustDesk 跑過（服務沒跑、同步延遲、同步不到），
  設定檔還給使用者的部分在容器裡以 root 跑過（`$HOME` 是使用者的才還、`/root` 不動）。
  macOS 真機與 Windows 指令還沒實機跑過。

### 用 RustDesk app（埠轉發）

桌面頁的「想用 RustDesk app？」展開：把 **Direct IP Access**（TCP 21118）經裝置轉到使用者電腦，用 app 連 `127.0.0.1`。
多螢幕切換、傳檔、聲音都是 RustDesk 自己的功能。

- 「從裝置檢查」（`GET /api/reverse/server/{id}/desktop/probe?port=&username=&lan_host_id=`：和 start 同一道門、同一條路 ——
  池的 lease + direct-tcpip 通道，通了立刻關；不看 `desktop_enabled`；錯誤碼同 start）→ `ssh -L 21118:<host>:21118 <alias>`
  （命令表的 `rustdesk` recipe，別名來自 `/tunnels/server/config/{id}`）→ app 的 ID 填 `127.0.0.1`（本機埠非 21118 時
  `127.0.0.1:<port>`）。info 路徑圖在探測過、瀏覽器裡沒在連時顯示這條路（你的電腦 ─ssh─ Telepy ─隧道─ 裝置 ─ RustDesk）。
- 命令表多了「用 RustDesk」情境（`-L`，欄位：主機 `localhost` = 裝置自己、RustDesk 埠、本機埠）；區網掃描預設探測
  21118，`lib/lanConnect.ts` 把它顯示成 RustDesk，網路頁的指令分頁也會列出它的 `-L`。

## 輸入法（IME）與跨系統鍵盤

- 畫面把鍵盤焦點放在 `Guacamole.InputSink` 的隱藏 textarea，而不是 div：輸入法只會在可編輯元素上組字，所以 Windows 瀏覽器
  連 macOS / Linux VNC 也能打中文、日文（組好的字以 Unicode keysym `0x01000000 + codepoint` 送出；RDP 轉成 unicode 鍵盤
  事件，VNC 直接送 keysym，macOS 螢幕共享、x11vnc、TigerVNC、TightVNC 都收）。
- 「鍵盤 → 送出文字」：在對話框裡用自己的輸入法打字，每個字當一次按鍵送出（每字間隔 8 ms；換行 = Enter）。遠端桌面
  仍不理組合文字時的備援；最後手段還有「貼上」（送到遠端剪貼簿）。
- 「Ctrl 當作 ⌘」：Control_L/R → Meta_L/R（Command）。裝置偵測為 Darwin 且瀏覽器不是 Mac 時預設開（`telepy.desktopCtrlAsCmd`
  = auto / on / off）；按下時記住實際送出的 keysym，放開用同一個，中途切換不會卡住修飾鍵。

## 關閉碼

WebSocket 關閉時把代碼也放進 reason（guacamole-common-js 的 WebSocketTunnel 以 `parseInt(reason)` 當狀態碼；
自訂代碼本身會被翻成籠統的 SERVER_ERROR）。

| 代碼 | 意思 |
|---|---|
| 4404 | session / 票證無效或過期 |
| 4403 | 已沒有權限（VIEW 或裝置帳號） |
| 4011 | guacd 連不上或握手失敗 |
| 4013 | guacd 斷線或送了壞指令 |
| 4014 | 伺服器端結束（閒置、stop、權限被收回） |
| 4400 | 瀏覽器送了解析不了的指令 |

guacd 自己的錯誤以 Guacamole `error` 指令送到瀏覽器（例如 0x0203 / 0x0301 = RDP 登入被拒），
前端 `lib/desktop.ts` 的 `sessionFailure` 對到翻譯與「卡在哪一段」。

## 憑證庫（saved logins）

`vault.rs`、`db/credentials.rs`、`api/credentials.rs`；測試 `tests/credentials_api.rs` 與 `tests/desktop_api.rs` 的 vault 段落。

- 每位使用者自己的：`GET /api/credentials`（可用 `tunnel_id` / `lan_host_id` / `protocol` 篩選）、`POST`、
  `PATCH /api/credentials/{id}`、`DELETE`。只有本人看得到、用得到；管理員也不例外。
- 每筆綁一個桌面：`protocol`（`rdp` / `vnc` / `rustdesk`）+ `tunnel_id` + 可選的 `lan_host_id` / `port`，外加 `label`、`login`、`domain`
  （RustDesk 只有固定密碼，`login` 留空）。
  `start` 收到的 `credential_id` 若不是同一個目標（隧道、區網主機、協定）就回 `credential_id` 欄位錯誤，
  所以一筆 Windows 密碼不會被拿去登另一台。
- 密碼以 AES-256-GCM 封存，金鑰由 `SECRET_KEY` 衍生（前綴 `telepy-vault-v1:`），AAD =
  `telepy-credential:{user_id}:{id}`：把密文搬到別人或別筆名下就解不開。API 只回 `has_password`，密碼永不回傳；
  解密只發生在 `start`，結果跟手打的一樣只留在 session 記憶體。輪換 `SECRET_KEY` 會讓舊的存檔解不開（重存即可）。
  **RustDesk 是唯一的例外**：挑戰回應由瀏覽器裡的核心做，後端代答不了，所以 `POST …/rustdesk/start` 帶 `credential_id`
  時後端解開後放進回應的 `password`（只有這一次、走 TLS、不記錄），前端交給核心後不留在頁面狀態。
- 隧道或區網主機刪除時，綁在上面的憑證一起刪。使用後更新 `last_used_at`；`desktop_open` 事件會註明
  「with saved login '<label>'」（只有名稱，沒有帳密）。
- 前端：桌面頁的「已存的登入」選單（`hooks/useSavedLogins.ts`）與「儲存這組登入」勾選（連線前先存，再用
  `credential_id` 連）；偏好設定的 Saved logins 分頁（`components/layout/SavedLogins.tsx`）列出與刪除。
  任一處新增 / 刪除都會發 `telepy:saved-logins-changed`，其他畫面跟著重載。

## 稽核與可見性

- gateway 事件 `desktop_open` / `desktop_close`（含持續時間、結束原因、guacd 的最後錯誤），在該隧道的 Logs。
- presence 種類 `desktop`：擁有者在隧道列表看得到誰正開著。

## 站台設定（Settings → Remote desktop）

| key | 預設 | 說明 |
|---|---|---|
| `desktop_enabled` | true | 關閉後不能開新的 session |
| `desktop_max_sessions` | 4 | 整站同時上限（含尚未認領的票證），0 = 不限 |
| `desktop_session_idle_timeout` | 900 | 沒有鍵盤 / 滑鼠 / 剪貼簿輸入多久就斷線（秒），0 = 不斷 |
| `desktop_clipboard` | both | **上限**：both / to_remote / off。每個人在桌面頁或偏好設定裡自己選方向（個人設定 `desktop_clipboard`），實際用兩者較窄的那個；guacd 用 disable-copy / disable-paste 把關，RustDesk 由瀏覽器裡的核心套用（off = 那台的 `disable-clipboard`） |
| `desktop_max_resolution` | 2560 | 寬或高的上限（像素） |

## 部署

`docker-compose.yml` 的 `guacd` 服務（`guacamole/guacd:1.6.0`）只在 internal 網路 `telepy-desktop-${PROJECT_NAME}`；
backend 同時在 `telepy-network` 與它上面。環境變數：`GUACD_ADDR`（預設 `guacd:4822`）、`DESKTOP_CALLBACK_HOST`
（guacd 連回 backend 用的名字，compose 裡是 `backend`；未設時用 `HOSTNAME`）。

## 裝置端需求

- sshd 允許 TCP 轉發（`AllowTcpForwarding`，OpenSSH 與 Win32-OpenSSH 預設開啟）。
- 桌面伺服器：Windows 遠端桌面（3389）、macOS 螢幕共享（5900，要在「VNC 檢視器可以使用密碼控制螢幕」設密碼）、
  TigerVNC / x11vnc（5900 + display，例如 :1 = 5901）、xrdp（3389）。
- RDP 用 `security=any` + `ignore-cert=true`；NLA 需要正確的 Windows 帳密（含網域）。
