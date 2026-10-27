# AI 工具存取（MCP）

> 讓 Claude Code、Claude Desktop / claude.ai、Cursor 等支援 MCP 的 AI 工具，用使用者自己的權限操作 Telepy：
> 看隧道狀態、開一個**會自己關掉**的 SSH session、跑指令、用互動 shell 操作 TUI、讀寫檔案、經裝置開遠端瀏覽器。
> 追蹤 issue：#93、#107。
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

沒有瀏覽器的 agent / CI 可以改用**個人 API token**（`tpt_…`，在網頁左側 **API** 頁建立）當 Bearer：
`{"mcpServers": {"telepy": {"url": "https://telepy.example.com/mcp", "headers": {"Authorization": "Bearer tpt_…"}}}}`。
token 在 `/mcp` 上的工具、scope、隧道限制跟 OAuth app 一樣（還要「MCP app」功能開著）；它的每個 tool call 除了 AI 稽核，
也記在 API 頁的「活動」（`MCP <tool>`，200 / tool 回錯誤時 400）。同一組動作也有 REST 版：`/api/ai/sessions*`（指令）與
`/api/browser/sessions*`（遠端瀏覽器，見下），`telepy exec` / `telepy browse` 就是用它們。

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
  | `ssh:exec` | `ssh_session_open`、`ssh_exec`、`shell_open` / `shell_send` / `shell_read` / `shell_resize` / `shell_close` |
  | `ssh:files` | `ssh_session_open`、`sftp_list` / `sftp_read` / `sftp_write` |
  | `network:scan` | `lan_scan`（掃描裝置背後的區網；只限擁有者或 ADMIN 的隧道） |
  | `browser:use` | `browser_open` / `browser_navigate` / `browser_read` / `browser_screenshot` / `browser_click` / `browser_type` / `browser_close`（經裝置上網的真瀏覽器；同意頁標「會改東西」） |

  使用者可以取消勾選任何一項，也可以把 app 限制在部分隧道。
- access token 是 `token_type: "mcp_access"` 的 JWT，REST API 不接受；網頁的 token 也不能打 `/mcp`。
  每個 `/mcp` 請求都會重新檢查 grant 與使用者，所以在 **MCP 頁** 或 **偏好設定 → 已連接的應用程式** 撤銷後立即失效，
  該 app 開著的 SSH session 也會馬上關閉。

## 工具

| 工具 | 說明 |
| --- | --- |
| `list_tunnels` | 看得到的隧道：id、名稱、是否在線、延遲、我的權限、可用的目標 username、這個 app 開著的 session |
| `tunnel_status(tunnel_id)` | 在線 / 健康狀態（online / degraded = 隧道在但裝置 sshd 沒回應 / offline）/ 延遲 / 24 小時在線率 / 裝置的基本狀況 `facts`（OS、kernel、開機秒數、CPU、記憶體 / 根磁碟 KB、負載、ssh 版本、要不要重開機；只給能登入裝置的人）與 `warnings` / 最近 10 筆 gateway 事件 |
| `ssh_session_open(tunnel_id, username?, idle_timeout_s?, max_lifetime_s?)` | 開 session，回 `session_id`；username 省略時用隧道的預設（只有一個時自動選） |
| `ssh_exec(session_id, command, timeout_s?, max_output_bytes?)` | 跑指令（無 TTY）：`exit_code`、`stdout`、`stderr`、`timed_out`、`truncated` |
| `ssh_session_list` | 這個 app 開著的 session 與剩餘時間 |
| `ssh_session_close(session_id)` | 關 session |
| `sftp_list(session_id, path?)` | 列目錄（`~` = 家目錄） |
| `sftp_read(session_id, path, offset?, max_bytes?)` | 讀檔；文字回 UTF-8，其餘回 base64；可分頁 |
| `sftp_write(session_id, path, content, encoding?, append?)` | 寫檔或附加（`encoding`: `utf-8` / `base64`） |
| `lan_hosts(tunnel_id)` | 裝置背後的區網主機（掃描找到的與手動加的）：位址、名稱、開著的 port、SSH banner、標籤、登入帳號 |
| `lan_scan(tunnel_id, username?, subnets?, ports?)` | 經裝置的 sshd 掃描區網（私有網段、最多 1024 個位址、約一分鐘）並存進主機清單；需要 `network:scan` 與擁有者 / ADMIN 權限 |
| `shell_open(session_id, cols?, rows?)` | 在 session 上開互動 shell（PTY，`xterm-256color`，預設 120×40），回 `shell_id`；每個 session 最多 2 個 |
| `shell_send(shell_id, input, press_enter?)` | 打字：原樣送出（可含控制字元，`\u0003` = Ctrl+C、`\u001b` = Esc）；`press_enter` 加一個 Enter。每次 64 KiB 以內 |
| `shell_read(shell_id, timeout_ms?, max_bytes?, screen?)` | 讀：`output` = 上次之後的原始輸出、`screen` = 現在的畫面（vt100 模型，一列一行的純文字）、`cursor`、`size`、`more`、`exited`；沒有新輸出時最多等 `timeout_ms`（預設 1.5 秒、上限 10 秒）。沒讀走的輸出最多留 256 KiB（超過丟最舊的，回 `dropped_bytes`） |
| `shell_resize(shell_id, cols, rows)` / `shell_close(shell_id)` | 改大小 / 關掉 |
| `browser_open(tunnel_id, username?, url?, idle_timeout_s?, max_lifetime_s?)` | 經裝置開一個遠端瀏覽器（Chromium，流量從裝置出去：看得到它的區網、localhost、公網 IP），回 `browser_id`；可順便開 `url` |
| `browser_navigate(browser_id, url)` | 前往網址（只收 http / https，沒寫就補 `https://`），等頁面載入，回最後的網址與標題 |
| `browser_read(browser_id, selector?)` | 頁面文字：標題、網址、看得到的文字（最多 10 萬字）、連結；`selector` 只讀一部分 |
| `browser_screenshot(browser_id)` | PNG 截圖（縮到最寬 1280 px），以 MCP image content block 回傳 |
| `browser_click(browser_id, selector? \| text?)` | 用 CSS selector 或看得到的文字（連結、按鈕、label）點一下（真的滑鼠事件） |
| `browser_type(browser_id, selector, text, press_enter?, sensitive?)` | 在欄位打字，可按 Enter 送出；`sensitive` 預設 true = 稽核只記長度 |
| `browser_close(browser_id)` | 關瀏覽器 |

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
- **互動 shell 也一樣**：`shell_send` 裡每個在 shell 提示字元按下的 Enter，用跟網頁終端機同一套讀畫面的方式（`TerminalGuard`）
  讀出那一行再比對。擋下 → 改送 Ctrl+C、tool 回錯誤；要核准 → 跟 `ssh_exec` 一樣最多等 45 秒，核准就送 Enter；還在等時那一行
  留在提示字元上，核准後 agent 送 `input: ""`、`press_enter: true` 就會跑（同樣 10 分鐘內用一次）。Enter 之後沒送出的輸入會被丟掉
  （tool 會說幾個 bytes）。全螢幕程式（vim、less）裡的 Enter 不檢查。

