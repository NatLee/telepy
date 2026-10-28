# Webhooks

> 每個人把自己會收到的 Telepy 通知送到 Slack、Discord、Google Chat、Microsoft Teams、Telegram、ntfy（手機推播）
> 或自己的服務；管理員另外共管「全站」webhook，收整台伺服器的重要事件。
> 後端程式：`webhooks/`（`catalog.rs` 事件目錄、`text.rs` 三種語言的句子、`format.rs` 各服務格式、`sign.rs` 簽章、
> `target.rs` 位址檢查、`mod.rs` 發送）；`api/webhooks.rs`、`db/webhooks.rs`；狀態告警的計時在 `monitor/alerts.rs` + `monitor/runner.rs`。
> 前端：`/tunnels/webhooks` = 我的 webhook（管理員也只看到自己的）、`/tunnels/admin/webhooks` = 全站 webhook（側欄管理區
> 「全站 Webhook」）；兩頁共用 `components/webhooks/WebhooksView.tsx`（`hooks/useWebhooksPage.ts`、`lib/webhooks.ts`）。

## 兩種 webhook

| | 個人 webhook | 全站 webhook |
| --- | --- | --- |
| 誰建立 / 管理 | 每個人自己的（別人看不到） | 管理員；每位管理員都看得到、都能改 |
| 收什麼 | 他在網頁上本來就會收到的通知 | 精選的重要事件（狀態、裝置身分與安全、帳號） |
| 範圍 | 自己擁有或被分享的通道（可再限定幾條） | 每條通道、每個帳號（可限定在任何通道） |
| 內網位址 | 預設不准（見「位址檢查」） | 可以 |

網站設定 → 通知分頁（`notify_*`）：

- `notify_user_webhooks`（預設開）：關掉就暫停所有個人 webhook，全站的不受影響。
- `notify_private_targets`（預設關）：個人 webhook 能不能連內網 / 本機 / 雲端 metadata。
- `notify_max_webhooks`（預設 10，0–100）：每人上限。

管理員也可以在網站設定 → 存取權限替某些人（或某個使用者群組）關掉「個人 webhook」功能：那個人的 Webhooks 頁換成說明，
`/api/webhooks*` 回 403 `feature_disabled`。帳號被停用時，他的個人 webhook 不再送出。

以前的單一告警網址（`notify_webhook_url` / `notify_down_delay`）在升級時（data migration
`2026-10-26-site-webhook-from-settings`）搬成一個名為 “Status alerts” 的全站 webhook：同樣的四個狀態事件加上
`tunnel.ip_changed`、同樣的延遲，然後清掉設定。

## 事件

收件人一律沿用同一件事的站內通知對象，所以 webhook 不會讓任何人知道他在網頁上看不到的事；取消分享、權限調降之後，
那條通道的事件就不再送給他。

| 事件 | 分組 | 個人 webhook 誰收得到 | 全站 |
| --- | --- | --- | --- |
| `tunnel.offline` / `tunnel.online` | 通道狀態 | owner 與所有被分享者 | ✓ |
| `tunnel.degraded` / `tunnel.recovered` | 通道狀態 | owner 與所有被分享者 | ✓ |
| `tunnel.ip_changed` | 裝置身分 | owner 與 ADMIN 被分享者 | ✓ |
| `tunnel.host_key_changed` | 裝置身分 | owner 與所有被分享者 | ✓ |
| `device.claim_attempt` | 裝置身分 | owner 與 ADMIN 被分享者 | ✓ |
| `tunnel.device_warning` | 裝置身分 | owner 與 ADMIN 被分享者（根磁碟剩不到 10 % 或 2 GB、可用記憶體不到 10 %、1 分鐘負載超過 CPU 數兩倍、等著重開機；每條通道每種一天最多一次，data 有 `warning` / `detail` / `avail` / `total` / `load1` / `cpus`） | ✓ |
| `share.received` | 分享與存取 | 被分享的人 | |
| `share.ended` | 分享與存取 | 分享的雙方，不含動手的人 | |
| `access.requested` | 分享與存取 | owner 與 ADMIN，不含申請人 | |
| `access.decided` | 分享與存取 | 申請人 | |
| `command.approval_requested` | 指令規則 | 這條規則的核准人（規則有指定就是那些人，否則 owner 與 ADMIN；自己在終端機打的不送，自己的 MCP agent 的會送） | |
| `command.approval_decided` | 指令規則 | 申請人（自己決定或取消的不送） | |
| `command.blocked` | 指令規則 | owner 與 ADMIN，不含本人；訊息含指令 | |
| `session.started` | 連線 | owner 與 ADMIN，不含本人（終端機、區網終端機、檔案、瀏覽器、桌面、RustDesk） | |
| `session.watched` | 連線 | 被看的人（owner / ADMIN / 管理員開始看他的網頁終端機；data 有 `by` / `account` / `lan_host`） | |
| `mcp.session_opened` / `mcp.session_closed` | 連線 | agent 的使用者與通道 owner（data 的 `kind`：`ssh` 或 `browser`） | |
| `account.sign_in` | 登入 | 帳號本人 | |
| `account.sign_in_new_device` | 登入 | 帳號本人（90 天內成功登入都沒見過的國家或瀏覽器） | |
| `account.sign_in_failed` | 登入 | 帳號本人 | ✓（任何帳號） |
| `key.expiring` | SSH 金鑰 | 金鑰的擁有者（個人 SSH 金鑰 7 天內到期） | |
| `key.expired` | SSH 金鑰 | 金鑰的擁有者（剛到期：gateway 拒絕、從裝置移除） | |
| `user.created` | 管理 | — | ✓ |
| `webhook.test` | — | 「送測試」按鈕，不能訂 | |

