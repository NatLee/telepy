# Remote desktop（RDP / VNC / RustDesk in the browser）

> 在瀏覽器裡看、操作裝置（或它區網裡電腦）的 RDP / VNC 桌面，以及經隧道連 RustDesk。裝置上不裝任何東西：連線由裝置
> 自己的 sshd 轉接，RDP / VNC 的畫面由 guacd 轉成 Guacamole 協定，RustDesk 由瀏覽器裡的 RustDesk 核心解碼。程式：
> `src/backend-api/src/desktop/`、`api/desktop.rs`、`ws/desktop.rs`（RustDesk：`rustdesk/`、`api/rustdesk.rs`、
> `ws/rustdesk.rs`）；前端 `app/tunnels/desktop/`、`components/desktop/`、`hooks/useDesktopPage.ts`、`lib/desktop.ts`；
> 測試 `tests/desktop_api.rs`、`tests/rustdesk_api.rs`。
>
> 入口：`/tunnels/desktop?tunnel=<id>[&lanHost=<id>]`（側欄、隧道選單、區網主機面板、隧道列表的 Desktop 按鈕）。表單最上面是
> 和終端機頁共用的路徑圖選擇器（`DesktopPathPicker`：目標、協定、埠在最後一個節點裡），下面是畫質、剪貼簿、聲音與登入。
> 整個功能受功能權限 `remote_desktop` 管（關掉 = REST 回 403 `feature_disabled`，頁面換成說明）。

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

1. `POST /api/reverse/server/{id}/desktop/start` `{protocol, username?, port?, lan_host_id?, login?, password?, domain?, credential_id?, quality?, clipboard?, audio?}`：
   檢查 `desktop_enabled`、隧道 VIEW、step-up（敏感隧道）、`username` 在 `permissions::allowed_usernames` 裡（裝置那一跳的帳號；
   沒帶就用 `choose_username` 挑預設）、區網主機屬於這條隧道、`desktop_max_sessions`；接著**先**借池的連線並開 direct-tcpip
   通道到目標，所以 `device_offline` / `device_auth` / `host_key_changed` / `forwarding_disabled` / `target_unreachable` /
   `device_unreachable` 在這一步就回 502（`desktop_disabled` / `desktop_busy` 是 503），不必等 WebSocket。
   回 `{session_id, ws_path, ticket, expires_in, protocol, clipboard, clipboard_limit, quality, audio, target, username}`；帳密只留在記憶體。
   `clipboard`：沒帶就用使用者的個人設定 `desktop_clipboard`，再套上站台的同名上限（取較窄的）；回應的 `clipboard` 是實際用的方向。
   帶 `credential_id` 時改用憑證庫裡那筆的 login / password / domain（見下方「憑證庫」），請求裡的帳密欄位被忽略。
2. 瀏覽器用票證開 WS。後端重驗權限、開 rendezvous、連 guacd 握手（`hostname` / `port` = rendezvous），
   guacd 連回來的那條接到第 1 步的通道。握手完成後先送 `0.,<uuid>;`（guacamole-common-js 收到才把 tunnel 標成開啟），
   再把握手期間已讀進解析器的指令送出（guacd 常把 `ready` 和第一批畫面放在同一個封包）。
3. 中繼直到任一端結束。結束原因：使用者、guacd、閒置（`desktop_session_idle_timeout`，reaper 每 10 秒看一次）、
   `POST /api/reverse/server/desktop/{sid}/stop`（4014）、從即時 session 頁結束、失去權限（4009，見「稽核與可見性」）、
   開它的那個網頁登入被登出（4010）。

## 延遲與串流狀況（`desktop/stats.rs`、前端 `lib/desktopStats.ts`、`components/desktop/DesktopStats.tsx`）

中繼每秒給瀏覽器兩個自家指令（guacamole-common-js 不認得的 opcode 會被忽略，前端在交給 Client 前攔下）：

| 指令 | 方向 | 內容 |
|---|---|---|
| `telepy-ping <n>` | 中繼 → 瀏覽器 | 瀏覽器立刻回 `telepy-pong <n>`；中繼結算網路往返，**不轉給 guacd** |
| `telepy-stats <json>` | 中繼 → 瀏覽器 | `{ms, frame_ms, net_ms, tunnel_ms, frames, merged, down, up, behind, audio}`（`audio` 見「聲音」） |

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
| `sharp` | `color-depth 24`、`force-lossless` | `color-depth 24`、`quality-level 9`、`force-lossless` | — |

存在帳號上的遠端桌面偏好 `desktop_display.quality`（偏好設定 → 遠端桌面也改得到同一個值）；start 回應帶 `quality`。以前 `sharp` 還順便要 HiDPI 解析度，現在 HiDPI 是「顯示」裡獨立的開關（下一節）。

## 顯示：縮放、解析度、HiDPI（前端 `lib/desktopDisplay.ts`、`lib/desktopZoom.ts`、`hooks/useDesktopZoom.ts`、`components/desktop/DisplayMenu.tsx` / `DisplaySettings.tsx`；後端 `desktop::clamp_size`、`ws/desktop.rs` `browser_size`）

**為什麼以前畫面小（實測，OrbStack + 真 guacd 1.6 + xrdp / x11vnc / Xvnc，1440×900 視窗）：**
1. 畫面框高 `100dvh − 15rem`、連線時不捲動：1440×900 只有約 1150×684，1280×800 時 990×584，框底在 y = 815（視窗外）。
2. 「塞進框裡」上限 1:1，VNC / RustDesk 的畫面比框小時不會放大（VNC 1024×768 在 1540×864 的框裡就是 1024×768）。
3. 畫質選 `sharp` 時，HiDPI 螢幕上上限變成 1 / devicePixelRatio：Retina 上 x11vnc 1024×768 的畫面只畫成 512×384 CSS px（量到的）。
   RDP 則向 xrdp 要 2 倍像素（2300×1555），xrdp 不理 `dpi`，字只剩一半大。
