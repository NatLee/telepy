# 遠端瀏覽器

<p align="center"><a href="./remote-browser.md">English</a> | <b>繁體中文</b> | <a href="./remote-browser.ja.md">日本語</a></p>

遠端瀏覽器是一個真的 Chromium：你在 Telepy 的分頁裡操作它，它發出的每個請求則從你的某台裝置出去。網站看到的是那台裝置的位址，連 `localhost` 指的都是裝置本身。

Chromium 本身跑在 Telepy 這邊的瀏覽器容器裡。裝置只是借出它的 SSH 伺服器，負責真正連出去，上面不用裝任何東西。

## 適合拿來做什麼

- **只在區網裡打得開的管理頁**：`192.168.1.1` 的路由器、NAS、印表機、交換器。這類頁面從沒聽說過網際網路，也打算繼續這樣下去。
- **裝置自己 `localhost` 上的服務**：例如 `http://localhost:8080` 上一個本來就沒打算對外的儀表板。打開它就像坐在那台裝置前面一樣。
- **用裝置的角度看網路**：同一個公網 IP、同一個所在地、同一套 DNS。

## 開一個來用

1. 在通道列表裡，按某台裝置的「瀏覽器」。終端機頁面會直接開在瀏覽器分頁。
2. 在頁面上方選好登入帳號。瀏覽器會用這個帳號的 SSH 登入上網。
3. 按「啟動瀏覽器」（或面板中間的「點擊初始化」）。

啟動分成三步，面板會一步一步顯示：

- **經由裝置開代理**：Telepy 用那個帳號登入裝置，經由它的 SSH 開一個 SOCKS 代理。
- **啟動 Chromium**：Telepy 的瀏覽器容器開一個全新的 Chromium，使用這個代理。
- **在這裡顯示畫面**：你的分頁連上瀏覽器的畫面。

![遠端瀏覽器逐步啟動](images/zh-TW/browser-start.gif)

哪一步失敗，清單就停在那一步並寫出原因，按「再試一次」從頭來過。第一次開代理時連線還是冷的，可能比較慢，所以預設會自動再試一次。

## 裡面會看到什麼

- **每次都是全新的**：每個工作階段都有一份全新的瀏覽器設定檔，停止時就刪掉。瀏覽紀錄、cookie、存下來的密碼通通不會留下。
- **首頁與語系**：由網站設定決定，沒改過的話是 Google 與 `zh-TW`。畫面預設是 `1280x720`。
- **輸入中文或日文**：用你自己的輸入法就行。面板標頭的「IME」按鈕切換這個模式，預設是開的。
- **下載被擋掉了**：檔案只會落在一個誰都拿不到的容器裡。保密到家，連你自己都看不到。
- **視窗不見了**：縮小的視窗可以從遠端桌面頂端的工作列點回來。如果是關掉了，按那條工具列上的「Open Browser」捷徑，或在桌面按右鍵選「Open Browser / 開啟瀏覽器」。已經有視窗就把它叫回來，沒有才開新的。
- **Chromium 當掉了**：等幾秒就好。有個看門狗每 10 秒檢查一次，會自動把它開回來。沒有瀏覽器的遠端瀏覽器，只是一張很貴的桌布。

## 誰可以開

- 你要有這條通道的 **VIEW** 權限，而且在這條通道上至少有一個可用的登入帳號。瀏覽器就是用其中一個帳號執行。
- 功能「遠端瀏覽器」要對你開著。管理員在「功能權限」頁設定。
- 標示「需先確認」（step-up）的通道，啟動前會要你用第二個驗證因素確認身分。
- 如果網站要求兩步驟登入，你的帳號得先設定好。
- 整個網站同時最多跑 `remote_browser_max_sessions` 個瀏覽器（預設 10 個），MCP agent 與腳本開的也算在內。

你在用的時候，通道擁有者和有 ADMIN 權限的分享對象，會在通道列表的「N 人使用中」按鈕和「即時連線」頁面看到你。Telepy 會把 `browser_open` 與 `browser_close`（含時長）寫進這條通道的「日誌」，並把 `session.started` webhook 事件送給擁有者與 ADMIN（不會送給你自己）。

