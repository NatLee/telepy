# CDP 遠端瀏覽器遷移：評估與實作委託書（取代 Neko）

> **這份文件的用途：** 交給一個 AI 實作代理（Fable）**先評估、再實作**。委託者（專案擁有者）認為 CDP 方向可行，但**沒把握能做出來**，因此你的首要任務是「誠實評估可行性 + 先破除關鍵風險」，而**不是**無腦照抄步驟。文件本身自足（self-contained）：即使你沒有先前對話脈絡，也能據此行動。

---

## 0. 給評估者（Fable）的委託說明 — 先讀這段

**你的任務，依序：**

1. **驗證關鍵假設（放行閘門）。** 先做 **Phase 0**：確認「同一顆 headless Chrome 用 `Target.createBrowserContext({proxyServer})` 讓每個 context 走不同 SOCKS」真的成立（出去的 IP == 目標機器 IP）。**這是整個方案的地基**；不過就別往下，改走 fallback。誠實回報 go / no-go。
2. **裁決三個開放決策（見 §3）** 並給明確建議：raw CDP vs Playwright 驅動、共用 Chrome vs 一 session 一 Chrome、CJK/IME 輸入要做到什麼程度。
3. **若你評估後認為 CDP 不划算**，請直說，並和 **KasmVNC fallback**（§1 有比較）誠實對比後建議改道——委託者可接受換方向，但要有根據。
4. **確認可行後才逐 Task 實作**，用 TDD（此 repo 慣例：先寫失敗測試），並在每個 Phase 結束設檢查點讓委託者驗收。**先給一個能動的 MVP（Phase 2：單分頁、看得到＋能操作），再往上疊。**

**委託者的顧慮 =「沒把握做出來」。** 所以本計畫刻意：(a) 把最大風險前置到 Phase 0；(b) 準備 fallback；(c) 分階段、每階段可獨立驗收；(d) 保留與 Neko **並存過渡**的能力（可用旗標切換），失敗能立即回退。請維持這個精神。

**成功長怎樣：** 使用者在網頁點「Start」→ 數秒內畫布出現網頁、能滑鼠鍵盤操作、能開/切分頁；瀏覽器對外流量以**目標機器**身分出去（proxy 正確）；**在只開 443 或手機熱點（對稱 NAT）也能用**（這是離開 Neko 的主因）；不需 docker.sock、不需 UDP 埠段。

---

## 1. 決策脈絡：為什麼走到 CDP（讓你能挑戰這個決定）

**遠端瀏覽器功能的演進史：**

1. **Selenium Grid + standalone-chromium + x11vnc + noVNC** → 太肥大（Java grid＋hub/node＋X＋VNC，一堆 Selenium 開銷）。
2. **Neko（WebRTC）+ neko-rooms** → 目前上線版本，但三個痛點讓委託者想換：
   - **WebRTC/NAT**：要開 UDP+TCP 埠段（59000-59049）、設 `NAT1TO1` IP、受限網路（對稱 NAT／只開 443）要自架 TURN，遠端使用者常連不進來。
   - **維運太複雜**：自訂 image（supervisord 注入 proxy）、掛 `docker.sock`、neko-rooms 多層、每台部署要開防火牆埠段。
   - **功能被綁死**：proxy 只能 env hack、控制模型/自動登入參數脆弱、隨上游改版易壞。
3. **CDP screencast（本計畫）** → 目標終點。

**選項全景（在委託者的三軸上評分）：**

| 方案 | 執行時重量 | 網路 | 功能掌控 | 要自己寫的量 |
|---|---|---|---|---|
| Selenium Grid + noVNC（原） | 🔴 肥大 | 🟢 單埠 | 🟡 中 | 🟢 低（現成） |
| Neko（WebRTC，現況） | 🔴 重：1 容器/session | 🔴 UDP/NAT/TURN | 🔴 綁死 | 🟢 低 |
| KasmVNC | 🟡 中量：X+WM+VNC+Chrome /session | 🟢 單一 WS | 🟢 佳 | 🟡 低～中 |
| **CDP 原生（本計畫）** | 🟢 **最輕：headless Chrome，可共用** | 🟢 純 WS | 🟢🟢 全掌控 | 🔴 高（自建畫面/輸入/keymap/分頁） |
| CDP + Playwright | 🟢 輕（但 backend 帶 Playwright+Chromium） | 🟢 純 WS | 🟢🟢 全掌控 | 🟡 中（lib 處理 proxy/輸入/下載） |