`key.*` 指的是金鑰頁上的**個人 SSH 金鑰**（筆電經 gateway 連裝置用的那把；管理員用 `user_key_max_days` 讓它們有效期限）。
通道（裝置）金鑰刻意不會到期，所以沒有對應事件。每 10 分鐘看一次（`webhooks/keys.rs`）：7 天內到期送 `key.expiring`
（`days_left` 無條件進位），到期了送 `key.expired`（只送 48 小時內到期的，舊的到期不補發）；每把金鑰每個階段每個到期時間只送一次
（`telepy_key_expiry_notice`），續期改了到期時間就重新算。

狀態事件（offline / online / degraded / recovered）不是一發生就送：每個 webhook 有自己的延遲（立刻 – 1 天，預設 1 分鐘），
狀況要持續超過延遲才送；只有送過 offline / degraded 的，結束時才送 online / recovered。只追蹤 webhook 建立之後的變化。

## 送出的內容

每個 webhook 選格式（預設依網址判斷）與訊息語言（English / 繁體中文 / 日本語，句子在後端組，因為訊息直接進聊天室）。

| 格式 | 網址判斷 | 內容 |
| --- | --- | --- |
| Telepy JSON | 其他網址 | 下面的完整 JSON |
| Slack 相容 | `hooks.slack.com` | `{"text"}`，跳脫 `& < >`（Mattermost、Rocket.Chat 也吃） |
| Discord | `discord.com/api/webhooks/…` | `{"content", "allowed_mentions": {"parse": []}}` |
| Google Chat | `chat.googleapis.com` | `{"text"}`，`<…>` 語法失效 |
| Microsoft Teams | `*.logic.azure.com`、`*.webhook.office.com`、`*.powerplatform.com` | Adaptive Card（Workflows 的「收到 webhook 時張貼」） |
| Telegram | `api.telegram.org` | `{"text"}`；`chat_id` 放在網址（`…/sendMessage?chat_id=…`） |
| ntfy | `ntfy.sh`、`ntfy.*` | 純文字，`title` / `tags` / `priority` / `click` 加在網址參數 |

名稱、指令這些是使用者打的字，所以各格式都讓 `@everyone` / `<!channel>` 這類提及失效。

Telepy JSON：

```json
{
  "id": "msg_…",
  "event": "tunnel.ip_changed",
  "title": "New device IP address",
  "severity": "warning",
  "at": "2026-10-26T12:00:00Z",
  "text": "[Telepy] office-pi connected from a new IP address: 203.0.113.9 (was 198.51.100.1)",
  "server": "https://telepy.example.com",
  "url": "https://telepy.example.com/tunnels/logs?tunnel=4",
  "tunnel": { "id": 4, "name": "office-pi", "reverse_port": 1025 },
  "data": { "ip": "203.0.113.9", "previous_ip": "198.51.100.1" }
}
```

`tunnel` 只有跟通道有關的事件才有；`data` 依事件不同（`by`、`command`、`reason`…，見 `webhooks/text.rs` 用到的欄位）。
連結用 `PUBLIC_URL`（沒設就 `https://SERVER_DOMAIN`；都沒有就不附連結）。

## 自訂 header

