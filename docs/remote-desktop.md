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
  │  copy_bidirectional ⇄ russh direct-tcpip 通道（ssh::pool 那條裝置連線上的一個 lease）
  ▼
裝置 sshd ──► 127.0.0.1:<port>（裝置自己的桌面）或 <LAN 位址>:<port>（區網主機，和 ssh -J / 區網掃描同一個機制）
```

## 流程

1. `POST /api/reverse/server/{id}/desktop/start` `{protocol, username, port?, lan_host_id?, login?, password?, domain?, quality?}`：
   檢查 `desktop_enabled`、隧道 VIEW、`username` 在 `permissions::allowed_usernames` 裡（裝置那一跳的帳號）、
   區網主機屬於這條隧道、`desktop_max_sessions`；接著**先**借池的連線並開 direct-tcpip 通道到目標，所以
   `device_offline` / `device_auth` / `target_unreachable` 在這一步就回 502，不必等 WebSocket。
   回 `{session_id, ws_path, ticket, expires_in, protocol, clipboard, quality, target, username}`；帳密只留在記憶體。
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
   黑色區域判斷貼上緣還是下緣（`isBlack` 讀 canvas）；都推不出來就依長寬比給「左半 / 右半 / 三等分 / 上半 / 下半」預設。
3. 工具列「螢幕」選單（只有 VNC）：整個桌面 + 每個偵測到的螢幕（名稱、大小、主螢幕）+ **等分切法**（左 / 右半、
   三等分、上 / 下半，`splitChoices`，不靠偵測、隨時可選）+ **自訂區域**（「框選區域…」進入框選模式：viewer 顯示
   整張畫面、蓋一層 `AreaSelector`，拖一個矩形 → `rectFromPoints` 夾進畫面、最小 64px；Esc 或「取消」放棄；框選中
   鍵盤滑鼠不送往遠端）+ 重新偵測。選擇記在 localStorage `telepy.desktopScreen.<tunnel>.<lanHost|device>`，
   自訂區域記在 `telepy.desktopArea.<…>`（JSON，`parseStoredArea` 在畫面大小知道後驗證）。連上就自動偵測一次。

RDP 不需要：RDP session 的大小由我們（瀏覽器的框）決定，只有一個虛擬螢幕。

## RustDesk（經隧道轉發，用原生 client）

RustDesk 用自己的協定，guacd 不認得，所以不在瀏覽器裡畫；Telepy 做的是把 RustDesk 的 **Direct IP Access**（TCP 21118）
經裝置轉到使用者電腦，使用者用 RustDesk app 連 `127.0.0.1`。多螢幕切換、傳檔、聲音都是 RustDesk 自己的功能。

- 桌面頁協定選「RustDesk」：不開 session，面板四步 —— 在那台 RustDesk 開 Direct IP Access 並設固定密碼 →
  「從裝置檢查」（`GET /api/reverse/server/{id}/desktop/probe?port=&username=&lan_host_id=`：和 start 同一道門、同一條路
  —— 池的 lease + direct-tcpip 通道，通了立刻關；不看 `desktop_enabled`；錯誤碼同 start）→ `ssh -L 21118:<host>:21118 <alias>`
  （命令表的 `rustdesk` recipe，別名來自 `/tunnels/server/config/{id}`）→ app 的 ID 填 `127.0.0.1`（本機埠非 21118 時
  `127.0.0.1:<port>`）。info 路徑圖在 RustDesk 模式顯示這條路（你的電腦 ─ssh─ Telepy ─隧道─ 裝置 ─ RustDesk），階段跟著探測。
- 命令表多了「用 RustDesk」情境（`-L`，欄位：主機 `localhost` = 裝置自己、RustDesk 埠、本機埠）；區網掃描預設探測
  21118，`lib/lanConnect.ts` 把它顯示成 RustDesk，網路頁的指令分頁也會列出它的 `-L`。
- 做不到的：在瀏覽器裡直接看 RustDesk。RustDesk 的 web client 要自架 hbbs / hbbr 並另做 WebSocket 中繼，不在這裡。

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
- 每筆綁一個桌面：`protocol` + `tunnel_id` + 可選的 `lan_host_id` / `port`，外加 `label`、`login`、`domain`。
  `start` 收到的 `credential_id` 若不是同一個目標（隧道、區網主機、協定）就回 `credential_id` 欄位錯誤，
  所以一筆 Windows 密碼不會被拿去登另一台。
- 密碼以 AES-256-GCM 封存，金鑰由 `SECRET_KEY` 衍生（前綴 `telepy-vault-v1:`），AAD =
  `telepy-credential:{user_id}:{id}`：把密文搬到別人或別筆名下就解不開。API 只回 `has_password`，密碼永不回傳；
  解密只發生在 `start`，結果跟手打的一樣只留在 session 記憶體。輪換 `SECRET_KEY` 會讓舊的存檔解不開（重存即可）。
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
| `desktop_clipboard` | both | both / to_remote / off（對應 guacd 的 disable-copy / disable-paste） |
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
