# AI 工具存取（MCP）

> 讓 Claude Code、Claude Desktop / claude.ai、Cursor 等支援 MCP 的 AI 工具，用使用者自己的權限操作 Telepy：
> 看隧道狀態、開一個**會自己關掉**的 SSH session、跑指令、讀寫檔案。追蹤 issue：#93。
> 後端程式：`oauth/`、`api/oauth.rs`、`db/oauth.rs`、`auth/mcp.rs`（OAuth 2.1）；`mcp/`（MCP server）；
> `ai/`（SSH session 與 reaper）；`api/ai.rs`、`db/ai_audit.rs`（session 列表與稽核）。

## 連線方式

MCP 端點是 `https://<你的主機>/mcp`（Streamable HTTP）。正式環境請在 `.env` 設定 `PUBLIC_URL`
（例如 `https://telepy.example.com`），OAuth 的 issuer 與 MCP resource 都由它決定；沒設時依請求的
`X-Forwarded-Proto` / `X-Forwarded-Host` / `Host` 推導。

| 客戶端 | 設定 |
| --- | --- |
| Claude Code | `claude mcp add --transport http telepy https://telepy.example.com/mcp`，之後在對話裡 `/mcp` 完成授權 |
| Claude Desktop / claude.ai | Settings → Connectors → Add custom connector，URL 填 `https://telepy.example.com/mcp` |
| Cursor 等 | `mcp.json`：`{"mcpServers": {"telepy": {"url": "https://telepy.example.com/mcp"}}}` |

不需要手動產生 token：第一次呼叫時客戶端拿到 401，自動走完下面的 OAuth 流程。

網頁左側 **AI → MCP**（`/tunnels/mcp`）顯示實際要填的端點網址（取自 discovery 的 `resource`，所以會反映
`PUBLIC_URL`）、上表三種客戶端可直接複製的設定、各權限對應的工具、session 何時關閉，以及已連接的應用程式。

## 授權流程（OAuth 2.1）

```
MCP client ── POST /mcp ──────────────────────────────▶ 401 + WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"
           ── GET /.well-known/oauth-protected-resource/mcp   （RFC 9728：authorization_servers）
           ── GET /.well-known/oauth-authorization-server     （RFC 8414：endpoints、S256）
           ── POST /api/oauth/register                        （RFC 7591 動態註冊，公開）
           ── 開瀏覽器 → /oauth/authorize（前端同意頁；沒登入先到 /oauth/login，畫面與一般登入頁不同，
                 登入前就用公開的 GET /api/oauth/authorize/preview 顯示 app、導回位址與權限，可直接取消）
                 使用者用網頁登入狀態核可：確認 app 名稱與導回位址、目前帳號（不是你？換帳號）、勾選權限、限制可用隧道；
                 同一個 app 先前的連線可勾「取代」，客戶端換到新 token 時舊的就撤銷
                 前端 POST /api/oauth/authorize → {redirect_to: <redirect_uri>?code=…&state=…&iss=…}
           ── POST /api/oauth/token  (authorization_code + PKCE S256) → access token（1 小時）+ refresh token（30 天、每次換發都輪替）
           ── POST /mcp  Authorization: Bearer <access token>
```

- 同意頁的權限（scope）：

  | scope | 允許 |
  | --- | --- |
  | `tunnels:read` | `list_tunnels`、`tunnel_status` |
  | `ssh:exec` | `ssh_session_open`、`ssh_exec` |
  | `ssh:files` | `ssh_session_open`、`sftp_list` / `sftp_read` / `sftp_write` |
  | `network:scan` | `lan_scan`（掃描裝置背後的區網；只限擁有者或 ADMIN 的隧道） |

  使用者可以取消勾選任何一項，也可以把 app 限制在部分隧道。
- access token 是 `token_type: "mcp_access"` 的 JWT，REST API 不接受；網頁的 token 也不能打 `/mcp`。
  每個 `/mcp` 請求都會重新檢查 grant 與使用者，所以在 **MCP 頁** 或 **偏好設定 → 已連接的應用程式** 撤銷後立即失效，
  該 app 開著的 SSH session 也會馬上關閉。

## 工具

| 工具 | 說明 |
| --- | --- |
| `list_tunnels` | 看得到的隧道：id、名稱、是否在線、延遲、我的權限、可用的目標 username、這個 app 開著的 session |
| `tunnel_status(tunnel_id)` | 在線 / 健康狀態（online / degraded = 隧道在但裝置 sshd 沒回應 / offline）/ 延遲 / 最近 10 筆 gateway 事件 |
| `ssh_session_open(tunnel_id, username?, idle_timeout_s?, max_lifetime_s?)` | 開 session，回 `session_id`；username 省略時用隧道的預設（只有一個時自動選） |
| `ssh_exec(session_id, command, timeout_s?, max_output_bytes?)` | 跑指令（無 TTY）：`exit_code`、`stdout`、`stderr`、`timed_out`、`truncated` |
| `ssh_session_list` | 這個 app 開著的 session 與剩餘時間 |
| `ssh_session_close(session_id)` | 關 session |
| `sftp_list(session_id, path?)` | 列目錄（`~` = 家目錄） |
| `sftp_read(session_id, path, offset?, max_bytes?)` | 讀檔；文字回 UTF-8，其餘回 base64；可分頁 |
| `sftp_write(session_id, path, content, encoding?, append?)` | 寫檔或附加（`encoding`: `utf-8` / `base64`） |
| `lan_hosts(tunnel_id)` | 裝置背後的區網主機（掃描找到的與手動加的）：位址、名稱、開著的 port、SSH banner、標籤、登入帳號 |
| `lan_scan(tunnel_id, username?, subnets?, ports?)` | 經裝置的 sshd 掃描區網（私有網段、最多 1024 個位址、約一分鐘）並存進主機清單；需要 `network:scan` 與擁有者 / ADMIN 權限 |

