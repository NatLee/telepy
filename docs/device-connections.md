# 後端怎麼連到裝置：共用連線與 port

> 本文涵蓋現在的連線路徑、port 用在哪裡、依「隧道 + OS 帳號」共用連線的設計（第三節已實作），以及接下來
> 讓 port 變成「純號碼」的步驟。程式：`gateway/mod.rs`、`ssh/device.rs`、`ssh/pool.rs`；測試：
> `tests/device_pool.rs`、`tests/ssh_topology.rs`（都建在 `tests/common/lab.rs` 上）。

## 一、現在怎麼連？跟以前一樣嗎？

**裝置端完全一樣。** 裝置照舊用隧道金鑰跑
`ssh / autossh -NR '*:<reverse_port>:localhost:22' telepy@<server> -p 24242`，腳本沒改。差別只在伺服器端：
以前接住這條連線的是 OpenSSH 容器，現在是後端行程裡的 gateway（russh）。

```
裝置                                         Telepy 後端（單一行程）
┌──────────────┐  ssh -NR（隧道金鑰）       ┌──────────────────────────────────────────────────────┐
│ sshd :22     │◀═══════════════════════════▶│ gateway :2222（對外 24242）                            │
└──────────────┘                            │   forward 表：reverse_port → 這台裝置的那條連線        │
       ▲                                    │                                                        │
       │ 每條「通道」= 隧道裡的一條            │ ① 網頁終端機、遠端瀏覽器：OpenSSH 客戶端               │
       │ forwarded-tcpip channel；裝置的       │    → 127.0.0.1:<reverse_port>（loopback listener）→ 通道 │
       │ ssh 客戶端把它接到 localhost:22        │ ② 檔案管理、SFTP、AI session：russh                     │
       └──────────────────────────────────── │    → 行程內直接開通道（不經 TCP）                        │
                                            │ ③ 筆電：ssh -W localhost:<port> telepy@server           │
                                            │    （使用者金鑰登入 gateway）→ 通道                       │
                                            └──────────────────────────────────────────────────────┘
```

不管走哪條，最後都是**對裝置 sshd 的一次 SSH 登入**：後端用服務金鑰，筆電用使用者自己的金鑰。

| 路徑 | 以前（Django + OpenSSH 容器） | 現在 |
|---|---|---|
| 裝置 → 伺服器 | `ssh -NR` 到 ssh 容器 | 一樣的指令，連到後端內建 gateway |
| 網頁終端機 | 後端 → ssh 容器（第一次 SSH）→ 裝置（第二次） | 後端 → loopback → 裝置（一次 SSH），分頁共用 ControlMaster |
| 檔案管理 / SFTP | 每個操作 spawn `ssh` / `scp`，各自兩次 SSH | 行程內通道 + 一次 SSH，**同一台同一帳號共用一條連線**（第三節） |
| 裝置金鑰清單（`device_keys`） | 沒有：使用者自己把公鑰貼進裝置的 authorized_keys | 同一個池子借連線，SFTP 讀寫 `~/.ssh/authorized_keys`（暫存檔 + `posix-rename` 原子取代） |
| 筆電 | `ProxyCommand ssh -W` 經 ssh 容器 | 一樣，經 gateway |

## 二、port 用在哪裡？會不會用完？

| port | 用途 | 數量 | 會不會用完 |
|---|---|---|---|
| 24242、8787 | 對外：裝置隧道、網頁 | 固定 | 不會 |
| `reverse_port` | 每條隧道一個號碼。裝置在 `-R` 指定它；gateway 在後端容器的 `127.0.0.1:<port>` 綁一個 listener 給 OpenSSH 客戶端用 | 每條隧道 1 個 | 號碼上限約 64,500 條隧道 |
| 臨時 port（ephemeral） | 每條經 loopback 的 TCP 連線用一個，關閉後 TIME_WAIT 約 60 秒 | 每條連線 1 個 | 同一條隧道每分鐘約 2.8 萬條新連線才會滿。以前 SFTP 每個請求都開一條；現在只剩終端機與 `ssh -D` 會用 |
| SOCKS port | 每個遠端瀏覽器 session 一個（kasm 容器連進來） | 受 session 上限限制 | 不會 |