4. 站台上限 `desktop_max_resolution` 寬高各自夾（3080×1916 在 2560 下變 2560×1916，比例走樣、畫面加黑邊），而且連線中瀏覽器送的
   `size` 根本沒經過上限。
5. 縮放鈕只在觸控裝置上有。

**現在：** 偏好存在帳號上（個人設定 `desktop_display`，一個 JSON：`scale` / `percent` / `resolution` / `width` / `height` / `hidpi` / `vnc_resize` / `quality` / `audio`；
後端 `desktop::display::parse` 檢查，未知欄位或超出範圍 = 欄位錯誤、百分比夾在 25–400；空 = 還沒選過。localStorage `telepy.desktopDisplay` 只是第一次畫面的快取，
登入時帳號有值就用帳號的，沒有就把這台瀏覽器的值（含舊的 `telepy.desktopQuality` / `telepy.desktopAudio`）傳上去），
偏好設定 → 遠端桌面 → 顯示、連線表單的「顯示」欄，與桌面頁工具列的「顯示」選單讀寫同一份：
- 縮放：`fit`（塞進框裡，小畫面也放大，預設）/ `shrink`（只縮不放 = 以前）/ `actual`（1:1，HiDPI 時一個裝置像素；滑鼠移到邊緣捲動，雙指拖曳）/
  `custom`（25–400 %）。模式會黏著：視窗變大變小時 fit 重新塞、1:1 維持；工具列 − / % / + 與捏合改成固定比例。
- RDP 解析度：跟著視窗（預設，`resize-method display-update`，框停 400 ms 才送 `size`）或固定（1280×720、1600×900、1920×1080、2560×1440、自訂）。
  固定時 start 帶 `resize: false`：guacd 不帶 resize-method，中繼丟掉瀏覽器的 `size`。
- HiDPI：要 devicePixelRatio 倍（≤ 2）的像素與 `dpi`；預設關。連線中切換、改解析度，跟著視窗的 session 立刻送新的 `size`。
- VNC 也跟著視窗（預設關）：start 帶 `resize: true` 就不送 `disable-display-resize`，guacd 1.6 用 SetDesktopSize 要伺服器改大小
  （連線時送一次、之後每個 `size`）；只有虛擬桌面（TigerVNC Xvnc、KasmVNC）照做，實體螢幕（x11vnc、macOS 螢幕共享、多數 Windows 伺服器）
  維持原解析度。預設關是因為改掉一台真機器的螢幕解析度不是使用者要的。guacd 1.6 的 VNC 預設會送初始大小，所以以前其實就會改 Xvnc 的大小。
- RustDesk：解析度由遠端決定，只在瀏覽器縮放；網頁核心的 `change_resolution` 沒實作（`setByName change_resolution not implemented (phase 2)`）。
  **之後可以做：** 像檔案面板的 `ReadEmptyDirs` 一樣，自己編一個 `Misc.change_resolution` 送到核心追蹤的 WebSocket（RustDesk 的 Windows / Linux X11 端支援改解析度），
  RustDesk 就也能跟著視窗。
- 「佔滿瀏覽器視窗」：卡片 `fixed inset-0` 蓋住側欄與頁首（不是全螢幕；Esc 照樣送遠端），工具列「回到頁面」退出。
- 框高改成 `100dvh − 8.5rem`，連線時卡片捲到頁首下方。
- 上限：`clamp_size` 等比縮到長邊 = `desktop_max_resolution`，握手與連線中每個 `size` 都經過（以前只夾握手，而且各邊分開夾）。start 回 `resize` 與 `max_resolution`。

實測（同一套環境，新框高）：RDP 跟著視窗 1116×764（1440）→ 1534×944（1920）→ 958×664（1280）→ 佔滿 1280×751 → 958×664（`xdpyinfo`）；
HiDPI 在 Retina 2236×1528，1920 視窗時 2560×1575（等比夾），連線中關 HiDPI → 1534×944；固定 1600×900 不跟著視窗、瀏覽器縮到 70 % / 60 %；
Xvnc 要求跟著時 1280×800 → 1118×764 → 958×664，不要求時維持、瀏覽器放大到 115 % / 142 %；x11vnc 1024×768 在 Retina 預設畫成
1019×764（以前 512×384），1:1 → 125 % 後滑鼠移到右緣會往右捲。
測試：`tests/desktop_api.rs` `desktop_resolution_follows_the_window_within_the_site_limit`，單元測試 `clamp_size`、`browser_size`、
`lib/desktopZoom.test.ts`、`lib/desktopDisplay.test.ts`。

## 剪貼簿方向（每個人自己選，站台設定是上限）

- 三個方向：`both`（雙向）/ `to_remote`（只能貼進遠端）/ `off`。個人設定 `desktop_clipboard` 存在帳號上
  （`/api/user/settings`，同一個回應帶唯讀的 `desktop_clipboard_limit` = 站台設定），在桌面頁的「剪貼簿」欄與
  偏好設定 → 遠端桌面（`hooks/useDesktopClipboard.ts`，兩處共用一份）都能改；超過上限的選項在介面上停用。
- 每個 start（RDP / VNC、RustDesk）可以帶 `clipboard` 蓋過這次，沒帶就用個人設定；實際用的是它和站台 `desktop_clipboard`
  較窄的那個（`desktop::Clipboard::within` / `effective`，前端 `lib/desktop.ts` 的 `clipboardWithin`），回應的 `clipboard` 是實際值。
- 誰把關：guacd 用 `disable-copy` / `disable-paste`；RustDesk 的資料流後端看不到，由瀏覽器裡的核心套用（off = 那台的
  `disable-clipboard`，to_remote = 不收遠端的剪貼簿事件）。測試 `desktop_clipboard_is_the_users_choice_within_the_site_limit`。

