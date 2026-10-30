# AI 工具存取（MCP）

<p align="center"><a href="./mcp.md">English</a> | <b>繁體中文</b> | <a href="./mcp.ja.md">日本語</a></p>

> 讓 Claude Code、Claude Desktop / claude.ai、Cursor 等支援 MCP 的 AI 工具，用使用者自己的權限操作 Telepy：
> 看通道狀態、開一個**會自己關掉**的 SSH session、跑指令、用互動 shell 操作 TUI、讀寫檔案、經裝置開遠端瀏覽器。
> 追蹤 issue：#93、#107。
> 後端程式：`oauth/`、`api/oauth.rs`、`db/oauth.rs`、`auth/mcp.rs`（OAuth 2.1 與個人 API token）；`mcp/`（MCP server）；
> `ai/`（SSH session 與 reaper；`ai/shell.rs` 互動 shell、`ai/browser.rs` agent 的瀏覽器）；`api/ai.rs`、`api/browser.rs`、
> `db/ai_audit.rs`（session 列表、REST 版與稽核）。

## 連線方式

![MCP app 依權限範圍能碰到哪些東西](images/zh-TW/agent-reach.png)

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
token 在 `/mcp` 上的工具、scope、通道限制跟 OAuth app 一樣（這個人的「API token」與「MCP app」兩個功能都要開著）；
它的 session 與 shell、瀏覽器都只屬於這把 token，稽核的 app 名稱是 `API token "<名稱>"`。它的每個 tool call 除了 AI 稽核，
也記在 API 頁的「活動」（`MCP <tool>`，200 / tool 回錯誤時 400）。撤銷 token 時它開著的 session 立刻關閉。同一組動作也有
REST 版：`/api/ai/sessions*`（指令）與 `/api/browser/sessions*`（遠端瀏覽器，見下），`telepy exec` / `telepy browse` 就是用它們
（見 [cli.md](cli.md)）。

網頁左側 **AI → MCP**（`/tunnels/mcp`）顯示實際要填的端點網址（取自 discovery 的 `resource`，所以會反映
`PUBLIC_URL`）、上表三種客戶端可直接複製的設定、各權限對應的工具、session 何時關閉，以及已連接的 MCP 應用程式。
右上的「app 碰得到哪裡？」打開一張圖：MCP app ─ Telepy ─ 裝置 ─ 區網 / 網際網路，依選到的已連接 app 的權限亮起對應的
分支（`lib/aiAccess.ts` `reachFor`）。

## 授權流程（OAuth 2.1）

```
MCP client ── POST /mcp ──────────────────────────────▶ 401 + WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"
           ── GET /.well-known/oauth-protected-resource/mcp   （RFC 9728：authorization_servers）
           ── GET /.well-known/oauth-authorization-server     （RFC 8414：endpoints、S256）
           ── POST /api/oauth/register                        （RFC 7591 動態註冊，公開）
           ── 開瀏覽器 → /oauth/authorize（前端同意頁；沒登入先到 /oauth/login，畫面與一般登入頁不同，
                 登入前就用公開的 GET /api/oauth/authorize/preview 顯示 app、導回位址與權限，可直接取消）
                 使用者用網頁登入狀態核可：確認 app 名稱與導回位址、目前帳號（不是你？換帳號）、勾選權限、限制可用通道；
                 同一個 app 先前的連線可勾「取代」，客戶端換到新 token 時舊的就撤銷
                 前端 POST /api/oauth/authorize → {redirect_to: <redirect_uri>?code=…&state=…&iss=…}
           ── POST /api/oauth/token  (authorization_code + PKCE S256) → access token（1 小時）+ refresh token（30 天、每次換發都輪替）
           ── POST /mcp  Authorization: Bearer <access token>
```

