# 後端怎麼連到裝置：共用連線與 port

> 本文涵蓋現在的連線路徑、port 用在哪裡、依「隧道 + OS 帳號」共用連線的設計，以及還沒做的部分。
> 程式：`gateway/mod.rs`、`ssh/device.rs`、`ssh/pool.rs`、`ssh/terminal.rs`、`ssh/socks.rs`、`ssh/bridge.rs`；
> 測試：`tests/terminal_e2e.rs`、`tests/socks_e2e.rs`、`tests/device_pool.rs`、`tests/ssh_topology.rs`
> （都建在 `tests/common/lab.rs` 上）。

## 一、現在怎麼連？跟以前一樣嗎？

**裝置端完全一樣。** 裝置照舊用隧道金鑰跑
`ssh / autossh -NR '*:<reverse_port>:localhost:22' telepy@<server> -p 24242`，腳本沒改。差別只在伺服器端：
以前接住這條連線的是 OpenSSH 容器，現在是後端行程裡的 gateway（russh）。

```
裝置                                         Telepy 後端（單一行程）
┌──────────────┐  ssh -NR（隧道金鑰）       ┌──────────────────────────────────────────────────────────┐
│ sshd :22     │◀═══════════════════════════▶│ gateway :2222（對外 24242）                                │
└──────────────┘                            │   forward 表：reverse_port → 這台裝置的那條連線（不綁本機 port）│
       ▲                                    │                                                            │
       │ 每條「通道」= 隧道裡的一條            │ 連線池（ssh::pool）：同一台、同一個 OS 帳號一條 SSH 連線      │
       │ forwarded-tcpip channel；裝置的       │   ├ 網頁終端機：一個分頁一條 PTY channel                     │
       │ ssh 客戶端把它接到 localhost:22        │   ├ 檔案管理 / SFTP：一個操作一條 sftp（或 exec）channel       │
       └──────────────────────────────────── │   ├ 遠端瀏覽器：行程內 SOCKS5，每個 CONNECT 一條 direct-tcpip    │
                                            │   └ 區網主機那一跳：一條 direct-tcpip（最後一跳仍是 OpenSSH）   │
                                            │ AI session、區網掃描：各自一條連線（同樣在行程內開通道）         │
                                            │ 筆電：ssh -W localhost:<port> telepy@server（使用者金鑰）→ 通道 │
                                            └──────────────────────────────────────────────────────────┘
```

不管走哪條，最後都是**對裝置 sshd 的一次 SSH 登入**：後端用服務金鑰，筆電用使用者自己的金鑰。

| 路徑 | 以前（Django + OpenSSH 容器） | 現在 |
|---|---|---|
| 裝置 → 伺服器 | `ssh -NR` 到 ssh 容器 | 一樣的指令，連到後端內建 gateway |
| 網頁終端機 | 後端 → ssh 容器（第一次 SSH）→ 裝置（第二次） | 池子連線上的 PTY channel；同一台同一帳號的分頁、檔案管理共用**一次** SSH 登入 |
| 檔案管理 / SFTP | 每個操作 spawn `ssh` / `scp`，各自兩次 SSH | 池子連線上一個操作一條 channel；沒有 sftp 子系統時用 exec channel 跑 `ls -la` |
| 遠端瀏覽器 | `ssh -D` 子程序 | 後端自己的 SOCKS5（只做 CONNECT），CONNECT = 池子連線上的 direct-tcpip |
| 區網主機終端機 | `ProxyCommand ssh -W` 經 ssh 容器 | 池子連線上的 direct-tcpip 接到一次性本機入口（`ssh::bridge`），最後一跳 OpenSSH（可問密碼） |
| 裝置金鑰清單（`device_keys`） | 沒有 | 同一個池子借連線，SFTP 讀寫 `~/.ssh/authorized_keys` |
| 筆電 | `ProxyCommand ssh -W` 經 ssh 容器 | 一樣，經 gateway |

## 二、port 用在哪裡？會不會用完？

| port | 用途 | 數量 | 會不會用完 |
|---|---|---|---|
| 24242、8787 | 對外：裝置隧道、網頁 | 固定 | 不會 |
| `reverse_port` | 每條隧道一個**號碼**：裝置在 `-R` 指定它，gateway 用它找到那條連線。**不綁任何本機 port** | 每條隧道 1 個 | 號碼上限約 64,500 條隧道 |
| SOCKS port | 每個遠端瀏覽器 session 一個（kasm 容器連進來；Chromium 的 SOCKS 不支援帳密，所以無法共用一個） | 受 session 上限限制 | 不會 |
| 區網主機一次性入口 | 每開一個區網主機終端機，`127.0.0.1:<臨時埠>` 等一條連線（30 秒沒人來就關） | 開著的區網終端機數 | 不會 |

後端連裝置不再經過任何 loopback TCP，所以也沒有臨時 port、TIME_WAIT 的問題。`reverse_port` 只是號碼，
不會跟容器裡任何東西衝突，分配時只要避開已經發出去的號碼（`monitor::find_free_port`）。

## 三、依「隧道 + OS 帳號」共用連線（`ssh::pool`）

