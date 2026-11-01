# AI 工具（MCP）

<p align="center"><a href="./mcp.md">English</a> | <b>繁體中文</b> | <a href="./mcp.ja.md">日本語</a></p>

Telepy 本身就是一個 MCP server。把支援 MCP 的 AI 工具（Claude Code、Claude Desktop / claude.ai、Cursor 等）接上來，它就能用你自己的權限操作你的裝置，絕不會多拿。

agent 可以：

- 看哪些通道在線、裝置狀況如何
- 開一個會自己關掉的 SSH session，在裡面跑指令
- 透過互動 shell 操作 TUI
- 讀寫檔案
- 掃描裝置背後的區網
- 開一個經裝置上網的瀏覽器

哪些能做、能碰哪些通道，由你在核准頁上決定。

## 連接用戶端

MCP 端點是 `https://<你的主機>/mcp`（Streamable HTTP）。

正式環境請在 `.env` 設定 `PUBLIC_URL`（例如 `https://telepy.example.com`），OAuth 的 issuer 與 MCP resource 都由它決定。

沒設的話，Telepy 會依每個請求的 `X-Forwarded-Proto` / `X-Forwarded-Host` / `Host` 標頭推出來。

| 用戶端 | 設定 |
| --- | --- |
| Claude Code | `claude mcp add --transport http telepy https://telepy.example.com/mcp`，之後在對話裡 `/mcp` 完成授權 |
| Claude Desktop / claude.ai | Settings → Connectors → Add custom connector，URL 填 `https://telepy.example.com/mcp` |
| Cursor 等 | `mcp.json`：`{"mcpServers": {"telepy": {"url": "https://telepy.example.com/mcp"}}}` |