每個 webhook 最多 10 個，例如自己服務的 `Authorization`、ntfy 的 access token。名稱必須是 HTTP token、不能重複，
Telepy 自己設的（`content-type`、`user-agent`、`webhook-*`、`x-telepy-event`、`host`、`content-length`…）不能改；
值是 1–2048 個可見 ASCII（不能換行）。以 `SECRET_KEY` 衍生的金鑰加密存放（AAD `telepy-webhook-headers:<id>`），
API 只回給能管這個 webhook 的人；`PATCH` 帶 `headers` 就整組取代，沒帶就不變。換掉 `SECRET_KEY` 之後讀不出來：送出會失敗並說明，
編輯畫面提示重新輸入（`headers_unreadable`）。

## 簽章（Standard Webhooks）

每個請求都有：

- `webhook-id`：訊息代號，重試時不變（拿來去重）
- `webhook-timestamp`：這次送出的 Unix 秒（拒絕太舊的，防重送）
- `webhook-signature`：`v1,` + base64(HMAC-SHA256(key, `{id}.{timestamp}.{body}`))，key = 密鑰 `whsec_` 後面 base64 解開的位元組
- `x-telepy-event`：事件名稱

密鑰在卡片選單的「簽章密鑰」看 / 複製 / 換；以 `SECRET_KEY` 衍生的金鑰加密存放（AAD 綁 webhook id），換掉 `SECRET_KEY`
之後讀不出來，要換一把新的。任何 Standard Webhooks 函式庫都能驗；對話框裡有 Node.js / Python 範例。

## 送出、重試、暫停

- 失敗（連線錯誤、逾時、408、429、5xx）在 10 秒與 1 分鐘後各重試一次；其他 4xx 不重試；3xx 不跟（請填最終網址）。
- 每個 webhook 一分鐘最多 30 則，超過的跳過，第一次跳過記一筆 `skipped`。
- 連續失敗 20 次就暫停（`paused_reason = failing`），通知擁有者（全站的通知每位管理員，`WEBHOOK-PAUSED`）；重新打開就清掉。
- 每個 webhook 留最新 50 筆送出紀錄（含內容，最多 16 KB），保留 30 天。送之前就先記成 `sending`，送完補結果；
  重試還在等時後端重啟的，啟動時改成失敗（「Telepy restarted before this was delivered.」）。
- **重送**：送出紀錄裡失敗 / 跳過的（送達的展開後也有）可以按「重送」：同一個 `webhook-id`、依 webhook 現在的格式 / 語言 / header 重組，
  不重試、不算進連續失敗、關著的 webhook 也能送，記成新的一筆（`redelivered_from`）。事件本身存在 `event_json`；測試送出不能重送。
- 全站 webhook 的新增 / 修改 / 刪除 / 換密鑰記成 `webhook` gateway 事件（Logs，管理員看得到）。

## 位址檢查（SSRF）

個人 webhook 的網址是任何人都能填的，伺服器會照著連，所以預設只准公網位址：儲存時解析主機名稱，任何一個位址落在
內網 / 本機 / link-local（含雲端 metadata 169.254.169.254）/ CGNAT / 保留段，或是 IPv6 裡包著這些 IPv4（mapped、NAT64、6to4）
就拒絕（`private_target`）；送出時再用只回傳公網位址的 DNS resolver 連線（擋 DNS rebinding），IP 字面值另外檢查，
也不跟 redirect、不走環境變數的 proxy。管理員打開 `notify_private_targets` 才放行；全站 webhook 一律放行。

## API

| | |
| --- | --- |
| `GET /api/webhooks` | 我的、（管理員）全站的、兩個範圍的事件目錄、`policy` |
| `POST /api/webhooks` | `{scope?, name?, url, format?, language?, events?, all_tunnels?, tunnel_ids?, delay?, enabled?, headers?}` → `{webhook, secret}` |
| `GET / PATCH / DELETE /api/webhooks/{id}` | 只有自己的（全站的：管理員）；別人的一律 404 |
| `POST /api/webhooks/{id}/test` | 送 `webhook.test` 並等結果（不重試、不算進連續失敗） |
| `GET /api/webhooks/{id}/deliveries` | 最新 50 筆 |
| `POST /api/webhooks/{id}/deliveries/{delivery_id}/redeliver` | 重送一筆（409 `not_redeliverable`：測試送出） |
| `GET / POST /api/webhooks/{id}/secret` | 讀 / 換簽章密鑰 |

錯誤是 `{field: [message], code}` 或 `{error, code}`；`code`：`private_target`、`invalid_url`、`unresolvable`、`no_events`、
`no_tunnels`、`limit`、`personal_disabled`、`admins_only`、`secret_unreadable`、`bad_header`、`not_redeliverable`。
`GET /api/webhooks` 對管理員另外回 `site_tunnels`（整台伺服器的通道，給全站 webhook 選）。
