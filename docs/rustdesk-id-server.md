# RustDesk 不經 SSH：Telepy 當 RustDesk 的 ID／中繼伺服器（研究與方案，2026-10-26）

> 問題：Telepy 的網頁能不能遠端一台**沒有裝 Telepy 隧道**的 RustDesk？能不能讓裝置「遠端申請號碼」？
> 這份是研究紀錄＋方案比較，不是功能文件；程式碼沒有進產品。上一份研究是 [`rustdesk-spike.md`](rustdesk-spike.md)，
> 已上線的 SSH 路線見 [`remote-desktop.md`](remote-desktop.md)（#195、#196）。

## 結論

- **可以，而且不用開新埠。** RustDesk 1.5.0 的「使用 WebSocket」（`allow-websocket`）讓裝置**主動往外**連 ID 伺服器的
  `/ws/id`、中繼的 `/ws/relay`。Telepy 自己實作這兩個端點（不跑官方 hbbs／hbbr），裝置只需要能連到 Telepy 的 443，
  不需要 SSH、不需要對外開任何埠。實測：沒有 SSH、沒有發佈埠的容器裝置，用 RustDesk ID 從瀏覽器連上，**首幀 0.5 秒**。
- **還多了端對端加密。** Telepy 用自己的 ed25519 伺服器金鑰簽裝置的公鑰，瀏覽器裡的核心驗證後與裝置做 RustDesk 的
  金鑰交換：中繼只看得到加密後的 bytes。現在的 SSH 路線走 Direct IP，沒有金鑰交換（核心會跳「不安全連線」，Telepy 自動確認），
  RustDesk 串流在 Telepy 內是明文，只靠外層的 TLS 與 SSH。
- **「遠端申請號碼」合理，而且 RustDesk 本來就有兩個現成機制，都實測可用：**
  - **申請（登記）**：伺服器對沒登記過的裝置回 `NOT_DEPLOYED`，裝置就停著等；在裝置上跑
    `rustdesk --deploy --token <Telepy 發的權杖>`，它把 `{id, pk, uuid}` POST 到 `/api/devices/deploy`，
    Telepy 收下並綁到帳號，6 秒內裝置就註冊成功。錯的權杖被擋。
  - **號碼由 Telepy 發**：`rustdesk --set-id <號碼>` 會向伺服器送 `RegisterPk {id: 新, old_id: 舊}`，
    **伺服器回 OK 才換**，所以號碼空間由 Telepy 管。限制：號碼要英文字母開頭（`900100200` 被裝置端拒絕，
    `tp900100200`、`nat-office-01` 可以）。
- **上一份研究說「拿掉 SSH 就要自架 hbbs／hbbr、對外開 21115–21119、而且它不認識 Telepy 的使用者」——前半句已被推翻。**
  Telepy 自己當 hbbs／hbbr，走 WebSocket 就在 Telepy 原本的網域與 443 上，誰能連由 Telepy 的登入與權限決定。
- **建議：先做「Telepy 當 ID＋中繼伺服器，權杖登記」**（下面的方案 B＋B1），與現有 SSH 路線並存；號碼發放（B2）與
  臨時協助（B4）之後再加。MVP 估 2–3 週。

## 實測（2026-10-26）

環境：裝置 = 先前的測試映像（Debian bookworm、RustDesk 1.5.0 aarch64、Xvfb 1280×800），**這次不跑 sshd、不建隧道、
不發佈任何埠**，只在 `RustDesk2.toml` 設 `custom-rendezvous-server`、`allow-websocket = Y`、`api-server`、`key`；
伺服器 = 約 300 行 Python（標準函式庫手寫 WebSocket 與 protobuf）模擬 Telepy 要做的 ID＋中繼；瀏覽器 = headless Chrome +
已 vendored 的 `rustdesk-web-core.js`。