## 互動 shell

- 一個 shell = AI session 那條連線上的一條 PTY channel，跟 `ssh_exec` 共用每個 session 的 4 條 channel 配額，最多 2 個。
- 背景一直讀輸出（餵畫面模型、錄影），agent 沒在讀也不會卡住裝置。
- 關閉：`shell_close`、session 關掉（每一種原因）、或超過 session 的 `idle_timeout` 沒有 send / read（reaper 每 30 秒）。
  用 shell 也算 session 有在用，不會讓 session 閒置逾時。
- **錄影**：隧道開了「錄下網頁終端機」時，agent 的 shell 一樣錄成 asciicast（`kind: agent`，在錄影頁標「MCP agent」）。
- 即時 session 頁的 agent session 那一列顯示開著幾個 shell（`/api/sessions` 的 `shells`、`/api/ai/sessions` 的 `shells`）。

## 遠端瀏覽器（`browser:use`）

- 就是一般的 remote-browser session（`remote_browser/`：經裝置的 SOCKS、kasm-browser 裡的 Chromium，算進
  `remote_browser_max_sessions`），只是由 agent 經 session-manager 的 CDP 端點操作（見 `docs/remote-browser.md`「MCP agent 操作」）。
  backend 從不直接連 Chromium 的 DevTools。
- 跟 SSH session 共用每人上限 `ai_max_sessions_per_user`、同一組 idle / 壽命限制與 reaper（裝置離線、grant 撤銷、權限或 username
  被拿掉、remote-browser session 不見了都會關）；step-up 隧道拒絕。
- 出現在「誰在用」與即時 session 頁（kind `browser`、client = app 名稱），可以從那裡結束：之後的 tool 回「ended by <誰>」。
- 開 / 關寫 `browser_open` / `browser_close` gateway 事件（隧道的 Logs），通知沿用 `AI-SESSION-OPENED` / `AI-SESSION-CLOSED`
  （多 `kind: "browser"`，webhook `mcp.session_*` 的 data 也有 `kind`）。
- 稽核：網址、selector；`browser_type` 的文字預設只記長度（`sensitive: false` 才記內容）；截圖本身不存。
- **REST 版**（`api/browser.rs`，給腳本與 `telepy browse`）：`POST /api/browser/sessions {tunnel_id, username?, url?}` → `{id, …}`、
  `POST …/{id}/navigate {url}`、`GET …/{id}/text?selector=`、`GET …/{id}/screenshot`（image/png）、`POST …/{id}/click {selector | text}`、
  `POST …/{id}/type {selector, text, press_enter?, sensitive?}`、`DELETE …/{id}`、`GET /api/browser/sessions`。共用 `ai::browser`
  （`open_at` / `lookup` / `run_action`），所以上限、presence、即時 session、reaper、稽核跟 MCP 一樣；個人 API token / OAuth app 的
  token 要 `browser:use`，網頁登入也能打（client 名稱「Telepy web sign-in」）；一個瀏覽器只屬於開它的那把憑證；step-up 隧道回 403
  `step_up_refused`。

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
- 每位使用者同時最多 `ai_max_sessions_per_user` 個（預設 3，所有 app 合計，SSH session 與 agent 的瀏覽器一起算；0 = 不允許 AI 開 session）。
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
逾時 / 截斷 / scope / 上限 / 撤銷 / reaper / 分享通知、互動 shell（PTY echo shell：畫面、控制字元、錄影、指令規則），
以及以假的 session-manager 測 agent 瀏覽器）；`docker/kasm-browser/tests/test_cdp.py`（CDP 動作、WebSocket frame、/cdp 路由）。

網頁 **AI → MCP** 頁右上的「app 碰得到哪裡？」打開一張圖：MCP app ─ Telepy ─ 裝置 ─ 區網 / 網際網路，依選到的已連接 app
的權限亮起對應的分支（`lib/aiAccess.ts` `reachFor`）。