- 同意頁的權限（scope）：

  | scope | 允許 |
  | --- | --- |
  | `tunnels:read` | `list_tunnels`、`tunnel_status`、`lan_hosts` |
  | `ssh:exec` | `ssh_session_open`、`ssh_exec`、`shell_open` / `shell_send` / `shell_read` / `shell_resize` / `shell_close` |
  | `ssh:files` | `ssh_session_open`、`sftp_list` / `sftp_read` / `sftp_write` |
  | `network:scan` | `lan_scan`（掃描裝置背後的區網；只限擁有者或 ADMIN 的通道） |
  | `browser:use` | `browser_open` / `browser_navigate` / `browser_read` / `browser_screenshot` / `browser_click` / `browser_type` / `browser_close`（經裝置上網的真瀏覽器；同意頁標「會改東西」） |

  使用者可以取消勾選任何一項，也可以把 app 限制在部分通道。
- access token 是 `token_type: "mcp_access"` 的 JWT，網頁的 token 不能打 `/mcp`。REST API 只在 token 白名單
  （`auth::api_tokens::ROUTES`，見 [cli.md](cli.md)）內接受它，`telepy` 命令列的瀏覽器登入就是這樣用的。
- 每個 `/mcp` 請求都會重新檢查 grant 與使用者，所以在 **MCP 頁**、**偏好設定 → MCP 應用程式**、或 AI 活動頁的
  「你的 MCP 應用程式」撤銷後立即失效，該 app 開著的 SSH session、shell 與瀏覽器也會馬上關閉（管理員可以在「管理使用者」對話框
  撤銷任何人的）。
- 帳號被停用時，grant 與個人 API token **暫停而不撤銷**：`/mcp` 立刻拒絕、開著的 session 關閉，重新啟用後照常可用。
  管理員替這個人關掉「MCP app」功能時，app 全部拿到 401（像被撤銷）、開著的 agent session 也會結束；功能打開就恢復。
- **`telepy login` 不算 MCP 應用程式。** 命令列的瀏覽器登入也走這套 OAuth（同意頁會說是 CLI 在要求），每次登入註冊成
  `telepy CLI (<電腦名稱>)`。這些 grant 列在 API 頁的「CLI 登入」分頁（`/tunnels/api?tab=cli`），MCP 頁、偏好設定與
  AI 活動頁的 MCP 應用程式清單都不列。同一台電腦再登入一次會提議取代先前那個；每人最多保留 10 個 CLI 登入，第 11 個會
  登出最久沒用的。CLI 登入一樣跟著「MCP app」功能開關（見 [cli.md](cli.md)）。名稱是客戶端自己報的，只用來分類顯示。

## 工具

| 工具 | 說明 |
| --- | --- |
| `list_tunnels` | 看得到的通道：id、名稱、是否在線、延遲、我的權限、可用的目標 username、這個 app 開著的 session |
| `tunnel_status(tunnel_id)` | 在線 / 健康狀態（online / degraded = 通道在但裝置 sshd 沒回應 / offline）/ 延遲 / 24 小時在線率 / 裝置的基本狀況 `facts`（OS、kernel、開機秒數、CPU、記憶體 / 根磁碟 KB、負載、ssh 版本、要不要重開機；只給能登入裝置的人）與 `warnings` / 最近 10 筆 gateway 事件 |
| `ssh_session_open(tunnel_id, username?, idle_timeout_s?, max_lifetime_s?)` | 開 session，回 `session_id`；username 省略時用通道的預設（只有一個時自動選） |
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

權限完全照網頁規則：要有該通道的 VIEW 權限，而且目標 username 必須在允許清單內（被分享的通道只能用分享時允許的
username，與 web terminal 相同）。另外：

- **功能權限**（管理 → 使用者與權限 → 功能權限，`/tunnels/admin/access`）一樣適用：管理員替這個人關掉的功能，對應的工具回錯誤（`isError`）說明——
  `ssh:exec` 的工具要「網頁終端機」、`ssh:files` 要「檔案管理」、`lan_hosts` 與 `lan_scan` 要「區網探索」、`browser:use`
  要「遠端瀏覽器」。scope 本身沒給時，錯誤會告訴 agent 請使用者重新連接並核准那個 scope。
