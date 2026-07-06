# Telepy

[English](./README.md) | **繁體中文** | [日本語](./README.ja.md)

自架式的**反向 SSH 隧道**管理平台。裝置註冊一次，之後隨處可達：在即時儀表板監控隧道狀態、直接在瀏覽器開啟終端機、透過 SFTP 管理檔案、與團隊成員共享存取權，甚至能「透過」遠端裝置上網。

## 功能特色

- **隧道儀表板** — 即時顯示上線／離線狀態與逐段延遲（你 → Telepy → 裝置），支援列表與卡片兩種檢視。
- **引導式建立流程** — 五步驟精靈自動發放金鑰，並產生可直接執行的連線腳本：SSH、AutoSSH、systemd 服務、PowerShell、Docker Run 與 Docker Compose，另可產生單次有效的 `curl` 網址，方便在目標機器上取得腳本。
- **網頁終端機** — 基於 xterm.js 的多分頁終端機（WebSocket），支援各使用者獨立工作階段與即時延遲顯示。
- **檔案管理** — 終端機旁的 SFTP 檔案瀏覽器，可上傳、下載裝置上的檔案。
- **遠端代理瀏覽器** — 啟動真實的 Chromium 桌面（KasmVNC），流量經由目標裝置轉送，對外請求看起來就像來自那台機器。
- **分享與權限** — 以 VIEW / EDIT / ADMIN 階層式權限與其他使用者共享隧道。
- **金鑰與日誌** — 直接在介面上管理 authorized keys、檢視 SSH 伺服器日誌。
- **身分驗證** — Google OAuth2 或帳號密碼登入，API 採 JWT。第一位登入的使用者自動成為超級管理員。
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

裝置以反向 SSH 連線（`ssh -NR <port>:localhost:22 telepy@server`）連回 Telepy 的 SSH 容器，每條隧道都會分配到一個專屬埠。網頁終端機、檔案管理與代理瀏覽器都經由該埠存取裝置——裝置端不需要設定防火牆入站規則，也不需要公共 IP。

Telepy 由 Docker Compose 編排的六個容器組成：

| 服務           | 角色                                                         |
| -------------- | ------------------------------------------------------------ |
| `traefik`      | 反向代理；將 `/api/*` 與 `/ws/*` 導向後端，其餘導向前端     |
| `frontend`     | Next.js 網頁介面                                             |
| `backend`      | Django + DRF + Channels（REST API 與 WebSocket 終端機）      |
| `redis`        | 快取與 channel layer                                         |
| `ssh`          | 承接反向隧道的 OpenSSH 伺服器                                |
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
| `DEBUG`                   | `false`     | Django 除錯模式                      |
| `WEB_SERVER_PORT`         | `8787`      | Traefik 對外提供網頁介面的埠         |
| `REVERSE_SERVER_SSH_PORT` | `24242`     | 裝置反向 SSH 連入的埠                |
| `SOCIAL_GOOGLE_CLIENT_ID` | —           | Google OAuth 用戶端 ID               |
| `SERVER_DOMAIN`           | `localhost` | Telepy 伺服器的公開主機名稱          |
| `INTERNAL_API_TOKEN`      | —           | 內部服務間通訊用的密鑰               |

## CLI 工具

`./telepy.sh` 封裝了日常維運腳本：

```
Usage: ./telepy.sh sub-command [args]
Sub-commands:
  keygen: Generate SSH keys for Telepy service.
  create-superuser: Create an admin account for Telepy management.
  shell: Create a shell to run arbitrary command.
  ipython: Create a shell to run ipython.
  supervisorctl: Attach to supervisor control shell.
  ssh-shell: Similar to 'shell', but for ssh container.
  migration: Run migration process.
  backend-debug: Recreate and attach to backend container.
  collect-static: Collect static files to increase rendering speed.
  django-startapp: Create a new Django app.
```

## API 文件

請先登入，再造訪：

- Swagger UI — `http://localhost:<WEB_SERVER_PORT>/api/__hidden_swagger`
- ReDoc — `http://localhost:<WEB_SERVER_PORT>/api/__hidden_redoc`
- Django admin — `http://localhost:<WEB_SERVER_PORT>/api/__hidden_admin/`

## 延伸閱讀

- [遠端瀏覽器架構](./docs/remote-browser.md)
- [延遲量測深入解析](./docs/latency-deep-dive.md)
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

[MIT](./LICENSE)