## 聲音（RDP 經 guacd；RustDesk 見下一節）

- 表單的「聲音」開關（RDP 與 RustDesk 才有；guacd 的 VNC 沒有聲音 —— 它要另接 PulseAudio，裝置那邊不會有 —— 所以 VNC
  不顯示；VNC 協定本身只有畫面與輸入。macOS 的「螢幕共享」就是 VNC，所以要聽 Mac 的聲音請用 RustDesk），記在
  帳號上的 `desktop_display.audio`（**預設關**：聲音多吃頻寬；偏好設定 → 遠端桌面改的是同一個值）。
- RDP：`POST …/desktop/start` 帶 `audio: true`（VNC 帶了也當 false；非布林 → 欄位錯誤），回應帶 `audio`（實際）。
  開：握手的 `audio` 指令列出 `audio/L8`、`audio/L16`（guacamole-common-js 的 RawAudioPlayer 會播的原始 PCM），
  guacd 開音訊串流（`audio` / `blob` / `end`）。guacd → 瀏覽器本來就整個透傳；瀏覽器 → guacd 的白名單放 `ack`（接受串流），
  瀏覽器送的 `audio`（= 麥克風）照樣丟掉。關：連線參數帶 `disable-audio=true`，guacd 不載入 rdpsnd，遠端根本不送。
  `desktop_open` 事件寫 `Remote desktop (RDP, sound) …`。
- 工具列的聲音按鈕（`components/desktop/SoundButton.tsx`）：靜音 = 在瀏覽器這邊丟掉 blob（取消靜音時不會一次湧出來）。
  按鈕的圖示與字跟著 `lib/desktopSound.ts` 的判斷：**在播**、**安靜**（通道開著但沒聲音）、**等遠端**（剛連上）、
  **聲音被擋住**（資料到了但 AudioContext 沒在跑 —— 旁邊多一顆「點一下啟用聲音」）、**沒有聲音**（連上 10 秒遠端都沒開聲音
  通道）、靜音、關；提示與資訊對話框「這條連線上走哪些東西」的聲音那一條講原因。
- **自動播放（使用者「開了聲音卻聽不到」的修正）**：瀏覽器只讓「在使用者手勢裡」建立或 resume 的 AudioContext 出聲
  （Safari 最嚴格：在手勢外建的 context 一律是 `suspended`）。guacamole-common-js 的播放器是在 guacd 開音訊串流時
  （WebSocket 訊息裡、沒有手勢）才建 context，原本只靠「在畫面上點擊 / 按鍵」才 resume —— 只看不點就一直沒聲音，
  而且舊的「正在播」只看有沒有收到 blob，context 被擋著也照樣顯示正在播。現在「連線」那一下點擊（第一個 await 之前）就
  `primeAudio()` 建好並 resume 一個共用 context，交給 guacd 當 `Guacamole.AudioContextFactory.singleton`；RustDesk 核心也經
  `installRustDeskTap` 拿到同一個。被擋時狀態如實顯示「聲音被擋住」。
- 中繼數聲音串流的量（`desktop/stats.rs`：guacd 開的 `audio` 串流上的 `blob`）：`telepy-stats` 帶 `audio`（沒開過聲音串流 =
  null），統計面板多一列「聲音資料」；`desktop_close` 事件寫 `sound 1.2 MB`，要了聲音卻沒開通道則寫
  `no sound channel from the RDP server`（Logs 就能看出是遠端不送）。
- 遠端那一端：Windows 的 RDP 主機預設會轉送聲音，除非原則關掉（「允許音訊及視訊播放重新導向」）；Linux 的 xrdp 要裝
  `pulseaudio-module-xrdp`（Debian / Ubuntu 沒有打包，要照它的說明從原始碼建）或 `pipewire-module-xrdp`，否則 guacd 拿不到聲音。
- 實測（OrbStack）：真的 guacd 1.6 + xrdp + 自己建的 pulseaudio-module-xrdp，session 裡用 `module-sine` 放 440 Hz：
  Chromium（`--autoplay-policy=document-user-activation-required`）與 WebKit 都排進了非靜音的 buffer（峰值 0.5）、context
  `running`；WebKit 在點擊裡建的 context 是 `suspended`，靠 `primeAudio` 的 resume 才跑起來。把 context 暫停 → 按鈕變「聲音被
  擋住」→ 點「點一下啟用聲音」→ 又在播。測試 `tests/desktop_api.rs` 的 `desktop_rdp_sound_is_offered_and_relayed`（假 guacd
  檢查握手格式、`disable-audio`、串流透傳、麥克風被擋、結束事件的聲音量與「沒有聲音通道」）。

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

## 觸控縮放（`lib/desktopZoom.ts` 純函式 + 測試、`hooks/useDesktopZoom.ts`、`components/desktop/ZoomControl.tsx`）

兩個畫面元件（guacd 的 `DesktopViewer`、`RustDeskViewer`）都經 `useDesktopZoom().layout()` 排版：在「塞進框裡」的比例上再乘
一個倍率，超出框的部分由框裁切、用平移看。

- 雙指捏合縮放、雙指拖曳平移；單指照舊是遠端滑鼠（點一下 = 點擊、長按 = 右鍵）。
- 觸控裝置（`pointer: coarse`）右上角有 − / 倍率 / + 的小膠囊（點倍率 = 回到塞進框裡），倍率停在 `ZOOM_STEPS`，上限至少 4 倍。
- 手機（`(pointer: coarse) and (max-width: 639px)`）上，畫面被縮小時（VNC / RustDesk 的固定解析度）一打開就是 `PHONE_ZOOM`
  （1.5 倍、從左上角開始），遠端的字才看得清楚；RDP 的解析度跟著框走，不放大。新的連線、換螢幕 / 區域、解析度改變時重新套用。
