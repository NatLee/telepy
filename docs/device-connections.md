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

不管走哪條，最後都是**對裝置 sshd 的一次 SSH 登入**：後端用這條隧道自己的服務金鑰（見第八節），筆電用使用者自己的金鑰。

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
- **隧道已經由金鑰辨識**（第十節）：裝置在 `-R` 要求哪個號碼都無所謂，筆電可以用 `ssh -W <隧道名>:22`。
  `reverse_port` 仍是每條隧道的內部號碼（u16），超過 6 萬條隧道時要把它放寬成更大的整數——純粹是型別與分配器
  的改動，裝置與筆電都不用改。

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

## 六、裝置的 host key 釘選

後端每次連到裝置（`ssh::device::connect`）都會比對裝置 sshd 出示的 host key：這條隧道第一次連線時記下（TOFU，
通常就是裝置加入後後端自己的驗證登入），之後不同就拒絕握手、記成待確認，並通知擁有者與分享者。擁有者 / ADMIN 在
隧道詳細資訊的「裝置身分」核對指紋後按「改信任這把金鑰」，或「忘掉」讓下一次連線重新記。理由：裝置分不出 Telepy
使用者、只認服務金鑰，而拿到隧道金鑰的人可以把 `-R` 指到自己的 sshd 冒充裝置，接住終端機輸入、上傳的檔案與遠端桌面
的密碼；釘選之後這種冒充在握手時就被擋下，服務金鑰的登入也不會送出。測試：`tests/host_keys.rs`。

## 七、一台機器一個主人（host key = 機器身分）

裝置分不出 Telepy 使用者：所有人都用同一把服務金鑰登入，誰能把隧道指到那台 sshd（`-R <port>:<那台>:22`，從它本機的
任何帳號、同一個區網或 VPN 都行），誰就能用「自己隧道」的帳號清單登入它，連 root 都行。擋這件事的是釘選的 host key：
它同時是「這台機器」的身分。

- **釘選前先看同一把金鑰還被誰信任**（`db::host_keys::claimants`）：別的帳號的隧道 → 拒絕握手（錯誤開頭
  `device managed by another account`，API / 遠端桌面錯誤碼 `device_claimed`），被拒的隧道記 `claim_refused`，那台機器
  的隧道記 `claim_attempt` 並送 `DEVICE-CLAIM-ATTEMPT` 給擁有者與 ADMIN sharee；同一把只報一次。「確認新金鑰」與
  「忘掉再連」都走同一條規則，繞不過。自己的另一條隧道 → 照常釘選，`GET …/host-key` 的 `same_machine` 列出來。
- **加入腳本在註冊時就送 host key**（`ssh-keyscan` 本機 → `host_keys`）：屬於別的帳號的機器在建隧道前就被拒（409，訊息
  請他向擁有者要分享，或若是複製的 VM 就重做 host key）；自己的另一條隧道回 `SAME_MACHINE_AS`，票上有 `same_machine_as`
  給網頁提醒；新隧道的 host key 立刻釘選（`source = join`），第一次連線不再是看到什麼信什麼。重新加入時只在還沒釘、或
  至少一把對得上時才補釘，全換掉的留給連線時的比對去拒絕。
- **裝置金鑰全站唯一**（`api::reverse_keys::device_key_problem`）：不看註解、不分誰的，也不能是任何人的個人金鑰或服務
  金鑰（gateway 只認金鑰，先登記的那條隧道會被當成那把金鑰的裝置）。
- **gateway 的 direct-tcpip**：只看狀態、一個帳號都沒被允許的 sharee 不能開通道到裝置的 sshd（允許清單是唯一邊界；
  ADMIN 管清單所以例外）。
- 隧道刪掉後釘選也沒了，機器就沒有主人，下一個指過來的人會釘選它；要在刪除時勾「移除服務金鑰」，機器才真的離開 Telepy。

測試：`tests/machine_identity.rs`（指到別人的機器、兩種繞法、自己的第二條、刪掉後釋出）、`tests/join_api.rs`
（註冊時的拒絕 / 同一台提醒 / 立刻釘選）、`tests/rest_api.rs`（裝置金鑰去重）、`tests/ssh_topology.rs`（沒有允許帳號的
sharee）。

## 八、每條隧道一把服務金鑰（`ssh::tunnel_keys`）

第七節擋的是「別人的機器」，這裡把根拔掉：以前全站只有一把服務金鑰（`SSH_IDENTITY`），每台裝置都信它。現在每條隧道
第一次需要時產生一把 ed25519 金鑰對，私鑰以 vault（`SECRET_KEY` 衍生）密封存在 `telepy_tunnel_service_key`，公鑰
（`… telepy-tunnel-<id>`）給精靈、一鍵加入、docker 腳本與隧道詳細資訊（`service_key`）；裝置只授權這一把。

- **登入順序**（`ssh::device`）：先隧道金鑰，裝置還沒裝它才退回共用金鑰；用隧道金鑰成功就記下該帳號「已驗證」
  （`telepy_tunnel_key_account`）。
- **遷移舊裝置**（`device_keys::sync_tunnel`）：隧道金鑰算進每個登入帳號的 wanted，同步時裝進去；下一條連線改用它；
  共用金鑰只在**同一台機器上每條列了這個帳號的隧道**都用自己的金鑰登入過之後才從那個帳號移掉
  （`tunnel_keys::shared_removable`，事件 `service_key_migrated`）。金鑰面板把共用金鑰標成 legacy；管理者可在同一條
  規則下手動移除。
- **刪隧道**：它的金鑰一定從裝置移掉；「移除服務金鑰」的選項現在只管共用的那把。
- **不能撞**：隧道的服務公鑰不能登記成裝置金鑰或個人金鑰（`device_key_problem` / `checked_key`）。
- **換 `SECRET_KEY`**：密文解不開 → 退回共用金鑰；`doctor` 的 `tunnel keys` 會指出有幾把解不開。共用金鑰已經被移掉
  的裝置得重新授權（精靈第 3 步或一鍵加入）。

測試：`tests/tunnel_service_keys.rs`（新裝置只信隧道金鑰、舊裝置遷移、同一台機器等每條隧道、刪除移除）。

## 十、隧道由金鑰辨識（port 只是號碼）

gateway 在公鑰認證時就知道是哪條隧道（`Identity::Tunnel`），所以 `tcpip-forward` 不再看裝置要求的號碼：要求 0 或
別人的號碼都一樣，forward 記在隧道自己的 `reverse_port` 下，回給裝置的也是那個號碼（裝置要求的號碼不同時，`forward`
事件會註明）。使用者金鑰認不出隧道，照舊只能開自己擁有的隧道的號碼。

筆電的 `direct-tcpip` 除了 `localhost:<號碼>`，也接受 `<隧道名稱>:<任意 port>`（名稱全站唯一）：產生的 ssh config
裝置區塊改成 `HostName <名稱>` / `Port 22`，`ProxyCommand ssh -W %h:%p telepy-ssh-server` 不變；舊的設定檔照常可用。
存取規則與以前相同（擁有者、ADMIN、或至少有一個允許帳號的 sharee；敏感隧道要先在網頁確認）。

裝置端腳本仍寫著號碼（伺服器反正會忽略它），移除腳本也還靠 `<號碼>:localhost:` 辨認這條隧道的東西；
`reverse_port` 的 u16 上限是純內部的，真的接近時再放寬型別。測試：`tests/key_identified.rs`。
