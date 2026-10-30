<h1 align="center"><img src="./docs/brand/banner.png" alt="Telepy：從瀏覽器連到每一台裝置" width="100%"></h1>

<p align="center"><a href="./README.md">English</a> | <b>繁體中文</b> | <a href="./README.ja.md">日本語</a></p>

Telepy 是自架的網頁主控台，給那些你沒辦法直接連進去的機器用：NAT 後面的伺服器、家裡的 Raspberry Pi、防火牆後的
辦公室電腦、OpenWrt 路由器。每台裝置只要向你的 Telepy 伺服器撥出**一條反向 SSH 通道**，之後就能在瀏覽器裡操作它——終端機、檔案、
遠端桌面、經由裝置上網的瀏覽器，以及它所在區網裡的其他機器。裝置可以用細緻的權限分享給同事，所有操作也都能用
`telepy` 命令列、REST API 或 MCP 自動化。除了那條往外撥的 SSH 連線，裝置所在的網路不需要開任何連接埠、也不用安裝其他東西。

![通道頁：健康狀態、延遲、每台裝置怎麼連進來、公網與內網位址、作業系統、標籤、誰正在使用](./docs/screenshots/zh-TW/tunnels.png)

## 能做什麼

### 連接裝置

- **Linux、macOS 與 OpenWrt 一行指令。**在裝置上貼上一行 `curl … | sudo sh`：腳本會先看裝置有什麼（shell、HTTP
  工具、OpenSSH 或 Dropbear、systemd / launchd / procd），再建立通道金鑰、註冊裝置、授權 Telepy、釘選 Telepy 的
  主機金鑰、裝成服務，並等到 Telepy 真的透過通道登入成功；加 `--check` 可以只先跑檢查。其他系統（Windows、Docker、
  設備）則由五步驟精靈產生 SSH、AutoSSH、systemd、PowerShell、Docker run 與 Docker Compose 腳本。
- **走 SSH 埠；被擋時改走網頁埠。**裝置先試 gateway 的 SSH 埠，連不上時把 SSH 包在網頁埠的 WebSocket 裡。每條通道
  都標出它怎麼連進來（SSH 或 SSH over WSS），已經裝好的裝置也能改成自動，過程中通道不會斷。網頁的名稱若在只轉送
  網頁流量的代理後面，可以給 SSH 另一個名稱。
- **整理裝置上的安裝。**每條通道在裝置上的服務都有一個不透露資訊的安裝名稱；Telepy 會列出裝了什麼、裝在哪裡，
  並能把舊的安裝改名、移除多出來的副本，裝置都不用離線。
- **狀態一目了然。**上線／降級／離線／從未連線、每一段的延遲、上線率與連線紀錄、裝置的公網與內網位址（IP 變了會
  通知），以及每天讀一次的裝置資訊（作業系統、記憶體、磁碟、負載、待重開機）與警示。
- **管理上百台裝置。**精簡清單或卡片、標籤、釘選、個人群組，以及支援 `status:down`、`label:env=prod`、`os:openwrt`、
  `lastseen:>1d` 等條件的搜尋。

### 操作裝置

- **網頁終端機**：分頁、Nerd Font 字型、內建與自訂配色、連線中斷時 shell 可以保留（你允許的話）、操作錄影、
  可選擇不把指令留在裝置的 shell 歷史裡，以及可帶變數的常用指令**工具箱**。
- **檔案管理**（SFTP）：拖放上傳、移動／複製／重新命名／刪除／權限、打包成 zip 下載、圖片預覽，以及不會寫壞半個檔案的
  線上編輯器。
- **遠端桌面**：在瀏覽器裡經通道使用 RDP 與 VNC（guacd），或直接在分頁裡解碼 RustDesk；支援聲音、剪貼簿控制、
  檔案傳輸、多螢幕裁切，縮放與解析度也能跟著視窗走。
- **遠端瀏覽器**：真正的 Chromium（KasmVNC），流量從裝置出去，適合只在裝置所在網路才打得開的管理介面。
- **網路拓撲**：不用安裝任何東西就能掃描裝置所在的區網，看到廠牌與開著的連接埠，再透過裝置對區網主機開終端機或
  遠端桌面，或複製 `ssh -J`／`ProxyJump` 設定。
- **從自己的電腦連**：一行指令把所有裝置加進 `~/.ssh/config`（也會檢查每台裝置自己的主機金鑰）；指令速查頁提供現成的
  `ssh -L`／`-R`／`-D`／`-J`、`scp` 與 `rsync`；**SSH config 編輯器**會列出設定檔裡每台主機實際用到的值、修掉永遠不會
  生效的設定並把檔案簡化——每個改動都照 ssh 讀檔的方式驗證過（終端機裡用 `telepy config tidy` 也一樣）。