- 只有滑鼠的瀏覽器看不到任何差別。

## RustDesk（瀏覽器裡連，或經隧道轉發給原生 client）

RustDesk 用自己的協定，guacd 不認得。Telepy 有兩條路，**都經隧道**，桌面頁協定選「RustDesk」時預設走第一條：

> 歷史：「Telepy 當 RustDesk 的 ID / 中繼伺服器」（裝置不需要隧道）的模式在 #201–#208 做過，#212 又拿掉了，只留經隧道這條
> （終端機、檔案、分享、即時 session、錄影等功能都走同一條路）。研究紀錄在 [`rustdesk-id-server.md`](rustdesk-id-server.md)；
> 資料遷移 `2026-10-26-drop-rustdesk-server-devices` 刪掉它存的登入與兩張表。

### 瀏覽器裡連（`rustdesk/`、`api/rustdesk.rs`、`ws/rustdesk.rs`；前端 `components/desktop/RustDeskViewer.tsx`、`lib/rustdesk.ts`）

RustDesk 的 web client 核心（社群的 TypeScript 移植，AGPL-3.0，vendored 在 `src/frontend/public/vendor/rustdesk-web-core/`，
來源與版本記在旁邊的 `README.md`）在瀏覽器裡跑：解碼影像（WebCodecs）、做密碼挑戰、送鍵鼠。Telepy **不架 hbbs / hbbr**：
核心以為自己在連 ID 伺服器與 relay，其實兩條都連到同一個 WebSocket，後端看第一則訊息分角色，然後把 relay 那條
重新分框成 RustDesk 的 TCP 線路格式，接到裝置 Direct IP 埠（21118）的 `direct-tcpip` 通道。研究紀錄與量測在
[`rustdesk-spike.md`](rustdesk-spike.md)（1280×800 高動態：核心經中繼 28 fps / ~645 KB/s，guacd VNC 4–5 fps / 0.5–1.3 MB/s）。

- `POST /api/reverse/server/{id}/rustdesk/start`（`{username?, port?, lan_host_id?, credential_id?, clipboard?}`；和桌面同一道門：
  `desktop_enabled`、VIEW、step-up、`choose_username` / `allowed_usernames`、`desktop_max_sessions` 算的是 guacd + RustDesk 的總數）：
  先 `desktop::prepare` —— 池的 lease + 對目標 Direct IP 埠開好 `direct-tcpip`（`device_offline` / `target_unreachable` … 在這裡就是
  502）—— 再發 60 秒單次票證：`{session_id, ws_path: "/ws/rustdesk/{sid}/", ticket, expires_in, target, username, clipboard,
  clipboard_limit, file_transfer}`（帶 `credential_id` 時多一個 `password`，見憑證庫）。
  **密碼不經後端**：固定密碼只交給瀏覽器裡的核心，它用 RustDesk 的雜湊挑戰回應；Telepy 只中繼。
- `/ws/rustdesk/{sid}/?ticket=`：核心會連兩次（`custom-rendezvous-server` 與 `relay-server` 都設成這個網址）。第一則 binary
  訊息是 `RendezvousMessage`：`punch_hole_request`（欄位 8）= hbbs 角色，後端回 `relay_response`（欄位 19：uuid + relay_server =
  同一網址）後只等著、再有 punch 就再回；`request_relay`（欄位 18）= relay 角色，接過 `prepare` 好的通道，之後 WS 的每則
  binary 訊息 → `codec::encode_frame`（1–4 byte LE 前綴，低 2 bits = 前綴長 − 1）→ 通道；通道的 bytes → `decode_frame`
  （上限 16 MiB）→ 一則一訊息。presence kind `rustdesk`，gateway events `rustdesk_open` / `rustdesk_close`（含時長、原因、
  兩個方向的 byte 數）。關閉碼：4404 票證無效 / 過期、4403 權限或登入守門拒絕、4013 裝置端關閉、4014 被伺服器停止（`POST
  /api/reverse/server/rustdesk/{sid}/stop`；檔案 session 另有「畫面那條結束了」「站台關掉傳檔」「被新的取代」）、4400 協定錯、
  4009 從即時 session 頁結束或失去權限、4010 開它的網頁登入被登出。RustDesk 沒有閒置斷線（`desktop_session_idle_timeout` 只管 guacd）。
- 前端（桌面頁）：表單多「RustDesk 密碼」欄（留在瀏覽器），主要按鈕「在瀏覽器裡連線」；`RustDeskViewer` 載入核心（一頁
  同時只能有一個，核心是 window 上的全域物件），設兩個 server 選項 = `rustdeskWsUrl()`、`session_add_sync` + `session_start`，
  自動確認「不加密的直連」msgbox（隧道本身加密），`onVideoFrame` 畫到 canvas（等比縮小、不放大），鍵盤焦點在隱藏的
  textarea（輸入法組字 → `input_string`；按鍵 → `input_key`，鍵名表在 `lib/rustdesk.ts`），滑鼠座標除以縮放比例，游標從
  `cursor_data` 轉成 CSS cursor。工具列：延遲 / 串流按鈕（吃核心的 `update_quality_status`：延遲、fps、目標位元率）、
  螢幕選單（對方 `peer_info` 的 displays → `switch_display`，RustDesk 原生切螢幕；畫質 best / balanced / low 對應 Telepy
  的三個預設）、鍵盤選單（送出文字、Ctrl+Alt+Del）、全螢幕、說明、中斷。info 路徑圖用 `inBrowser` 變體（三步）。
  剪貼簿：核心自己在分頁有焦點時讀瀏覽器剪貼簿送過去；遠端複製的文字顯示在工具列下方。
