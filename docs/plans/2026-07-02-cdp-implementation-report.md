# CDP 遠端瀏覽器遷移：實作完成報告

> 委託書：`docs/plans/2026-07-02-cdp-remote-browser.md`
> Phase 0 評估：`docs/plans/2026-07-02-cdp-phase0-report.md`（GO）
> 分支：`feat/cdp-remote-browser`　日期：2026-07-02

## 一句話

Neko（WebRTC）→ 共用 headless Chromium + CDP screencast，畫面與輸入全走既有
Channels `/ws`。ssh `-D` SOCKS 段、REST 三 URL、`FirstMessageAuthConsumer`、
`ACTIVE_SESSIONS`+idle GC 全數保留。後端 48 測試綠（本功能新增 38 個）。

## 各 Task 狀態

| Task | 內容 | 狀態 |
|---|---|---|
| Phase 0 | 站起 Chromium、驗證 per-context proxy（8/8） | ✅ GO |
| 1 | 分支 `feat/cdp-remote-browser` | ✅ |
| 2 | `services/cdp_client.py`（Future-based async CDP）+ 12 測試 | ✅ 綠 |
| 3 | 改寫 `remote_browser_service`（保 ssh -D，Neko→CDP）+ 9 測試 | ✅ 綠 |
| 4 | SiteSettings：移 `neko_image`，加 `cdp_url`/`quality`/`every_nth_frame` | ✅ |
| 5 | docker-compose：移 neko-rooms/docker.sock/自訂 image，加 `chromium` | ✅ 驗證 |
| 6 | `RemoteBrowserConsumer`（screencast+輸入橋接）+ 17 測試 | ✅ 綠 |
| 7 | 前端 `remoteBrowser.ts` + `RemoteBrowserPanel.tsx`（canvas+分頁+IME） | ✅ tsc 綠、build 見下 |
| 8 | 清理 Neko（檔案/dynamic.yml/.env/requirements） | ✅ |
| 9 | 端到端驗收 | ⏳ 需在正式 stack 執行（清單見文末） |

## §3 四題最終決定（已落實）

- **A raw CDP**：per-context proxy 風險經 Phase 0 排除，Playwright 保險價值歸零；
  只用 ~12 個 CDP method，backend 不增肥。
- **B 共用一顆 Chrome**，不做 `SESSION_MODE`：以 `restart:always` + consumer 偵測
  CDP 斷線收 session + 前端可重啟緩解爆炸半徑；session 無長期狀態。
- **C 基本 IME 首發**：前端隱形 textarea 收 `compositionend` → `{type:"text"}` →
  後端 `Input.insertText`（Phase 0 G7 + 整合測試皆已驗證中文落字）。頁內 preedit 屬 Phase 4。
- **D 定值 JPEG**，`quality`/`every_nth_frame` 進 SiteSettings，留鉤子；不做自適應。

## 相對委託書的修訂（都有理由，非照抄）

1. **多 worker 正確性（最重要）：Redis-backed session registry。**
   prod 是 gunicorn 多 uvicorn worker；`/start`（REST）與串流 WS consumer 常落在
   不同 worker。委託書用 in-process `ACTIVE_SESSIONS` 存 session，但 consumer 需靠
   `session_id` 反查 `target_id` 並重驗權限——跨 worker 就查不到。
   解法：`ACTIVE_SESSIONS`（本行程）只留 ssh `Popen`（無法序列化）；另用同一顆 Redis
   存跨 worker 查詢欄位（server_id/target_id/context_id/proxy_port，TTL=idle+30s）。
   `get_session`、`stop`（非 owner worker 也能收 CDP context + 刪 Redis）、`ping`
   （續 TTL）、GC（store key 消失即回收 ssh）全數對齊此模型。若不改，正式環境約 2/3 機率
   consumer 連不到自己的 session。

2. **chromium 容器 fail-closed 預設 proxy**（`--proxy-server=socks5://127.0.0.1:1`）。
   Phase 0 G8 驗證：per-context proxy 仍可覆蓋死的預設。任何未走 per-context 設定的
   流量（含潛在 service worker / chrome 內部請求）一律連線失敗，不以容器自身 IP 洩漏身分。

3. **分頁操作全程綁 `browserContextId`**（安全）：client 給的 `target_id` 一律先比對
   「是否屬於本 session 的 context」才 attach/close；`tab list` 只回本 context 的 page。
   擋掉跨 session 竊看他人分頁。整合測試已驗證隔離。