- **需要 step-up 的通道**（每次 session 前都要使用者用第二道驗證確認）拒絕 agent 開 SSH session、瀏覽器與 `lan_scan`；
  `list_tunnels` 的 `requires_step_up` 先告訴 agent。

### 指令規則（`ssh_exec`）

![指令怎麼判定：拆解、全站規則、個人規則、結果](images/zh-TW/command-decision.png)

網頁「指令規則」頁（`/tunnels/commands`）上的規則也管 agent 的指令。規則有兩種：

- **個人規則**：每個人自己寫。對象選「所有人」或「只限被分享的人」時，只在作者**目前**是 owner 或 ADMIN 的通道上生效；
  選「只有我」就只管作者自己的指令，在他用的任何通道上都算——例如替自己在別人通道上跑的 MCP agent 加一道防護。
  「只有我」的規則別人看不到。
- **全站規則**：管理員寫（管理區「規則與通知 → 指令規則」）。預設可以覆寫：通道的 owner / ADMIN 可以在自己管的通道上關掉它；
  管理員關掉「允許使用者覆寫」就是強制，誰都關不掉。

規則可以只管 MCP agent（`via: agents`）。一條指令符合好幾條規則時，擋下 > 需要核准 > 提醒。各動作對 agent 的效果：

- **擋下**：不執行，tool 回錯誤（`isError`），內容寫出是哪條規則與規則的說明。
- **需要核准**：Telepy 送出核准申請（核准人——規則指定的人；沒指定就是通道擁有者與 ADMIN；「只有我」的規則是作者自己——
  會在網頁右下角看到，也可在指令規則頁處理），這次 tool call
  最多等 45 秒；核准就照常執行並回結果，拒絕或逾時回錯誤。還沒有人決定時回錯誤「還在等」——請 agent 告訴使用者，
  核准後**用一模一樣的指令**再呼叫一次；核准在 10 分鐘內可用一次（同一個 app、通道、帳號與指令）。
- **提醒**：照常執行，`ssh_exec` 的結果多一個 `reminder`（規則的說明，沒寫說明就是比對式），請 agent 轉告使用者；
  REST 版 `POST /api/ai/sessions/{id}/exec` 也一樣。不等人，也不進指令規則頁的「紀錄」。不是強制的提醒，每個人可以替自己靜音。
- **允許（例外）**：讓符合的指令不受**同一個作者**的擋下 / 需要核准規則管（全站的例外豁免全站規則，個人的例外豁免同一個人的規則；
  另外，通道 owner / ADMIN 的例外在他管的通道上也豁免可覆寫的全站規則，強制的不行）。別人的例外蓋不掉你的規則。
- agent 用通道擁有者的身分跑時，一樣要擁有者按核准（human in the loop）。
- 被擋下 / 等待 / 拒絕都會在 AI 稽核裡記成失敗的 `ssh_exec`，申請與結果也列在指令規則頁的「紀錄」。
- **互動 shell 也一樣**：`shell_send` 裡每個在 shell 提示字元按下的 Enter，用跟網頁終端機同一套讀畫面的方式（`TerminalGuard`）
  讀出那一行再比對。擋下 → 改送 Ctrl+C、tool 回錯誤；要核准 → 跟 `ssh_exec` 一樣最多等 45 秒，核准就送 Enter；還在等時那一行
  留在提示字元上，核准後 agent 送 `input: ""`、`press_enter: true` 就會跑（同樣 10 分鐘內用一次）。Enter 之後沒送出的輸入會被丟掉
  （tool 會說幾個 bytes）。符合提醒規則的行照送，`shell_send` 的結果帶 `reminders`（每條一句）。全螢幕程式（vim、less）裡的 Enter 不檢查。

## 互動 shell