- **準備清單（「讓那台電腦的 RustDesk 準備好」，`components/desktop/RustDeskSetup.tsx`，純函式 `lib/rustdeskSetup.ts` + 測試）**：
  RustDesk 模式一打開（或換了目標）就從裝置探一次 Direct IP 埠，清單四步各有狀態與一張扁平的小視窗示意（用 RustDesk 自己
  的翻譯標籤，標出要點的地方）：① RustDesk 開著且「啟用 IP 直接存取」（設定 → 安全 → 解鎖安全設定；探測被拒 =
  `desktop.err.rdDirectIpOff`）② 固定密碼且密碼設定不是「使用一次性密碼」（連線回 `rdPassword` = 失敗）③ macOS 的螢幕錄製 /
  輔助使用（`rdNoDisplay` = 失敗）④ 系統服務（看不到，只提醒：沒裝的話 app 一關、重開機就連不到）。這次開頁連上過 = 前三步
  都好、清單收成一行。只有「現在該看的那一步」（第一個失敗的，否則第一個還不知道的）攤開示意，其他各一行、可點「看要點哪裡」。
  起因：一台 Mac mini 開著 RustDesk 卻沒勾 IP 直接存取、密碼設定是「只用一次性密碼」，頁面只說沒偵測到。
- 憑證庫：RustDesk 密碼也能存（`protocol: rustdesk`）；表單有「已存的登入」選單與「儲存這組登入」。start 帶
  `credential_id` 時後端解開、放進回應交給核心（見憑證庫一節）；`rustdesk_open` 事件註明 with saved login '<label>'。
  統計：隧道那一段由 monitor 的延遲補上（連線時讀一次 dashboard，之後跟 `UPDATE-TUNNEL-LATENCY`）；面板不顯示畫面往返 /
  待畫幀（核心在瀏覽器解碼，沒有這兩個數字），「網路往返」是核心自己量的瀏覽器 ↔ 裝置。
- 範圍：畫面、鍵鼠、剪貼簿文字、切螢幕、畫質、**聲音**、**傳檔**。沒有終端機、遠端列印、麥克風 —— 要這些用下面的 app 路。
- **聲音**：核心自己解（RustDesk 送 Opus，WebCodecs `AudioDecoder` → `AudioContext`；瀏覽器沒有 WebCodecs 音訊就沒有聲音，
  按鈕停用並說明）。關 = 那台的 `disable-audio`：登入的 `OptionMessage` 就請裝置別送（裝置不開 audio service，不只是靜音）；
  連線中工具列切換走核心的 `option:toggle`（送 option 給裝置並靜音 / 取消靜音）。和 RDP 共用帳號上的 `desktop_display.audio`。
  裝置那端送什麼（看 RustDesk 1.5 原始碼）：**Linux** 錄 PulseAudio / PipeWire 的 monitor，由已登入桌面工作階段的連線管理員
  （`--cm`）行程負責 —— 沒人登入桌面就沒有聲音；**Windows** 錄預設輸出的 WASAPI loopback；**macOS（Apple 晶片版）** 經
  ScreenCaptureKit 錄系統聲音（用的是本來就要給的「螢幕錄製」權限）；**macOS（Intel 版）** 只錄「音訊輸入裝置」（預設是
  麥克風），要聽 Mac 播的聲音得裝 BlackHole 這類 loopback 裝置並在 RustDesk 設定 → 一般 → 音訊輸入裝置選它。開了聲音、
  上次連到的是 Mac 時，準備清單多一步「Mac 的聲音」（附 RustDesk 設定的示意）。
  實測：容器裡的 Linux RustDesk 1.5（PulseAudio null sink + 440 Hz），補上假的 `loginctl` 與 `sudo` 讓它能起連線管理員後，
  Chromium 與 WebKit 都播出非靜音的 Opus 解碼結果；連線中從關切到開也有聲音。核心的 AudioContext 就是點擊裡解鎖的那個。