**為什麼是 CDP：** 以「不肥大 + 不要 WebRTC + 不被綁死」三條件，**headless Chrome 是「能跑真實網站的最輕執行時」的地板**——沒有更輕的類別了。CDP 的殺手鐧是 `Target.createBrowserContext({proxyServer})`：**一顆共用 Chrome 內，每個 session 一個 context，各自走各自的 SOCKS**——per-target 隔離 + 專屬 proxy **不需要**任何容器編排、不需要 docker.sock。這正好把「維運複雜」整個拔掉。

**KasmVNC 這個 fallback 的誠實對比（給你評估用，別忽略）：**

- KasmVNC 是 web-native VNC（TigerVNC fork），**單一 WebSocket 埠、無 WebRTC、自帶 HTML5 client**——網路痛點跟 CDP 一樣乾淨，而且前端幾乎是「貼一個 iframe」，**自建量遠低於 CDP**。
- **但對 Telepy 有隱藏成本：** KasmVNC 是「一 session 一桌面（Xvnc）」模型，它**不提供**「依 target 動態生出瀏覽器 + 注入該 target 的 proxy」這層。要滿足「per-target 專屬 proxy + 隔離」，你會被迫回到「一 target 一容器 + 一個 spawner（docker.sock/Docker SDK）+ 動態 Traefik 路由」——**等於把 neko-rooms 的工作重寫一遍**（只是省掉 WebRTC）。所以它只**完全解掉 WebRTC**、**部分解掉維運複雜**（拿掉 proxy hack，但 spawner/docker.sock 又回來了）。
- **KasmVNC 的真優勢（CDP 要自己補的）：** 它是**真桌面**，所以 **CJK/IME 中文輸入、剪貼簿、檔案傳輸、觸控、resize 幾乎免費就能用**；CDP screencast 這些都要自己接，其中 **CJK/IME 輸入是 CDP 最難的一塊**（見 §3 開放問題 C）。Telepy 很在意 CJK，這點請認真權衡。

**一句話定調：** 要**最輕 + 零編排 + 可程式化掌控** → CDP。要**最少前端工 + 人性化功能免費** → KasmVNC（但吞回 spawner）。委託者選 CDP，但要你評估後確認這個取捨對他們划算。

---

## 2. 目標與硬約束（實作不可破壞）

**Goal：** 把「畫面傳輸 + 瀏覽器執行」層從 Neko（WebRTC）換成 **單一 headless Chromium + CDP screencast**，畫面與輸入全走**既有 Django Channels WebSocket（`/ws`）**。

**硬約束（動到就是錯）：**

- **SSH `-D` SOCKS 段原封保留**：`ssh -N -q -D 0.0.0.0:<port> -p <reverse_port> <user>@reverse`，含 `SSH_HOST="reverse"`、兩跳 ControlMaster、`_wait_for_port` 30s 冷啟邏輯。這是「以目標身分上網」的核心，已在正式環境運作。
- **REST 三條 URL 與權限判斷不變**：`browse_views.py` 的 `/start`、`/stop`、`/ping`，以及 `TunnelPermissionManager.check_access` / `TunnelPermissionService.get_allowed_usernames`。views 維持「權限檢查 + pass-through service 回傳」，改動極小（`start` 回傳 `ws_path` 取代 iframe `url`）。
- **沿用既有 Channels 認證慣例**：`FirstMessageAuthConsumer`（`connect()` 立即 `accept()` → 首則訊息 `{"type":"auth","token":...}` 驗 JWT → `after_auth()` 做每-consumer 權限/資源建立 → `on_message()`）。JWT 只在 WS payload、不進 URL/subprotocol。新 consumer **直接繼承它**。
- **需求：可切分頁、per-target 隔離、可嵌入現有面板**。
- **CDP endpoint 不對外**：`chromium:9222` 只掛 telepy-network、不 publish 到 host。

