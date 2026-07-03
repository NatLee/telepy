# KasmVNC 遠端瀏覽器遷移 — 交接給 Claude Code

> **這份文件的用途:** 交給 Claude Code 接手「把 remote-browser 從 TigerVNC 遷到 KasmVNC」的收尾。
> 後端已完成並測綠;**卡在一個 runtime 連線問題(已備好修法待驗)**,以及**最後一大塊:前端改用
> KasmVNC 自家 client**。本文自足:只讀這份 + repo 就能接著做,不必重新查 KasmVNC 的雷。
> 深度細節見 `docs/plans/2026-07-03-kasmvnc-corrected-plan.md`(§編號皆指該文)。

---

## 0. Claude Code 請依序做這四件事

1. **先把目前 WIP 提交到分支**(下面的變更目前是未提交的工作區改動)。
   ```bash
   cd <repo>
   # 若 git 抱怨 lock:rm -f .git/index.lock .git/*.lock .git/refs/heads/*.lock
   git checkout -b feat/kasmvnc-wsproxy      # 從 feat/vnc-remote-browser 切出;未提交改動會跟過來
   git add docker/kasm-browser src/backend/tunnels src/backend/services \
           src/backend/authorized_keys requirements.txt docker-compose.yml \
           dev-scripts/phase0_kasmvnc_probe.py docs/plans
   git commit -m "feat(remote-browser): migrate to KasmVNC (WS↔WS relay, auth, homepage/anti-bot/profile)"
   ```
   > `src/frontend/src/app/layout.tsx` 與 `globals.css` 有使用者**無關的**字型改動,別混進來。
2. **驗證上游 WS 能連**(§3)。這是目前的即時阻塞,修法已就緒,需 rebuild + 看 log 確認;若仍失敗,照 §3 的除錯樹。
3. **做前端**(§4)——本遷移剩下的主要工程:stock noVNC 連不上 KasmVNC,必須改用 KasmVNC 自家 client。
4. **端到端驗收**(§5)。全過 → 準備 merge。

**回退隨時可用:** `git checkout feat/vnc-remote-browser`(TigerVNC,raw-RFB,stock noVNC,已測可用)。
前端(step 3)完成前**別上 prod**——現況 stock noVNC 配 KasmVNC 後端是黑畫面。

---

## 1. 這個遷移是什麼(脈絡)

把 remote-browser 的 VNC server 從 **TigerVNC** 換成 **KasmVNC**(動機:更佳的動態編碼/影片串流 +
原生 seamless 剪貼簿/IME,直接滿足使用者「剪貼簿+中文輸入」需求)。

**一個關鍵事實(委託書原本弄錯了):** KasmVNC 已脫離 RFB 規範,**stock `@novnc/novnc` 連不上**,
必須用 KasmVNC 自己 fork、baked 在 server 裡的 web client。因此:
- **後端** = Django consumer 做 **WS↔WS 中繼**(連 KasmVNC 的 websocket)。✅ 已完成。
- **前端** = 必須改用 **KasmVNC 的 client**(不是 stock noVNC)。⏳ 未做(§4)。

---

## 2. 現況(DONE / 待驗 / TODO)

| 區塊 | 狀態 | 說明 |
|---|---|---|
| 後端 session 生命週期(session_manager → Xkasmvnc,回 ws_port) | ✅ 完成+測綠 | 含 Google 首頁、反爬蟲旗標、保留共用設定檔 |
| kasm_client / remote_browser_service → ws_port + profile_key | ✅ 完成+測綠 | ssh -D / GC 骨架不動 |
| consumer → WS↔WS 中繼(握手/權限/斷線收尾保留) | ✅ 完成+測綠 | 含 scheme/path 自動退回 + Basic Auth |
| Dockerfile 裝 KasmVNC 1.4.0 + kasmvnc.yaml + 建 Basic Auth 使用者 | ✅ 完成 | build 時驗證 Xkasmvnc / 密碼檔 |
| 單元測試(34 個) | ✅ 全綠(真 stack,Django 6/py3.12) | 見 §8 指令 |
| 上游 WS 連線(auth/path) | ✅ **已通(2026-07-03)** | 密碼檔修法有效;真正最後一雷是 **`Sec-WebSocket-Origin`**(§3);probe PASS、consumer 已加 header |
| 前端改用 KasmVNC client | ✅ **完成(Option B,2026-07-03)** | vendor kasmtech/noVNC v1.3.0 至 `src/frontend/src/vendor/kasm-novnc/`(見該 README);`npm run build` 綠 |
| 端到端驗收 | 🔶 自動化部分過(2026-07-03) | 全鏈 relay E2E 過:auth→ready→begin→RFB 雙向→斷線收 session;雙 session 隔離(:10/:11、各自 profile)過。**剩視覺/互動項**(桌面畫面、滑鼠鍵盤、中文 IME/剪貼簿、proxy 出口 IP)需真人開 UI 驗(§5) |

