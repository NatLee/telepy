<h1 align="center"><img src="./docs/brand/banner.png" alt="Telepy：從瀏覽器連到每一台裝置" width="100%"></h1>

[English](./README.md) | **繁體中文** | [日本語](./README.ja.md)

自架式的**反向 SSH 隧道**管理平台。裝置註冊一次，之後隨處可達：在即時儀表板監控隧道狀態、直接在瀏覽器開啟終端機、透過 SFTP 管理檔案、與團隊成員共享存取權，甚至能「透過」遠端裝置上網。

## 功能特色

- **隧道儀表板** — 即時顯示上線／離線狀態與逐段延遲（你 → Telepy → 裝置），支援列表與卡片兩種檢視。
- **引導式建立流程** — 五步驟精靈自動發放金鑰，並產生可直接執行的連線腳本：SSH、AutoSSH、systemd 服務、PowerShell、Docker Run 與 Docker Compose，另可產生單次有效的 `curl` 網址，方便在目標機器上取得腳本。
- **網頁終端機** — 基於 xterm.js 的多分頁終端機（WebSocket），支援各使用者獨立工作階段與即時延遲顯示。
- **檔案管理** — 終端機旁的 SFTP 檔案瀏覽器，可上傳、下載裝置上的檔案。
- **遠端代理瀏覽器** — 啟動真實的 Chromium 桌面（KasmVNC），流量經由目標裝置轉送，對外請求看起來就像來自那台機器。
- **分享與權限** — 以 VIEW / EDIT / ADMIN 階層式權限與其他使用者共享隧道。
- **指令速查** — 選一條隧道，就能拿到可直接貼上的 `ssh -L` / `-R` / `-D` / `-J` / `scp` 指令，在自己的電腦上轉發埠或複製檔案，每個情境都有即時流程圖畫出流量怎麼走；可搭配 `~/.ssh/config`，也能用不需設定的單行指令。
- **一行指令加入裝置** — 在 Linux 或 macOS 裝置上貼一行 `curl … | sudo sh`：自動建立通道金鑰、註冊裝置、授權 Telepy、釘住 Telepy 的主機金鑰、把通道裝成 systemd／launchd 服務，最後等 Telepy 透過通道登入成功。指令只能用一次、30 分鐘後失效，建立頁面會即時顯示每一步。
- **網路拓撲（跳板機）** — 一眼看出每台裝置背後有哪些機器：不用在裝置上安裝任何東西就能掃描它的區網（由裝置自己的 sshd 去連），幫主機加標籤、設定登入帳號，再經由裝置直接開網頁終端機連進去，或複製 `ssh -J` 一行指令與 `ProxyJump` 的 ssh config 片段。
- **金鑰與日誌** — 在介面中管理授權金鑰並檢視 SSH gateway 日誌，可看全部或只看某條隧道（使用者只看得到自己與被分享的隧道）。
- **身分驗證** — Google OAuth2 或帳號密碼登入，API 採 JWT。第一位登入的使用者自動成為超級管理員。可選用兩步驟驗證：passkey（也能免密碼登入）或驗證器 App（TOTP），並附一次性復原碼；管理員可以重設使用者的第二因素。
- **多語系與主題** — 英文、繁體中文、日本語；淺色與深色主題。

## 使用方式

### 建立隧道

前往 **Tunnels → Create Tunnel**，貼上裝置的 SSH 公鑰並依精靈指示操作。在裝置上執行產生的腳本後，隧道即會上線。

![建立隧道](./docs/gifs/create-tunnel.gif)

### 網頁終端機

在任一上線的隧道點擊 **Terminal**，即可直接在瀏覽器中取得裝置的 shell。

![網頁終端機](./docs/gifs/web-terminal.gif)

### 遠端代理瀏覽器

在上線的隧道點擊 **Browser**，即可啟動一個透過該裝置上網的 Chromium 工作階段（SSH SOCKS 代理 + KasmVNC 串流）。

![遠端代理瀏覽器](./docs/gifs/remote-browser.gif)

## 運作原理

裝置以反向 SSH 連線（`ssh -NR <port>:localhost:22 telepy@server`）連回 Telepy 後端，由內建的 SSH gateway 直接承接，每條隧道都會分配到一個專屬埠。網頁終端機、檔案管理與代理瀏覽器都經由該埠存取裝置——裝置端不需要設定防火牆入站規則，也不需要公共 IP。

Telepy 由 Docker Compose 編排的四個容器組成：

| 服務           | 角色                                                         |
| -------------- | ------------------------------------------------------------ |
| `traefik`      | 反向代理；將 `/api/*` 與 `/ws/*` 導向後端，其餘導向前端     |
| `frontend`     | Next.js 網頁介面                                             |
| `backend`      | Rust（axum）服務：REST API、WebSocket 終端機／檔案管理／中繼，以及承接反向隧道的內建 SSH gateway |
| `kasm-browser` | 供遠端瀏覽器工作階段使用的 KasmVNC + Chromium                |

## 快速開始

需要安裝含 Compose 外掛的 Docker。

1. 建立環境設定檔並視需要調整：

   ```bash
   cp .env.example .env
   ```

2. 產生 SSH 伺服器金鑰：

   ```bash
   ./telepy.sh keygen
   ```

3. 建置並啟動所有服務：

   ```bash
   docker compose up -d --build
   ```

4. 開啟 `http://localhost:<WEB_SERVER_PORT>/login`（預設為 `http://localhost:8787/login`）並登入。

> [!NOTE]
> **第一位**建立的使用者即為超級管理員——無論是透過 Google 登入或 `./telepy.sh create-superuser`（執行前可先修改 `dev-scripts/dev-create-superuser.sh` 內的預設帳號密碼）。