## 什麼時候會結束

- **你自己關掉**：按「停止工作階段」、關掉面板或關掉分頁。代理、瀏覽器、設定檔一次收乾淨。
- **你的連線不見了**：後端每 20 秒 ping 一次分頁，40 秒內什麼都沒收到，就當你已經離開。筆電睡著或換了網路，都不會讓工作階段一直掛著。
- **有人從「即時連線」頁面結束它**：關閉碼 4009，原因欄寫的是對方的名字。
- **你失去權限**：通道取消分享、帳號被移出允許清單、功能「遠端瀏覽器」被關掉，或你的帳號被停用。工作階段以 4009 關閉，原因是 `Telepy (access changed)`。`browser_close` 會記下為什麼，你也會收到 `SESSION-ENDED` 通知。
- **工作階段沒有回應**：面板另外每 15 秒回報一次。如果背後的代理已經死了，Telepy 會把工作階段收掉，面板顯示「工作階段不存在或已過期」。
- **定期清理掃到它**：Telepy 每 10 秒也會清掉裝置連線已經斷掉的工作階段，以及超過 `remote_browser_session_idle_timeout` 再加 30 秒都沒回報的工作階段。
- **Telepy 重新啟動**：執行中的工作階段不會保留。Telepy 啟動時會把容器裡留下來的瀏覽器都停掉。

## 網站懷疑你是機器人的時候

一個真人透過 VNC 操作、又從裝置自己的 IP 出去，本來就是最好的偽裝。Telepy 另外加了幾個 Chromium 旗標，讓瀏覽器看起來不像自動化程式。它們有幫助，但有些封鎖它們管不到。

### Telepy 已經做的事

- `--disable-blink-features=AutomationControlled` 讓 `navigator.webdriver` 變成 false。
- `--lang` 與 `--accept-lang` 給瀏覽器一個真實而一致的語系。`navigator.languages` 是空的，是很典型的機器人特徵。
- `--accept-lang` 只傳乾淨的語言標籤、不帶 q 值（`zh-TW,zh,en`）。Chromium 用這個值同時決定 `Accept-Language` 標頭與 `navigator.languages`，q 值由它自己算。舊版曾經先把 q 值塞進去，結果送出真瀏覽器絕對不會有的東西：
  - `Accept-Language` 變成 `zh-TW,zh;q=0.9,zh;q=0.9;q=0.8,en;q=0.8;q=0.7`（q 疊了兩層）
  - `navigator.languages` 變成 `['zh-TW','zh;q=0.9','en;q=0.8']`（q 漏了進去）

  下場就是到處跳 CAPTCHA。改用乾淨標籤後，標頭是 `zh-TW,zh;q=0.9,en;q=0.8`，`navigator.languages` 是 `['zh-TW','zh','en']`。
- `--enable-unsafe-swiftshader`，而且只加這一個，讓 WebGL 能用。容器沒有 GPU，少了它 `canvas.getContext("webgl")` 會回傳 null。「完全沒有 WebGL」是很強的機器人訊號，YouTube 的「登入以確認你不是機器人」就會檢查。這個旗標只讓 WebGL 退回軟體繪圖（SwiftShader），不碰合成器。

> [!WARNING]
> 千萬不要為了「確保 WebGL 能用」加上 `--use-gl=angle --use-angle=swiftshader`。它會把整個合成器都推去軟體繪圖，影片就播不順了。用真的 VP9 在 640x480 實測：強制版掉 4 幀，只加單一旗標與完全不加都是 0 幀，而且 WebGL 一樣正常。到了 720p 或 1080p，強制版根本播不動。

WebGL 回報的繪圖器仍然是 SwiftShader，不是真的 GPU。這是個弱訊號；要藏起來得偽造 renderer 字串，Telepy 沒有這樣做。

### 旗標救不了的事

