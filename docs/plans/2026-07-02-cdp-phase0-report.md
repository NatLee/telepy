# CDP 遷移 Phase 0 評估報告：GO

> 對應計畫：`docs/plans/2026-07-02-cdp-remote-browser.md`（§0 委託說明的「先評估」部分）
> 評估者：Fable（AI 實作代理）／日期：2026-07-02
> 驗證腳本：`dev-scripts/cdp_phase0_smoke.py`（可在正式環境重跑，見下）

## 結論

**GO。** 整個方案的地基假設——「同一顆 headless Chrome 用
`Target.createBrowserContext({proxyServer})` 讓每個 context 走不同 SOCKS」——已用
真實 headless Chromium + 原生 CDP 實測成立，且比計畫要求多驗了五項正確性前提，
8/8 全過。無需改走 KasmVNC fallback。

## 實測結果（Chromium 149 headless_shell，raw CDP，兩顆 mock SOCKS5）

| # | 驗證項 | 結果 | 證據 |
|---|---|---|---|
| G1 | per-context proxy 真的分流 | ✅ | context A 的頁面 body 回 `VIA-A`（該 SOCKS 所服務的內容），context 建立→載入完成僅 0.1s |
| G2 | 同顆 Chrome、兩個 context、兩顆 proxy 互不串流 | ✅ | A 走 A、B 走 B，雙向 cross-talk = 0 |
| G3 | 網域名送進 SOCKS（remote DNS，ATYP=3） | ✅ | `(3, 'probe-a.internal', 80)` — DNS 會在 ssh -D 的目標端解析，符合「以目標身分上網」 |
| G4 | context 間 cookie 隔離 | ✅ | A 設 cookie，B 讀為空 |
| G5 | context/target 在建立它的 CDP 連線關閉後存續 | ✅ | 斷線重連後 target 仍在、proxy 綁定不變 — `/start`（同步 view）先建、consumer 後 attach 的分工成立 |
| G6 | `Page.startScreencast` 出幀 + ack 流程 | ✅ | 5 幀即到、逐幀 ack；1280×720 jpeg q60 簡單頁面約 3KB/幀 |
| G7 | `Input.insertText`（含中文）+ `dispatchKeyEvent` | ✅ | headless 下輸入 `中文測試a` 全數落入 `<input>`（需 `Emulation.setFocusEmulationEnabled`） |
| G8 | fail-closed：browser 預設 proxy 設為死埠，per-context 仍可覆蓋 | ✅ | default context 得 `net::ERR_PROXY_CONNECTION_FAILED`（不會以伺服器身分漏流量），per-context 照常 `VIA-A` |

### 環境差異聲明（誠實範圍）

- 實測用 **headless_shell 149（linux-arm64，Chrome for Testing / Playwright 建置）**，
  與 `chromedp/headless-shell` 是同一個 build target（`//headless:headless_shell`），
  行為等價性極高；但仍建議在正式 stack 起好 chromium 容器後用外部模式重跑一次：
  ```bash
  # 在 backend 容器內（與 chromium 同網路）:
  python3 dev-scripts/cdp_phase0_smoke.py --cdp-url http://chromium:9222 \
      --socks-host $(hostname)
  ```
- 未實測：TLS-over-SOCKS（標準行為，風險低）、service worker 是否吃 per-context
  proxy（見風險表——已用 G8 的 fail-closed 旗標把最壞情況從「漏身分」降為「該站壞掉」）。

## §3 四題裁決

**A. raw CDP vs Playwright → raw CDP。**
關鍵理由：Playwright 的 per-context proxy 底層就是同一個
`Target.createBrowserContext({proxyServer})` CDP 呼叫，**它並不能規避 Phase 0 風險
——而該風險現已實測排除**，Playwright 的保險價值歸零。剩餘價值（輸入/keymap/下載 API）
換不回代價（backend image 增肥 ~400MB、自帶 Chromium 與容器內 chromium 二選一的
架構糾結）。所需 CDP 面積很小（~12 個 method），smoke 腳本已含一個可用的
Future-based async client 參考實作。若日後 plumbing 失控，仍可改
`playwright.connect_over_cdp()` 接同一顆容器 Chrome，架構不變——退路仍在。