**已修的問題：** 新隧道原本拿的是「DB 和現有 forward 都沒用到的最小 port」。後端自己的 listener
（gateway 2222、API 8000、SOCKS）不在這兩個集合裡，所以用到第 1,198 條隧道時會被分配 2222，裝置的 forward
永遠綁不起來。現在 `find_free_port` 只發在 `127.0.0.1` 真的綁得起來的 port。

## 三、依「隧道 + OS 帳號」共用連線（`ssh::pool`，已實作）

- **key**：`(reverse_port, OS 帳號)`。不同 Telepy 使用者只要被允許用同一個帳號，就共用同一條連線；各自是獨立
  的 channel。權限照舊在取用前由 `permissions::allowed_usernames` 檢查。
- **建立**：第一次用到才連。傳輸在行程內：`Gateway::open_stream(port)` 在裝置隧道上開一條 forwarded-tcpip
  channel，russh 直接在上面跟裝置 sshd 握手，不經 TCP、不占本機 port。同一個 key 同時有多個請求時，只握手一次，
  其他人等它。
- **lease**：每個操作借一個 lease，開一條 channel（SFTP 子系統）；用完 drop，channel 關閉，lease 歸還。
  - 一條連線最多 8 個 lease。OpenSSH sshd 預設 MaxSessions 是 10，留 2 個餘裕。
  - 如果裝置把 MaxSessions 設得更小、拒絕開 channel，池子會把那條連線的額度降到它實際撐得住的數量，然後為
    同一個 key 再開一條連線。
- **回收**：沒有 lease、閒置超過 5 分鐘的連線由 reaper 關掉（每 30 秒檢查一次）。裝置斷線時連線自己失效，
  下次取用會重連。
- **誰在用**：SFTP REST（偵測 shell、列目錄、下載、上傳）和檔案管理 WebSocket。
- **效果**：同一台、同一帳號，從第二個操作起就不再握手，省下 TCP 建立、金鑰交換和認證，大約是好幾個到裝置
  的 RTT。測試量到的數字：連續 5 次列目錄只有 1 次登入；同時 12 個請求最多 2 次登入；下載 0 次。

## 四、下一步：讓 `reverse_port` 只是號碼

第二階段把剩下兩條走 loopback 的路也搬到池子上：

1. **網頁終端機**：在池子的連線上用 russh 開 PTY channel（`request_pty` / `request_shell` / `window_change`），
   取代 OpenSSH 客戶端 + ControlMaster。一個分頁就是一條 channel，關分頁就是關 channel，原本 kill / killpg
   的那些坑會一起消失。
2. **遠端瀏覽器**：後端自己提供 SOCKS5，每個 CONNECT 是池子連線上的一條 direct-tcpip channel，取代
   `ssh -D` 子程序。kasm 那端還是要連一個 port（Chromium 的 SOCKS 不支援帳密），所以每個 session 仍然一個 port。
3. **AI session** 也改借池子的連線：關 session 只歸還 lease，不斷線。

做完之後，gateway 不必再綁 `127.0.0.1:<port>`：`reverse_port` 只剩識別號碼的功能，不會再跟容器裡的任何
東西衝突，也不再用到 loopback 的臨時 port。

風險：終端機會從身經百戰的 OpenSSH ControlMaster 換成 russh。動手前要先在 lab 補上 PTY、resize、多分頁、
斷線重連和 Windows / dropbear 的測試。

第三階段（隧道超過 6 萬條才需要）：改用金鑰辨識隧道、不再用 port。每台裝置都 `-R` 同一個號碼，筆電用
`ssh -W <隧道名>:22`。這需要改 DB（`reverse_port` 目前是 UNIQUE），所以先不做。

## 五、怎麼測

- `tests/device_pool.rs`：連線共用（數裝置 sshd 的登入紀錄）、MaxSessions 比 8 小時改開第二條、裝置重連、
  閒置回收、使用中的連線不會被收。
- `tests/ssh_topology.rs`：同一台多使用者、多 OS 帳號，以及多跳路徑。
- 新的 SSH 路徑一律建在 `tests/common/lab.rs` 上（說明見 `.claude/CLAUDE.md` 的 Code Conventions）。