- 一個 shell = AI session 那條連線上的一條 PTY channel，跟 `ssh_exec` 共用每個 session 的 4 條 channel 配額，最多 2 個。
- 背景一直讀輸出（餵畫面模型、錄影），agent 沒在讀也不會卡住裝置。
- 關閉：`shell_close`、session 關掉（每一種原因）、或超過 session 的 `idle_timeout` 沒有 send / read（reaper 每 30 秒）。
  用 shell 也算 session 有在用，不會讓 session 閒置逾時。
- **錄影**：通道開了「錄下網頁終端機」時，agent 的 shell 一樣錄成 asciicast（`kind: agent`，在錄影頁標「MCP agent」）。
- 即時 session 頁的 agent session 那一列顯示開著幾個 shell（`/api/sessions` 的 `shells`、`/api/ai/sessions` 的 `shells`）。

## 遠端瀏覽器（`browser:use`）

- 就是一般的 remote-browser session（`remote_browser/`：經裝置的 SOCKS、kasm-browser 裡的 Chromium，算進
  `remote_browser_max_sessions`），只是由 agent 經 session-manager 的 CDP 端點操作（見 [remote-browser.md](remote-browser.md)「MCP agent 與腳本操作」）。
  backend 從不直接連 Chromium 的 DevTools。
- 跟 SSH session 共用每人上限 `ai_max_sessions_per_user`、同一組 idle / 壽命限制與 reaper（裝置離線、grant 撤銷、權限或 username
  被拿掉、remote-browser session 不見了都會關）；step-up 通道拒絕。
- 出現在「誰在用」與即時 session 頁（kind `browser`、client = app 名稱），可以從那裡結束：之後的 tool 回「ended by <誰>」。
- 開 / 關寫 `browser_open` / `browser_close` gateway 事件（通道的 Logs），通知沿用 `AI-SESSION-OPENED` / `AI-SESSION-CLOSED`
  （多 `kind: "browser"`，webhook `mcp.session_*` 的 data 也有 `kind`）。
- 稽核：網址、selector；`browser_type` 的文字預設只記長度（`sensitive: false` 才記內容）；截圖本身不存。
- **REST 版**（`api/browser.rs`，給腳本與 `telepy browse`）：`POST /api/browser/sessions {tunnel_id, username?, url?}` → `{id, …}`、
  `POST …/{id}/navigate {url}`、`GET …/{id}/text?selector=`、`GET …/{id}/screenshot`（image/png）、`POST …/{id}/click {selector | text}`、
  `POST …/{id}/type {selector, text, press_enter?, sensitive?}`、`DELETE …/{id}`、`GET /api/browser/sessions`。共用 `ai::browser`
  （`open_at` / `lookup` / `run_action`），所以上限、presence、即時 session、reaper、稽核跟 MCP 一樣；個人 API token / OAuth app 的
  token 要 `browser:use`，網頁登入也能打（client 名稱「Telepy web sign-in」）；一個瀏覽器只屬於開它的那把憑證；step-up 通道回 403
  `step_up_refused`。

## Session 生命週期

一個 session = 一條到裝置的 russh 連線，所有指令共用（不會每個指令重新握手）。指令各自開一個 exec channel，
同一個 session 最多同時 4 個。

| 何時關閉 | 原因（通知與稽核裡的 `reason`） |
| --- | --- |
| agent 呼叫 `ssh_session_close` | `closed_by_agent` |
| 使用者 / 通道擁有者 / 管理員在網頁關掉（AI 活動頁或即時 session 頁，`DELETE /api/ai/sessions/{id}`）；管理員替這個人關掉「MCP app」功能 | `closed_by_user` |
| 閒置超過 `ai_session_idle_timeout`（預設 600 秒；執行中的指令不算閒置） | `idle` |
| 存活超過 `ai_session_max_lifetime`（預設 7200 秒；一律關閉） | `max_lifetime` |
| 裝置離線、連線中斷 | `device_offline` / `disconnected` |
| grant 或個人 API token 撤銷 / 過期、帳號停用 | `revoked` |
| 通道被刪 | `tunnel_deleted` |
| 權限被拿掉、username 被移除（取消分享、分享到期、允許清單縮小…） | `permission_removed` |

