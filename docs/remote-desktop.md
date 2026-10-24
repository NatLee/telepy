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

1. `POST /api/reverse/server/{id}/desktop/start` `{protocol, username, port?, lan_host_id?, login?, password?, domain?}`：
   檢查 `desktop_enabled`、隧道 VIEW、`username` 在 `permissions::allowed_usernames` 裡（裝置那一跳的帳號）、
   區網主機屬於這條隧道、`desktop_max_sessions`；接著**先**借池的連線並開 direct-tcpip 通道到目標，所以
   `device_offline` / `device_auth` / `target_unreachable` 在這一步就回 502，不必等 WebSocket。
   回 `{session_id, ws_path, ticket, expires_in, protocol, clipboard, target, username}`；帳密只留在記憶體。
   帶 `credential_id` 時改用憑證庫裡那筆的 login / password / domain（見下方「憑證庫」），請求裡的帳密欄位被忽略。
2. 瀏覽器用票證開 WS。後端重驗權限、開 rendezvous、連 guacd 握手（`hostname` / `port` = rendezvous），
   guacd 連回來的那條接到第 1 步的通道。握手完成後先送 `0.,<uuid>;`（guacamole-common-js 收到才把 tunnel 標成開啟），
   再把握手期間已讀進解析器的指令送出（guacd 常把 `ready` 和第一批畫面放在同一個封包）。
3. 中繼直到任一端結束。結束原因：使用者、guacd、閒置（`desktop_session_idle_timeout`）、`/desktop/{sid}/stop`、
   權限被收回（reaper 每 10 秒重驗）。

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