**環境事實（供你對照）：** 後端 Python 3.12 / Django 6.0 / DRF 3.17 / Channels 4.3 / channels_redis；prod ASGI 用 gunicorn+uvicorn worker，dev 用 daphne runserver；Traefik v3.7.6（`readTimeout:0` 已設，長連線安全）；前端 Next.js（App Router）/ TypeScript / Tailwind。`requests` 已在相依；**需新增 `websockets`（async CDP client）**。

---

## 3. 必須先解決的開放問題（需要你的判斷與建議）

> 請在動工前，於 PR 描述或回覆中，對這四題各給一個「決定 + 理由」。

**A. raw CDP vs Playwright 驅動？**
本文件主線寫 raw CDP（最少相依、最輕）。但 Playwright 的 `browser.new_context(proxy=...)` **官方支援 per-context proxy**，能直接消掉 Phase 0 的最大風險，還內建輸入/keymap/下載/檔案選擇/分頁 API。代價：backend 帶 Playwright + 它自帶的 Chromium（image 變胖），且串流仍要自己接（Playwright 不給你 web viewer）。**你的建議？** 若判斷 raw CDP 的 per-context proxy 風險高、或想省後端 plumbing，可改 Playwright 版；consumer / 前端幾乎不變。

**B. 共用 Chrome vs 一 session 一 Chrome？**
主線是「一顆共用 Chrome + 多 context」（最省資源）。風險：Chrome 掛掉 = 所有 session 中斷（爆炸半徑大）。fallback：一 session 一 Chrome 行程（行程級隔離、per-context proxy 風險歸零，但較耗資源、仍遠比 Neko 輕）。**建議做成可切換的 `SESSION_MODE`**，預設 `shared`，risk 高時切 `per-session`。

**C. CJK / IME 中文輸入要做到什麼程度？**
CDP screencast 下，中文**顯示**沒問題（裝 `fonts-noto-cjk` 即可），但中文**輸入（IME 組字）**是最難的一塊：得攔前端 `compositionstart/update/end`、把最終字串用 `Input.insertText` 送、組字中的 preedit 難完美還原。**請評估使用者是否真的需要在被代理的瀏覽器裡打中文**：
- 若「幾乎只是導覽/點擊/貼網址」→ 一般英數 + `onPaste` 貼上就夠，IME 列 Phase 4 或不做。
- 若「需要大量中文輸入」→ 這是 KasmVNC 明顯較省的地方，值得回頭重估方案。

**D. 畫面編碼與頻寬策略？**
JPEG-over-WS 比 VP8 重；靜態/表單順、高幀率影片偏卡（可接受）。主線用 `Page.startScreencast({format:jpeg, quality, everyNthFrame, maxWidth})`，參數進 `SiteSettings` 可調。**是否需要**依連線狀況自動降質、或 WebP？先做定值、留鉤子即可。

---

## 4. 現況架構（要被改寫／移除的部分）

- `src/backend/authorized_keys/remote_browser_service.py` — `ssh -D` + `neko_rooms_client` 建/刪房間 + `ACTIVE_SESSIONS` + 背景 GC/對帳 thread。**ssh -D 段保留，Neko 段換 CDP。**
- `src/backend/services/neko_rooms_client.py`(+ tests) — **刪除**。
- `docker/neko-chromium/`（`Dockerfile` + `chromium.conf`）— **刪除**（不再需要 supervisord 注入 proxy 的自訂 image）。
- `docker-compose.yml` — 移除 `neko-rooms`、`neko-chromium-image`、`docker.sock`；新增 `chromium` service。
- `src/configs/traefik/dynamic.yml` — 移除 `/neko` router/service。**不新增路由**（畫面走既有 `/ws`）。
- `.env.example` — 移除 `NEKO_EPR_RANGE` / `NEKO_NAT1TO1_IP`。
- `src/backend/site_settings/models.py` — 移除 `remote_browser_neko_image`，改加 CDP/screencast 設定。
- `src/frontend/src/components/tunnels/RemoteBrowserPanel.tsx` — iframe → `<canvas>` + 分頁列 + WS client。

