# 裝置代理

<p align="center"><a href="./proxy.md">English</a> | <b>繁體中文</b> | <a href="./proxy.ja.md">日本語</a></p>

裝置代理把一條通道變成網路代理。程式帶著 token 連到 Telepy，由裝置自己的 SSH 伺服器把連線開到目的地。目的地看到的是裝置的位址，`localhost` 指的也是裝置本身。

裝置上不安裝、也不執行任何東西。這跟它的 sshd 本來就替 `ssh -D` 和[遠端瀏覽器](./remote-browser.zh-TW.md)做的轉送是同一件事，代理只是多開一扇 app 也能用的門。

## 適合拿來做什麼

- **用自己的瀏覽器，從裝置出去。** `telepy proxy box --browser` 會開一個經過裝置的 Chrome。它做得到遠端瀏覽器的事，但伺服器上不必跑瀏覽器，速度就是你自己電腦的速度。
- **吃代理設定的工具。** `curl`、套件管理工具、資料庫用戶端，凡是讀 `HTTPS_PROXY` 或會講 SOCKS5 的都行。
- **你串接的 app。** app 用 OAuth 登入，使用者選它能用哪些通道，之後它就經這些通道開連線。

眼前這台電腦什麼都不能裝的時候，還是用遠端瀏覽器；用腳本操作瀏覽器（`telepy browse`、MCP agent）也一樣，因為那需要一個 Telepy 能操控的瀏覽器。

## 開啟

管理員開啟之前它是關的：「網站設定 → 功能 → 裝置代理 → 允許裝置代理」。

開啟之後，下面每一項都成立的人才能用：

| 檢查 | 在哪裡設定 |
| --- | --- |
| 這個人的「裝置代理」功能是開的 | 使用者與權限 → 功能權限 |
| 他的 token 或 app 有 `proxy:use` | API 頁，或 app 的同意頁 |
| 通道在那把 token 或那個 app 的範圍內 | 建立 token 或同意 app 時選的 |
| 他看得到這條通道，也有能用的裝置帳號 | 通道的分享與帳號設定 |
| 通道沒有要求每次連線前先驗證 | 通道的設定（要二次驗證的通道一律拒絕） |

## 在自己的電腦上用

```sh
telepy login https://telepy.example.com --scope "tunnels:read ssh:exec ssh:files proxy:use"
telepy proxy                       # 你能代理的通道
telepy proxy box                   # 在 127.0.0.1:8118 開代理，同一個埠講 HTTP 與 SOCKS5
telepy proxy box --browser         # 同上，另外開一個套用它的 Chrome（獨立的設定檔）
curl -x http://127.0.0.1:8118 https://ifconfig.me     # 裝置的位址
```

`telepy proxy` 不需要 SSH 金鑰，也不需要管理員權限。它只走網頁的埠，所以打得開 Telepy 網頁的地方就能用。你的程式每開一條連線，就是一條到 Telepy 的 WebSocket。

`--browser` 會找 Chrome、Chromium、Edge 或 Brave，帶著代理設定與獨立的設定檔資料夾啟動，所以你平常用的瀏覽器和它的設定都不會被動到。用其他瀏覽器的話，自己把代理設成 `http://127.0.0.1:8118`。

跟其他連到裝置網路的方式比一比：

| | 需要 | 帶什麼 | 適合 |
| --- | --- | --- | --- |
| `telepy proxy` | 有 `proxy:use` 的 token | TCP，經代理設定 | 瀏覽器、curl、有代理選項的工具 |
| `telepy forward` / `ssh -L` | 你的 SSH 金鑰在裝置上 | 一個埠 | 固定用某個本機埠連一個服務 |
| `telepy vpn` | 你的 SSH 金鑰，加上這台電腦的管理員權限 | 每個位址，不用設代理 | 不能設代理的程式 |
| 遠端瀏覽器 | 你的電腦上什麼都不用 | 瀏覽器的畫面 | 不能裝東西的電腦 |

## 從 app 使用

### 取得 token

- **OAuth**（給別人串接的 app）：跟 MCP 用戶端用的是同一個授權伺服器，說明在 [MCP](./mcp.zh-TW.md)。要求 `proxy:use` 這個 scope。同意頁上使用者會選「全部通道」或「只選這幾條」，app 只列得出、也只用得到被選的那些。
- **個人 API token**（你自己的腳本）：API 頁 →「你的 token」→ 建一把有 `proxy:use` 的，可以只限某幾條通道。

### 列出通道

```sh
curl -H "Authorization: Bearer $TELEPY_TOKEN" https://telepy.example.com/api/proxy/tunnels
```

回應會列出這把 token 能代理的通道、每條通道上的裝置帳號、現在能不能用（`blocked` 是 `null`，或 `step_up` / `no_account` / `offline`），以及入口網址。

### 開一條連線

一條 WebSocket 就是一條 TCP 連線：

```
wss://telepy.example.com/ws/proxy/?tunnel=<id 或名稱>&host=<主機>&port=<埠>[&account=<裝置帳號>]
Authorization: Bearer <token>
```