旗標只處理瀏覽器指紋。像 YouTube 那樣的封鎖，主要看另外兩件事：

1. **裝置 IP 的信譽**：流量從裝置的 IP 出去。如果那是機房、雲端或 VPN 的位址，或已經被大量自動化流量用過，YouTube 和 Cloudflare 不管瀏覽器多像真人都會擋。唯一的解法是換一台住家網路上的裝置。
2. **沒有 cookie，就沒有信任**：每個工作階段都從全新的設定檔開始，而網站對有登入、有瀏覽紀錄的瀏覽器信任得多。對 YouTube 來說，一個沒有 cookie 的全新瀏覽器看起來就是機器人。說真的，它平常遇到的這種，大多也真的是。

每次全新開始是刻意的隱私選擇，偶爾被要求登入就是代價。如果封鎖變成問題，先換一台住家 IP 的裝置。

<details>
<summary>給貢獻者：為什麼設定檔維持全新</summary>

commit 967ea75 把設定檔改成用完即丟之後，出現了「YouTube 要求登入」的回歸，因為 cookie 再也累積不起來。當時考慮過一個折衷：只保留 cookie 與登入狀態，仍然不留瀏覽紀錄。專案擁有者選擇隱私優先（2026-07-04 決定），況且出口 IP 的影響更大。在這個決定重新討論之前，請不要把設定檔的持久化加回來。

</details>

## MCP agent 與腳本操作

同一個瀏覽器，也可以在沒人看畫面的情況下操作：

- **MCP agent**：有 `browser:use` 範圍的 agent 可以用 `browser_*` 工具，見 [MCP](mcp.zh-TW.md)。
- **腳本**：用 `/api/browser/sessions*` 底下的 REST 路由：開啟（`{tunnel_id, username?, url?}`）、`navigate`、`text?selector=`、`screenshot`（image/png）、`click`、`type`、`DELETE`，以及列出。個人 API token 需要 `browser:use` 範圍；網頁登入也可以呼叫。
- **命令列**：`telepy browse`，見 [命令列](cli.zh-TW.md)。

```bash
ID=$(telepy browse box http://192.168.1.1/)   # a browser on the device's network (browser:use); prints its id
telepy browse shot "$ID" -o router.png
telepy browse close "$ID"
```

這些都是一般的遠端瀏覽器工作階段：同一個代理、同一個瀏覽器容器，也算進 `remote_browser_max_sessions`。不一樣的地方是：

- 瀏覽器屬於開它的那個憑證：MCP app、API token 或網頁登入。它和這個人的 agent SSH 工作階段一起算進 `ai_max_sessions_per_user`。
- 閒置、壽命、撤銷、失去權限、裝置離線，都照 agent 工作階段的規則處理，這套規則還會檢查 app 的核准或 token 是否仍然有效。會結束網頁工作階段的變更，也會立刻觸發這項檢查。
- 它們會以 app 的名稱出現在「即時連線」頁面，也可以在那裡結束；之後的動作會回報是誰結束的。
- 開啟與關閉會寫入 `browser_open` 與 `browser_close`。每個動作都會在 AI 活動紀錄留一筆；`type` 送出的文字只記長度，除非呼叫時指定 `sensitive: false`。
- 要求 step-up 的通道一律拒絕（403 `step_up_refused`，MCP 則是工具錯誤）。
- 功能「遠端瀏覽器」關掉時，誰都不能開啟或操作；列出與關閉照常可用。

各個動作做什麼：

- `navigate`：只收 http 和 https。後端會擋掉 `file:` 之類的網址，免得有人讀到容器自己的檔案。
- `screenshot`：寬度最多 1280 px 的 PNG。
- `read` / `text`：頁面上看得到的文字與連結，可以用 CSS selector 限定範圍。
- `click`：用 selector 或看得到的文字點，是真的滑鼠點擊。
- `type`：先聚焦欄位再輸入文字，也可以按 Enter。

動作作用在瀏覽器分頁中第一個一般網頁；分頁全部關掉的話，會開一個空白頁。每個動作有 30 秒。