- **傳檔（「檔案」面板，`components/desktop/RustDeskFiles.tsx`、純函式 `lib/rustdeskFiles.ts`）**：RustDesk 的傳檔是**另一條
  連線**（登入時帶 `file_transfer`），所以面板向 `POST /api/reverse/server/rustdesk/{sid}/files` 要一個掛在畫面 session 底下的
  子 session（`rustdesk::Kind::Files`：同目標、同帳號、自己的票證與 direct-tcpip 通道；只有開畫面的人能開；不佔
  `desktop_max_sessions`、不另算 presence、不另發 webhook；同一個畫面最多兩個，再開收掉最舊的 —— 重新整理或 React 開發模式的
  雙重 effect 會短暫重疊；畫面那條結束就一起結束）。錯誤碼：409 `not_connected`、503 `file_transfer_disabled` /
  `desktop_disabled`、502 同 start。站台設定 `desktop_file_transfer`（預設開）關掉 → 不發子 session、start 回應
  `file_transfer: false`（按鈕停用並說明）、reaper 收掉開著的。
  - 為什麼要第二份核心：核心是 window 上的全域物件，而且同一個核心裡只有「最上面」的 session 拿得到畫面（`videoFrame` /
    `rgba` 只給 top）；檔案 session 開在畫面那個核心裡，遠端畫面就停了。所以面板在看不見的同源 iframe 裡再載一份核心。
  - 用的是核心自己的檔案 API：`read_remote_dir`（登入後主動要一次，空路徑 = 家目錄）、`send_files {is_remote: true}`（下載）、
    `select_files` + `send_local_files`（上傳）、`confirm_override_file`、`cancel_job`；事件 `file_dir`、`job_progress`、
    `job_done`、`job_error`、`update_folder_files`、`override_file_confirm`、`selected_files`。
  - 對話框要使用者的手勢：存檔對話框（`showSaveFilePicker`）在這一頁的點擊裡開，把手換進 iframe 的核心；選檔用這一頁的
    `<input type=file>`（也能拖放），iframe 裡核心建的 input 的 `click()` 被換成「放進這一頁已選好的檔案」。沒有存檔對話框的
    瀏覽器（Firefox / Safari）由核心整個放記憶體再下載，所以每個檔案 ≤ 2 GB（上傳同樣限制）。
  - 面板：麵包屑（Windows 最上層 = 磁碟機）、上一層、家目錄、隱藏檔、新資料夾、上傳資料夾、上傳、每一列的下載鈕與「⋯」選單
    （下載 / 改名 / 刪除）、勾選多個一起刪、傳輸清單（進度、速度、取消、同名時「略過 / 取代」，只顯示最近 4 筆、進行中的在前）。
    桌面寬度在畫面右邊（`lg:w-80`），手機在畫面下面。
  - **整個資料夾下載成 .zip**（純函式 `lib/rustdeskFileOps.ts`、`lib/zipStream.ts`，zip 用 client-zip（MIT，串流 + ZIP64））：
    點下載 → 存檔對話框（要在點擊裡開）→ `read_dir_to_remove_recursive`（= `ReadAllFiles`，回答是帶 id 的 `file_dir`，名稱是
    相對路徑）數檔案與大小 → 再問一次空資料夾（`ReadEmptyDirs`：核心處理回答（`empty_dirs` 事件）但沒有送出的呼叫，面板自己
    編這一則從 iframe 的 WebSocket 送；舊版 RustDesk 不回答，4 秒後當沒有）→ 超過 500 個檔案或 2 GB 先在傳輸清單裡問 →
    `send_files {is_dir: true}`：核心向 `showDirectoryPicker()` 要資料夾把手再逐檔 `getFileHandle().createWritable()`，面板換成
    一個假把手（`zipDirectoryHandle`），每個檔案的內容一塊一塊流進 zip，再串流寫進使用者選的 .zip；沒有存檔對話框的瀏覽器收在
    記憶體（≤ 2 GB，事先就擋）。核心不會為 0 byte 的檔案開把手，所以完成後依清單補上空檔案與空資料夾。進度 = 第幾個檔案 / 總數 + 位元組。
  - **刪除**：檔案 = `remove_file`；資料夾 = 先（連隱藏檔）遞迴列出、確認對話框講資料夾名稱與裡面幾個檔案多大，再逐一
    `remove_file`（沿用列出的 id）最後 `remove_all_empty_dirs`（RustDesk 只刪「空的」樹）。可多選。**改名**（`rename_file`）：
    裝置把 `new_name` 接在原本的上一層後面，所以打 `../x/名字` 或絕對路徑就是同一顆磁碟裡的搬移（對話框即時顯示結果路徑，
    換資料夾時按鈕變「搬移」）。**新資料夾**（`create_dir`）。**上傳資料夾**（`webkitdirectory` 或拖進資料夾，拖放保留空資料夾）：
    先依序建好資料夾（「已存在」不算錯）再逐檔上傳。每個動作等裝置對那個 id 的 `job_done` / `job_error`，錯誤原樣顯示裝置的訊息。
  - **稽核（`rustdesk/file_audit.rs`，純函式 + 單元測試）**：中繼看得到檔案 session 的明文（加密被拒），所以讀瀏覽器送的
    `file_action`（`ReadAllFiles` / `RemoveFile` / `RemoveDir` / `Rename`）與裝置回的 `done` / `error`，寫 `rustdesk_file_delete`
    / `rustdesk_file_rename` 事件（只有路徑與數量，不含內容）：刪資料夾整個合成一筆（「deleted folder /x (12 files)」，有失敗就
    附上數量與第一個錯誤），單一檔案與改名等裝置回答後各一筆，session 結束時還沒回答的也寫出來。
  - 說明圖：面板的 info 鈕（`RustDeskFilesFlow.tsx`）畫 你的瀏覽器（第二份核心）─ Telepy 中繼 ─ 隧道 ─ 裝置上的 RustDesk ─ 磁碟，
    依階段與正在做的動作亮起，下面是四種動作各自的狀態；頁面的資料流圖在「檔案」那一列底下也列出下載 / 上傳 / 改名 / 刪除的狀態。
- **登入守門（`rustdesk::codec::LoginGuard`）**：中繼唯一解析的東西是瀏覽器 → 裝置方向的 peer `Message` 最外層：
  `login_request`（欄位 7）的 oneof 分支決定這條連線登入成什麼（遙控 / 傳檔 / 埠轉發 / 鏡頭 / 終端機）。畫面 session 只准遙控、
  檔案 session 只准傳檔，不符 → 4403，`rustdesk_close` 事件寫 `refused: a file transfer login on a remote control session`。
  帶內容的 `public_key`（欄位 4，= 要加密）也拒絕：Telepy 的假 hbbs 從不給裝置的金鑰，我們的核心永遠走不加密的 Direct IP
  （整段在 TLS + SSH 裡），會加密的只會是改過的客戶端，而加密後就看不到它登入成什麼了。登入前超過 32 則訊息也拒絕。
  畫面 session 上出現的 `file_action` / `file_response`（核心的檔案 API 只走傳檔連線，只有改過的客戶端會這樣送）也拒絕。
  所以站台設定 `desktop_file_transfer` 是伺服器把關，不只是隱藏按鈕。