| 步驟 | 結果 |
|---|---|
| 裝置啟動 | log `start tcp: ws://<server>:21118`，送 `RegisterPk {id: 113668456, uuid, pk 32 bytes}`；回 `RegisterPkResponse OK, keep_alive 30` 後保持連線 |
| 裝置的 HTTP（`api-server`） | 自己 POST `/api/sysinfo`（hostname、OS、CPU、記憶體、版本）、每 15–18 秒 `/api/heartbeat`（id、uuid、版本）、每次連線 `/api/audit/conn`（new／close、對方 ID 與名稱 `Web (Mac OS)`、驗證方式） |
| 瀏覽器用 ID 連 | 核心送 `PunchHoleRequest {id}` → 伺服器在裝置的連線上推 `RequestRelay {uuid, socket_addr, relay_server, secure: true}`，回瀏覽器 `RelayResponse {uuid, relay_server, pk = 伺服器簽過的 IdPk{id, 裝置公鑰}}` |
| 裝置回應 | 另開一條 `/ws/id` 送 `RelayResponse {socket_addr, version: 1.5.0}`，再開 `/ws/relay` 送 `RequestRelay {uuid}`；伺服器以 uuid 配對瀏覽器與裝置兩條 WS，逐則轉送（兩邊都是一則 WS 訊息一則 protobuf，不必重新分框） |
| 結果 | `connection_ready` → `fingerprint`（端對端加密完成）→ 登入 → **首幀 511 ms**，1280×800；沒有「不安全連線」提示 |
| `--set-id` | 見上：`old_id` 機制，伺服器決定准不准；數字開頭的號碼在裝置端就被拒 |
| `--deploy --token` | `POST /api/devices/deploy`，`Authorization: Bearer <token>`，body `{id, pk, uuid}`；伺服器先前回 `NOT_DEPLOYED` 時裝置 log `Server requires deployment…`，權杖對了之後下一次註冊（約 6 秒）成功 |
| `--assign --token … --user_name …` | `POST /api/devices/cli`，body `{id, user_name, uuid}`（Server Pro 的「指派給使用者」；Telepy 可以不實作） |

踩到的坑：

- `RequestRelay` 一定要帶**非空、每次不同**的 `socket_addr`（`AddrMangle` 編碼）：裝置會丟掉「100 ms 內與上一個相同位址」
  的請求，而它的初始值正好是空位址解出來的 `0.0.0.0:0`，所以空的會被當成重複而被默默丟掉。
- `/api/audit/conn` 要回 **2xx 空 body**；回 `{}` 裝置會當成失敗，10 秒、30 秒後重送（不影響連線）。
- 容器 `docker restart` 後第一次登入可能被裝置拒絕（`Login Error: connection refused`）：舊的 IPC socket 還在；全新容器沒有這問題。
  是測試環境的現象，不是協定。

## RustDesk 端的事實（原始碼 rustdesk master 2026-10 ＋ 1.5.0 二進位）