（不動：`browse_views.py` 權限與 URL、`FirstMessageAuthConsumer`、`ACTIVE_SESSIONS`/idle GC 骨架、ssh -D。）

---

## 5. 目標架構（CDP）與關鍵決策

```
使用者瀏覽器（client）
   │  1) POST /api/reverse/server/<id>/remote-browser/start   (JWT, 既有權限檢查)
   │        ← { session_id, ws_path: "/ws/remote-browser/<session_id>/" }
   │  2) WebSocket /ws/remote-browser/<session_id>/   (經 Traefik /ws → backend)
   ▼        首則訊息帶 JWT（FirstMessageAuthConsumer 慣例）
Django Channels：RemoteBrowserConsumer(FirstMessageAuthConsumer)
   │  雙向橋接：
   │   • CDP Page.screencastFrame（JPEG/base64） → client         → <canvas> 繪圖
   │   • client 滑鼠/鍵盤/滾輪 → CDP Input.dispatch{Mouse,Key}Event
   │   • client 導覽/新分頁/切分頁/關分頁 → CDP Target.* / Page.navigate
   ▼  CDP over WebSocket（ws://chromium:9222，僅 telepy-network，不對外）
共用 headless Chromium 容器（chromedp/headless-shell）
   │  每個 session：Target.createBrowserContext({ proxyServer:"socks5://backend:PORT",
   │                                              proxyBypassList:"<-loopback>" })
   │               Target.createTarget({ browserContextId }) → 分頁（可多開）
   ▼  SOCKS5
ssh -D 0.0.0.0:PORT（跑在 backend 容器內，維持現狀）
   ▼  兩跳反向隧道（不變）
目標裝置 —— 對外流量以「目標機器」身分出去
```

**關鍵決策：**

1. **共用 Chrome + per-context proxy**（見 §3-A/B）：context 與 target 是 browser 層級物件，`/start` 建立後即使建立它的 CDP 連線關掉也**持續存在**，consumer 之後再連 CDP `attachToTarget` 接手串流。
2. **畫面走 WebSocket 不走 WebRTC**：本次遷移的核心動機；穿透任何能開網頁的網路。
3. **分頁列自己畫**：headless screencast 只擷取頁面內容、無瀏覽器 chrome，故前端用 CDP targets 自建分頁/網址列——同時滿足「可切分頁」且完全掌控 UX。
4. **CDP 連線分工**：一次性控制（建/關 context、建 target）在 `/start`/`/stop`（同步 DRF view）內用 `async_to_sync` 呼叫；串流在 async consumer 內長連線 CDP。
5. **安全**：`9222` 不對外；consumer `after_auth` **重驗 tunnel 權限**（不只驗 JWT）。
6. **image**：用現成 `chromedp/headless-shell`（就是「Chrome + CDP endpoint」）；唯一可能自訂 = 補 CJK 字型的 ~4 行 Dockerfile（無 supervisord），或用內建字型的 `browserless/chromium`。

---

## 6. 檔案切分

**新增**
- `src/backend/services/cdp_client.py` — 薄 async CDP client。
- `src/backend/services/tests/test_cdp_client.py`
- `RemoteBrowserConsumer`（放進 `tunnels/consumers.py` 或新檔再 re-export）。
- `src/backend/authorized_keys/tests/test_remote_browser_service.py`（改寫版）。
- `docker/chromium/Dockerfile`（可選，含 CJK 字型）。
- `src/frontend/src/lib/remoteBrowser.ts` — WS client + 輸入編碼 + 美式 keymap。

**修改**
- `remote_browser_service.py`、`browse_views.py`（幾乎不動）、`tunnels/routing.py`、`site_settings/{models,serializers,admin}.py`(+migration)、`docker-compose.yml`、`dynamic.yml`、`RemoteBrowserPanel.tsx`、`.env.example`、`requirements.txt`（加 `websockets`）。

**刪除**
- `services/neko_rooms_client.py`(+test)、`docker/neko-chromium/`。