沙箱限制(為何沒幫你 rebuild/驗端到端):無 Docker、無 sudo、Python 3.10(裝不了 Django 6)、git 被
lock。所以後端邏輯是用 Django 5.2 在沙箱測綠;KasmVNC 本體/前端/端到端要在真環境跑。

---

## 3. 即時阻塞:讓上游 WS 連上(auth/path)

### 症狀(最後一輪 log)
consumer 逐一試候選都失敗:`ws://…/api/vnc → 401`、`ws://…/websockify → RST`、`wss://… → ConnectionReset`。
隨後 kasm-browser 出現 `Missing X server` / `X connection to :10 broken`(這是**連帶症狀**:上游連不上 →
consumer 回 4011 → WS 關 → disconnect 收掉 session → Xkasmvnc 被殺 → chromium 看到 X 消失)。

### 已釘死的事實(來自 Xvnc/vncpasswd man + 兩輪實測,別再重猜)
- 埠是**純 ws**(`-sslOnly` 預設關)。不要用 wss。
- 真正的 ws 端點是 **`/websockify`**;缺帳密時 KasmVNC 直接 RST(不回乾淨 401)。
- **(2026-07-03 解掉的最後一雷)** KasmVNC 的 websocket 檢查要求 **`Sec-WebSocket-Origin`**
  header(Hixie 時代 legacy header;Python `websockets` 等非瀏覽器 client 不會送)。缺了它
  `/websockify` 回 **404**(log:`request failed websocket checks, missing Sec-WebSocket-Origin
  header`),不是 401!帶上(值不驗)即回 101。consumer 的 `_ws_connect` 與 probe 都已加上。
- 整台 KasmVNC web 層**要 HTTP Basic Auth**;`-disableBasicAuth` 在此 1.4.0 build **無效** → 改用「建
  使用者 + 帶 Authorization header」。
- **最後一個雷(本次修的)**:密碼檔若用預設 `${HOME}/.kasmpasswd`,build 時 HOME=/root 但 runtime
  PID1 的 HOME 未必是 /root → Xkasmvnc 找不到使用者 → **任何帳密都 401**。

### 已就緒的修法(已寫進碼,待驗)
- `docker/kasm-browser/Dockerfile`:`kasmvncpasswd -u telepy -w /etc/kasmvnc/kasmpasswd`(**固定路徑**)。
- `docker/kasm-browser/session_manager.py`:`Xkasmvnc … -KasmPasswordFile /etc/kasmvnc/kasmpasswd -httpd
  /usr/share/kasmvnc/www …`,且會 `logger.info("spawn vnc: …")` 印出實際旗標。
- `src/backend/tunnels/consumers.py`:連上游帶 `Authorization: Basic base64(telepy:telepyvnc)`;預設
  scheme=ws、path=/websockify;保留 scheme/path 自動退回。
- 帳密由 `docker-compose.yml` 同一組 `.env` 控制(backend env `KASM_WS_USER/PASSWORD` = kasm-browser
  build args `KASMVNC_USER/PASSWORD`,預設 `telepy` / `telepyvnc`)。

### 驗證步驟
```bash
docker compose up -d --build kasm-browser backend    # Dockerfile + session_manager 都改了,必須重 build
docker compose logs -f kasm-browser backend
```
- kasm-browser log 應出現:`spawn vnc: Xkasmvnc :10 … -KasmPasswordFile /etc/kasmvnc/kasmpasswd -httpd …`
- backend log 應出現:`remote-browser(vnc): upstream connected ws://kasm-browser:8453/websockify`
- 到這裡 session 就不再被秒收(接著會遇到 §4 的黑畫面 = 正常,前端還沒換)。