| 事實 | 出處 | 對 Telepy 的意義 |
|---|---|---|
| `allow-websocket = Y`（或代理、`disable-udp`）時，裝置走 TCP 版的註冊迴圈，傳輸是 WebSocket | `rendezvous_mediator.rs` `start()` → `start_tcp()`；1.5.0 二進位含 `allow-websocket` | 不需要 UDP 21116，也不用 TCP 21116／21117 |
| WS 網址：ID 伺服器是 IP → `ws://IP:21118`（中繼 21119）；是網域 → `ws(s)://網域/ws/id`、`/ws/relay`，**`api-server` 以 `https` 開頭才用 `wss`**，埠用預設 443 | `hbb_common/src/websocket.rs` `check_ws()` | 正式環境：裝置設 Telepy 的網域＋`api-server = https://<Telepy>`，就連 `wss://<Telepy>/ws/id`，Traefik 已經把 `/ws/*` 交給 backend（**網域＋wss 這條只從原始碼確認，PoC 用的是 IP＋ws**） |
| `RelayResponse`／`RequestRelay` 裡的中繼位址若是 `ws://`／`wss://` 開頭就原樣使用 | `is_ws_endpoint()` | Telepy 可直接給完整網址（PoC 實測） |
| WS 上的註冊不做伺服器金鑰交換（WS 視為已加密的傳輸） | `common.rs` `secure_tcp_required()` 註解與 `use_ws()` 分支 | 裝置端的 `key` 設定在 WS 模式下不參與註冊；伺服器金鑰只用在「簽裝置公鑰給控制端」 |
| 註冊回應有 `NOT_DEPLOYED`；裝置會每 30 秒重試，直到 `--deploy --token` 成功 | `register_pk_response`、`NEEDS_DEPLOY` | 天然的「申請／登記」閘門：沒登記的機器連註冊都不行 |
| `PunchHoleRequest` 有 `token` 欄位（原生 app 登入 `api-server` 後帶的權杖） | `rendezvous.proto` | 若要讓**原生 RustDesk app** 也走 Telepy，可以用它做授權（方案 C） |
| `RequestRelay` 有 `control_permissions`（鍵盤、剪貼簿、檔案、聲音、終端機…的位元遮罩） | `rendezvous.proto` `ControlPermissions` | Telepy 可以依分享權限限制對方能做什麼（例如 VIEW = 只能看）；未實測 |
| 裝置的 `/api/audit/conn` 回報每次連線的開始與結束、對方 ID 與驗證方式 | `server/connection.rs` `post_audit_async` | 「裝置端看到的」連線紀錄，可以進 Logs |

## 方案

### A. 現況：經 Telepy 隧道（已上線，#195／#196）

瀏覽器 ─ Telepy ─ 反向 SSH ─ 裝置的 Direct IP 21118。裝置要有 Telepy 隧道，RustDesk 開 Direct IP Access 與固定密碼。
優點：不用改 RustDesk 的伺服器設定、延續隧道的權限與分享。缺點：一定要 SSH；串流在 Telepy 內不是端對端加密。

### B. Telepy 當 RustDesk 的 ID＋中繼伺服器（不經 SSH）

```
裝置的 RustDesk（allow-websocket，設 Telepy 的網域與 api-server）
  │ 往外連 wss://<Telepy>/ws/id：RegisterPk，保持連線         ← 不需要 SSH、不需要開埠
  │ POST /api/sysinfo、/api/heartbeat、/api/audit/conn       ← 裝置資訊、在線、裝置端稽核
  ▼
Telepy backend
  ├─ /ws/id：已登記裝置的註冊連線（記住 id → 連線、公鑰、uuid）
  ├─ 瀏覽器的 /ws/rustdesk/<session>/?ticket=…（現有的票證端點）收到 PunchHoleRequest
  │    → 在裝置的註冊連線上推 RequestRelay{uuid, wss://<Telepy>/ws/relay, secure}
  │    → 回瀏覽器 RelayResponse{uuid, relay, 伺服器簽過的裝置公鑰}
  └─ /ws/relay：以 uuid 配對兩條 WS，逐則轉送（端對端加密，Telepy 看不到內容）
  ▲
瀏覽器（現有的 RustDeskViewer，`key` = Telepy 的伺服器公鑰）
```

誰能連：瀏覽器端照舊要 Telepy 登入＋權限＋票證；裝置端還要 RustDesk 密碼（兩道鎖）。`/ws/id` 只收已登記的裝置，
上面的 `PunchHoleRequest` 一律拒絕（原生 app 不經 Telepy 授權就連不進來）；`/ws/relay` 只配對 Telepy 自己發出的 uuid。

**怎麼讓裝置進到帳號（「申請號碼」的幾種做法）：**