**依賴順序**：Phase 0（閘門）→ Task 2(cdp_client) → Task 3(service) → Task 6(consumer)；Task 7(前端) 可並行；最後整合。

---

## Phase 0：站起 Chromium 並驗證 per-context proxy（放行閘門 — 先做）

- [ ] **起一顆 headless Chrome**
```bash
docker run -d --rm --name cdp-smoke --shm-size=2g -p 9222:9222 \
  chromedp/headless-shell:latest \
  --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 \
  --no-sandbox --disable-dev-shm-usage
sleep 3 && curl -s http://localhost:9222/json/version | head
```
Expected：JSON 含 `webSocketDebuggerUrl`。

- [ ] **（關鍵）驗證 per-context proxy 真的分流。** 準備一個測試 SOCKS（任一可 SSH 機器 `ssh -D 1080`），用原生 CDP：`Target.createBrowserContext({proxyServer:"socks5://<host>:<port>"})` → `Target.createTarget` 開 `https://ifconfig.me` → 抓 body。
Expected：**出去的公網 IP == 該 SOCKS 機器 IP**（非本機）。
  - ✅ 命中 → 採主線（共用 Chrome + per-context proxy）。
  - ❌ 不吃 → 切 fallback（§3-A/B：Playwright，或一 session 一 Chrome + `--proxy-server`）；其餘 Task 不變。

- [ ] **（可選）中文豆腐字才建自訂 image**
```dockerfile
# docker/chromium/Dockerfile
FROM chromedp/headless-shell:latest
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
```

- [ ] **記錄決策**：`SESSION_MODE`、image、raw-CDP-or-Playwright（§3 四題）寫進 PR。

---

## Task 1：分支
- [ ] `git checkout -b feat/cdp-remote-browser`

## Task 2：CDP client（`services/cdp_client.py`）

CDP = WebSocket 上的 JSON-RPC：請求 `{"id":N,"method":...,"params":...}`；attach target 後對該 target 的請求帶 `sessionId`（`flatten:true`）。browser endpoint 由 `GET /json/version` 的 `webSocketDebuggerUrl` 取得。

- [ ] **先寫失敗測試**（mock `requests.get` 取 version、mock `websockets` 收送，斷言 `create_session` 送出帶 `proxyServer` 的 `Target.createBrowserContext` → `Target.createTarget` 帶 `browserContextId`，回 `{context_id, target_id}`）。
- [ ] **實作（介面草案，依 TDD 收斂）：**
```python
# services/cdp_client.py
import os, json, itertools, requests, websockets

class CdpError(Exception): ...

class CdpClient:
    def __init__(self, base_url=None):
        self.base_url = (base_url or os.getenv("CHROMIUM_CDP_URL", "http://chromium:9222")).rstrip("/")

    def _browser_ws(self) -> str:
        r = requests.get(f"{self.base_url}/json/version", timeout=5); r.raise_for_status()
        return r.json()["webSocketDebuggerUrl"]

    async def _rpc(self, ws, method, params=None, session_id=None, _ids=itertools.count(1)):
        mid = next(_ids)
        msg = {"id": mid, "method": method, "params": params or {}}
        if session_id: msg["sessionId"] = session_id
        await ws.send(json.dumps(msg))
        while True:                       # 一次性操作可線性讀；串流版必須改 Future-based（見 Task 6）
            data = json.loads(await ws.recv())
            if data.get("id") == mid:
                if "error" in data: raise CdpError(data["error"])
                return data.get("result", {})

    async def create_session(self, proxy_server: str) -> dict:
        async with websockets.connect(self._browser_ws(), max_size=None) as ws:
            ctx = await self._rpc(ws, "Target.createBrowserContext",
                                  {"proxyServer": proxy_server, "proxyBypassList": "<-loopback>"})
            cid = ctx["browserContextId"]
            tgt = await self._rpc(ws, "Target.createTarget",
                                  {"url": "about:blank", "browserContextId": cid})
            return {"context_id": cid, "target_id": tgt["targetId"]}

    async def dispose_context(self, context_id: str) -> None:
        async with websockets.connect(self._browser_ws(), max_size=None) as ws:
            await self._rpc(ws, "Target.disposeBrowserContext", {"browserContextId": context_id})
```
> Playwright fallback：`create_session` 改為 `browser.new_context(proxy={"server": proxy_server})` + `context.new_page()`；consumer/前端不變。