- 實測（OrbStack：Debian + RustDesk 1.5.0）：畫面 session 開著時開「檔案」，遠端畫面持續更新；容器裡的 RustDesk 沒有
  連線管理員 UI（Linux 的檔案操作、聲音擷取都交給它），所以傳檔用一層測試用的前置代理（遙控照轉、傳檔由代理服務）驗證：
  清單、下載文字檔與 3 MB 二進位（md5 相同）、上傳、同名取代、資料流圖、手機寬度無水平捲動。之後的資料夾 / 刪除 / 改名
  也用同一層代理（加上 `ReadAllFiles`、`ReadEmptyDirs`、多檔 `send`、`remove_*`、`create`、`rename`）驗證：資料夾 zip（串流
  與記憶體兩條路，空資料夾、0 byte 檔案都在、md5 相同）、501 個檔案先問、改名與 `../` 搬移、新資料夾、上傳資料夾、多選刪除
  （確認數到隱藏檔）、裝置錯誤原樣顯示、Logs 的兩種事件。聲音：開著時裝置進入 audio
  service，關著登入時不進入、連線中切關時退出（真的聲音見上面「聲音」）。
- 踩過的坑：核心的 `confirmInsecure()` 先同步發 msgbox 事件、**之後**才記下等答案的 resolver，所以在事件處理器裡同步回
  `continue-insecure-connection` 會被丟掉（連線卡住、30 秒後裝置端關閉、relay 統計「0 B to the device」）—— viewer 用
  `setTimeout(…, 0)` 下一個 tick 再答。裝置端 RustDesk 跑在 C locale（沒有 `LANG`）時 xdo 拒絕多位元組文字（log
  `Invalid multi-byte sequence encountered`），`input_string` 的中文打不進去 —— 那是裝置的環境，不是 Telepy。
- 實測（OrbStack 裡的 Debian + RustDesk 1.5.0 + Xvfb，headless Chrome）：連上 < 1 s，點擊 / 滾輪 / 移動落在裝置上的座標
  分毫不差（`xev`），打字到達 xterm，即時 session 頁列出 `rustdesk`，Logs 有兩個事件。（這個瀏覽器端的 E2E 腳本沒有放進
  repo；repo 裡的是 `tests/rustdesk_api.rs` 的假裝置測試。）

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
| 4014 | 伺服器端結束（閒置、`…/desktop/{sid}/stop`） |
| 4400 | 瀏覽器送了解析不了的指令 |
| 4009 | 從即時 session 頁被結束（reason = 誰），或失去權限（reason = `Telepy (access changed)`） |
| 4010 | 開它的那個網頁登入被登出（「這個瀏覽器已被登出」；reason = user / admin / logout / reuse / disabled） |

上表是 guacd 這條（`/ws/desktop/`）；RustDesk（`/ws/rustdesk/`）的關閉碼見上面 RustDesk 一節。兩條 socket 都沒有 auth frame
（一次性 `?ticket=`），功能權限與 step-up 在 REST start 就擋了，所以不會出現 4012 / 4008。

guacd 自己的錯誤以 Guacamole `error` 指令送到瀏覽器（例如 0x0203 / 0x0301 = RDP 登入被拒），
前端 `lib/desktop.ts` 的 `sessionFailure` 對到翻譯與「卡在哪一段」。

## 憑證庫（saved logins）

`vault.rs`、`db/credentials.rs`、`api/credentials.rs`；測試 `tests/credentials_api.rs` 與 `tests/desktop_api.rs` 的 vault 段落。

- 每位使用者自己的：`GET /api/credentials`（可用 `tunnel_id` / `lan_host_id` / `protocol` 篩選）、`POST`、
  `PATCH /api/credentials/{id}`、`DELETE`。只有本人看得到、用得到；管理員也不例外。
- 每筆綁一個桌面：`protocol`（`rdp` / `vnc` / `rustdesk`）+ `tunnel_id` + 可選的 `lan_host_id` / `port`，外加 `label`、`login`、`domain`
  （RustDesk 只有固定密碼，`login` 留空）。同一個憑證庫也存 `ssh` 列（網路頁區網主機那一跳的登入：密碼和 / 或私鑰），
  那是終端機的事，不在這份文件的範圍。
  `start` 收到的 `credential_id` 若不是同一個目標（隧道、區網主機、協定）就回 `credential_id` 欄位錯誤，
  所以一筆 Windows 密碼不會被拿去登另一台。
- 密碼以 AES-256-GCM 封存，金鑰由 `SECRET_KEY` 衍生（前綴 `telepy-vault-v1:`），AAD =
  `telepy-credential:{user_id}:{id}`：把密文搬到別人或別筆名下就解不開。API 只回 `has_password`（`ssh` 列另有 `has_key`），密碼永不回傳；
  解密只發生在 `start`，結果跟手打的一樣只留在 session 記憶體。輪換 `SECRET_KEY` 會讓舊的存檔解不開（重存即可）。
  **RustDesk 是唯一的例外**：挑戰回應由瀏覽器裡的核心做，後端代答不了，所以 `POST …/rustdesk/start` 帶 `credential_id`
  時後端解開後放進回應的 `password`（只有這一次、走 TLS、不記錄），前端交給核心後不留在頁面狀態。
- 隧道或區網主機刪除時，綁在上面的憑證一起刪。使用後更新 `last_used_at`；`desktop_open` 事件會註明
  「with saved login '<label>'」（只有名稱，沒有帳密）。
- 前端：桌面頁的「已存的登入」選單（`hooks/useSavedLogins.ts`）與「儲存這組登入」勾選（連線前先存，再用
  `credential_id` 連）；偏好設定的 Saved logins 分頁（`components/layout/SavedLogins.tsx`）列出與刪除。
  任一處新增 / 刪除都會發 `telepy:saved-logins-changed`，其他畫面跟著重載。

## 稽核與可見性

- gateway 事件 `desktop_open` / `desktop_close`（含持續時間、結束原因、串流摘要、guacd 的最後錯誤）與 `rustdesk_open` /
  `rustdesk_close`（含兩個方向的 byte 數）、`rustdesk_file_delete` / `rustdesk_file_rename`，在該隧道的 Logs。
- presence 種類 `desktop` / `rustdesk`（帶它登入的裝置帳號）：擁有者 / ADMIN 在隧道列表的「N 人使用中」看得到誰正開著，
  即時 session 頁（`/tunnels/sessions`、管理員 `/tunnels/admin/sessions`）列出並可結束（4009，reason = 誰結束的）。