| | 做法 | 裝置端要做的事 | 優點 | 缺點 |
|---|---|---|---|---|
| **B1 權杖登記（建議預設）** | Telepy 對沒登記的裝置回 `NOT_DEPLOYED`；網頁「新增 RustDesk 裝置」發一次性權杖（像現在的一行指令加入） | 設定伺服器（`--option` 或寫設定檔）＋ `rustdesk --deploy --token tpr_…`（要管理員權限） | RustDesk 內建、實測可用；陌生機器連註冊都不行；登記時就拿到 id、公鑰、uuid | 要能在裝置上下指令（遠端協助的對象未必會） |
| **B2 Telepy 發號碼** | 登記時 Telepy 指定號碼（例如 `tp` + 8 碼、或 `帳號-名稱`），指令裡多一行 `rustdesk --set-id <號碼>`；只有登記過的 uuid 能換成這個號碼 | 同 B1 多一行 | 號碼好記、在 Telepy 的命名空間、可以電話裡唸 | 號碼要英文字母開頭；裝置原本的 ID 會被換掉 |
| **B3 輸入 ID＋密碼認領** | 不擋註冊；使用者在 Telepy 輸入裝置畫面上的 ID 與密碼，第一次連線成功就綁定 | 只要設定伺服器（Windows 可用 RustDesk 官方的「改檔名帶設定」或貼上設定字串，未實測） | 對方不用跑指令 | Telepy 變成誰都能註冊的 RustDesk 伺服器，要限流、未認領的過期清除 |
| **B4 臨時協助（像 TeamViewer QuickSupport）** | 協助者在 Telepy 建一張有期限的協助單；對方照連結下載官方 RustDesk 並套用 Telepy 的設定，唸出畫面上的 ID 與一次性密碼 | 下載＋套設定 | 對方不用帳號、不用裝 Telepy | 要處理 Windows／macOS 的權限提示；單次、到期即失效 |

### C. 原生 RustDesk app 也透過 Telepy 連（之後再說）

讓使用者電腦上的 RustDesk app 把 Telepy 當伺服器：Telepy 實作 RustDesk 的 `/api/login`，app 登入後在
`PunchHoleRequest.token` 帶權杖，Telepy 依權限放行。好處是能用原生 app 的傳檔與聲音；代價是要追 RustDesk Server Pro
API 的相容性，而且 app 端的帳號 UI 不受 Telepy 控制。現在用方案 A 的 `ssh -L` 已經能讓原生 app 連，不急。

### 比較

| | A 隧道（現況） | B 當 ID＋中繼 | C 原生 app 走 Telepy |
|---|---|---|---|
| 裝置要 Telepy 隧道 | 要 | 不用 | 不用 |
| 裝置要改 RustDesk 設定 | 開 Direct IP | 指向 Telepy、開 WebSocket（離開公用 RustDesk 伺服器） | 同 B |
| Telepy 對外多開的埠 | 無 | 無（`/ws/id`、`/ws/relay` 走 443） | 無 |
| 端對端加密 | 否 | 是 | 是 |
| 誰能連 | Telepy 權限＋RustDesk 密碼 | Telepy 權限＋RustDesk 密碼 | RustDesk 帳號權杖（Telepy 簽發）＋密碼 |
| 傳檔、聲音 | 瀏覽器沒有；原生 app 經 `ssh -L` 有 | 瀏覽器沒有 | 有 |
| 工作量 | 已完成 | MVP 2–3 週 | 再 2 週以上，且要追 API |

## 若要做 B：拆法

1. **後端 ID＋中繼**（約 1 週）：`rustdesk/idserver`（註冊連線表、`RegisterPk` 處理含 `old_id`／`NOT_DEPLOYED`、
   `RequestRelay` 推送、`socket_addr` 編碼）、`/ws/id`、`/ws/relay`（uuid 配對、逐則轉送、位元組計數、逾時）；伺服器
   ed25519 金鑰（像 gateway host key 一樣產生、以 vault 封存），簽 `IdPk`；現有 `/ws/rustdesk/<session>/` 的 id 角色改成
   「依裝置 ID 推 RequestRelay」而不是假回應；`desktop_max_sessions` 照算。