- [ ] 測試綠 → commit。

## Task 3：改寫 `remote_browser_service`（保留 ssh -D，Neko → CDP）

- [ ] **改寫測試**（沿用三案：建 session 帶 `socks5://` proxy 且登記 / 建失敗要收 ssh / stop 要 dispose context + 收 ssh；把 `_neko` 換 `_cdp`、`create_room`→`create_session`、`delete_room`→`dispose_context`）。
- [ ] **改寫 service**（保留 `get_free_port`/`_wait_for_port`/`ACTIVE_SESSIONS`/GC 骨架與 ssh -D，只換「建/刪瀏覽器」與回傳）：
```python
from services.cdp_client import CdpClient, CdpError
from asgiref.sync import async_to_sync
_cdp = CdpClient()

def start_remote_browser(target_username, target_reverse_port, server_id):
    settings = SiteSettings.get_solo()
    max_sessions = getattr(settings, "remote_browser_max_sessions", 10)
    if max_sessions and _count_active() >= max_sessions:
        raise Exception("...concurrent user limit...")

    proxy_port = get_free_port()
    ssh_cmd = f"ssh -N -q -D 0.0.0.0:{proxy_port} -p {target_reverse_port} {target_username}@{SSH_HOST}"
    ssh_process = subprocess.Popen(ssh_cmd, shell=True)                       # 不變
    ssh_timeout = getattr(settings, "remote_browser_ssh_timeout", 30)
    if not _wait_for_port("127.0.0.1", proxy_port, timeout=ssh_timeout, proc=ssh_process):
        ssh_process.terminate(); raise Exception("Failed to start SSH proxy ...")

    session_id = str(uuid.uuid4())
    with _SESSIONS_LOCK:
        ACTIVE_SESSIONS[session_id] = {"ssh_process": ssh_process, "proxy_port": proxy_port,
            "server_id": server_id, "context_id": None, "target_id": None, "last_seen": time.time()}

    proxy_host = os.getenv("HOSTNAME", "backend")     # chromium 容器經 telepy-network 連回
    try:
        ids = async_to_sync(_cdp.create_session)(f"socks5://{proxy_host}:{proxy_port}")
    except CdpError as e:
        stop_remote_browser(session_id); raise Exception(f"Failed to create CDP session: {e}")

    with _SESSIONS_LOCK:
        if session_id in ACTIVE_SESSIONS:
            ACTIVE_SESSIONS[session_id].update(context_id=ids["context_id"], target_id=ids["target_id"])
    return {"session_id": session_id, "ws_path": f"/ws/remote-browser/{session_id}/"}

def stop_remote_browser(session_id):
    with _SESSIONS_LOCK: session = ACTIVE_SESSIONS.pop(session_id, None)
    if not session: return False
    ctx = session.get("context_id")
    if ctx:
        try: async_to_sync(_cdp.dispose_context)(ctx)
        except CdpError as e: logger.warning(f"dispose context {ctx} failed: {e}")
    proc = session.get("ssh_process")
    if proc:
        try: proc.terminate(); proc.wait(timeout=5)
        except Exception:
            try: proc.kill()
            except Exception: pass
    return True
```
- `ping_remote_browser` / `cleanup_dead_sessions`(idle GC) 照舊；`_reconcile_orphan_rooms` → `_reconcile_orphan_contexts`（列 Chrome 內 context，關掉不在 `ACTIVE_SESSIONS` 的；或直接靠 stop+idle GC 移除對帳）。新增 `get_session(session_id)` 給 consumer 取 `target_id`/校驗歸屬。
- [ ] 測試綠 → commit。

## Task 4：SiteSettings 欄位調整
- [ ] 移除 `remote_browser_neko_image`；新增 `remote_browser_cdp_url`(default `http://chromium:9222`)、`remote_browser_screencast_quality`(60)、`remote_browser_screencast_every_nth_frame`(1)。serializers `fields`/`create`/`update` 與 admin `list_display` 同步。`makemigrations && migrate`（此 repo `.gitignore` 排除 migration，commit 只含三個 .py）。→ commit。