### 團隊與管控

- **分享**：VIEW／EDIT／ADMIN 權限、逐一指定可用的登入帳號、會到期的分享，以及申請暫時加權限。收回權限時，那個人
  正在用的連線會立刻結束。
- **功能權限與使用者群組**：決定誰可以用終端機、檔案、遠端桌面、區網掃描、API token、MCP app 等功能——可以對所有人、
  某個群組或某個人設定。
- **指令規則**：在網頁終端機與 MCP agent 上擋下指令、要求核准後才執行，或只顯示提醒——你可以替自己管理的裝置設
  個人規則，管理員設全站規則，並決定哪些全站規則可以讓人在自己的裝置上關掉。
- **即時連線**：看誰正連在哪台裝置，即時觀看終端機（也能交出鍵盤），或結束連線。
- **登入安全**：通行金鑰與驗證器 app、連敏感裝置前再確認一次身分、列出已登入的瀏覽器、新裝置登入通知，以及可選的
  低調登入頁。
- **通知**：頁面提示與桌面通知可以逐一事件設定，管理員訂全站預設、也能強制，還能把某台裝置靜音；個人或全站的
  webhook 送到 Slack、Discord、Google Chat、Teams、Telegram、ntfy 或自己的服務。
- **稽核**：防竄改日誌（雜湊鏈）、終端機錄影與登入紀錄。
- **伺服器狀態**：管理區直接在運作中的伺服器上跑它自己的檢查——設定、金鑰、搭配的服務、訪客位址怎麼傳進來、稽核鏈——
  旁邊是即時數據，已知的問題也能標記為已確認。

### 自動化

- **`telepy` 命令列**：`telepy ls`、`telepy ssh web-01`、`telepy exec --label env=prod -- uptime`、`telepy cp`，
  以及即時連線、錄影、指令片段、區網主機與腳本化瀏覽器；`ssh`／`scp`／`sftp` 走網頁埠，`telepy update` 讓 CLI
  保持最新。
- **REST API**：個人 API token（範圍、限定通道、到期日、呼叫紀錄）與自動產生的 OpenAPI 文件。
- **MCP 伺服器**，給 AI agent 使用（Claude Code、Cursor…）：每個 app 透過 OAuth 個別核准，每次工具呼叫都留紀錄，
  指令規則與權限一樣適用。

## 截圖

<table>
  <tr>
    <td width="50%"><img src="./docs/screenshots/zh-TW/terminal.png" alt="網頁終端機與檔案管理"><br><sub><b>網頁終端機 + 檔案管理</b>——分頁、SFTP 側欄與每一段的延遲。</sub></td>
    <td width="50%"><img src="./docs/screenshots/zh-TW/network.png" alt="網路拓撲"><br><sub><b>網路拓撲</b>——裝置後面的區網，透過裝置自己的 sshd 掃描，含廠牌與開著的連接埠。</sub></td>
  </tr>
  <tr>
    <td><img src="./docs/screenshots/zh-TW/desktop.png" alt="遠端桌面"><br><sub><b>遠端桌面</b>——經通道連上的 VNC 桌面，附串流數據與螢幕選擇。</sub></td>
    <td><img src="./docs/screenshots/zh-TW/browser.png" alt="遠端瀏覽器"><br><sub><b>遠端瀏覽器</b>——從裝置上網的 Chromium。</sub></td>
  </tr>
  <tr>
    <td><img src="./docs/screenshots/zh-TW/create.png" alt="一行指令加入裝置"><br><sub><b>新增裝置</b>——一行指令；頁面說明腳本做了什麼，並一路顯示到 Telepy 登入成功。</sub></td>
    <td><img src="./docs/screenshots/zh-TW/commands.png" alt="指令規則"><br><sub><b>指令規則</b>——個人與全站規則：擋下、核准、提醒或例外，測試器會告訴你誰需要核准。</sub></td>
  </tr>
  <tr>
    <td><img src="./docs/screenshots/zh-TW/sessions.png" alt="即時連線"><br><sub><b>即時連線</b>——誰從哪裡連進來；可觀看或結束。</sub></td>
    <td><img src="./docs/screenshots/zh-TW/access.png" alt="功能權限"><br><sub><b>功能權限</b>——對個人、使用者群組或所有人設定。</sub></td>
  </tr>
  <tr>
    <td><img src="./docs/screenshots/zh-TW/sshconfig.png" alt="SSH config 編輯器"><br><sub><b>SSH config 編輯器</b>——貼上 <code>~/.ssh/config</code>，看每台主機實際用到什麼並簡化，照 ssh 讀檔的方式驗證。</sub></td>
    <td><img src="./docs/screenshots/zh-TW/health.png" alt="伺服器狀態"><br><sub><b>伺服器狀態</b>——伺服器自己的檢查、即時數據與過去 24 小時。</sub></td>
  </tr>
  <tr>
    <td><img src="./docs/screenshots/zh-TW/api.png" alt="API token"><br><sub><b>API</b>——個人 token，含範圍、限定通道與每把 token 的呼叫摘要。</sub></td>
    <td><img src="./docs/screenshots/zh-TW/activity.png" alt="Agent 活動"><br><sub><b>Agent 活動</b>——每一次 MCP 工具呼叫，包含等待核准的指令。</sub></td>
  </tr>