2. **登記與裝置資料**（約 3–4 天）：`telepy_rustdesk_device`（擁有者、RustDesk ID、uuid、公鑰、名稱、`sysinfo`、最後上線、
   可選的對應隧道）；`POST /api/devices/deploy`（權杖＝一次性票證，像 join）、`/api/heartbeat`、`/api/sysinfo`、
   `/api/audit/conn`（回 2xx 空 body，寫進 Logs）；B2 的號碼配發與 `old_id` 審核。這幾個路徑落在 Telepy 的 `/api/*`
   底下，名稱目前沒有衝突；也可以把 `api-server` 設成 `https://<Telepy>/rustdesk` 讓它們落在子路徑（未實測）。
3. **權限**：MVP 先「擁有者＋管理員」；分享沿用隧道的 VIEW／EDIT／ADMIN 模型之後再接，VIEW 可以用 `control_permissions`
   做成只能看。
4. **前端**（約 1 週）：RustDesk 裝置清單（在線、名稱、ID、OS）、「新增裝置」對話框（Linux／macOS／Windows 指令，含
   權杖倒數與登記成功的即時狀態，像 JoinPanel）、連線沿用 `RustDeskViewer`（換一個 start 端點、`key` 帶伺服器公鑰）、
   說明圖的第三種路徑、Live sessions／presence／Logs 的新事件。
5. **測試**：後端整合測試用假 RustDesk 裝置（WS 版的 `RegisterPk` → `RequestRelay` → 配對），以及 OrbStack 真裝置 E2E
   （本文的 PoC 流程）。

## 風險與限制

- **裝置會離開公用 RustDesk 伺服器**：改了 ID 伺服器，那台 RustDesk 就只能經 Telepy 被連。要同時保留公用 ID 的人不適合 B。
- **需要支援 WebSocket 的 RustDesk**：實測 1.5.0；更舊的版本沒有這個選項就只能走 UDP／TCP 21116、21117，Telepy 不打算開這些埠。
- **macOS／Windows 的系統權限**（螢幕錄製、輔助使用、服務安裝）仍要在裝置上手動允許，Telepy 自動不了；Linux 無頭機器要
  `allow-linux-headless`。
- **伺服器金鑰是信任根**：拿到它的人可以替任何裝置簽假公鑰做中間人。要封存保管；換金鑰只影響瀏覽器端（Telepy 自己），
  裝置端在 WS 模式不驗它。
- **頻寬經 Telepy**：每個連線的畫面都經 Telepy 中繼（高動態約 0.6–1 MB/s），和現在一樣。
- **授權**：沿用已 vendored 的社群核心（AGPL）；Telepy 只實作協定、不散布 RustDesk 的二進位。

## 附錄：PoC 重現摘要

- 裝置設定（`/root/.config/rustdesk/RustDesk2.toml` 的 `[options]`）：`custom-rendezvous-server = '<伺服器 IP>'`、
  `allow-websocket = 'Y'`、`api-server = 'http://<伺服器 IP>:21114'`、`key = '<伺服器公鑰 base64>'`、
  `allow-linux-headless = 'Y'`、`direct-server = 'N'`；啟動 `rustdesk --server` 後 `rustdesk --password …`。容器裡
  `host.docker.internal` = OrbStack 的 `0.250.250.254`，連到 Mac 的 loopback。
- 伺服器：一個連接埠收 WebSocket，依第一則訊息分角色：`register_pk`（15）= 裝置註冊、`punch_hole_request`（8）= 瀏覽器、
  `request_relay`（18）= 中繼的任一端、`relay_response`（19）= 裝置回報；`IdPk` 用 `openssl pkeyutl -sign -rawin`
  （ed25519）簽，NaCl 的格式是「64 bytes 簽章＋原訊息」。`socket_addr` 用 `AddrMangle` 在 tm = 0 時的形式：
  `((ip_le << 49) | port)` little-endian、去掉尾端 0。
- 瀏覽器：核心的 `custom-rendezvous-server = ws://127.0.0.1:21118`、`relay-server = ws://127.0.0.1:21119`、
  `key = <伺服器公鑰>`，`session_add_sync {id: <RustDesk ID>, password}`。