<details>
<summary>動作怎麼送到 Chromium</summary>

```
MCP 工具（browser_navigate / read / click / type / screenshot）或 REST /api/browser/sessions/{id}/…
  → 後端
  → session manager：POST /sessions/<id>/cdp（X-Internal-Token）
  → cdp.py → ws://127.0.0.1:<CDP_BASE + display>（chromium --remote-debugging-port，只聽容器內的 loopback）
```

- DevTools 連接埠只聽容器內的 127.0.0.1。後端從不直接連它，而是請 session manager 把動作交給一支小小的轉接程式（`cdp.py`）。
- 每個動作的上限是 `CDP_ACTION_TIMEOUT`（30 秒）。
- 截圖用 CDP 的 clip scale 縮放；點擊是真的 `Input.dispatchMouseEvent` 事件；輸入用 `Input.insertText`。
- 選中的分頁是 `/json/list` 裡第一個一般網頁；沒有的話就開一個 `about:blank`。
- `cdp.py` 只用 Python 標準函式庫，連 WebSocket client 都是自己寫的最小版本。測試在瀏覽器容器的 `tests/test_cdp.py`。

</details>

## 內部怎麼運作

### 各個元件

- **你的分頁**：執行 KasmVNC 自家的網頁 client（Telepy 已內附），把遠端畫面畫出來。
- **後端**：確認你是誰，在你的分頁與瀏覽器容器之間轉送畫面，並為每個工作階段跑一個小小的 SOCKS 代理。
- **瀏覽器容器**（`kasm-browser`）：每個工作階段各有一個虛擬螢幕（KasmVNC 的 Xkasmvnc）、一個視窗管理員（openbox）和 Chromium。
- **session manager**：容器裡的一個小 HTTP 服務。它照後端的要求啟動、停止上面那三樣，而且只接受帶著共用 `INTERNAL_API_TOKEN` 的呼叫。
- **裝置的 SSH 伺服器**：負責真正連到網站。

```
你的分頁 ──wss /ws/remote-browser/<session>/──▶ 後端 ──ws──▶ kasm-browser 容器
                                                         （Xkasmvnc + openbox + Chromium）

Chromium ──SOCKS5──▶ 後端 ──經通道的 channel──▶ 裝置的 sshd ──▶ 網站
```

Chromium 啟動時以 `--proxy-server` 指向後端的代理。它開的每條連線，都會變成 Telepy 原本就連著裝置的那條 SSH 連線上的一條 channel，再由裝置的 sshd 往外連。這和 `ssh -D` 是同一個機制，只是不用另外開一個程序。

這個 SSH 登入是共用的：同一台裝置、同一個帳號已經開著網頁終端機或檔案管理的話，瀏覽器就搭同一條連線。代理只做 CONNECT、沒有密碼，而且只有在 Telepy 的 Docker 網路裡連得到。

目的地是主機名稱、裝置又是 Mac 的時候，Telepy 會先在裝置上把名稱解析成 IP 再連。Apple 的 sshd 一收到「轉送到某個名稱」的請求，就會把整條 SSH 連線斷掉。

<details>
<summary>面板呼叫了哪些 API</summary>

- `POST /api/reverse/server/{id}/remote-browser/start`，內容 `{username?}`：檢查功能、VIEW、step-up、帳號（沒給就用通道的預設帳號，再沒有就用你可用的第一個）與工作階段上限，接著開代理、請 session manager 開瀏覽器，回傳 `{session_id, ws_path}`。
- 代理開不起來時回 500 與 `code: device_offline`，面板會換成自己的訊息。完全沒有通道的裝置會馬上失敗，不會把每次嘗試都等完。
- `POST /api/reverse/server/remote-browser/{sid}/ping`：每 15 秒一次。它先確認這個工作階段的代理還在聽；不在的話就把工作階段收掉，回 404。
- `POST /api/reverse/server/remote-browser/{sid}/stop`：面板關閉或分頁卸載時呼叫。畫面的 socket 斷掉也走同一條路。
- 畫面的 socket 連著時，後端自己也每 20 秒續命一次，所以背景分頁被瀏覽器節流也不會害它斷掉。
- 工作階段存在後端的記憶體裡。另有一張小表記著它們，只是為了重新啟動後，讓 Telepy 能停掉容器裡還在跑的瀏覽器。