### 若仍失敗 — 除錯樹
```bash
# (a) 密碼檔在不在、有沒有內容:
docker compose exec kasm-browser sh -lc 'ls -l /etc/kasmvnc/kasmpasswd; wc -c /etc/kasmvnc/kasmpasswd'
#   空/不存在 → kasmvncpasswd 的 prompt 餵入方式要改成 PTY(用 python3 -c 'import pty…' 餵兩次密碼)。
# (b) 起一顆 standalone Xkasmvnc,用探測腳本確認 path/scheme/auth(不會被 session 收掉):
docker compose exec kasm-browser bash -lc \
  'Xkasmvnc :20 -geometry 1280x720 -depth 24 -SecurityTypes None -disableBasicAuth \
   -KasmPasswordFile /etc/kasmvnc/kasmpasswd -websocketPort 8463 -httpd /usr/share/kasmvnc/www \
   -interface 0.0.0.0 & sleep 3'
docker compose cp dev-scripts/phase0_kasmvnc_probe.py kasm-browser:/tmp/probe.py
docker compose exec kasm-browser python3 /tmp/probe.py --port 8463 --user telepy --password telepyvnc
#   PASS → 記下它印的 KASM_WS_SCHEME/PATH;NO-GO → 逐行看原因(401=帳密不符;只 wss=TLS;全連不上=path)。
# (c) 直接驗帳密(容器內若有 curl):
docker compose exec kasm-browser sh -lc 'curl -si -u telepy:telepyvnc http://127.0.0.1:8463/api/vnc | head -3'
```
> dbus 的 `Failed to connect to /run/dbus/system_bus_socket` 是**非致命警告**,先忽略。要消可用
> `dbus-run-session -- chromium …` 包一層(改 `BROWSER_CMD` 或 session_manager)。

---

## 4. 主要剩餘工程:前端改用 KasmVNC 的 client

現況 `src/frontend/src/components/tunnels/RemoteBrowserPanel.tsx` 用 `@novnc/novnc`(stock)→ **連得上
但畫面黑/協定錯**,因為 KasmVNC 不相容 stock noVNC。後端(WS↔WS 中繼在既有 `/ws`)直接支援 **Option B**;
B 卡住再退 **Option A**。握手協定(前端 `auth → ready → attach client → begin`)兩者都要保留。

### Option B(建議先試):vendor KasmVNC 的 noVNC fork,接既有 `/ws`
1. 取得 client(擇一):
   - `npm i 'github:kasmtech/noVNC#<tag>'`,或
   - 從已 build 的 image 取:`docker compose cp kasm-browser:/usr/share/kasmvnc/www ./src/frontend/vendor/kasmvnc-www`
2. `RemoteBrowserPanel.tsx`:把 `import RFB from "@novnc/novnc/lib/rfb"` 換成 KasmVNC fork 的 `RFB`;
   **握手與 `new RFB(el, ws, {shared:true})` 用法保持不變**。
3. `cd src/frontend && npm run build` 要能過;連上活的 KasmVNC 驗:畫面出來、滑鼠鍵盤、**中文可貼(seamless
   剪貼簿)**、IME。
4. 開 DevTools Network:若 client 對 same-origin 發 **HTTP** 請求(`/api/…`、settings 等)且 404 → 它不只靠
   ws → **改走 Option A**。

### Option A(fallback):反向代理 KasmVNC 內建 web UI + iframe
把 KasmVNC 的 HTTP + WS 整包經 Django 代理(session/JWT + tunnel 權限閘),前端用 `<iframe>` 載入。
注意 KasmVNC 送 `COEP: require-corp` / `COOP: same-origin`(iframe 內嵌要同源或在代理層改寫這兩個 header)。
詳見修正版計畫 §4 的 Option A。

---

## 5. 端到端驗收清單

- [ ] `docker compose up -d --build`;`Xkasmvnc` 起得來、ws 埠可達;backend log `upstream connected …/websockify`。
- [ ] 前端(B 或 A)完成:UI「Start Browser」→ **真桌面 Chromium 直接開 Google 首頁**。
- [ ] 滑鼠鍵盤可操作;**中文可輸入**(seamless 剪貼簿貼上或 IME);**剪貼簿雙向**可互貼(含中文)。
- [ ] proxy 走目標出口:遠端開 IP 查詢頁,公網 IP == 目標機器 IP。
- [ ] 反爬蟲:常擋機器人的站較不會一直跳驗證;**保留設定檔**讓同目標第二次進更少驗證。
- [ ] per-session 隔離:兩 session 各開 → 各自桌面、各走各 proxy。
- [ ] 斷線/idle → session 被收(ssh + kasm + Redis 清空);`GUNICORN_WORKERS≥2` 不會 "session not found"。
- [ ] `docker compose run --rm backend python manage.py test` 全綠。→ 準備 merge。

---

## 6. 參考:KasmVNC 事實(別再重查)

