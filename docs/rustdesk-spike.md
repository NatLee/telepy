# RustDesk 進 Telepy 瀏覽器：可行性研究（2026-10-25）

> 問題：能不能把 RustDesk 的畫面放進 Telepy 的網頁介面、自己客製；這樣是不是就不需要 SSH 隧道了？
> 這份是研究紀錄，不是功能文件。程式碼沒有進產品；重現用的腳本在當時的 scratchpad（已清），做法寫在附錄。

> **2026-10-26 更新：** 下面「『不用 SSH』是反的」那一點已被推翻。RustDesk 1.5.0 能經 WebSocket 主動連 ID 伺服器，
> Telepy 自己當 ID＋中繼伺服器就不需要 SSH、也不用開新埠，還多了端對端加密；見 [`rustdesk-id-server.md`](rustdesk-id-server.md)。

## 結論

- **可以，而且不需要 RustDesk 的 server（hbbs／hbbr）。** 裝置上 RustDesk 的 Direct IP 埠（21118）是純 TCP，
  Telepy 只要在現有的 `/ws/desktop` 那種中繼旁邊再做一個「重新分框」的 bridge（WebSocket 訊息 ⇄ RustDesk 的
  TCP 長度前綴），接到連線池的 direct-tcpip 通道，瀏覽器端用社群開源的 TypeScript 核心解碼，就能在 Telepy 的頁面裡
  看到 RustDesk 的畫面。不用開新的公開埠、不用 UDP、授權就是 Telepy 的。
- **「不用 SSH」是反的。** 正因為有 SSH 隧道，RustDesk 才能繞過它自己的 server 進到瀏覽器；拿掉 SSH 就要自架
  hbbs／hbbr、對外開 21115–21119、裝置改設定，而且 RustDesk 的 server 不認識 Telepy 的使用者與權限。SSH 仍是基礎。
- **效能差距是真的。** 同一台裝置、同一個高動態畫面（1280×800，整頁捲動的文字視窗）：RustDesk 核心 **28 fps、約 645 KB/s**；
  Telepy 現在的 guacd VNC **4–5 fps、0.5–1.3 MB/s**。靜止畫面兩者都約 1–2 fps、≤ 1 KB/s。差別來自 RustDesk 是真的
  視訊編碼（VP9／AV1／H.264），guacd 是把畫面切成 PNG／JPEG／WebP 圖塊。
- **工作量：MVP 約 2–3 週**（畫面、鍵鼠、剪貼簿、多螢幕切換；不含傳檔與聲音），細節見「設計」。

## 事實（從原始碼確認，rustdesk／hbb_common master，2026-10）

| 事實 | 出處 | 對 Telepy 的意義 |
|---|---|---|
| Direct IP 埠的連線是 `secure=false`：沒有 SignedId／NaCl 交換，第一則訊息就是密碼挑戰 `Hash{salt, challenge}` | `src/rendezvous_mediator.rs direct_server` → `create_tcp_connection(…, false, …)`；實測探測 21118 收到 45 bytes、protobuf 第 9 欄 | 串流本身不加密，由 SSH 隧道 + Telepy 的 TLS 保護；不需要 server 金鑰 |
| TCP 分框 = `BytesCodec`：1–4 bytes little-endian 前綴，低 2 bits = 前綴長度 − 1，長度 << 2 | `hbb_common/src/bytes_codec.rs` | bridge 要做的只有這件事 |
| WebSocket 分框 = 一則 binary message 一則 protobuf；加密在訊息層 | `hbb_common/src/websocket.rs` | 瀏覽器端核心只看 WS，bridge 不需要懂內容 |
| 官方 web client 已不開源（2025 年中移除，自架 web client 是 Server Pro 功能） | `flutter/` 下沒有 `web/` | 瀏覽器端只能用社群實作 |
| 社群 `temandroid/rustdesk-web`：AGPL，TypeScript 核心約 5,700 行 + Flutter 外殼；預編 bundle 28.5 MB，核心 `rustdesk-web-core.js` 825 KB；對著 RustDesk 的 proto 與 Rust 原始碼實作，釘在一個 RustDesk commit（`RUSTDESK_REF`） | repo README、`src/` | 核心可以不用 Flutter 外殼，由 Telepy 自己的 React UI 經 `window.setByName / getByName / onVideoFrame / onGlobalEvent` 驅動 |
| 核心的連線流程：`/ws/id` 送 `punch_hole_request` → 收 `relay_response` → `/ws/relay` 送 `request_relay` → 那條 WS 就是 peer 串流；明確給 `ws://` 的 id-server 會當 proxy，relay 也從它推 | `src/session.ts`、`src/transport/ws.ts` | Telepy 的 bridge 假裝 hbbs＋hbbr 回應，核心一行不改就能直連 |
| hbbs 開源版沒有使用者授權（只有金鑰閘門） | `rustdesk-server/src/rendezvous_server.rs` 1,454 行 | 走 bridge 路線後完全不需要它 |
| Linux 無頭受控端可行：Debian + RustDesk 1.5.0 + Xvfb，`allow-linux-headless Y`、`direct-server Y`、`--password` | 實測容器 | 測試環境可以全自動 |