不用貼任何 token。用戶端第一次呼叫會吃到 401，它會自己摸摸鼻子，走完 [核准 app](#核准-app) 那段登入流程。

不確定網址要填什麼？打開左側選單的 **AI → MCP**。頁面上有實際要填的端點（會跟著 `PUBLIC_URL`）、上表三種用戶端可直接複製的設定、各權限對應的工具、session 何時關閉，以及已連接的 MCP 應用程式。

### 沒有瀏覽器？改用 API token

開不了瀏覽器的 agent 或 CI，可以改把個人 API token（`tpt_…`）當 Bearer token 送出。token 在左側選單的 **API** 頁建立：

```json
{"mcpServers": {"telepy": {"url": "https://telepy.example.com/mcp", "headers": {"Authorization": "Bearer tpt_…"}}}}
```

- token 在 `/mcp` 上拿到的工具、scope、通道限制，都跟 OAuth app 一樣。
- 這個人的「API token」與「MCP app」兩個功能都要開著。
- 它開的 session、shell 和瀏覽器只屬於這把 token。稽核裡的 app 名稱是 `API token "<名稱>"`。
- 每個 tool call 也會記在 API 頁的「活動」，顯示為 `MCP <tool>`，狀態 200；工具回錯誤時是 400。
- 撤銷 token，它開著的 session 會立刻關閉。

## 核准 app

用戶端第一次連上來時，瀏覽器會打開 Telepy 的核准頁。

如果還沒登入，會先看到登入頁。這個登入頁刻意長得跟一般的不一樣，而且登入前就會顯示是哪個 app 在要求、之後會導回哪裡、想要哪些權限。不想給的話，在這裡就能直接取消。

在核准頁上，你會：

- 確認 app 的名稱和導回位址
- 確認目前登入的帳號（「不是你？」→「切換帳號」）
- 勾選要給它的權限（scope），不想給的就取消勾選
- 選擇開放全部通道，或只開放部分通道
- 視需要勾選「取代先前的連線」，讓同一個 app 舊的連線失效。用戶端一拿到新 token，舊的就會被撤銷。

接著用戶端會拿到 access token（效期 1 小時）和 refresh token（30 天，每次換發都會輪替），再帶著它呼叫 `/mcp`。

<details>
<summary>OAuth 2.1 流程細節</summary>

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

- access token 是 `token_type: "mcp_access"` 的 JWT。網頁登入的 token 不能呼叫 `/mcp`。
- REST API 只在 token 可以呼叫的路由上接受 MCP 的 access token（見 [cli.zh-TW.md](cli.zh-TW.md)），`telepy` 命令列的瀏覽器登入就是這樣用它的。

</details>

### 權限範圍（scope）

| scope | 核准頁上的名稱 | 開放的工具 |
| --- | --- | --- |
| `tunnels:read` | 查看你的通道 | `list_tunnels`、`tunnel_status`、`lan_hosts` |
| `ssh:exec` | 在你的裝置上執行指令 | `ssh_session_open`、`ssh_exec`、`shell_open` / `shell_send` / `shell_read` / `shell_resize` / `shell_close` |
| `ssh:files` | 讀寫你裝置上的檔案 | `ssh_session_open`、`sftp_list` / `sftp_read` / `sftp_write` |
| `network:scan` | 探索裝置所在區網的機器 | `lan_scan`（只限你擁有或身為 ADMIN 的通道） |
| `browser:use` | 以你的裝置的身分瀏覽網頁 | `browser_open` / `browser_navigate` / `browser_read` / `browser_screenshot` / `browser_click` / `browser_type` / `browser_close` |

`ssh:exec`、`ssh:files` 與 `browser:use` 在核准頁上會標「可以變更內容」，另外兩個標「唯讀」。

### `telepy login` 不算 MCP 應用程式

`telepy` 命令列的瀏覽器登入也走同一套 OAuth，核准頁會註明是 CLI 在要求。不過 Telepy 會把它跟 MCP 應用程式分開：

- 每次登入都會註冊成 `telepy CLI (<電腦名稱>)`。這個名稱是用戶端自己報的，Telepy 只拿來分類顯示。
- 這些登入列在 API 頁的「CLI 登入」分頁。MCP 頁、偏好設定和 AI 活動頁的 MCP 應用程式清單都不會列出它們。
- 在同一台電腦再登入一次，會詢問要不要取代先前那個。
- 每人最多保留 10 個 CLI 登入，第 11 個會把最久沒用的那個登出。
- CLI 登入一樣跟著「MCP app」功能開關走。詳見 [cli.zh-TW.md](cli.zh-TW.md)。

## Agent 能做什麼

![MCP app 依權限範圍能碰到哪些東西](images/zh-TW/agent-reach.png)

下面的工具依開放它們的 scope 分組。MCP 頁上的「app 碰得到哪裡？」按鈕，會替你選的已連接 app 畫出這張圖：app ─ Telepy ─ 裝置 ─ 區網 / 網際網路，它的 scope 允許的分支會亮起來。

### 查看通道（`tunnels:read`）

| 工具 | 做什麼 |
| --- | --- |
| `list_tunnels` | 你看得到的通道：id、名稱、是否在線、延遲、你的權限、可用的目標 username，以及這個 app 開著的 session |
| `tunnel_status(tunnel_id)` | 健康狀態、延遲、24 小時在線率、裝置的 `facts` 與 `warnings`，以及最近 10 筆 gateway 事件 |
| `lan_hosts(tunnel_id)` | 裝置背後的區網主機（掃描找到的與手動加的）：位址、名稱、開著的 port、SSH banner、標籤、登入帳號 |

- 健康狀態分成 online、degraded（通道在，但裝置的 sshd 沒回應）和 offline。
- `facts` 包含 OS、kernel、開機秒數、CPU、記憶體與根磁碟（KB）、負載、ssh 版本，以及要不要重開機。只有能登入裝置的人拿得到。

### 執行指令（`ssh:exec`）

一切從 session 開始：`ssh_session_open` 回傳 `session_id`，其他工具都要帶著它。

| 工具 | 做什麼 |
| --- | --- |
| `ssh_session_open(tunnel_id, username?, idle_timeout_s?, max_lifetime_s?)` | 開 session，回傳 `session_id`。省略 `username` 時用通道的預設（只有一個時自動選） |
| `ssh_exec(session_id, command, timeout_s?, max_output_bytes?)` | 跑指令（無 TTY），回傳 `exit_code`、`stdout`、`stderr`、`timed_out`、`truncated` |
| `ssh_session_list` | 這個 app 開著的 session 與各自的剩餘時間 |
| `ssh_session_close(session_id)` | 關掉 session |
| `shell_open(session_id, cols?, rows?)` | 開互動 shell（PTY，`xterm-256color`，預設 120×40），回傳 `shell_id`。每個 session 最多 2 個 |
| `shell_send(shell_id, input, press_enter?)` | 原樣打出 `input`，可含控制字元（`\u0003` = Ctrl+C、`\u001b` = Esc）。`press_enter` 會多按一個 Enter。每次 64 KiB 以內 |
| `shell_read(shell_id, timeout_ms?, max_bytes?, screen?)` | 回傳新的原始輸出 `output`、目前畫面 `screen`、`cursor`、`size`、`more`、`exited`。沒有新輸出時最多等 `timeout_ms`（預設 1.5 秒，上限 10 秒） |
| `shell_resize(shell_id, cols, rows)` / `shell_close(shell_id)` | 改大小 / 關掉 shell |

shell 的行為細節請看 [互動 shell](#互動-shell)。

### 讀寫檔案（`ssh:files`）

這些工具同樣在 session 裡用，session 由 `ssh_session_open` 開。

| 工具 | 做什麼 |
| --- | --- |
| `sftp_list(session_id, path?)` | 列出目錄（`~` = 家目錄） |
| `sftp_read(session_id, path, offset?, max_bytes?)` | 讀檔：文字回 UTF-8，其他回 base64。可以分段讀 |
| `sftp_write(session_id, path, content, encoding?, append?)` | 寫檔或附加（`encoding`：`utf-8` / `base64`） |

### 掃描區網（`network:scan`）

| 工具 | 做什麼 |
| --- | --- |
| `lan_scan(tunnel_id, username?, subnets?, ports?)` | 經裝置的 sshd 掃描區網，把找到的主機存進主機清單 |

- 只掃私有網段，最多 1024 個位址，一次大約一分鐘。
- 只限你擁有或身為 ADMIN 的通道。
- 結果用 `lan_hosts` 讀。

### 使用瀏覽器（`browser:use`）

| 工具 | 做什麼 |
| --- | --- |
| `browser_open(tunnel_id, username?, url?, idle_timeout_s?, max_lifetime_s?)` | 經裝置開一個遠端瀏覽器（Chromium），回傳 `browser_id`。可以順便打開 `url` |
| `browser_navigate(browser_id, url)` | 前往網址（只收 http / https，沒寫就補 `https://`），等頁面載入，回傳最後的網址與標題 |
| `browser_read(browser_id, selector?)` | 頁面文字：標題、網址、看得到的文字（最多 10 萬字）、連結。給 `selector` 就只讀一部分 |
| `browser_screenshot(browser_id)` | PNG 截圖（最寬縮到 1280 px），以 MCP image content block 回傳 |
| `browser_click(browser_id, selector? \| text?)` | 用 CSS selector 或看得到的文字（連結、按鈕、label）點一下，是真的滑鼠事件 |
| `browser_type(browser_id, selector, text, press_enter?, sensitive?)` | 在欄位打字，可以按 Enter 送出。`sensitive` 預設 true，稽核只記長度 |
| `browser_close(browser_id)` | 關掉瀏覽器 |

瀏覽器的流量從裝置出去，所以它看得到裝置的區網、localhost 和公網 IP。詳見 [Agent 的瀏覽器](#agent-的瀏覽器)。

## Session 與上限

一個 session 就是一條到裝置的 SSH 連線，所有指令共用，不會每跑一個指令就重新握手一次。每個指令各開一條 channel，同一個 session 同時最多 4 條。

agent 不一定記得掛電話，所以每個 session 都會自己關。

### 上限

| 項目 | 預設 | 說明 |
| --- | --- | --- |
| 閒置逾時（`ai_session_idle_timeout`） | 600 秒 | 執行中的指令不算閒置 |
| 最長存活時間（`ai_session_max_lifetime`） | 7200 秒 | 時間到一律關閉 |
| 每人 session 數（`ai_max_sessions_per_user`） | 3 | 所有 app 合計，SSH session 與 agent 的瀏覽器一起算。0 = 不允許 agent 開 session |
| 指令逾時 | 60 秒 | 最多 600 秒。逾時會送 `KILL` 並關掉 channel |
| 每個輸出串流 | 64 KiB | 最多 1 MiB。超過時保留開頭 1/4 與結尾 3/4 |

- agent 可以要求更短的 `idle_timeout_s` / `max_lifetime_s`，但不能超過網站設定，也不能短於 10 秒。
- 前三項由管理員在 **網站設定 → AI 存取（MCP）** 設定（同一頁也顯示 MCP 端點網址），改了之後對新開的 session 生效。
- session 綁的是憑證，不是 MCP 連線：MCP 2026-07-28 版沒有 transport session。所以每個 session 都屬於某個 OAuth grant 或某把個人 API token，不同 app / token 看不到彼此的 session。

### Session 何時關閉

| 何時關閉 | 原因（通知與稽核裡的 `reason`） |
| --- | --- |
| agent 呼叫 `ssh_session_close` | `closed_by_agent` |
| 使用者、通道擁有者或管理員在網頁關掉（AI 活動頁或即時連線頁，`DELETE /api/ai/sessions/{id}`）；或管理員替這個人關掉「MCP app」功能 | `closed_by_user` |
| 閒置超過 `ai_session_idle_timeout` | `idle` |
| 存活超過 `ai_session_max_lifetime` | `max_lifetime` |
| 裝置離線、連線中斷 | `device_offline` / `disconnected` |
| grant 或個人 API token 被撤銷或過期、帳號被停用 | `revoked` |
| 通道被刪除 | `tunnel_deleted` |
| 權限或 username 被拿掉（取消分享、分享到期、允許清單縮小…） | `permission_removed` |

Telepy 每 30 秒檢查一次。撤銷 grant 或 token 時會立刻關閉，取消分享、改權限這類變更也會馬上重新檢查一次。

## 互動 shell

有了 shell，agent 就能像你在終端機裡那樣工作：回答提示、操作 TUI、看著畫面變化。

- 一個 shell 是 session 現有連線上的一條 PTY channel。它跟 `ssh_exec` 共用 session 的 4 條 channel，每個 session 最多 2 個 shell。
- Telepy 在背景一直讀輸出（餵給畫面模型和錄影），所以 agent 沒在讀，也不會卡住裝置。
- `shell_read` 的 `screen` 來自終端機的 vt100 模型：純文字，一列一行。
- 沒人讀走的輸出最多保留 256 KiB，超過就丟掉最舊的，並用 `dropped_bytes` 告訴你丟了多少。
- shell 在這些時候關閉：呼叫 `shell_close`、所屬 session 關掉（不論原因），或超過 session 的 `idle_timeout` 都沒有 send / read（每 30 秒檢查一次）。
- 用 shell 也算 session 有在用，所以 session 不會在 shell 用到一半時閒置逾時。
- **錄影**：通道開了「錄下網頁終端機」時，agent 的 shell 也會錄成 asciicast（`kind: agent`，在終端機錄影頁標成「MCP agent」）。
- 在 **即時連線** 頁上，agent session 那一列會顯示開著幾個 shell（`/api/sessions` 與 `/api/ai/sessions` 裡的 `shells`）。

在 shell 提示字元按下的每個 Enter 也都會經過指令規則，見 [互動 shell 也會檢查](#互動-shell-也會檢查)。

## Agent 的瀏覽器

agent 的瀏覽器就是一般的遠端瀏覽器 session：瀏覽器容器裡的 Chromium，經裝置上網，算進 `remote_browser_max_sessions`。唯一的差別是操作的人換成 agent。

- agent 透過瀏覽器容器裡的 session manager 操作它，後端從不直接連 Chromium 的 DevTools。詳見 [remote-browser.zh-TW.md](remote-browser.zh-TW.md)。
- 它跟 SSH session 共用每人上限 `ai_max_sessions_per_user`，也套用同一組閒置與存活時間限制。
- 裝置離線、grant 被撤銷、權限或 username 被拿掉，或遠端瀏覽器 session 不見了，它都會關閉。
- 需要 step-up 的通道會拒絕它。
- 它會出現在通道的「誰在連線」清單和 **即時連線** 頁（kind `browser`，client = app 名稱），也可以從那裡結束。之後的 tool call 會回「ended by <誰>」。
- 開啟與關閉會在通道的 Logs 寫下 `browser_open` / `browser_close` 事件。
- 通知沿用 `AI-SESSION-OPENED` / `AI-SESSION-CLOSED`，多帶 `kind: "browser"`；webhook `mcp.session_*` 的 data 也會有 `kind`。
- 稽核會記網址和 selector。用 `browser_type` 打的文字只記長度，除非 agent 傳了 `sensitive: false`。截圖本身從不儲存。

## 防護機制

### 規則跟網頁一樣

agent 拿到的權限，跟你在網頁上拿到的完全一樣：

- 要有該通道的 VIEW 權限。
- 目標 username 必須在你的允許清單裡。被分享的通道只能用分享時允許的 username，跟網頁終端機一樣。
- **功能權限**（管理 → 使用者與權限 → 功能權限）也適用。管理員替某人關掉某個功能時，對應的工具會回錯誤（`isError`）說明原因。

| 工具 | 需要的功能 |
| --- | --- |
| `ssh:exec` 的工具 | 網頁終端機 |
| `ssh:files` 的工具 | 檔案管理 |
| `lan_hosts`、`lan_scan` | 區網探索 |
| `browser:use` 的工具 | 遠端瀏覽器 |

如果只是 app 沒拿到某個 scope，錯誤訊息會請 agent 告訴你重新連接並核准那個 scope。

### 需要 step-up 的通道

有些通道要求每個人在每次 session 前，都先用第二道驗證確認。agent 做不到這一步，所以在這些通道上不能開 SSH session、開瀏覽器，也不能跑 `lan_scan`。

`list_tunnels` 會帶 `requires_step_up`，agent 動手前就知道。

### 指令規則（`ssh_exec`）

![指令怎麼判定：拆解、全站規則、個人規則、結果](images/zh-TW/command-decision.png)

**指令規則** 頁上的規則也管 agent 的指令。規則也可以設成只管 MCP agent（`via: agents`）。

#### 兩種規則

- **個人規則**：每個人自己寫。對象選「所有人」或「只限被分享的人」時，只在作者「目前」是擁有者或 ADMIN 的通道上生效。
  - 選「只有我」就只管作者自己的指令，在他用的任何通道上都算。很適合替自己跑在別人通道上的 agent 加一道防護。「只有我」的規則別人看不到。
- **全站規則**：由管理員寫（管理 → 規則與通知 → 指令規則）。預設可以覆寫：通道擁有者或 ADMIN 可以在自己管的通道上關掉它。管理員關掉「允許使用者覆寫」後就變成強制，誰都關不掉。

#### 各動作的效果

一條指令符合好幾條規則時，擋下 > 需要核准 > 提醒。

- **擋下**：不執行。工具回錯誤（`isError`），寫出是哪條規則和規則的說明。
- **需要核准**：Telepy 送出核准申請，這次 tool call 最多等 45 秒。核准了就照常執行並回傳結果；被拒絕，或申請到期都沒人核准，就回錯誤。
- **提醒**：照常執行，`ssh_exec` 的結果多一個 `reminder`（規則的說明；沒寫說明就是比對式），agent 應該轉告你。REST 版的 `POST /api/ai/sessions/{id}/exec` 也一樣。
- **允許（例外）**：符合的指令不受同一個作者的「擋下」與「需要核准」規則管。

關於核准：

- 核准人是規則指定的人。沒指定的話，就是通道擁有者與 ADMIN；「只有我」的規則則是作者自己。
- 核准人會在網頁右下角看到申請，也可以在指令規則頁處理。
- 45 秒內沒人決定，錯誤訊息會說還在等。agent 應該告訴你，等核准後再用 **一模一樣的指令** 呼叫一次。
- 核准在 10 分鐘內可以用一次（同一個 app、通道、帳號與指令）。
- agent 用通道擁有者的身分跑時，核准鈕還是得擁有者本人按。球員不能兼裁判，agent 也一樣。

關於提醒與例外：

- 提醒不等任何人，也不會出現在指令規則頁的「紀錄」。每個人都可以替自己把提醒靜音，除非管理員把它設成強制。
- 全站的例外豁免全站規則；個人的例外只豁免同一個人的規則。
- 通道擁有者或 ADMIN 的例外，在他管的通道上也會豁免可覆寫的全站規則，但強制的不行。
- 別人的例外，蓋不掉你的規則。

被擋下、等待中、被拒絕的指令，都會在 AI 稽核裡記成失敗的 `ssh_exec`。申請與結果也會列在指令規則頁的「紀錄」。

#### 互動 shell 也會檢查

agent 用 `shell_send` 在 shell 提示字元按下的每個 Enter，Telepy 都會用跟網頁終端機一樣的方式，從畫面讀出那一行再比對。

- **擋下**：改送 Ctrl+C，工具回錯誤。
- **需要核准**：跟 `ssh_exec` 一樣最多等 45 秒，核准了才送出 Enter。還在等時，那一行會留在提示字元上；核准後 agent 送 `input: ""` 加 `press_enter: true` 就會執行（同樣是 10 分鐘內用一次）。
- 在沒送出的 Enter 之後打的輸入會被丟掉，工具會說丟了幾個 bytes。
- **提醒**：那一行照常送出，`shell_send` 的結果帶 `reminders`（每條規則一句）。
- 全螢幕程式（vim、less）裡的 Enter 不檢查。

## 通知與稽核

session 開啟或關閉時，`/ws/notifications` 會送 `AI-SESSION-OPENED` / `AI-SESSION-CLOSED` 給 session 的使用者與通道擁有者，內容有 `details`、`tunnel_id`、`session_id`、`by`、`client`，關閉時另帶 `reason`。

所以被你分享通道的人如果讓 agent 連上來，你會知道。

每一次 tool call 都會寫一筆稽核紀錄：

- 誰、哪個 app、哪個通道與 username
- 指令或路徑（最多 2000 字元）
- exit code、耗時、輸出 bytes、錯誤、來源 IP

最多保留 10 萬筆，每筆保留 90 天，並以 hash chain 防竄改。

> [!WARNING]
> 指令原文會整段記下來。稽核紀錄記性很好，可惜不太會保密，所以別讓 agent 在指令列帶密碼。

在哪裡看：

- **AI 活動**：你自己的呼叫、開著的 session 和 MCP 應用程式。
- **全站 AI 活動**：所有人的，在管理區。
- API：`GET /api/ai/activity` 與 `GET /api/ai/sessions` 預設 `?scope=mine`，管理員也一樣，也就是你自己的，加上你擁有的通道上的。
- `scope=all` 回傳全部，只有管理員能用（其他人會拿到 403 `admin_only`）。`activity` 另外可以用 `tunnel_id`、`user_id`、`grant_id` 篩選。

## 撤銷存取

- 在 **MCP** 頁、**偏好設定 → MCP 應用程式**，或 AI 活動頁的「你的 MCP 應用程式」都能撤銷 app。管理員可以在「管理使用者」對話框撤銷任何人的。
- 每個 `/mcp` 請求都會重新檢查 grant 與使用者，所以撤銷立刻生效，該 app 開著的 SSH session、shell 和瀏覽器也會馬上關閉。
- 撤銷個人 API token，它開著的 session 也會立刻關閉。
- **帳號被停用**：grant 與個人 API token 是暫停，不是撤銷。`/mcp` 會立刻拒絕它們，開著的 session 也會關閉；帳號重新啟用後就照常可用。
- **「MCP app」功能被關掉**：這個人所有的 app 都會拿到 401，像被撤銷一樣，開著的 agent session 也會結束。功能打開後就恢復。

## 不用 MCP：REST 與 CLI

同一組動作也有 REST API，`telepy exec` 和 `telepy browse` 就是用它們（見 [cli.zh-TW.md](cli.zh-TW.md)）。

- 指令：`/api/ai/sessions*`。
- 遠端瀏覽器：`/api/browser/sessions*`，如下表。

| 請求 | 做什麼 |
| --- | --- |
| `POST /api/browser/sessions {tunnel_id, username?, url?}` | 開瀏覽器 → `{id, …}` |
| `POST …/{id}/navigate {url}` | 前往網址 |
| `GET …/{id}/text?selector=` | 頁面文字 |
| `GET …/{id}/screenshot` | 截圖（image/png） |
| `POST …/{id}/click {selector \| text}` | 點擊 |
| `POST …/{id}/type {selector, text, press_enter?, sensitive?}` | 打字 |
| `DELETE …/{id}` | 關掉 |
| `GET /api/browser/sessions` | 列出開著的瀏覽器 |

- 上限、誰在連線、即時連線、自動關閉與稽核，都跟走 MCP 時一樣。
- 個人 API token 或 OAuth app 的 token 要有 `browser:use`。網頁登入也能呼叫（client 名稱「Telepy web sign-in」）。
- 一個瀏覽器只屬於開它的那把憑證。
- 需要 step-up 的通道會回 403 `step_up_refused`。

## 安全須知

核准 app 之前，值得記住這幾件事：

- app 拿到的權限不會超過你，而且只有你核准的 scope 和通道。
- `ssh:exec`、`ssh:files` 與 `browser:use` 會改東西。經裝置開的瀏覽器碰得到那台裝置的區網和 localhost。
- 完整的指令原文會進稽核紀錄，密碼別放在指令列上。
- 指令規則會檢查 `ssh_exec` 和 shell 提示字元上的每個 Enter，但不檢查 vim、less 這類全螢幕程式裡的 Enter。
- 需要 step-up 的通道，agent 進不去。
- 別人的 agent 連上你擁有的通道時，你會收到通知。
- `telepy CLI (<電腦名稱>)` 這個名稱是用戶端自己報的，當成標籤看就好，不能當證明。

## 手動檢查

```bash
# 401 + discovery 指向 metadata
curl -si -X POST https://telepy.example.com/mcp -H 'content-type: application/json' -d '{}' | grep -i www-authenticate
curl -s https://telepy.example.com/.well-known/oauth-protected-resource/mcp
curl -s https://telepy.example.com/.well-known/oauth-authorization-server
```

<details>
<summary>自動化測試（給貢獻者）</summary>

- `tests/oauth_api.rs`：OAuth 流程。
- `tests/mcp_api.rs`：以假的裝置 sshd 做端到端測試，涵蓋 exec、SFTP、逾時、截斷、scope、上限、撤銷、自動關閉、分享通知、互動 shell（畫面、控制字元、錄影、指令規則），以及用假的 session manager 測 agent 瀏覽器。
- `tests/api_tokens.rs` 與 `tests/api_token_calls.rs`：個人 API token 呼叫 `/mcp` 與 REST，以及呼叫紀錄。
- `tests/features.rs`：功能權限擋工具。
- `docker/kasm-browser/tests/test_cdp.py`：session manager 那一側的瀏覽器動作。

</details>