**B. 共用 vs per-session → 共用一顆，`SESSION_MODE` 先不做（修訂計畫建議）。**
per-session Chrome 行程要嘛把 chromium 塞進 backend image、要嘛在 chromium 容器內
再寫一個 spawner API——後者就是 neko-rooms 的幽靈。真正的爆炸半徑緩解是：
`restart: always` + consumer 偵測 CDP 斷線即結束 session + 前端可重啟 + session 本來
就是短命的（proxy 瀏覽,無長期狀態）。等實際跑出不穩定證據再回頭做隔離，不預付成本。

**C. CJK/IME → 「基本中文輸入」納入首發，完整 preedit 不做。**
G7 已證 `Input.insertText` 收中文。前端用隱形 textarea 收 `compositionend`，把最終
字串送 `{type:"text"}` → `Input.insertText`（xterm.js 同款手法，~30 行）。使用者可以
用注音/拼音打中文，只是組字中的 preedit 顯示在 overlay 而非頁面內。
這把 KasmVNC 在 §1 的最大優勢消掉大半。頁面內 preedit 還原（`Input.imeSetComposition`）
列 Phase 4。

**D. 編碼/頻寬 → 照計畫：定值 JPEG，參數進 SiteSettings，留鉤子。**
實測數據：q60@720p 簡單頁 ~3KB/幀；一般網頁預估 30–100KB/幀，靜態瀏覽時只有
damage 才出幀。先不做自適應降質與 WebP。

## 對 KasmVNC fallback 的最終對比

KasmVNC 要滿足「per-target 專屬 proxy + 隔離」必然回到一 session 一容器 + spawner
（docker.sock）——正是本次要拔掉的維運複雜度；而它免費送的 CJK 輸入優勢，已被
C 的 insertText 方案以極低成本補上。**維持 CDP 方向，無需改道。**

## 對原計畫的修訂建議（差異點，其餘照案執行）

1. **chromium 容器啟動參數加 `--proxy-server=socks5://127.0.0.1:1`（fail-closed）**：
   G8 已驗證 per-context proxy 可覆蓋死的預設 proxy。這保證任何未走 per-context 設定
   的流量（含潛在 service worker 邊角、chrome 內部請求）一律失敗，而不是以伺服器
   自身 IP 出去。零成本的身分保險。
2. **Task 2 的 `_rpc` 草案不要用「邊送邊線性讀」**：直接做 Future-based reader
   （計畫 Task 6 已預告串流版需要；一套實作兩處共用即可，smoke 腳本 `class CDP` 可抄）。
3. **`SESSION_MODE` 不實作**（見 B），文件記錄 fallback 路徑即可。
4. **前端 Task 7 增加 composition 事件處理**（見 C）。
5. requirements 新增 `websockets>=12`（實測 16.0）。

## 已知殘餘風險（帶緩解）

| 風險 | 等級 | 緩解 |
|---|---|---|
| service worker 請求是否吃 per-context proxy（未實測） | 中→低 | 修訂 1 的 fail-closed 旗標：最壞情況=該站壞，不會漏身分；Task 9 驗收時試 SW 重的站 |
| 共用 Chrome 崩潰 = 全 session 斷 | 中 | restart:always + consumer 偵測斷線收 session + 前端一鍵重啟；session 無長期狀態 |
| JPEG-over-WS 看影片偏卡 | 低（已接受） | SiteSettings 可調 quality/everyNthFrame/maxWidth |
| headless_shell 無專有編解碼（H.264/AAC） | 低 | 部分影音站播不了；VP8/VP9/AV1 可。可換 `browserless/chromium` 若成剛需 |
| 下載/上傳檔案 | 低 | Phase 4：`Browser.setDownloadBehavior` + `DOM.setFileInputFiles` |
| 9222 安全 | — | 不 publish、僅 telepy-network（照計畫） |

## 下一步

依計畫 Task 1–8 實作（TDD），Phase 檢查點交付：
MVP（單分頁可看可操作）→ 分頁/網址列 → 清理 Neko → Task 9 端到端驗收
（含「只開 443 / 對稱 NAT 可用」與「出口 IP == 目標機器」兩條主目標）。