權限完全照網頁規則：要有該隧道的 VIEW 權限，而且目標 username 必須在允許清單內（被分享的隧道只能用分享時允許的
username，與 web terminal 相同）。

### 指令規則（`ssh_exec`）

管理員的全站規則與隧道擁有者 / ADMIN 設的隧道規則（網頁的「指令規則」頁，`/tunnels/commands`）也管 agent 的指令：

- **擋下**：不執行，tool 回錯誤（`isError`），內容寫出是哪條規則與規則的說明。
- **需要核准**：Telepy 送出核准申請（隧道擁有者與 ADMIN 會在網頁右下角看到，也可在指令規則頁處理），這次 tool call
  最多等 45 秒；核准就照常執行並回結果，拒絕或逾時回錯誤。還沒有人決定時回錯誤「還在等」——請 agent 告訴使用者，
  核准後**用一模一樣的指令**再呼叫一次；核准在 10 分鐘內可用一次（同一個 app、隧道、帳號與指令）。
- agent 用隧道擁有者的身分跑時，一樣要擁有者按核准（human in the loop）；規則可以只管 MCP agent（`via: agents`）。
- 被擋下 / 等待 / 拒絕都會在 AI 稽核裡記成失敗的 `ssh_exec`，申請與結果也列在指令規則頁的「紀錄」。

## Session 生命週期

一個 session = 一條到裝置的 russh 連線，所有指令共用（不會每個指令重新握手）。指令各自開一個 exec channel，
同一個 session 最多同時 4 個。

| 何時關閉 | 原因（通知與稽核裡的 `reason`） |
| --- | --- |
| agent 呼叫 `ssh_session_close` | `closed_by_agent` |
| 使用者 / 隧道擁有者 / 管理員在網頁關掉（`DELETE /api/ai/sessions/{id}`） | `closed_by_user` |
| 閒置超過 `ai_session_idle_timeout`（預設 600 秒；執行中的指令不算閒置） | `idle` |
| 存活超過 `ai_session_max_lifetime`（預設 7200 秒；一律關閉） | `max_lifetime` |
| 裝置離線、連線中斷 | `device_offline` / `disconnected` |
| grant 撤銷或過期、使用者停用 | `revoked` |
| 隧道被刪、權限被拿掉、username 被移除 | `permission_removed` |

- reaper 每 30 秒檢查一次；撤銷 grant 時立即關閉。
- agent 可以要求更短的 `idle_timeout_s` / `max_lifetime_s`，但不能超過站台設定（最短 10 秒）。
- 每位使用者同時最多 `ai_max_sessions_per_user` 個（預設 3，所有 app 合計；0 = 不允許 AI 開 session）。
- 指令逾時預設 60 秒、最多 600 秒，逾時送 `KILL` 並關 channel；每個輸出串流預設保留 64 KiB、最多 1 MiB，
  超過時保留開頭 1/4 與結尾 3/4。
- MCP 2026-07-28 版沒有 transport session，所以 SSH session 綁的是 OAuth grant（哪個 app），不是 MCP 連線；
  不同 app 互相看不到彼此的 session。

三個上限都在管理員的 **網站設定 → AI 存取（MCP）** 分頁（`/tunnels/settings?tab=ai`，同頁也顯示 MCP 端點網址），變更後對新開的 session 生效。

## 通知與稽核

- 開 / 關 session 時，`/ws/notifications` 會送 `AI-SESSION-OPENED` / `AI-SESSION-CLOSED`
  （`details`、`tunnel_id`、`session_id`、`by`、`client`，關閉時另有 `reason`）給 session 的使用者與隧道擁有者 ——
  被分享的使用者用 AI 連上別人的隧道時，擁有者會知道。
- 每一次 tool call 寫一列 `telepy_ai_audit_event`（最多保留 10 萬列）：誰、哪個 app、哪個隧道與 username、
  指令或路徑（最多 2000 字元）、exit code、耗時、輸出 bytes、錯誤。`GET /api/ai/activity`：管理員看全部，
  其他人看自己的與自己擁有的隧道上的。**指令原文會被記錄**，請勿讓 agent 在指令列帶密碼。
- `GET /api/ai/sessions`：自己的 session 與自己隧道上的 session（管理員：全部）。

## 手動驗證

```bash
# 401 + discovery 指向 metadata
curl -si -X POST https://telepy.example.com/mcp -H 'content-type: application/json' -d '{}' | grep -i www-authenticate
curl -s https://telepy.example.com/.well-known/oauth-protected-resource/mcp
curl -s https://telepy.example.com/.well-known/oauth-authorization-server
```

自動化測試：`tests/oauth_api.rs`（OAuth 流程）、`tests/mcp_api.rs`（以假的裝置 sshd 端到端測 exec / SFTP /
逾時 / 截斷 / scope / 上限 / 撤銷 / reaper / 分享通知）。