## 實測

環境：裝置 = Debian bookworm 容器（RustDesk 1.5.0 aarch64、Xvfb 1280×800、x11vnc :5901、sshd + `ssh -NR` 到 Telepy）；
瀏覽器 = headless Chrome；RustDesk 路線 = 自己寫的 60 行外殼頁 + 社群核心 + 200 行 Python bridge（假 hbbs／hbbr，
WS ⇄ BytesCodec 接到裝置 21118）；guacd 路線 = Telepy 本機後端 + guacd 1.6.0 經隧道連 x11vnc。全部在同一台 Mac 上，
所以絕對延遲都很小，有意義的是 fps 與頻寬。

| 畫面 | 路線 | fps | 下行 | 延遲 | 首幀 |
|---|---|---|---|---|---|
| 高動態（整頁捲動文字） | RustDesk 核心經 bridge | **28**（裝置回報 29） | **~645 KB/s**（目標 719 kbps） | RustDesk 自己的 delay 0–1 ms | 1.0 s |
| 高動態 | guacd VNC（auto） | 4.7（1–6） | 0.45–1.3 MB/s | 畫面往返中位 18 ms | 0.4 s |
| 高動態 | guacd VNC（流暢優先） | 3.8 | 0.6–0.9 MB/s | 14 ms | — |
| 高動態 | guacd VNC（清晰優先） | 5.2 | 17–154 KB/s | 5 ms | — |
| 靜止 | RustDesk 核心經 bridge | 1.0 | < 1 KB/s | — | 1.0 s |
| 靜止 | guacd VNC（auto） | 1.8 | ~1 KB/s | 19 ms | — |

踩到的坑：`rustdesk --password` 要在 `--server` 跑起來後才設得進去（走 IPC）；沒有 server 金鑰的直連，核心會停在
「Insecure Connection」的 msgbox 等使用者確認（`setByName("common", {name: "continue-insecure-connection", value: "Y"})`
才會繼續登入）；Mac 連不到 OrbStack 容器的 IP，要用發佈到 loopback 的埠。

## 設計（若要做）

```
瀏覽器（Telepy React 頁 + rustdesk-web-core.js，WebCodecs 解碼）
  │ wss /ws/rustdesk/<session>/?ticket=…   和 /ws/desktop 一樣：REST start 發票證、同一道權限門
  ▼
backend ws/rustdesk.rs（bridge）
  │ /ws/id：收 punch_hole_request → 回 relay_response（指向自己）
  │ /ws/relay：吃掉 request_relay，之後 WS 訊息 ⇄ BytesCodec 框
  ▼
ssh::pool 的 direct-tcpip 通道 ──► 裝置 127.0.0.1:21118（RustDesk Direct IP）
```