## Task 5：docker-compose（移除 Neko、加 chromium）
- [ ] 移除 `neko-rooms`、`neko-chromium-image` 與 `docker.sock`；backend `depends_on` 改 `chromium`、env `NEKO_ROOMS_API`→`CHROMIUM_CDP_URL=http://chromium:9222`。新增：
```yaml
  chromium:
    <<: [ *common-networks, *common-restart ]
    image: chromedp/headless-shell:latest   # 或 telepy-chromium:latest（含 CJK 字型）
    container_name: telepy-chromium-${PROJECT_NAME}
    shm_size: "2gb"
    command:
      - "--remote-debugging-address=0.0.0.0"
      - "--remote-debugging-port=9222"
      - "--no-sandbox"
      - "--disable-dev-shm-usage"
    # 不 publish 9222：只在 telepy-network 內
```
- [ ] `docker compose config >/dev/null && echo ok` → commit。

## Task 6：Channels consumer（screencast 串流 + 輸入橋接）
- [ ] **routing 加一條**：`re_path(r'ws/remote-browser/(?P<session_id>[0-9a-f-]+)/$', consumers.RemoteBrowserConsumer.as_asgi())`
- [ ] **`RemoteBrowserConsumer(FirstMessageAuthConsumer)`**
  - `after_auth(user, message)`：取 URL 的 `session_id` → `svc.get_session()`（無則關閉）→ 由 session 的 `server_id` 找 tunnel，`TunnelPermissionManager.check_access(user, tunnel, VIEW)`（不過回 4403）→ 連 CDP、`Target.attachToTarget({targetId, flatten:true})` 取 `sessionId` → `Page.enable` → `Page.startScreencast({format:"jpeg", quality, everyNthFrame, maxWidth, maxHeight})` → 起背景 reader。
  - reader：遇 `Page.screencastFrame` → `send({type:"frame", data, metadata})` → 回 `Page.screencastFrameAck({sessionId})`。
  - `on_message`：`mouse`→`Input.dispatchMouseEvent`；`key`→`Input.dispatchKeyEvent`；`navigate`→`Page.navigate`；`tab(new/switch/close/list)`→`Target.createTarget/activateTarget/closeTarget/getTargets`（切分頁 = 停舊 target screencast、attach 新 target、重啟）；`resize`→`Emulation.setDeviceMetricsOverride`＋重設 screencast 尺寸。
  - `disconnect()`：停 screencast、關 CDP；建議 WS 斷線即 `svc.stop_remote_browser(session_id)`（idle GC 當後備）。務必 `super().disconnect()`。
  - **正確性要點**：(1) 串流版 CDP 需**背景 reader + Future 對應**（不能像 Task 2 草案邊送邊線性讀，會漏事件）；(2) 座標用 CSS 像素（除 devicePixelRatio），`setDeviceMetricsOverride` 尺寸要與前端 canvas 邏輯尺寸一致；(3) 鍵盤需 `windowsVirtualKeyCode/code/key/text`，用美式 keymap（可取 puppeteer `USKeyboardLayout` 的值），一般打字+貼上先做，IME 見 §3-C。
- [ ] commit。

## Task 7：前端（iframe → canvas + 分頁列）
- [ ] **`src/lib/remoteBrowser.ts`**：封裝 WS（connect(ws_path)→首則送 `{type:"auth",token}`→`onFrame(cb)`），提供 `sendMouse/sendKey/navigate/newTab/switchTab/closeTab/resize`，內含美式 keymap。
- [ ] **`RemoteBrowserPanel.tsx`**：`start` 流程不變，改讀 `data.ws_path`→補成絕對 `ws(s)://.../ws/remote-browser/<id>/` 開 WS。移除 `<iframe>`，放 `<canvas>`：`onFrame`→`createImageBitmap`/`img.src=data:...`→drawImage；`onMouse*`/`onWheel`/`onContextMenu`(preventDefault)→`sendMouse`；`tabIndex=0`+`onKeyDown/Up`(preventDefault)→`sendKey`；`onPaste`→送剪貼簿文字。上方薄工具列：← → ⟳、網址列(Enter→navigate)、分頁列(每 target 一顆，+/x/點擊切換)。`ResizeObserver`→resize。保留 heartbeat/beforeunload（或以 WS 存活取代 ping）。文案 `Neko`→`Proxy Browser`。
- [ ] `npm run build` 綠 → commit。