- **失去權限就結束**（`access_recheck.rs`，和終端機、檔案、遠端瀏覽器同一套）：取消分享 / 分享到期、權限或允許清單變小、
  裝置帳號改名或刪除、功能 `remote_desktop` 被關、帳號停用等一發生就 `access_recheck::kick`，另有每 10 秒的 `run` 接住其他的；
  判斷是純函式 `lost()`（VIEW + 這個 session 用的裝置帳號還在允許清單）。結束走即時 session 的路徑：socket 4009、reason
  `Telepy (access changed)`，`desktop_close` / `rustdesk_close` 附上 `ended by …: <為什麼>`，本人收到 `SESSION-ENDED`。
  桌面 / RustDesk 自己的 reaper 不再重驗權限。測試 `desktop_ends_when_access_is_lost`、`rustdesk_ends_when_access_is_lost`。
- 開它的網頁登入被撤銷（從「你的裝置」登出、管理員登出、帳號停用）：start 時記下的 web session 一被撤銷就 4010。

## 站台設定（Settings → Remote desktop）

| key | 預設 | 說明 |
|---|---|---|
| `desktop_enabled` | true | 關閉後不能開新的 session |
| `desktop_max_sessions` | 4 | 整站同時上限（含尚未認領的票證），0 = 不限 |
| `desktop_session_idle_timeout` | 900 | 沒有鍵盤 / 滑鼠 / 剪貼簿輸入多久就斷線（秒），0 = 不斷 |
| `desktop_clipboard` | both | **上限**：both / to_remote / off。每個人在桌面頁或偏好設定裡自己選方向（個人設定 `desktop_clipboard`），實際用兩者較窄的那個；guacd 用 disable-copy / disable-paste 把關，RustDesk 由瀏覽器裡的核心套用（off = 那台的 `disable-clipboard`） |
| `desktop_max_resolution` | 2560 | 要求的遠端大小上限（長邊，像素），超過等比縮小；握手與連線中的 `size` 都夾 |
| `desktop_file_transfer` | true | 網頁內 RustDesk 的「檔案」面板（上傳 / 下載 / 改名 / 刪除）；關掉時中繼也拒絕傳檔登入、收掉開著的 |

## 這條連線上走什麼（info 對話框的資料流圖）

`lib/desktopStreams.ts`（純函式 + 測試）→ `components/desktop/DesktopStreams.tsx`，放在 `DesktopFlow` 路徑圖下面：畫面、鍵盤與
滑鼠、剪貼簿、聲音、檔案五條並排的直線（左 = 你的瀏覽器、右 = 桌面，箭頭 = 方向），每條的狀態 on / oneWay（剪貼簿 to_remote）/
off（自己關的、RDP 在這個分頁靜音）/ blocked（站台上限）/ unsupported（這種連法沒有：guacd 的 VNC 沒聲音、RDP / VNC 畫面不傳檔、
瀏覽器沒有 WebCodecs 音訊），旁邊一句為什麼。聲音那一條跟著 `lib/desktopSound.ts` 的判斷（等遠端 / 被擋住 / 沒有聲音），
檔案那一列在 RustDesk 底下列出下載 / 上傳 / 改名 / 刪除各自的狀態。

info 對話框（`DesktopInfoDialog`）上半是 `DesktopFlow` 的路徑圖：你的瀏覽器 ─ Telepy ─ 裝置 ─ 桌面，每一點 waiting / active /
ok / failed（`lib/desktop.ts` 的 `spotStates`，失敗由 `sessionFailure` 對到卡在哪一段），連線中兩段線上標往返時間；RustDesk
在瀏覽器裡連時用 `inBrowser` 變體，用 app 時畫埠轉發那條路。

## 連線方式比較（`components/desktop/ConnectionWays.tsx`、純函式 `lib/connectionWays.ts` + 測試）

一個對話框並排比較兩種都經隧道的連法：RDP / VNC 經 guacd（Telepy 把畫面轉成圖片）與 RustDesk（瀏覽器裡的核心解碼）。
兩條路徑欄位對齊（瀏覽器 ─ Telepy ─ 裝置 ─ 桌面；隧道 = 雙線、裝置到桌面的那一跳 = 虛線），每條下面是「誰加密哪一段」
的標尺（TLS / SSH / 協定自己的，`layerColumns`），標出畫面在哪裡畫；再來是一張事實表（手機上變卡片，`ROWS`：含聲音與檔案）
和怎麼選。現在用的那種（`wayFor(protocol)`）會被標出來。從桌面頁標題列、協定欄的提示、info 對話框的頁尾都打得開。
事實變了就改 `ROWS`。

## 部署

`docker-compose.yml` 的 `guacd` 服務（`guacamole/guacd:1.6.0`）只在 internal 網路 `telepy-desktop-${PROJECT_NAME}`；
backend 同時在 `telepy-network` 與它上面。環境變數：`GUACD_ADDR`（預設 `guacd:4822`）、`DESKTOP_CALLBACK_HOST`
（guacd 連回 backend 用的名字，compose 裡是 `backend`；未設時用 `HOSTNAME`）。

## 裝置端需求

- sshd 允許 TCP 轉發（`AllowTcpForwarding`，OpenSSH 與 Win32-OpenSSH 預設開啟）。
- 桌面伺服器：Windows 遠端桌面（3389）、macOS 螢幕共享（5900，要在「VNC 檢視器可以使用密碼控制螢幕」設密碼）、
  TigerVNC / x11vnc（5900 + display，例如 :1 = 5901）、xrdp（3389）。
- RDP 用 `security=any` + `ignore-cert=true`；NLA 需要正確的 Windows 帳密（含網域）。