- reaper 每 30 秒檢查一次；撤銷 grant / token 時立即關閉，取消分享、改權限這類變更也會立刻重新檢查一次（`ai::recheck`）。
- agent 可以要求更短的 `idle_timeout_s` / `max_lifetime_s`，但不能超過站台設定（最短 10 秒）。
- 每位使用者同時最多 `ai_max_sessions_per_user` 個（預設 3，所有 app 合計，SSH session 與 agent 的瀏覽器一起算；0 = 不允許 AI 開 session）。
- 指令逾時預設 60 秒、最多 600 秒，逾時送 `KILL` 並關 channel；每個輸出串流預設保留 64 KiB、最多 1 MiB，
  超過時保留開頭 1/4 與結尾 3/4。
- MCP 2026-07-28 版沒有 transport session，所以 SSH session 綁的是憑證（哪個 OAuth grant 或哪把個人 API token），
  不是 MCP 連線；不同 app / token 互相看不到彼此的 session。

三個上限都在管理員的 **網站設定 → AI 存取（MCP）** 分頁（`/tunnels/settings?tab=ai`，同頁也顯示 MCP 端點網址），變更後對新開的 session 生效。

## 通知與稽核

- 開 / 關 session 時，`/ws/notifications` 會送 `AI-SESSION-OPENED` / `AI-SESSION-CLOSED`
  （`details`、`tunnel_id`、`session_id`、`by`、`client`，關閉時另有 `reason`）給 session 的使用者與通道擁有者 ——
  被分享的使用者用 AI 連上別人的通道時，擁有者會知道。
- 每一次 tool call 寫一列 `telepy_ai_audit_event`（最多保留 10 萬列，90 天後刪掉，hash chain 防竄改）：誰、哪個 app、
  哪個通道與 username、指令或路徑（最多 2000 字元）、exit code、耗時、輸出 bytes、錯誤、來源 IP。**指令原文會被記錄**，
  請勿讓 agent 在指令列帶密碼。
- `GET /api/ai/activity` 與 `GET /api/ai/sessions` 預設 `?scope=mine`（管理員也一樣）：自己的，加上自己擁有的通道上的；
  `scope=all` = 全部，只有管理員（其他人 403 `admin_only`）。`activity` 另外可用 `tunnel_id`、`user_id`、`grant_id` 篩選。
- 網頁：**AI 活動**（`/tunnels/activity`）是自己的（含開著的 session、你的 MCP 應用程式）；管理員的全站版在管理區的
  **全站 AI 活動**（`/tunnels/admin/activity`）。

## 手動驗證

```bash
# 401 + discovery 指向 metadata
curl -si -X POST https://telepy.example.com/mcp -H 'content-type: application/json' -d '{}' | grep -i www-authenticate
curl -s https://telepy.example.com/.well-known/oauth-protected-resource/mcp
curl -s https://telepy.example.com/.well-known/oauth-authorization-server
```

自動化測試：`tests/oauth_api.rs`（OAuth 流程）、`tests/mcp_api.rs`（以假的裝置 sshd 端到端測 exec / SFTP /
逾時 / 截斷 / scope / 上限 / 撤銷 / reaper / 分享通知、互動 shell（PTY echo shell：畫面、控制字元、錄影、指令規則），
以及以假的 session-manager 測 agent 瀏覽器）；`tests/api_tokens.rs`（個人 API token 打 `/mcp` 與 REST）、`tests/api_token_calls.rs`
（呼叫紀錄）；`tests/features.rs`（功能權限擋工具）；`docker/kasm-browser/tests/test_cdp.py`（CDP 動作、WebSocket
frame、/cdp 路由）。