4. **串流用 Future-based CDP + create_task 轉發幀**：委託書 Task 2 的「邊送邊線性讀」
   草案在串流下會漏事件、且若在 reader loop 內 await ack 會 self-deadlock。實作改為背景
   reader + 每幀 `create_task`。以真實 Chromium 驗證：3 秒穩定 28 幀、無 deadlock。

5. **不做 `SESSION_MODE`**（見 §3-B）、**基本 IME**（§3-C）。

6. **附帶修復兩處環境健壯性**（非本功能、但不修就無法跑測試/CI）：
   - `settings.py` `LOG_ROOT`：容器外退回 repo 相對路徑（原本硬寫 `/logs`，CI/本機直跑會崩）。
   - `authorized_keys/signals.py`：`post_migrate` 讀不到 `id_rsa.pub` 時記錄後略過，不再
     讓整個 migrate/test 崩（容器內該檔仍在，行為不變）。可用 `WEB_SERVICE_SSH_PUBKEY` 覆寫路徑。

## 驗證做了什麼（證據）

- **Phase 0 閘門**：真實 headless Chromium + 原生 CDP，8/8 全過（`dev-scripts/cdp_phase0_smoke.py`）。
- **後端單元測試**：`cdp_client` 12 + `remote_browser_service` 9 + `RemoteBrowserConsumer` 17 =
  38 全綠；連同既有測試共 **48 綠**（3 個 SSH-renderer 測試需容器慣例的 `PYTHONPATH=…/tunnels`，
  與本功能無關，補上路徑後亦綠）。
- **真實 Chromium 整合測試**（`dev-scripts/cdp_integration_check.py`，跑既有 `cdp_client.py`）：
  create_session、**串流 28 幀無 ack deadlock**、`insertText` 中文落字、context 隔離
  （tab list 排除他人 target）、`dispose_context` 真的移除 context —— 5/5 全過。
- **前端**：`tsc --noEmit` 對 `remoteBrowser.ts` / `RemoteBrowserPanel.tsx` 無錯；
  `next build` 首次完整成功（TypeScript 通過、12/12 頁生成）。※ 沙箱掛載檔案系統後續
  出現 Turbopack workspace-root/next 解析抖動（`node_modules/next/package.json` 間歇讀不到），
  屬環境而非程式；請在正式環境 `npm ci && npm run build` 覆核一次。

## Task 9 端到端驗收清單（於正式 stack 執行）

- [ ] stack 起：`traefik/frontend/backend/redis/ssh/chromium` 皆 Up，無 neko-rooms/neko-chromium-image。
- [ ] 後端連得到 CDP：`docker compose exec backend python -c "import requests;print(requests.get('http://chromium:9222/json/version').status_code)"` → `200`。
- [ ] 前端「Start Browser」→ 數秒內 canvas 出現網頁；滑鼠可點、鍵盤可打字、中文可用注音/拼音輸入。
- [ ] 可切分頁：工具列 `+` 開新分頁、URL 列 Enter 導覽、點分頁切換、`x` 關分頁。
- [ ] proxy 走目標出口：瀏覽器內開 IP 查詢頁，公網 IP == 目標機器 IP。
- [ ] per-target 隔離：兩 session 各開 → cookie/登入互不影響、各走各 proxy。
- [ ] 斷線/idle：關分頁或斷 WS → context 被 dispose、ssh 收掉、`ACTIVE_SESSIONS`/Redis 清空。
- [ ] **主目標**：只開 443 出站 或 手機熱點（對稱 NAT）下 → 畫面正常（WebRTC/NAT 痛點消失）。
- [ ] `docker compose run --rm backend python manage.py test -v 2` 全綠。
- [ ] 多 worker 專驗（`GUNICORN_WORKERS≥2`）：反覆 start/操作/stop，確認 consumer 不會「session not found」。
- [ ] （可選）正式環境重跑 `dev-scripts/cdp_phase0_smoke.py --cdp-url http://chromium:9222 --socks-host $(hostname)` 覆核 per-context proxy。

## Rollback
- 未合併：`git checkout main` 即回 Neko。
- 已合併：`git revert` 合併 commit，還原 compose/dynamic 的 neko-rooms/`/neko`；
  Neko image 驗收前先別刪。