## Task 8：清理
- [ ] `git rm services/neko_rooms_client.py + test`；`git rm -r docker/neko-chromium`；`dynamic.yml` 移除 `/neko`；`.env.example` 移除 NEKO 區塊；正式主機可關 59000-59049 防火牆規則。→ commit。

## Task 9：端到端驗收（成功標準）
- [ ] stack 起：`traefik/frontend/backend/redis/ssh/chromium` 都 Up，**無** neko-rooms/neko-chromium-image。
- [ ] 後端連得到 CDP：`docker compose exec backend python -c "import requests;print(requests.get('http://chromium:9222/json/version').status_code)"` → `200`。
- [ ] UI 啟動 → 數秒內 canvas 出現網頁；滑鼠可點、鍵盤可打字。
- [ ] **可切分頁**：工具列 `+` 開新分頁、輸入不同網址、點分頁切換 → 畫面跟著切。
- [ ] **proxy 走目標出口**：瀏覽器內開 IP 查詢頁，公網 IP == 目標機器 IP。
- [ ] **per-target 隔離**：兩個 target 各開 session → cookie/登入互不影響、各走各 proxy。
- [ ] **idle GC/斷線**：關分頁或斷 WS → context 被 dispose、`ssh` 收掉、`ACTIVE_SESSIONS` 清空。
- [ ] **WebRTC/NAT 痛點消失（主目標）**：只開 443 出站 或 手機熱點（對稱 NAT）下連入 → 畫面正常。
- [ ] `docker compose run --rm backend python manage.py test -v 2` 全綠。
- [ ] merge。

---

## Rollback / 過渡策略
- 未合併前 `git checkout main` 即回 Neko；已合併 `git revert` 合併 commit，還原 compose/dynamic 的 neko-rooms/`/neko`。
- Neko image（`m1k1o/neko-rooms`、`telepy-neko-chromium`）驗收前**先別刪**。
- **可並存過渡**：保留兩套 service class，以 `SiteSettings`/env 旗標切 `start_remote_browser` 走 CDP 或 Neko，灰度驗證後再刪 Neko。（降低「沒把握」的風險）

## 已知風險（實作前再確認一次）
- **per-context proxy 可靠性（最高）** → Phase 0 閘門；fallback Playwright / per-session Chrome。
- **共用 Chrome 爆炸半徑** → `restart:always` + consumer 偵測 CDP 斷線即結束 session + 前端可重連；必要時切 per-session。
- **CJK/IME 輸入** → §3-C；一般英數+貼上先行，完整 IME 屬 Phase 4，或據此重估 KasmVNC。
- **頻寬/影片** → JPEG-over-WS 靜態順、影片偏卡；`quality`/`everyNthFrame`/`maxWidth` 調節。
- **screencast 無原生 chrome** → 分頁列/網址列自建（Task 6/7）。
- **下載/上傳** → `Browser.setDownloadBehavior`/`DOM.setFileInputFiles`，涉跨容器檔案，列 Phase 4。
- **CDP endpoint 安全** → `9222` 絕不 publish；只在 telepy-network。

## 附：需求涵蓋對照
WebRTC/NAT→純 WS(決策2、Task9)；維運複雜→移除 docker.sock/neko-rooms/自訂 image/埠段(Task5/8)；功能綁死→proxy 為參數、分頁/導覽/剪貼簿自控、chrome 自建(決策3、Task6/7)；可切分頁→Task6/7+Task9；per-target 隔離→一 session 一 context+專屬 proxy；ssh -D 不變→Task3；相容既有慣例→FirstMessageAuthConsumer/`/ws`/browse_views pass-through/ACTIVE_SESSIONS+idle GC。