</details>

### 為什麼 localhost 是那台裝置

Chromium 有一條內建規則：loopback 位址一律不走代理。在這裡，這會讓 `http://localhost:8080` 連到容器自己的 loopback，而那裡什麼都沒有。曾經有人回報遠端瀏覽器「連 localhost 都連不到」，原因就是這個。

Telepy 啟動 Chromium 時加上 `--proxy-bypass-list='<-loopback>'`。這個 token 會拿掉那條內建例外，於是 loopback 也走代理，由裝置的 sshd 去連裝置自己的 `127.0.0.1`。

這條例外涵蓋 `localhost`、`*.localhost`、`[::1]`、`127.0.0.1/8`、`169.254/16` 與 `[FE80::]/10`，所以 link-local 位址現在也會進到裝置的網路，這正是我們要的。一般上網不受影響；畫面串流也不受影響，因為那是 KasmVNC 自己的 websocket，不是 Chromium 的流量。

如果要改 Chromium 的命令列，單引號一定要留著。整條指令會再被 shell 解析一次（容器啟動腳本裡的 `sh -c "$BROWSER_CMD"`），沒加引號的 `<` 或 `>` 會被當成重新導向。

### 畫面怎麼送到你的分頁

KasmVNC 已經偏離標準的 VNC（RFB）：它只開 websocket，沒有傳統的 VNC 連接埠，原版 noVNC 也連不上它，只會看到黑畫面。所以分頁用的是 KasmVNC 自己 fork 的 noVNC client，後端則是 websocket 對 websocket 逐則轉送，完全不解析內容。

- 你的分頁連到 `/ws/remote-browser/<session_id>/`，第一則訊息送出登入用的 token。
- 後端檢查功能「遠端瀏覽器」（關著就回 4012），並再確認一次你對這個工作階段的通道有 VIEW 權限。
- VNC 伺服器會先開口，所以不能漏掉它的問候。順序是：分頁送 `auth`，後端連上游之後回 `ready`，分頁把 socket 交給 VNC client 再回 `begin`，後端這時才開始轉送。
- 心跳是每 20 秒一次的 WebSocket ping；ping 之後 40 秒沒有任何回應，就結束工作階段。

<details>
<summary>給貢獻者的 KasmVNC 實測事實（測過了，不用再查）</summary>

| 項目 | 值 |
|---|---|
| 相容原版 noVNC？ | **不相容**。要用 kasmtech/noVNC fork（server 1.4.0 ↔ client 1.3.0） |
| 傳輸 | 純 ws（`-sslOnly` 預設關閉）；端點 `/websockify`；subprotocol `binary` |
| `Sec-WebSocket-Origin` | 必帶（Hixie 時代的標頭，值不檢查）。少了會回 404 "failed websocket checks"，不是 401 |
| Basic Auth | 預設開啟；`-disableBasicAuth` 在 1.4.0 沒有作用。用 `kasmvncpasswd` 建使用者，連線時帶 `Authorization: Basic` |
| 密碼檔 | 固定路徑 `-KasmPasswordFile /etc/kasmvnc/kasmpasswd`。別依賴 `$HOME`：build 與執行時的 HOME 不同，會一直 401 |
| ws_port | `8443 + display`（可用 `WS_BASE` 調整） |

內附的 client 在 `src/frontend/src/vendor/kasm-novnc/`（kasmtech/noVNC v1.3.0）。它的 README 列出嵌入時必須做的事，例如設定滑鼠按鍵對應、在 `compositionend` 之後歸零。動面板之前先讀它。

改用 KasmVNC 的經過，寫在[這篇工程筆記](engineering/articles/2026-07-03-kasmvnc-migration-warstory.md)裡。

</details>