Telepy 會在升級**之前**做完所有檢查，並讓裝置先連上目的地。所以失敗就是一般的 HTTP 回應加 `{error, code}`，拿到 `101` 就表示裝置已經連上了。之後二進位 frame 就是那條連線的位元組，任何一邊關閉就結束。

| 狀態 | `code` | 意思 |
| --- | --- | --- |
| 401 | `token_required`、`token_invalid` | 沒帶 token，或 token 無效、過期、已撤銷 |
| 403 | `proxy_disabled`、`token_scope`、`feature_disabled`、`step_up_refused`、`no_account` | 上面某一項檢查沒過 |
| 404 | `tunnel_not_found` | 這把 token 沒有這條通道 |
| 400 | `bad_request`、`bad_target`、`username` | 少了參數、主機不是單純的名稱或位址，或帳號不是你能用的 |
| 429 | `proxy_busy` | 同時的連線太多 |
| 502 | `device_offline`、`device_login_failed`、`resolve_failed`、`connect_failed` | 裝置不在線上，或它連不到目的地 |

API 頁的「代理」分頁會列出你這台伺服器的入口網址，範例也都填好了。

## 標準的代理位址

有些程式只收代理網址。管理員可以替它們多開一條路：一般的 HTTPS 代理。

```sh
curl -x "https://box:$TELEPY_TOKEN@proxy.example.com:8444" https://ifconfig.me
```

**帳號填通道**（名稱或 id；加上 `@帳號` 可以指定裝置帳號），**密碼填 token**。能自己設標頭的程式也可以改送 `Proxy-Authorization: Bearer <token>` 加上 `Telepy-Tunnel: <通道>`。沒帶帳密會回 `407`，所以瀏覽器會跳出輸入框。之後的事跟 WebSocket 那條路完全一樣：同一套檢查、同一個 session、同樣的紀錄。

要開啟它，在 `.env` 設定下面這些再重啟：

| 變數 | 作用 |
| --- | --- |
| `PROXY_PORT` | 代理入口對外的主機埠，例如 `8444`。留白 = 不開 |
| `PROXY_URL` | 大家填進代理設定的位址，例如 `https://proxy.example.com:8444`。也可以在「網站設定 → 伺服器 → 位址」設定 |
| `PROXY_TLS_CERT`、`PROXY_TLS_KEY` | 憑證鏈與它的金鑰（PEM，容器裡的路徑，例如放在 `/data` 底下）。兩個都給，入口就是 HTTPS 代理。不給就是明文 HTTP，前面一定要有東西做 TLS，因為 token 就在請求裡 |

代理位址要用一個能**直接**連到伺服器的名稱。CDN 和大多數網頁代理只轉網頁請求、不轉 `CONNECT`，這跟 SSH 常常要另一個名稱是同一個原因。「網站設定 → 伺服器 → 位址」會把網頁位址、SSH 主機與代理位址並排列出來。

沒有設定代理位址也不會少什麼：裝置代理照樣走網頁位址上的 WebSocket，`telepy proxy` 會在使用者自己的電腦上給程式一個一般的代理。

## Telepy 檢查什麼、記錄什麼

同一把 token（或同一個 app）經同一條通道、用同一個裝置帳號開的所有連線，算一個**代理 session**。

- session 開啟與關閉時，各在通道的紀錄寫一行。關閉那一行會寫連了幾條、送出與收到多少，以及連去了哪裡（前 20 個目的地）。
- 開著的 session 列在 API 頁的「代理」分頁，本人、通道擁有者或管理員都能結束它。結束會立刻切斷它的所有連線。
- Telepy 每 10 秒重新檢查一次。token 被撤銷、帳號被停用、分享被收回、裝置帳號被移除、功能或全站開關被關掉，任何一項都會切斷 session。
- Telepy 不會看連線的內容。HTTPS 連線從你的程式到網站之間一直是加密的。

## 限制

- 只有 TCP。沒有 UDP，也沒有 ping。
- 預設每把 token 經每條通道**同時最多 64 條連線**（網站設定 → 裝置代理），每把 token 同時最多經 8 條通道。
- 沒有連線的 session 過 60 秒就關閉，下一條連線會再開一個新的。
- 名稱由裝置去查。裝置是 Mac 的時候，Telepy 會先在裝置上把名稱查好，因為 Apple 的 sshd 一收到名稱就會把整條連線斷掉。

## 疑難排解

| 看到什麼 | 怎麼辦 |
| --- | --- |
| `proxy_disabled` | 請管理員在「網站設定 → 裝置代理」開啟 |
| `token_scope` | 用 `--scope "… proxy:use"` 重新登入，或建一把有它的 token |
| `step_up_refused` | 那條通道要求每次連線前先驗證，請改用網頁或 ssh |
| 每個目的地都是 `connect_failed` | 裝置的 sshd 可能不准轉送，在它的 `sshd_config` 設 `AllowTcpForwarding yes` |
| 網頁的文字出來了，圖片沒出來 | 這個網頁需要的連線數超過上限，到「網站設定 → 裝置代理」調高 |
| `telepy proxy` 說埠被占用 | 用 `--port` 換一個，或 `--port 0` 讓它自己挑 |