</table>

## 運作原理

```
 你的瀏覽器 ──https──▶ Traefik ──▶ frontend（Next.js）
                         │
                         └──────▶ backend（Rust）◀══ 反向 SSH（由裝置往外撥）══ 裝置 ── 區網主機
                                    │   REST API · WebSocket · 內建 SSH gateway · 監控
                                    ├──▶ kasm-browser（遠端瀏覽用的 Chromium）
                                    └──▶ guacd（RDP / VNC）
```

裝置執行 `ssh -R 0:localhost:22 telepy@<伺服器>`——直接連 gateway 的 SSH 埠，只有 HTTPS 出得去時就包在網頁埠的
WebSocket 裡（一行指令與產生的腳本會把它裝成服務）。後端內建的 SSH gateway
接下這條連線、用金鑰認出是哪條通道，並把轉送記在記憶體裡——主機上不會綁定任何連接埠。Telepy 對裝置做的每件事
（終端機、檔案、桌面、遠端瀏覽器、區網掃描）都是在這條連線裡開一個通道，用該通道專屬的服務金鑰登入裝置自己的 sshd。
裝置不需要公網 IP，也不用開防火牆；Telepy 釘選每台裝置的主機金鑰，裝置也釘選 Telepy 的。

Telepy 由五個容器組成：

| 服務           | 角色                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------- |
| `traefik`      | 反向代理：`/api/*`、`/ws/*`（含裝置走網頁埠的 WebSocket）、`/mcp` 與 OAuth 探索交給後端，其餘交給前端 |
| `frontend`     | Next.js 網頁介面                                                                              |
| `backend`      | 單一 Rust 程序（axum + russh）：REST API、WebSocket、SSH gateway、監控、SQLite                 |
| `kasm-browser` | KasmVNC + Chromium，供遠端瀏覽器使用                                                           |
| `guacd`        | Apache Guacamole 的 RDP / VNC 引擎，供遠端桌面使用（只在內部網路）                              |

## 快速開始

需要 Docker 與 Compose 外掛。

1. 建立環境設定檔，至少設定 `SECRET_KEY`、`INTERNAL_API_TOKEN` 與 `SERVER_DOMAIN`（Telepy 在 HTTPS 代理後面時的
   對外網址，可以填 `PUBLIC_URL`，或之後在**網站設定 → 伺服器**設定）：

   ```bash
   cp .env.example .env
   ```

2. 產生 gateway 的主機金鑰與服務金鑰（重跑會保留已有的金鑰——裝置會釘選它們）：

   ```bash
   ./telepy.sh keygen
   ```

3. 建置並啟動，然後檢查：

   ```bash
   docker compose up -d --build
   ./telepy.sh doctor
   ```

4. 打開 `http://localhost:<WEB_SERVER_PORT>`（預設 `http://localhost:8787`）登入。

> [!NOTE]
> **第一個帳號**會成為管理員——不論是用 Google 登入，或用 `./telepy.sh create-superuser` 建立。

正式環境請在 Traefik 前面放一層 HTTPS 代理，設定對外網址，並讓裝置連得到 gateway 埠（`REVERSE_SERVER_SSH_PORT`）。
網頁的名稱若經過只轉送網頁流量的代理（Cloudflare 的橘色雲朵、CDN、HTTP 負載平衡器），請在**網站設定 → 伺服器 →
SSH 主機**給 SSH 一個直接指到伺服器的名稱——或讓裝置走網頁埠。訪客的位址（登入紀錄、即時連線）來自 X-Forwarded-For；
預設會自動跳過後端前面每一層內網的代理。管理區的**伺服器狀態**會檢查整套設定，並攤開你自己這個請求的位址是怎麼
算出來的。

### 連接裝置