### 瀏覽器容器裡面

每個工作階段都有自己的顯示器（`:N`，websocket 連接埠 `8443 + N`）、自己的視窗管理員與 Chromium，以及自己的暫存設定檔目錄。容器的 PID 1 是 tini（`init: true`），負責收掉沒人管的程序。

<details>
<summary>給貢獻者的容器細節</summary>

- **設定檔絕不共用**：Chromium 的 SingletonLock 會讓第二個同時執行的 Chromium 把工作交給第一個然後退出（`Opening in existing browser session.`），兩個工作階段一起失敗。瀏覽器的 `HOME` 也指向設定檔目錄，所以 dotfile 會跟著工作階段一起刪掉。
- **只有一支啟動腳本**：工作列的捷徑、桌面右鍵選單和看門狗，跑的都是同一支 `open-browser.sh`。Debian 預設的 openbox 選單有個「Web browser」，執行的是裸的 `x-www-browser`，以 root 身分又沒有沙箱，會馬上退出，看起來就像「點了沒反應」。那個選單已經換掉了。
- **瀏覽器指令有兩條路**：一條是環境變數，另一條是每個顯示器一份的檔案 `/tmp/telepy-browser-<display>.env`（工作階段停止時刪除）。環境變數不見時，腳本會依 `$DISPLAY` 讀那份檔案。舊版 openbox 不會傳環境變數，從它的選單開瀏覽器就會出現 `BROWSER_CMD not set`。
- **重複執行也沒關係**：捷徑會先聚焦或還原既有的視窗，沒有視窗才開新的 Chromium。它也會清掉殘留在背景模式的程序，否則只會印出「Opening in existing browser session」，卻不開任何視窗。
- **看門狗**：每 10 秒依 `--user-data-dir` 找這個工作階段的 Chromium，不見了就重開。工作階段啟動後先等 15 秒，兩次重開之間至少隔 30 秒。`REMOTE_BROWSER_RESPAWN=0` 可以關掉它。會有它，是因為有位使用者回到工作階段只看到空桌面，就以為整個功能壞了。
- **視窗**：openbox 用自己的設定檔啟動（沒有標題列、最大化）。Chromium 自己的 `--start-maximized` 只給了 1050×720，還留邊、帶標題列。
- **下載**：由 Chromium 的管理政策（`DownloadRestrictions: 3`）擋掉。要開放的話，得同時有配額和把檔案拿出來的方法。
- **沙箱**：Chromium 在容器裡以 root 執行，而 Docker 預設的 seccomp 設定擋住了非特權的 user namespace，所以需要 `--no-sandbox`。`--test-type` 用來藏起黃色警告列；它不會改變 JavaScript 指紋，網頁也看不到那條警告列。真正的沙箱需要從 compose 掛上自訂的 seccomp 設定檔。這件事沒有做：隔離的邊界就是容器。
- **停止**：程序用 `killpg(p.pid)` 整組收掉（`start_new_session` 讓群組 id 等於 pid）。不要用 `getpgid`：群組 leader 先死的話它會丟出例外，留下孤兒程序。

</details>

## 設定

### 網站設定

在「網站設定 → 遠端瀏覽器」。閒置逾時改了立刻生效，其他變更都在下次開瀏覽器時生效。

| 設定 | 預設 | 作用 |
|---|---|---|
| `remote_browser_session_idle_timeout` | 60 | 沒有回報多少秒（再加 30 秒寬限）就清掉工作階段 |
| `remote_browser_max_sessions` | 10 | 全站同時執行的瀏覽器數，含 agent 與腳本開的。0 = 不限 |
| `remote_browser_geometry` | `1280x720` | 每個瀏覽器的畫面大小 |
| `remote_browser_ssh_timeout` / `remote_browser_ssh_attempts` | 30 / 2 | 開代理時每次嘗試的秒數，與嘗試次數 |
| `remote_browser_kasm_create_timeout` | 30 | 等容器把顯示器和 Chromium 開好的秒數 |
| `remote_browser_homepage` / `remote_browser_language` | Google / `zh-TW` | 首頁與語系。留空 = 用容器環境變數的預設值 |