| 項目 | 值 | 出處 |
|---|---|---|
| stock noVNC 相容? | **否**,要用 KasmVNC 自家 fork | README / Differences wiki |
| TLS | `-sslOnly` 預設關 → **純 ws** | Xvnc man |
| ws 端點 path | **`/websockify`** | 實測 + kasm 慣例 |
| ws_port | **8443 + display**(`WS_BASE`) | config 文件 |
| Basic Auth | **預設開**;`-disableBasicAuth` 此 build 無效 → 用 `kasmvncpasswd` 使用者 + `Authorization: Basic` | Xvnc man / issue #284 |
| `Sec-WebSocket-Origin` | **必帶**(legacy header,值不驗);缺了 `/websockify` 回 404 "failed websocket checks" | 實測 2026-07-03 |
| 密碼檔 | **固定路徑** `-KasmPasswordFile /etc/kasmvnc/kasmpasswd`(勿靠 `${HOME}`) | Xvnc man + 實測 |
| 版本 | 1.4.0(deb `kasmvncserver_bookworm_1.4.0_{amd64,arm64}.deb`);client fork `@kasmtech/novnc` 1.3.0(已 vendor 進 `src/frontend/src/vendor/kasm-novnc/`,見該 README) | releases + image 內 www/package.json |

---

## 7. 變更檔案地圖

```
docker/kasm-browser/
  session_manager.py            # Xkasmvnc + ws_port + 首頁/反爬蟲/profile + KasmPasswordFile/httpd + 印 vnc cmd
  Dockerfile                    # 裝 KasmVNC 1.4.0(arch-aware)+ kasmvnc.yaml + kasmvncpasswd 使用者(固定路徑)
  kasmvnc.yaml                  # (新) require_ssl:false + 剪貼簿放行
  tests/test_session_manager.py # ws_port / 首頁 / 反爬蟲 / profile / KasmPasswordFile 斷言
src/backend/
  services/kasm_client.py                         # create_session → ws_port(+ profile_key)
  services/tests/test_kasm_client.py
  authorized_keys/remote_browser_service.py       # store ws_port;profile_key=server_id;ssh -D/GC 不動
  authorized_keys/tests/test_remote_browser_service.py
  tunnels/consumers.py                            # RemoteBrowserConsumer:WS↔WS 中繼 + scheme/path 退回 + Basic Auth
  tunnels/tests/test_remote_browser_consumer.py   # mock WS server 端到端
requirements.txt                # + websockets>=12.0
docker-compose.yml              # kasm-browser: build args/KASM_WS_* env/profiles volume;backend: KASM_WS_* env
dev-scripts/phase0_kasmvnc_probe.py               # (新) stdlib-only WS 探測(可帶 --user/--password)
docs/plans/2026-07-03-kasmvnc-corrected-plan.md   # (新) 修正版計畫(深度細節,§編號來源)
docs/plans/2026-07-03-kasmvnc-HANDOFF.md          # (新) 本文
```

---

## 8. 指令速查

```bash
# 後端單元測試(Claude Code 有 Docker,直接用真 stack 的 backend):
docker compose run --rm backend python manage.py test \
  services.tests.test_kasm_client \
  authorized_keys.tests.test_remote_browser_service \
  tunnels.tests.test_remote_browser_consumer -v 2
# session_manager 測試(純 stdlib,可在 kasm-browser 容器內或本機):
cd docker/kasm-browser && python3 -m unittest discover -s tests -p "test_*.py"
# rebuild + 起:
docker compose up -d --build kasm-browser backend
# Phase 0 探測(帶帳密):
docker compose cp dev-scripts/phase0_kasmvnc_probe.py kasm-browser:/tmp/probe.py
docker compose exec kasm-browser python3 /tmp/probe.py --port <ws_port> --user telepy --password telepyvnc
# 回退 TigerVNC:
git checkout feat/vnc-remote-browser
```

## 9. 環境變數(都有預設,通常不用設)

| 變數 | 預設 | 用途 |
|---|---|---|
| `KASM_WS_USER` / `KASM_WS_PASSWORD` | `telepy` / `telepyvnc` | Basic Auth 帳密(backend 帶、kasm-browser 建;同源) |
| `KASM_WS_SCHEME` / `KASM_WS_PATH` / `KASM_WS_SUBPROTOCOL` | `ws` / `/websockify` / `binary` | 上游 ws「優先嘗試」提示(仍會自動退回) |
| `KASM_PASSWORD_FILE` | `/etc/kasmvnc/kasmpasswd` | 固定密碼檔路徑(Dockerfile 與 session_manager 同一值) |
| `HTTPD_DIR` | `/usr/share/kasmvnc/www` | KasmVNC client 目錄(前端 Option A/B 可能用到) |
| `REMOTE_BROWSER_HOMEPAGE` / `REMOTE_BROWSER_LANG` | `https://www.google.com` / `zh-TW` | 首頁 / 語系(反爬蟲) |
| `REMOTE_BROWSER_PROFILE_BASE` / `WS_BASE` | `/profiles` / `8443` | 保留設定檔根目錄 / ws 埠基數 |
```