- **Linux / macOS / OpenWrt**：**通道 → 建立通道 → 一行指令**，複製指令到裝置上執行。頁面會即時顯示每一步，Telepy
  透過通道登入成功後就會變綠。詳見 [docs/device-join.md](./docs/device-join.md)。
- **其他系統（Windows、Docker、設備）**：**逐步設定**——貼上裝置的公鑰、選擇登入帳號、授權 Telepy 的金鑰、執行產生的
  腳本，再驗證登入。

通道顯示**上線**後，卡片上的終端機、檔案、桌面與瀏覽器按鈕就能用了。

## 環境設定

這些值放在 `.env`，因為 stack 啟動前就要用到（完整說明見 [`.env.example`](./.env.example)）：

| 變數                      | 預設        | 說明                                                                     |
| ------------------------- | ----------- | ------------------------------------------------------------------------ |
| `PROJECT_NAME`            | `main`      | 容器與網路名稱的後綴（同一台主機上每個 stack 各用一個）                  |
| `DEBUG`                   | `false`     | 除錯日誌                                                                 |
| `WEB_SERVER_PORT`         | `8787`      | Traefik 對外的網頁、API 與 WebSocket 埠                                   |
| `REVERSE_SERVER_SSH_PORT` | `24242`     | 裝置撥反向 SSH 通道的埠                                                   |
| `SERVER_DOMAIN`           | `localhost` | 這台伺服器的主機名稱；會寫進腳本、SSH 設定與釘選的主機金鑰               |
| `SECRET_KEY`              | —           | 簽署登入並加密保存的機密；正式使用前請設一長串亂數                       |
| `INTERNAL_API_TOKEN`      | —           | 後端與 kasm-browser 容器之間的密鑰                                        |
| `GEOIP_DIR` / `OUI_DIR`   | `/data/geoip` / `/data/oui` | 後端讀離線 IP 地理資料庫與網卡廠牌表的位置（容器內路徑；`./telepy.sh geoip` / `oui` 會下載到這裡） |

下面這些是**選用**的：每一個在**網站設定 → 伺服器**都有對應的欄位，管理員可以直接在網頁上改，不用重啟。變數留空就
在網頁上管理；`.env` 裡有值時以它為準，網頁上那一格會鎖住。

| 變數                          | 網站設定                       | 留空時                                                  |
| ----------------------------- | ------------------------------ | ------------------------------------------------------- |
| `PUBLIC_URL`                  | 對外網址                       | 依請求推導（OAuth issuer、通行金鑰來源、一行指令網址）  |
| `SSH_SERVER_DOMAIN`           | SSH 主機                       | 跟 `SERVER_DOMAIN` 一樣；網頁名稱經過只轉送網頁的代理時才需要 |
| `SOCIAL_GOOGLE_CLIENT_ID`     | Google 用戶端 ID               | 沒有 Google 登入                                        |
| `TRUSTED_PROXY_HOPS`          | 信任的代理層數                 | `auto`：X-Forwarded-For 裡的內部位址都算代理            |
| `CLIENT_IP_HEADER`            | 訪客位址標頭                   | 不用（請求經過 Cloudflare 時會自動用它的標頭）          |
| `GATEWAY_PROXY_PROTOCOL_FROM` | SSH 閘道的 PROXY protocol 來源 | 關閉                                                    |
| `DEVICE_PROBE`                | 每日裝置檢查                   | 開：每天以唯讀方式登入裝置一次，讀位址與裝置資訊        |
| `KEEP_SHARED_SERVICE_KEY`     | 在裝置上保留共用服務金鑰       | 關閉                                                    |
| `LOG_LEVEL`                   | 日誌等級                       | `info`（`DEBUG=true` 時為 `debug`）                     |
| `OPENAPI_ENABLED`             | API 文件                       | 開（Swagger UI 與 OpenAPI 文件，需登入）                |

其他設定——註冊、登入有效期與兩步驟要求、遠端瀏覽器與桌面的上限、MCP session、webhook、通知、終端機與指令規則預設值——
也都是網站設定；使用者與功能權限在管理區的**使用者與權限**。

## 命令列、API 與 MCP

**`telepy` 命令列**——下載發行版（macOS、Linux、Windows；每個 Telepy 發行版都附上），或
`cargo install --locked --git https://github.com/NatLee/telepy telepy-cli`。網頁的 **CLI** 頁（側欄「開發者」→ CLI）
有給你這台電腦的安裝指令，以及用你自己的通道填好的範例：