兩個 `remote_browser_ssh_*` 設定的名字，來自代理還是獨立 `ssh -D` 程序的年代。現在它跑在後端裡面，名字則留了下來。

### 環境變數

每個都有預設值，通常什麼都不用設。後端這邊：

- `KASM_BROWSER_API`（預設 `http://kasm-browser:7000`）：session manager。
- `KASM_BROWSER_HOST`（預設 `kasm-browser`）：KasmVNC websocket 所在的主機。
- `INTERNAL_API_TOKEN`：後端以 `X-Internal-Token` 送給 session manager 的密鑰。

瀏覽器容器裡的，或兩邊共用的：

| 變數 | 預設 | 用途 |
|---|---|---|
| `KASM_WS_USER` / `KASM_WS_PASSWORD` | `telepy` / `telepyvnc` | KasmVNC 網頁層的 Basic Auth。容器 build 時建立、後端連線時送出，同一個 `.env` 控制兩邊 |
| `KASM_WS_SCHEME` / `KASM_WS_PATH` / `KASM_WS_SUBPROTOCOL` | `ws` / `/websockify` / `binary` | 中繼優先嘗試的值（不行會自己改試其他組合） |
| `KASM_PASSWORD_FILE` | `/etc/kasmvnc/kasmpasswd` | 密碼檔的固定路徑 |
| `REMOTE_BROWSER_HOMEPAGE` / `REMOTE_BROWSER_LANG` | Google / `zh-TW` | 網站設定留空時的首頁與語系（語系會影響 `navigator.languages`） |
| `REMOTE_BROWSER_PROFILE_TMP` / `WS_BASE` | `/tmp` / `8443` | 暫存設定檔的上層目錄 / 第一個 websocket 連接埠 |
| `CDP_BASE` / `CDP_ACTION_TIMEOUT` | `9300` / `30` | 給 agent 用的 DevTools 連接埠基數（連接埠 = `CDP_BASE + display`，只聽 127.0.0.1）/ 每個動作的秒數 |

## 疑難排解

### 訊息與關閉碼

啟動失敗時，面板會停在出錯的那一步：

- **經由裝置開代理**，顯示「裝置離線」：它的通道沒有連上。在裝置上執行連線腳本，再試一次。
- **經由裝置開代理**，顯示「沒有及時回應」：裝置或它的通道太慢。調高 `remote_browser_ssh_timeout` 或 `remote_browser_ssh_attempts`。
- **啟動 Chromium**：瀏覽器容器沒能啟動它。確認 `kasm-browser` 有在跑，而且和後端用同一個 `INTERNAL_API_TOKEN`。伺服器慢或很忙的話，調高 `remote_browser_kasm_create_timeout`。
- **在這裡顯示畫面**：畫面連線先關掉了，原因看下面的關閉碼。
- 出現「The Proxy Browser has reached its maximum concurrent user limit.」，代表已經有 `remote_browser_max_sessions` 個瀏覽器在跑。等別人關掉一個，或調高上限。

`/ws/remote-browser/<sid>/` 的關閉碼：

| 關閉碼 | 意思 |
|---|---|
| 4000 / 4001 | 第一則訊息認證失敗（格式 / token） |
| 4007 | 網站要求兩步驟登入，這個帳號還沒設定 |
| 4012 | 功能「遠端瀏覽器」對你關著（原因 = 功能 id） |
| 4404 | 工作階段不存在或還沒準備好。面板顯示「工作階段不存在或已過期」 |
| 4403 | 你沒有這條通道的 VIEW 權限。面板顯示「你沒有這條通道的權限」 |
| 4011 | 後端連不上瀏覽器容器裡的 KasmVNC。面板顯示「無法連線到 VNC 瀏覽器後端」 |
| 4013 | KasmVNC 關掉了連線，或不再接收資料。面板顯示「VNC 連線已關閉」 |
| 4009 | 從「即時連線」頁面被結束，或失去權限（原因 = 是誰，或 `Telepy (access changed)`） |
| 4010 | 這個瀏覽器的網頁登入被登出了（原因 = user / admin / logout / reuse / disabled） |