### 連接裝置

1. 前往 **Tunnels → Create Tunnel**，貼上裝置的 SSH 公鑰並完成精靈（至少加入一個裝置上實際存在的 OS 使用者名稱）。
2. 將畫面顯示的 service key 附加到裝置的 `~/.ssh/authorized_keys`。
3. 在裝置上執行產生的連線腳本（快速測試用 SSH；長期連線用 AutoSSH／systemd／Docker）。腳本之後隨時可從隧道列的 **Scripts** 功能取得。
4. 隧道顯示 **Online** 後，終端機、檔案管理與遠端瀏覽器即可使用。

## 環境設定

`.env` 中的環境變數：

| 變數                      | 預設值      | 說明                                 |
| ------------------------- | ----------- | ------------------------------------ |
| `PROJECT_NAME`            | `main`      | 容器名稱後綴                         |
| `DEBUG`                   | `false`     | 除錯等級日誌                         |
| `SECRET_KEY`              | —           | JWT 簽章金鑰（正式環境請設定）       |
| `WEB_SERVER_PORT`         | `8787`      | Traefik 對外提供網頁介面的埠         |
| `REVERSE_SERVER_SSH_PORT` | `24242`     | 裝置反向 SSH 連入的埠                |
| `SOCIAL_GOOGLE_CLIENT_ID` | —           | Google OAuth 用戶端 ID               |
| `SERVER_DOMAIN`           | `localhost` | Telepy 伺服器的公開主機名稱          |
| `PUBLIC_URL`              | —           | 對外的 base URL，例如 `https://telepy.example.com`（MCP 客戶端的 OAuth issuer 與 passkey 的 origin；留空則依請求推導）。passkey 需要網域名稱 + https（或 `localhost`） |
| `INTERNAL_API_TOKEN`      | —           | 內部服務間通訊用的密鑰               |
| `OPENAPI_ENABLED`         | `true`      | 提供 Swagger UI 與 OpenAPI 規格（見下）|

### AI 工具（MCP）

Telepy 本身就是 OAuth 2.1 授權伺服器，任何支援 MCP 的 AI 工具（Claude、Cursor…）都能指向
`https://<你的主機>/mcp`。第一次使用時瀏覽器會開啟核可頁面：確認應用程式的導回位址、選擇權限
（查看隧道／執行指令／讀寫檔案）與可用的隧道。核可過的應用程式列在 **偏好設定 → 已連接的應用程式**，
撤銷會立刻停止存取並關閉它的工作階段。AI 工具開啟的工作階段閒置時會自動關閉，上限是站台設定。側邊欄的
**AI 活動** 會列出開啟中的工作階段（可直接關閉）與 agent 做過的每一次工具呼叫；agent 連上被分享的隧道時，
擁有者會收到通知。細節見 [docs/mcp.md](./docs/mcp.md)。

Claude Code：`claude mcp add --transport http telepy https://<你的主機>/mcp`。工具：`list_tunnels`、
`tunnel_status`、`ssh_session_open` / `ssh_exec` / `ssh_session_list` / `ssh_session_close`、`sftp_list` /
`sftp_read` / `sftp_write`。每次工具呼叫都會留下稽核紀錄（`/api/ai/activity`），被分享的使用者用 AI 連上隧道時
擁有者會收到通知。詳見 [docs/mcp.md](docs/mcp.md)。

### API 文件

後端在 `/api/openapi.json` 提供 OpenAPI 3 文件，並在 `/api/__hidden_swagger` 提供 Swagger UI。
兩者都需要登入：頁面沿用你的網頁登入狀態（用已登入的瀏覽器開啟，否則會導去 `/login`），規格則需要
Bearer token（`POST /api/auth/token` 拿到的 `access_token`）。「Try it out」會自動帶上你的登入，
**Authorize** 可改用別的 token 測試。規格由實際路由產生（`utoipa`），永遠與伺服器一致；
`telepy-server openapi` 也能從 CLI 印出同一份文件。設定 `OPENAPI_ENABLED=false` 可同時關閉兩者。

## CLI 工具

`./telepy.sh` 封裝了日常維運腳本：

```
Usage: ./telepy.sh sub-command [args]
Sub-commands:
  keygen: Generate SSH host keys (gateway) and the backend service key.
  create-superuser: Create an admin account for Telepy management.
  shell: Open a shell in the backend container.
  migration: Reconcile the database schema (also runs automatically on start).
  backend-debug: Recreate the backend container and follow its logs.
  doctor: Check .env, containers, ports and the backend's configuration; exits 1 when something is broken.
```

## 延伸閱讀

- [遠端瀏覽器架構](./docs/remote-browser.md)
- [遠端桌面（RDP / VNC）架構](./docs/remote-desktop.md)
- [延遲量測深入解析](./docs/latency-deep-dive.md)
- [後端效能比較：Django vs Rust](./docs/benchmarks.md)
- [文章](./docs/articles/)

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

Telepy 採用 [GNU Affero General Public License v3.0](./LICENSE)（AGPL-3.0）。若你把修改過的 Telepy 架成服務給其他人使用，就必須提供原始碼給這些使用者。如果這不符合你的用途，可以取得商業授權，請聯絡 [@NatLee](https://github.com/NatLee)。

2026 年 10 月以前發布的版本採用 MIT 授權，詳見 [NOTICE](./NOTICE)。貢獻程式碼即表示同意[貢獻者授權協議（CLA）](./CONTRIBUTING.md#contributor-license-agreement)。