- **授權**：和桌面一樣——VIEW + 允許的裝置帳號 + step-up；RustDesk 的固定密碼由使用者輸入（或憑證庫）；每個
  session 寫 `rustdesk_open / rustdesk_close` 事件、進 presence。
- **UI**：不嵌 28 MB 的 Flutter 外殼；Telepy 自己的頁面驅動核心（`session_add_sync` / `session_start` / `login` /
  `send_mouse` / `input_key` / `input_string` / `switch_display`；事件 `peer_info`、`update_quality_status`（含 fps、
  延遲、位元率，可直接接現有的延遲面板）、`msgbox`、`cursor_*`）。多螢幕切換是 RustDesk 原生的 `switch_display`，
  不用裁切。
- **安全**：直連串流不加密，但整段都在 SSH 隧道 + TLS 裡；bridge 看得到明文（和 guacd 路線一樣）。要端到端加密
  得讓核心驗證裝置的簽章公鑰——Telepy 可以經 SSH 從裝置的 `RustDesk.toml` 讀出公鑰交給核心，這是加分項，不在 MVP。
- **版本綁定**：社群核心釘在一個 RustDesk commit；RustDesk 改協定時要跟著更新。核心是 AGPL，Telepy 也是，相容，
  但要保留 NOTICE。
- **裝置端**：使用者自己裝 RustDesk 並開 Direct IP Access + 固定密碼（one-command join 可以順便做，但不是必要）。
- **MVP 範圍**：畫面、鍵鼠、剪貼簿文字、切換螢幕、畫質（RustDesk 的 image-quality 選項）；**不做**傳檔、聲音、
  終端機（核心有，但 Telepy 已有自己的）。估 2–3 週。

## 不建議的路線

- **自架 hbbs／hbbr + 嵌 Flutter web client**：要對外開 21115–21119（含 UDP），裝置改指向 Telepy 的 server，
  畫面不走隧道，server 不懂 Telepy 的權限，外殼 28 MB，還得自己維護 hbbs 的授權補丁。
- **後端跑 RustDesk client 再轉 WebRTC**：RustDesk 的 crate 不是給人當 library 用的，建置鏈重（vcpkg、libvpx、ffmpeg），
  數週起跳。

## 附錄：重現步驟摘要

1. 裝置容器：`debian:bookworm-slim` + `rustdesk-1.5.0-aarch64.deb` + `xvfb xterm x11vnc openssh-server`；
   `Xvfb :1 -screen 0 1280x800x24`，`rustdesk --option allow-linux-headless Y`、`--option direct-server Y`、
   `--option direct-access-port 21118`，`rustdesk --server &`，4 秒後 `rustdesk --password …`；發佈 21118 到 loopback。
2. 核心：下載 `temandroid/rustdesk-web` 的 release bundle，只取 `js/rustdesk-web-core.js`；自己的 HTML 先定義
   `window.onGlobalEvent / onVideoFrame / onRgba / onInitFinished`，載入核心後呼叫 `window.init()`。
3. bridge：Python asyncio，自己做 WebSocket 握手與分框；`/ws/id` 回 `RendezvousMessage{relay_response(19){uuid(2),
   relay_server(3)="ws://127.0.0.1:<port>"}}`；`/ws/relay` 吃掉第一則，之後 WS binary ⇄ BytesCodec 接裝置。
4. 驅動：`setByName("option", {name:"custom-rendezvous-server", value:"ws://127.0.0.1:<port>"})`、同樣設 `relay-server`、
   `key` 空；`session_add_sync {id, password}` → `session_start {id}`；遇到 `msgbox` type `insecure-connection-*`
   回 `common {name:"continue-insecure-connection", value:"Y"}`；數 `onVideoFrame` 次數與 WebSocket bytes 得 fps／頻寬，
   `update_quality_status` 事件有 RustDesk 自己量的 delay。