### 在伺服器上檢查

**Chromium 一啟動就消失**（SIGTRAP、exit 133；看門狗每 30 秒重開一次，它又馬上死掉）。這是 Debian chromium 150.0.7871.46 的打包問題（[#1141488](https://bugs.debian.org/1141488)，2026 年 7 月）。Telepy 的映像檔已經繞過它了；如果你改了瀏覽器的映像檔，兩個繞過方法都要留著。

<details>
<summary>Debian chromium 問題的細節</summary>

有個 patch 拿掉了 `{google:searchSource}` token 的處理，但 Chromium 內建的 Google 搜尋範本裡還有這個 token。一展開就撞上 `NOTREACHED()`，Chromium 就安安靜靜的死掉，就算開了 `--v=1` 也看不到 FATAL。

在這個容器裡，下面幾種情況會觸發：

- `--no-first-run` 碰上全新的設定檔。而每個工作階段都是全新的設定檔。
- Chromium 以 `--headless=new` 執行。
- 使用者把預設搜尋切回內建的 Google，然後搜尋。

繞過方法（對之後的版本無害，修好的版本出來後也請留著）：

1. 預設的瀏覽器指令不再帶 `--no-first-run`。Debian 的版本根本沒有首次執行精靈，這個旗標除了讓它當掉之外毫無作用。不要加回去。
2. Chromium 的政策檔用 `DefaultSearchProvider*` 把預設搜尋釘成範本乾淨的 Google（只用 `{searchTerms}`）。這樣就不經過內建範本，順便把那個版本預設的 DuckDuckGo 換回 Google，也不讓使用者選到會當掉的那個項目。不要拿掉這組政策。

最後手段：把 chromium 釘回 149.0.7827.196-1~deb12u1（snapshot.debian.org 20260703T000000Z）。這樣會停掉安全性更新，不建議。

</details>

其他常見狀況：

- `404 failed websocket checks`：少了 `Sec-WebSocket-Origin` 標頭。探測腳本和後端的中繼都會帶它。
- `401`：帳密或密碼檔有問題。用 `ls -l /etc/kasmvnc/kasmpasswd; wc -c` 確認檔案不是空的。
- websocket 有通、分頁卻是黑畫面：client 不是 Kasm 的 fork，或沒做到內附 client 要求的嵌入步驟（滑鼠按鍵對應、`compositionend` 歸零）。
- 找還活著的 Chromium 程序時，`pgrep -f` 也會比對到你自己外層 shell 的命令列。改用括號技巧 `ps ax | grep "[c]hromium"`。

上游的 websocket 連不上？啟動一個獨立的 Xkasmvnc 和探測腳本來看。它不像工作階段那樣會被自動清掉：

```bash
docker compose exec kasm-browser bash -lc \
  'Xkasmvnc :20 -geometry 1280x720 -depth 24 -SecurityTypes None \
   -KasmPasswordFile /etc/kasmvnc/kasmpasswd -websocketPort 8463 \
   -httpd /usr/share/kasmvnc/www -interface 0.0.0.0 & sleep 3'
docker compose cp docker/kasm-browser/probe_kasmvnc.py kasm-browser:/tmp/probe.py
docker compose exec kasm-browser python3 /tmp/probe.py --port 8463 \
  --user telepy --password telepyvnc
```

<details>
<summary>執行測試</summary>

```bash
# 後端測試(真 stack):
(cd src/backend-api && cargo test)   # 含 tests/remote_browser_api.rs：SSH lab 上的真裝置(程序內 SOCKS)+ 假 session-manager + 假 KasmVNC ws 的端到端;tests/socks_e2e.rs 測 SOCKS 本身
# session-manager 測試(純 stdlib):
cd docker/kasm-browser && python3 -m unittest discover -s tests -p "test_*.py"
```

</details>