- **key**：`(reverse_port, OS 帳號)`。不同 Telepy 使用者只要被允許用同一個帳號，就共用同一條連線；各自是獨立
  的 channel。權限照舊在取用前由 `permissions::allowed_usernames` 檢查。
- **建立**：第一次用到才連。傳輸在行程內：`Gateway::open_stream(port)` 在裝置隧道上開一條 forwarded-tcpip
  channel，russh 直接在上面跟裝置 sshd 握手。同一個 key 同時有多個請求時只握手一次，其他人等它。
- **lease**：每個使用者借一個 lease。
  - 開 session channel（終端機分頁、SFTP、exec）一律走 `DevicePool::session_channel`。
  - 一條連線最多 8 個 lease；OpenSSH sshd 預設 MaxSessions 是 10，留 2 個餘裕。
  - 裝置把 MaxSessions 設得更小、拒絕開 channel 時，池子把那條連線的額度降到它實際撐得住的數量，再為同一個 key
    開一條連線。
  - MaxSessions 只限 session channel、不限 direct-tcpip，所以 SOCKS 代理與區網那一跳各占一個 lease 就夠。
- **回收**：沒有 lease、閒置超過 5 分鐘的連線由 reaper 關掉（每 30 秒檢查一次）。裝置斷線時連線自己失效，
  開著的終端機分頁會被關掉，下次取用重連。
- **終端機**：分頁 = channel，關分頁只關那條 channel。以前 killpg 殺到 ControlMaster、把所有分頁一起踢掉的
  那一類問題不存在了。裝置離線時直接回 4005，不必等逾時。
- **sftp 子系統被拒**：等裝置的回覆，一被拒就馬上退回 exec，不再等 SFTP 初始化的 10 秒逾時。
- **macOS 裝置與名稱（`ssh::resolve`）**：Apple 的 `sshd-session` 收到目標是**名稱**的 direct-tcpip 時，
  privsep 子行程在 fork 之後呼叫 getaddrinfo 會 abort，整條 SSH 連線跟著斷。Chromium 經 SOCKS 一律送名稱，
  所以遠端瀏覽器一開頁就會觸發；在共用連線上，同一台同一帳號的終端機分頁與檔案管理也會一起斷。因此
  SOCKS 與區網那一跳開 direct-tcpip 之前：
  - 每條連線問一次 OS（`uname -s`）。
  - Darwin：用 `/usr/bin/dscacheutil` 在**裝置上**把名稱解析成 IP（IPv4 優先，內網與 `.local` 名稱照常），
    再對 IP 開 channel。
    - 同一個名稱同時查只跑一次；同時最多 2 個查詢（每個都占一條 session channel）。
    - 快取：查得到 60 秒、查不到 10 秒。
    - 查不到就讓那個 CONNECT 失敗，**絕不**把名稱交給 Apple 的 sshd。
  - 其他 OS：照舊把名稱交給裝置解析（與 `ssh -D` 相同）。
- **效果**：同一台、同一帳號，從第二個操作起就不再握手。測試量到的數字：
  - 連續 5 次列目錄：1 次登入
  - 同時 12 個請求：最多 2 次登入
  - 3 個終端機分頁加檔案管理：1 次登入

## 四、還沒做的

- **AI session 仍是自己的一條連線。** 一個 AI session 會同時跑最多 4 個指令再加 SFTP，若只算一個 lease，會讓
  池子低估裝置的 MaxSessions 用量。它已經在行程內開通道（不占 port），共用連線只省一次握手，所以先不搬。
- **超過 6 萬條隧道**才需要：改用金鑰辨識隧道、不再用 port。每台裝置都 `-R` 同一個號碼，筆電用
  `ssh -W <隧道名>:22`。這需要改 DB（`reverse_port` 目前是 UNIQUE），所以先不做。

## 五、怎麼測

- `tests/terminal_e2e.rs`：
  - PTY 與回聲（含多位元組字元）、resize 以 window-change 送到裝置、binary pong
  - 五個獨立分頁，關一個其餘照常
  - 分頁共用一次登入；MaxSessions 2 時第三個分頁也開得起來
  - 裝置斷線時分頁被關、重連後再開；離線直接 4005
  - 區網主機那一跳；檔案管理的 SFTP 與 exec 備援共用連線
- `tests/socks_e2e.rs`：
  - 真正的 SOCKS5 CONNECT 經裝置連到它區網裡的服務，含同時多條 CONNECT、連不到的目標
  - stop 後代理埠關閉；離線時回 `device_offline`
  - 假 macOS 裝置（lab 的 `pretend_darwin` 對名稱的 direct-tcpip 會斷線，模擬 Apple 的 crash）：用名稱
    CONNECT 也能通，同一條連線上的終端機分頁仍然活著
- `tests/device_pool.rs`：連線共用（數裝置 sshd 的登入紀錄）、MaxSessions 比 8 小時改開第二條、裝置重連、
  閒置回收、使用中的連線不會被收。
- `tests/ssh_topology.rs`：同一台多使用者、多 OS 帳號，以及多跳路徑。
- 新的 SSH 路徑一律建在 `tests/common/lab.rs` 上（說明見 `.claude/CLAUDE.md` 的 Code Conventions）。