```sh
telepy login https://telepy.example.com        # 瀏覽器登入，或用 API 頁的 --token tpt_…
telepy ls                                      # 通道與健康狀態、延遲、帳號、標籤
telepy ssh web-01                              # 用系統的 ssh 經通道連線，Telepy 主機金鑰已釘選
telepy exec --label env=prod -- uptime         # 一次跑多台；指令規則與稽核照樣適用
telepy cp ./app.conf web-01:/etc/app/
telepy config tidy                             # 簡化 ~/.ssh/config，照 ssh 讀檔的方式驗證
telepy api activity --follow                   # 即時看你的 API token 做了哪些呼叫
telepy update                                  # 換成最新發行版
```

CI 裡改設 `TELEPY_URL` 與 `TELEPY_TOKEN`，不用登入。詳見 [docs/cli.md](./docs/cli.md)。

**REST API**——在 **API** 頁建立個人 token；頁面列出 token 能呼叫的每個端點與 `curl` 範例。OpenAPI 文件在
`/api/openapi.json`，Swagger UI 在 `/api/__hidden_swagger`（都需要登入；`telepy-server openapi` 也能輸出文件）。

**MCP**——把 MCP 用戶端指向 `https://<你的主機>/mcp`，例如
`claude mcp add --transport http telepy https://<你的主機>/mcp`。第一次使用會開核准頁，讓你選權限與通道；**MCP** 頁
有各家用戶端的設定方式。詳見 [docs/mcp.md](./docs/mcp.md)。

## 維運

`./telepy.sh`（Windows 用 `telepy.ps1`）包裝了日常工作：

| 子指令             | 做什麼                                                       |
| ------------------ | ------------------------------------------------------------ |
| `keygen`           | 產生 gateway 主機金鑰與後端服務金鑰（已有的會保留）          |
| `create-superuser` | 建立管理員帳號                                               |
| `doctor`           | 檢查 `.env`、容器、連接埠與後端設定（有問題時回傳 1）        |
| `geoip`            | 下載離線 IP 地理資料庫（DB-IP Lite）；每月更新一次           |
| `oui`              | 下載 IEEE 廠牌清單，讓區網主機顯示網卡廠牌                   |
| `migration`        | 對齊資料庫結構（每次啟動也會自動做）                         |
| `shell`            | 進入後端容器的 shell                                         |
| `backend-debug`    | 重建後端容器並追蹤日誌                                       |

升級就是 `git pull && docker compose up -d --build`；資料庫結構在啟動時自動對齊。

## 文件

- [`telepy` 命令列與 API token](./docs/cli.md)
- [MCP：讓 AI agent 操作你的裝置](./docs/mcp.md)
- [Webhook：事件、格式與簽章](./docs/webhooks.md)
- [一行指令加入裝置（Linux、macOS、OpenWrt）](./docs/device-join.md)
- [遠端桌面（RDP / VNC / RustDesk）](./docs/remote-desktop.md)
- [遠端瀏覽器（KasmVNC）](./docs/remote-browser.md)
- [後端怎麼連到裝置](./docs/device-connections.md)
- [延遲量測深入解析](./docs/latency-deep-dive.md)
- [Rust 後端遷移規劃](./docs/rust-migration-plan.md) 與 [效能比較：Django vs Rust](./docs/benchmarks.md)
- [README 截圖怎麼做的](./docs/screenshots/README.md)
- [文章](./docs/articles/)
- 版本說明：[GitHub Releases](https://github.com/NatLee/telepy/releases)

## 貢獻者

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center"><a href="https://github.com/NatLee"><img src="https://avatars.githubusercontent.com/u/10178964?v=3?s=100" width="100px;" alt="Nat Lee"/><br /><sub><b>Nat Lee</b></sub></a></td>
      <td align="center"><a href="https://github.com/h-alice"><img src="https://avatars.githubusercontent.com/u/16372174?v=3?s=100" width="100px;" alt="H. Alice"/><br /><sub><b>H. Alice</b></sub></a></td>
      <td align="center"><a href="https://github.com/boris-lok"><img src="https://avatars.githubusercontent.com/u/77889460?v=3?s=100" width="100px;" alt="Boris Lok"/><br /><sub><b>Boris Lok</b></sub></a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

## 授權條款

Telepy 採用 [GNU Affero 通用公共授權條款 v3.0](./LICENSE)（AGPL-3.0）。如果你把修改過的 Telepy 架成服務給別人用，
就必須提供他們原始碼。若這不適合你的用途，也有商業授權——請聯絡 [@NatLee](https://github.com/NatLee)。

2026 年 10 月以前發行的版本採用 MIT 授權，見 [NOTICE](./NOTICE)。貢獻需同意
[貢獻者授權協議](./CONTRIBUTING.md#contributor-license-agreement)。
