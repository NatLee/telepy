# 後端怎麼連到裝置：共用連線與 port

<p align="center"><a href="./device-connections.md">English</a> | <b>繁體中文</b> | <a href="./device-connections.ja.md">日本語</a></p>

> 本文涵蓋現在的連線路徑、port 用在哪裡、依「通道 + OS 帳號」共用連線的設計，以及還沒做的部分。
> 程式：`gateway/mod.rs`、`gateway/proxy_protocol.rs`、`ws/gateway.rs`、`ssh/device.rs`、`ssh/pool.rs`、`ssh/sftp_watch.rs`、
> `ssh/resolve.rs`、`ssh/terminal.rs`、`ssh/socks.rs`、`ssh/bridge.rs`、`ssh/host_keys.rs`、`ssh/tunnel_keys.rs`；
> 測試：`tests/terminal_e2e.rs`、`tests/socks_e2e.rs`、`tests/device_pool.rs`、`tests/ssh_topology.rs`、`tests/gateway_ws.rs`、
> `tests/proxy_protocol.rs`（都建在 `tests/common/lab.rs` 上）。

## 一、現在怎麼連？跟以前一樣嗎？

![終端機連線的路徑：瀏覽器、Telepy、裝置的 sshd](images/zh-TW/terminal-flow.png)

**裝置端還是 OpenSSH 的 `-R`。** 裝置用通道金鑰跑
`ssh / autossh -NR '*:0:localhost:22' telepy@<server> -p 24242`：現在的腳本一律要求 `-R 0`，由 gateway 依金鑰認出通道
（第十節），並用 `StrictHostKeyChecking=yes` + `HostKeyAlias=telepy-<host>-<port>` 釘住 gateway 的 host key；以前寫著
號碼的舊腳本照常可用。只能出網頁 port 的網路改走 WebSocket（第九節），裡面是同一條 SSH。伺服器端以前接住這條連線的是
OpenSSH 容器，現在是後端行程裡的 gateway（russh）。

```
裝置                                         Telepy 後端（單一行程）
┌──────────────┐  ssh -NR（通道金鑰）       ┌──────────────────────────────────────────────────────────┐
│ sshd :22     │◀═══════════════════════════▶│ gateway :2222（對外 24242）                                │
└──────────────┘                            │   forward 表：reverse_port → 這台裝置的那條連線（不綁本機 port）│
       ▲                                    │                                                            │
       │ 每條 SSH channel = 通道裡的一條        │ 連線池（ssh::pool）：同一台、同一個 OS 帳號一條 SSH 連線      │
       │ forwarded-tcpip channel；裝置的       │   ├ 網頁終端機：一個分頁一條 PTY channel                     │
       │ ssh 客戶端把它接到 localhost:22        │   ├ 檔案管理 / SFTP：共用一條 sftp channel（exec 備援一指令一條）│
       └──────────────────────────────────── │   ├ 遠端瀏覽器：行程內 SOCKS5，每個 CONNECT 一條 direct-tcpip    │
                                            │   └ 區網主機那一跳：一條 direct-tcpip（最後一跳仍是 OpenSSH）   │
                                            │ AI session、區網掃描：各自一條連線（同樣在行程內開通道）         │
                                            │ 筆電：ssh -W <通道名>:22 telepy@server（使用者金鑰）→ channel      │
                                            └──────────────────────────────────────────────────────────┘
```

不管走哪條，最後都是**對裝置 sshd 的一次 SSH 登入**：後端用這條通道自己的服務金鑰（見第八節），筆電用使用者自己的金鑰。

| 路徑 | 以前（Django + OpenSSH 容器） | 現在 |
|---|---|---|
| 裝置 → 伺服器 | `ssh -NR` 到 ssh 容器 | 一樣是 `ssh -NR`（`-R 0`），連到後端內建 gateway；也可包在 `/ws/gateway/` 的 WebSocket 裡 |
| 網頁終端機 | 後端 → ssh 容器（第一次 SSH）→ 裝置（第二次） | 池子連線上的 PTY channel；同一台同一帳號的分頁、檔案管理共用**一次** SSH 登入 |
| 檔案管理 / SFTP | 每個操作 spawn `ssh` / `scp`，各自兩次 SSH | SFTP REST 與所有檔案管理共用池子連線上的**一條** sftp channel；沒有 sftp 子系統時檔案管理用 exec channel 跑 `ls -la` |
| 遠端瀏覽器 | `ssh -D` 子程序 | 後端自己的 SOCKS5（只做 CONNECT），CONNECT = 池子連線上的 direct-tcpip |
| 區網主機終端機 | `ProxyCommand ssh -W` 經 ssh 容器 | 池子連線上的 direct-tcpip 接到一次性本機入口（`ssh::bridge`），最後一跳 OpenSSH（可問密碼） |
| 裝置金鑰清單（`device_keys`） | 沒有 | 同一個池子借連線，SFTP 讀寫 `~/.ssh/authorized_keys` |
| 筆電 | `ProxyCommand ssh -W` 經 ssh 容器 | 一樣，經 gateway |

## 二、port 用在哪裡？會不會用完？

| port | 用途 | 數量 | 會不會用完 |
|---|---|---|---|
| 24242、8787 | 對外：裝置通道、網頁（走 WebSocket 的裝置也用網頁這個 port） | 固定 | 不會 |
| `reverse_port` | 每條通道一個**號碼**：裝置在 `-R` 指定它，gateway 用它找到那條連線。**不綁任何本機 port** | 每條通道 1 個 | 號碼上限約 64,500 條通道 |
| SOCKS port | 每個遠端瀏覽器 session 一個（kasm 容器連進來；Chromium 的 SOCKS 不支援帳密，所以無法共用一個） | 受 session 上限限制 | 不會 |
| 區網主機一次性入口 | 每開一個區網主機終端機，`127.0.0.1:<臨時埠>` 等一條連線（30 秒沒人來就關） | 開著的區網終端機數 | 不會 |
| 遠端桌面回連埠 | 每個 RDP / VNC session 一個一次性 listener（隨機埠，只收 guacd 的位址），guacd 連進來就接到裝置的 direct-tcpip、listener 關掉 | 開著的桌面 session 數 | 不會 |

後端連裝置不再經過任何 loopback TCP，所以也沒有臨時 port、TIME_WAIT 的問題。`reverse_port` 只是號碼，
不會跟容器裡任何東西衝突，分配時只要避開已經發出去的號碼（`monitor::find_free_port`）。

## 三、依「通道 + OS 帳號」共用連線（`ssh::pool`）

- **key**：`(reverse_port, OS 帳號)`。不同 Telepy 使用者只要被允許用同一個帳號，就共用同一條連線；各自是獨立
  的 channel。權限照舊在取用前由 `permissions::allowed_usernames` 檢查。
- **建立**：第一次用到才連。傳輸在行程內：`Gateway::open_stream(port)` 在裝置通道上開一條 forwarded-tcpip
  channel，russh 直接在上面跟裝置 sshd 握手。同一個 key 同時有多個請求時只握手一次，其他人等它。
- **額度只算 session channel**：OpenSSH 的 MaxSessions 只限 session channel（shell、exec、sftp），不限
  direct-tcpip，所以池子也只數這種。
  - 開 session channel（終端機分頁、exec、裝置金鑰清單、macOS 的名稱解析）一律走 `DevicePool::session_channel`。
  - 一條連線同時最多 8 條 session channel；sshd 預設 MaxSessions 是 10，留 2 個，因為裝置要處理完我們的
    close（shell 還得先結束）才放掉名額，剛還回來的名額馬上再用可能被拒。
  - 裝置把 MaxSessions 設得更小、拒絕開 channel 時，池子記下那條連線當下撐得住的數量，再為同一個 key 開一條
    連線。學到的上限 2 分鐘後失效：被拒可能只是一時的，不該讓那條連線一直縮著。
  - 只開 direct-tcpip 的用途（遠端瀏覽器的 SOCKS、遠端桌面 / RustDesk、區網那一跳）用 `DevicePool::acquire`
    借「傳輸」lease：不占額度，只讓連線不被收掉。以前它們各占一格，開著遠端瀏覽器加遠端桌面時，終端機分頁
    就少兩格。
- **SFTP 共用一條 channel**：SFTP 請求有編號，多人同時用同一條沒問題，所以每條連線只開一條 sftp channel，
  SFTP REST 與所有檔案管理都走它（`DevicePool::sftp`）。
  - 好處：SFTP REST 不必每個請求都重開 channel、要子系統、做 INIT（通道上好幾個來回）；檔案管理開再多也只占
    一格。
  - 代價：裝置的 sftp-server 一次只處理一個請求，一個卡住的請求（例如卡在掛掉的網路磁碟）會讓大家一起等。
    所以 `ssh::sftp_watch` 包住 channel 的 stream，數送出的請求與收到的回覆：channel 關了，或有請求在等卻
    15 秒什麼都沒收到，就算壞掉，下一個借的人拿到新的一條；檔案管理列目錄失敗時自己換一條再試一次。
  - 沒人用超過 5 分鐘就關掉，還回那一格（連線本身還有人用時也一樣）。
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
    - 同一個名稱同時查只跑一次；同時最多 2 個查詢（每個都向池子借一條 session channel，算在額度裡）。
    - 快取：查得到 60 秒、查不到 10 秒。
    - 查不到就讓那個 CONNECT 失敗，**絕不**把名稱交給 Apple 的 sshd。
  - 其他 OS：照舊把名稱交給裝置解析（與 `ssh -D` 相同）。
- **效果**：同一台、同一帳號，從第二個操作起就不再握手。測試量到的數字：
  - 連續 5 次列目錄：1 次登入、1 條 sftp channel
  - 同時 12 個請求：1 次登入、1 條 sftp channel
  - 3 個終端機分頁加檔案管理：1 次登入
  - 10 個傳輸 lease 加 8 個 session：1 次登入

## 四、還沒做的

- **AI session 與區網掃描仍是自己的一條連線**（`ssh::device::connect`）。一個 AI session 同時最多開 4 條 channel（指令與
  互動 shell 共用）再加 SFTP，若只算一個 session，會讓池子低估裝置的 MaxSessions 用量。它已經在行程內開通道（不占 port），
  共用連線只省一次握手，所以先不搬。
- **`reverse_port` 的上限**：通道已經由金鑰辨識（第十節），裝置在 `-R` 要求哪個號碼都無所謂，筆電也用 `ssh -W <通道名>:22`；
  但 `reverse_port` 仍是每條通道的內部號碼（u16），超過 6 萬條通道時要把它放寬成更大的整數——純粹是型別與分配器
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
- `tests/device_pool.rs`：
  - 連線與 sftp channel 共用（數裝置 sshd 的登入紀錄與 sftp 啟動次數）
  - MaxSessions 比 8 小時改開第二條；傳輸 lease 不占額度
  - 壞掉的共用 sftp 被換掉、沒人用的被關掉；檔案管理自己換一條
  - sftp 子系統被拒時 channel 會關掉（不留在裝置上占 MaxSessions）
  - 裝置重連、閒置回收、使用中的連線不會被收
- `tests/ssh_topology.rs`：同一台多使用者、多 OS 帳號，以及多跳路徑。
- `tests/gateway_ws.rs`：裝置經 `/ws/gateway/` 連上（含真的 `telepy-ws.py` 當 ProxyCommand）；`tests/proxy_protocol.rs`：
  L4 代理的 PROXY header（見第九節）。
- 新的 SSH 路徑一律建在 `tests/common/lab.rs` 上（說明見 `.claude/CLAUDE.md` 的 Code Conventions）。

## 六、裝置的 host key 釘選

後端每次連到裝置（`ssh::device::connect`）都會比對裝置 sshd 出示的 host key：這條通道第一次連線時記下（TOFU，
通常就是裝置加入後後端自己的驗證登入），之後不同就拒絕握手、記成待確認，並通知擁有者與分享者。擁有者 / ADMIN 在
通道詳細資訊「金鑰與身分」分頁的「裝置身分」核對指紋後按「改信任這把金鑰」，或「忘掉」讓下一次連線重新記。理由：裝置分不出 Telepy
使用者、只認服務金鑰，而拿到通道金鑰的人可以把 `-R` 指到自己的 sshd 冒充裝置，接住終端機輸入、上傳的檔案與遠端桌面
的密碼；釘選之後這種冒充在握手時就被擋下，服務金鑰的登入也不會送出。測試：`tests/host_keys.rs`。

筆電也一樣：產生的 ssh config 裡，裝置區塊用 `UserKnownHostsFile ~/.ssh/telepy_known_hosts` +
`HostKeyAlias <伺服器別名>-device-<通道 id>` 核對裝置的 host key。Telepy 已經釘住時是 `StrictHostKeyChecking yes`，
釘住的那幾行跟伺服器的放在同一個檔（安裝指令、`telepy config install` / `telepy ssh` 都會一起存）；還沒釘住時是
`accept-new`，筆電第一次連線自己記下、之後不同就拒絕。以前裝置區塊是 `StrictHostKeyChecking no`，拿到通道金鑰的人把
通道接到自己的 sshd，筆電的 `ssh <裝置>` 就直接連進去。擁有者改信任新金鑰之後，筆電要重跑一次安裝指令。
測試：`tests/laptop_device_host_key.rs`（含冒牌 sshd 與舊寫法的對照）。

## 七、一台機器一個主人（host key = 機器身分）

裝置分不出 Telepy 使用者：所有人都用同一把服務金鑰登入，誰能把通道指到那台 sshd（`-R <port>:<那台>:22`，從它本機的
任何帳號、同一個區網或 VPN 都行），誰就能用「自己通道」的帳號清單登入它，連 root 都行。擋這件事的是釘選的 host key：
它同時是「這台機器」的身分。

- **釘選前先看同一把金鑰還被誰信任**（`db::host_keys::claimants`）：別的帳號的通道 → 拒絕握手（錯誤開頭
  `device managed by another account`，API / 遠端桌面錯誤碼 `device_claimed`），被拒的通道記 `claim_refused`，那台機器
  的通道記 `claim_attempt` 並送 `DEVICE-CLAIM-ATTEMPT` 給擁有者與 ADMIN sharee；同一把只報一次。「確認新金鑰」與
  「忘掉再連」都走同一條規則，繞不過。自己的另一條通道 → 照常釘選，`GET …/host-key` 的 `same_machine` 列出來。
- **加入腳本在註冊時就送 host key**（`ssh-keyscan` 本機 → `host_keys`）：屬於別的帳號的機器在建通道前就被拒（409，訊息
  請他向擁有者要分享，或若是複製的 VM 就重做 host key）；自己的另一條通道回 `SAME_MACHINE_AS`，票上有 `same_machine_as`
  給網頁提醒；新通道的 host key 立刻釘選（`source = join`），第一次連線不再是看到什麼信什麼。重新加入時只在還沒釘、或
  至少一把對得上時才補釘，全換掉的留給連線時的比對去拒絕。
- **裝置金鑰全站唯一**（`api::reverse_keys::device_key_problem`）：不看註解、不分誰的，也不能是任何人的個人金鑰或服務
  金鑰（gateway 只認金鑰，先登記的那條通道會被當成那把金鑰的裝置）。
- **gateway 的 direct-tcpip**：只看狀態、一個帳號都沒被允許的 sharee 不能開 channel 到裝置的 sshd（允許清單是唯一邊界；
  ADMIN 管清單所以例外）。
- 通道刪掉後釘選也沒了，機器就沒有主人，下一個指過來的人會釘選它。刪除時這條通道自己的服務金鑰一定從裝置移掉（第八節）；
  裝置上還留著舊的共用金鑰時，要勾「移除服務金鑰」（這台機器的最後一條通道會預先勾好），機器才真的離開 Telepy。

測試：`tests/machine_identity.rs`（指到別人的機器、兩種繞法、自己的第二條、刪掉後釋出）、`tests/join_api.rs`
（註冊時的拒絕 / 同一台提醒 / 立刻釘選）、`tests/rest_api.rs`（裝置金鑰去重）、`tests/ssh_topology.rs`（沒有允許帳號的
sharee）。

## 八、每條通道一把服務金鑰（`ssh::tunnel_keys`）

第七節擋的是「別人的機器」，這裡把根拔掉：以前全站只有一把服務金鑰（`SSH_IDENTITY`），每台裝置都信它。現在每條通道
第一次需要時產生一把 ed25519 金鑰對，私鑰以 vault（`SECRET_KEY` 衍生）密封存在 `telepy_tunnel_service_key`，公鑰
（`… telepy-tunnel-<id>`）給精靈、一鍵加入、docker 腳本與通道詳細資訊（`service_key`）；裝置只授權這一把。

- **登入順序**（`ssh::device`）：先通道金鑰，裝置還沒裝它才退回共用金鑰；用通道金鑰成功就記下該帳號「已驗證」
  （`telepy_tunnel_key_account`）。
- **遷移舊裝置**（`device_keys::sync_tunnel`）：通道金鑰算進每個登入帳號的 wanted，同步時裝進去；下一條連線改用它；
  共用金鑰只在**同一台機器上每條列了這個帳號的通道**都用自己的金鑰登入過之後才從那個帳號移掉
  （`tunnel_keys::shared_removable`，事件 `service_key_migrated`）。金鑰面板把共用金鑰標成 legacy；管理者可在同一條
  規則下手動移除。網站設定 → 伺服器的「在裝置上保留共用服務金鑰」（或 `.env` 的 `KEEP_SHARED_SERVICE_KEY=true`）打開時，
  共用金鑰永遠不移（自動或手動都不行）：搬家期間舊的 Telepy 還在用同一把金鑰登入同一批裝置時用（通道金鑰照樣裝進去、
  照樣先用它登入）。
- **刪通道**：它的金鑰一定從裝置移掉；「移除服務金鑰」的選項現在只管共用的那把。
- **不能撞**：通道的服務公鑰不能登記成裝置金鑰或個人金鑰（`device_key_problem` / `checked_key`）。
- **換 `SECRET_KEY`**：密文解不開 → 退回共用金鑰；`doctor` 的 `tunnel keys` 會指出有幾把解不開。共用金鑰已經被移掉
  的裝置得重新授權（精靈第 3 步或一鍵加入）。

測試：`tests/tunnel_service_keys.rs`（新裝置只信通道金鑰、舊裝置遷移、同一台機器等每條通道、刪除移除）。

## 九、裝置怎麼到 gateway：TCP、WebSocket、PROXY protocol

![你的電腦怎麼連到 Telepy，以及裝置怎麼連進來](images/zh-TW/transport-info.png)

![為什麼 SSH 可能需要另一個名稱](images/zh-TW/ssh-host.png)

- **TCP（預設）**：對外 `REVERSE_SERVER_SSH_PORT`（24242，容器內 2222）。
  - 連的名稱是 `SSH_SERVER_DOMAIN`（網站設定 → 伺服器 → SSH 主機），沒設就跟網頁同一個名稱。網頁的名稱放在只轉網頁 port 的代理後面（Cloudflare 的橘色雲朵、其他 CDN、HTTP 負載平衡器）時，那個名稱連不到 SSH 的 port，要另外給 SSH 一個直接到伺服器的名稱。known_hosts 的別名（`telepy-<網域>-<port>`）仍然用網域，換 SSH 主機不會變成「另一台伺服器」。已經裝好的裝置繼續連當初的名稱。設定頁會解析兩個名稱、認得出 Cloudflare 的位址（別的代理認不出來），`doctor` 的 `ssh_host` 檢查也會。SSH 的名稱不該開得到網頁：`PUBLIC_URL` 有設、SSH 主機另有其名時，用 SSH 名稱進來的登入一律 421（`ssh_host`），前端換成一頁說明並指回正式網址；儲存時不能填自己正在用的名稱（會把自己鎖在外面）。這擋的是走錯網址與設定失誤，偽造 `Host` 要靠把 origin 鎖給代理。
- **WebSocket**（`ws/gateway.rs`）：給只放行網頁 port 的網路（公司內網、飯店、4G 路由器）。裝置的 ssh 加上
  `ProxyCommand ~/.ssh/telepy-<安裝代號>-ws.sh`，這個包裝腳本執行**載體**：優先用預編的 `telepy-carrier`（Rust 靜態 binary，`src/carrier/`，
  每次 release 都編 x86_64 / aarch64 / armv7 / armv6 Linux、macOS 與 Windows；裝置從這台伺服器的 `GET /api/join/carrier/<target>` 下載，並用伺服器在
  `…/sha256` 公布的 sha256 核對，那個值又來自 release 的 `SHA256SUMS`，而伺服器只接受帶有 Telepy 發行金鑰有效簽章（`SHA256SUMS.sig`，`release_key.rs`）的那份；伺服器在某平台第一次被要時才從 release 頁抓，快取在 `CARRIER_DIR` =
  `<DATA_DIR>/carriers`，`telepy-server fetch-carriers` 可以先抓齊；網站設定 `carrier_auto_update`（預設開）時伺服器每天問一次 release 頁，在背景把比較舊的換掉，並通知每個管理員與全站 webhook（`carriers.updated` / `carriers.update_failed`）；伺服器健康 → 附屬服務 → **裝置載體**看得到每個平台的版本，也能手動更新），沒有預編 binary 的 CPU（MIPS 路由器）則用 `python3` 跑 `telepy-ws.py`
  （只用標準函式庫，`GET /api/join/telepy-ws.py`）；join 腳本的 `--carrier binary|python` 可以指定。兩種都把位元組包成二進位 frame 送到網頁 port，
  也都會走裝置設定的 HTTP CONNECT 代理（`HTTPS_PROXY` / `--proxy`，`NO_PROXY` 照用；join 腳本會把執行環境的代理寫進包裝腳本，因為服務沒有自己的
  環境變數）。裡面是**同一條** SSH session：同一組 host key、同樣的金鑰認證與 forward 規則，沒有多信任什麼，也沒有 auth 第一則訊息（認證在裡面的
  SSH 做）。在精靈的連線步驟或一鍵加入時選（`transport: websocket`）。裝了哪種會回報成 `carrier` 事實（`binary <target>` / `python3` / `none`），
  顯示在 Device 分頁。
- **自動**（`transport: auto`，精靈與一鍵加入的預設）：小程式加上 `--tcp <SSH 主機>:<port>`，每次連線先直接連 SSH 的 port、看到 gateway 的 `SSH-` banner 才算數；連不上（防火牆、網頁名稱在只轉網頁 port 的代理後面）就改走上面的 WebSocket。成功走 WebSocket 會記 30 分鐘（暫存目錄裡一個小檔），之後再先試 SSH 的 port；走哪條會寫在 stderr（服務的 log）。完全沒有載體的裝置（它的 CPU 沒有預編 binary、也沒有 python3）只走 SSH 的 port，join 會說明。一鍵加入是 `--auto`，註冊時回報實際裝的方式（`facts.transport`、`facts.carrier`），存成 `way_in`。
  - 來源 IP 取自轉送 header（`X-Forwarded-For`，哪幾段是代理見網站設定 → 伺服器的「信任的代理層數」或 `TRUSTED_PROXY_HOPS`：
    預設 `auto` 把右邊的內部位址都當代理），port 記成 0；連線資訊、`accepted` 事件與
    清單的 `endpoint.transport` 記 `websocket`。連線上限（`GATEWAY_MAX_CONNECTIONS`）兩個入口一起算。
  - 筆電也能這樣連：SSH config 對話框的「連到 Telepy 的方式」選「只有網頁 port」（或「自動」= 帶 `--tcp`，先試 SSH 的 port），
    伺服器區塊就多一行 ProxyCommand（先把 `telepy-ws.py` 存到 `~/.ssh/telepy-ws.py`）。`telepy ssh / scp / sftp` 不用這個小程式，
    預設就走網頁 port（見 [cli.md](cli.md)）。
- **內建 client**（`--client builtin`，裝置沒有 OpenSSH client 時一鍵加入會選它）：唯一的 SSH client 跟 gateway 談不來（原廠 OpenWrt 的 dbclient）或根本沒有 client 的裝置，由同一個 `telepy-carrier` 自己跑整條通道：`telepy-carrier tunnel --identity <金鑰> --known-hosts <檔案> --server <SSH 主機>:<port> [--ws <網址>] --forward 0:<sshd>`。它自己跟 gateway 講 SSH（釘住 host key、金鑰登入、`tcpip-forward` 0），把 gateway 開過來的每條通道接到裝置的 sshd，用自己的 30 秒 keepalive，斷線就結束、由服務管理器重啟。連線方式（SSH 的 port / 網頁 port / 自動）與 CONNECT 代理跟上面一樣；服務直接執行 `~/.ssh/telepy-<安裝代號>-ws.bin`。細節與限制見 [device-join](device-join.zh-TW.md#一之二內建的-ssh-clienttelepy-carrier-tunnel)。
- **其他載體（自己動手）**：上面的 WebSocket 只是 Telepy 自己的小幫手，gateway 並不依賴它。任何能把 ssh 的 stdin / stdout 接成一條到 gateway 的 TCP 連線的程式，都能當裝置的 `ProxyCommand`。遇到連網頁 port 也過不去的網路（要 CONNECT 的對外 HTTP 代理、依 SNI 過濾、TCP 被限速），通用的隧道工具如 [wstunnel](https://github.com/erebe/wstunnel) 不用改 Telepy 就能補上：在後端的網路上多跑一個 `wstunnel server` 容器並加 `--restrict-to backend:2222`（再用 `--restrict-http-upgrade-path-prefix` 設一條暗號路徑），Traefik 把一條路徑導給它，裝置端寫 `ProxyCommand wstunnel client -L stdio://backend:2222 wss://<主機>/<路徑>`。裡面仍是 Telepy 的 SSH：同一組金鑰、host key 釘選與 forward 規則。
  - 會失去的：gateway 看到的對端是 wstunnel 容器（裝置的公網位址只能等每日探測補上，有延遲），連入方式的標示會是 SSH 而不是 SSH over WSS，Device 分頁也不認得手動裝的服務。
  - 必須做對的：wstunnel server 預設全部放行，沒有 `--restrict-to` 就等於開了一個進 compose 內網的中繼（guacd、kasm-browser 的 session-manager 都摸得到）。Telepy 不內建、也不管理它；wstunnel 的協定在大版本之間會變，每台裝置上的 client 得跟著容器一起升。
- **PROXY protocol**（`gateway/proxy_protocol.rs`）：gateway 前面有 L4 代理（nginx stream、HAProxy `mode tcp`、雲端 NLB）時，
  gateway 看到的來源都是代理。把代理列進網站設定 → 伺服器的「SSH 閘道的 PROXY protocol 來源」或 `.env` 的
  `GATEWAY_PROXY_PROTOCOL_FROM`（IP / CIDR，逗號或空白分隔；空 = 關閉；`.env` 有設就以它為準、頁面上鎖住），它送的 v1 / v2
  header 裡的來源就取代 peer：事件、endpoint、誰在用、IP 變更告警都用它。
  - header **可有可無、自動判斷**：先偷看第一個 byte（SSH 一定以 `S` 開頭，header 是 `P` / `\r`），5 秒都沒送東西就當成等 banner
    的直連客戶端；讀取剛好停在 header 結尾，後面的 SSH 一個 byte 都不動。所以設錯也不會把直連的裝置擋在外面。
  - v1 `UNKNOWN` / v2 `LOCAL` 沿用 peer；格式錯或 5 秒內沒送完 → 拒絕並記 `refused_proxy` 事件；只連上就斷（健康檢查）不記。
  - 沒列出的來源**從不**讀 header：否則任何人都能自稱任何 IP，IP 變更告警就沒有意義。裝置端腳本不用改。

測試：`tests/gateway_ws.rs`、`tests/proxy_protocol.rs`（lab 用 `Lab::start_with(|config| …)` 設定代理位址）。

## 十、通道由金鑰辨識（port 只是號碼）

gateway 在公鑰認證時就知道是哪條通道（`Identity::Tunnel`），所以 `tcpip-forward` 不再看裝置要求的號碼：要求 0 或
別人的號碼都一樣，forward 記在通道自己的 `reverse_port` 下，回給裝置的也是那個號碼（裝置要求的號碼不同時，`forward`
事件會註明）。使用者金鑰認不出通道，照舊只能開自己擁有的通道的號碼。

筆電的 `direct-tcpip` 除了 `localhost:<號碼>`，也接受 `<通道名稱>:<任意 port>`（名稱全站唯一）：產生的 ssh config
裝置區塊改成 `HostName <名稱>` / `Port 22`，經 `ProxyCommand ssh -W %h:%p <伺服器區塊>` 跳過去；舊的設定檔照常可用。
名稱**不分大小寫**比對：OpenSSH 會先把 `HostName` 轉成小寫才放進 `%h`（`MyBox` 到閘道時是 `mybox`）。完全相同的優先，
否則挑這把金鑰連得到的那條；以前精確比對，名稱有大寫的通道會被拒（`administratively prohibited`）。
通道名稱本身也照 OpenSSH 的主機名稱規矩：只能用英數與 `.` `_` `-`、字母或數字開頭、最多 63 字，而且不分大小寫唯一
（`tunnel_name.rs`）。空白在 ssh_config 會把一個名字拆成兩個、在命令列會被 OpenSSH 9.6 起直接拒絕；`%` 會被當成 `%h`
展開，`* ? ! ,` 是樣式符號，`#` 是註解，`@` `:` 是 Telepy 自己的 `<通道>@<帳號>` / `<通道>:<路徑>`。規則之前就存在、不合規則的
名稱照樣能用：產生的設定對它們改寫 `HostName localhost` / `Port <號碼>`，網頁提示擁有者改名。
伺服器區塊的別名是 `telepy-<網域>-<port>`（跟 `HostKeyAlias` 同一個字串），每台 Telepy 各自一個，裝在同一份 config 裡互不干擾；
舊版共用的 `telepy-ssh-server` 區塊由安裝指令在「確定是這台、又沒有區塊再用它」時清掉。
兩台 Telepy 有同名裝置時，安裝指令看同名區塊的 ProxyCommand 跳到哪台伺服器：是別台的就保留、不覆蓋，並列出這些名字；
使用者替其中一台設「名稱前綴」（個人設定 `ssh_alias_prefix`，例如 `work-` → `ssh work-pi`）後，兩邊就能並存。
存取規則與以前相同（擁有者、ADMIN、或至少有一個允許帳號的 sharee；敏感通道要先在網頁確認）。個人金鑰過期（記 `expired_key`
事件）、帳號被停用、或管理員替這個人關掉「個人 SSH 金鑰」功能時，gateway 在認證時就拒絕這把金鑰。

裝置端腳本一律寫 `-R 0`（Docker 版 `SSH_TUNNEL_PORT=0`，一鍵加入也是）：號碼只存在伺服器裡。網頁刪除通道時的移除腳本
改用**金鑰**辨認這條通道的東西（命令列或檔案裡的 `-i <金鑰檔>`、`IdentityFile`、docker 的 `KEY_FILE=` / `<path>:/id_rsa`、
容器掛在 `/id_rsa` 的金鑰；旁邊的 `.pub` 或 `ssh-keygen -y` 要算出通道金鑰），以前寫著號碼的舊腳本照舊用號碼認；
一鍵加入的背景迴圈重跑時用這條通道自己的 known_hosts 檔（`telepy-<安裝代號>.known_hosts`）找舊的 ssh：號碼認不出它，
金鑰檔又可能同時給別台 Telepy 的通道用（見第十一節）。
`reverse_port` 的 u16 上限是純內部的，真的接近時再放寬型別。測試：`tests/key_identified.rs`、`tests/tunnel_delete.rs`。

## 十一、裝置上的名稱：安裝代號、盤點、改名不離線（`device_install/`）

**問題**：以前裝到裝置上的東西有些帶著人或伺服器的名字——hdre 遷移腳本的 `telepy-natlee.service` /
`info.natlee.telepy` / `telepy_natlee_known_hosts`、一鍵加入 unit 說明裡的通道名稱、所有通道共用的 `telepy-tunnel.service`
（同一台兩條通道會互相覆蓋）與 `~/.ssh/telepy_known_hosts`（第二台伺服器加入時把第一台的 host key 蓋掉）。別的使用者的
機器上出現 `telepy-natlee`，等於告訴他是誰在管這台伺服器；Telepy 也不知道當初裝了什麼，刪除時只能猜。

**安裝代號**：每條通道第一次需要時抽一個 8 字的隨機代號（`[a-hj-km-np-z2-9]`，`telepy_device_install`，全站唯一，跟著通道刪），
所有裝置端的名稱都從它取：`telepy-<id>.service`（systemd，system / --user、autossh 服務都一樣）、`com.telepy.tunnel.<id>`
（launchd）、`~/.ssh/telepy-<id>.sh`（背景迴圈）、`telepy-<id>.known_hosts`、`telepy-<id>-uninstall.sh`、`telepy-<id>-ws.*`、
Docker 容器 `telepy-<id>`；unit 的說明只寫 `Telepy reverse tunnel <id>`。代號不含使用者、網域或通道名稱，通道改名不必動裝置；
在通道頁搜尋代號就找得到那條通道。不用雜湊：沒有紀錄的話算不回原名，`SECRET_KEY` 一換也全變；隨機 + 紀錄一樣乾淨。
`telepy-` 前綴留著——裝置管理員看得出這是什麼，一個看不出來歷、一直往外連 SSH 的服務反而像惡意程式。ssh 指令本身仍會寫
出它連的伺服器（`telepy@<網域>`、`HostKeyAlias`），那是連線本身需要的。

**盤點（survey）**：刪除用的 `remove_tunnel.sh` 多了 `T_MODE=survey`：什麼都不改，只回報 `found` 項目（unit / plist 的路徑、
迴圈、正在跑的 ssh 與它的擁有者 `owner <pid> <帳號> <家目錄>`、crontab 行、容器、金鑰、known_hosts）。結果存在
`telepy_device_install.survey`，一鍵加入驗證後、device_info 每天那趟（沒盤點過或超過 7 天）、詳細資料按「重新檢查」時更新。
Windows 的腳本只會移除，盤點還沒做（只回平台）。

**登入帳號讀不到的檔案**：以 root 跑的 unit 常把金鑰放在 `/root/.ssh`，登入帳號（例如 `ubuntu`）讀不到就認不出那是這條通道的。
登入帳號有 `sudo -n` 時，金鑰、unit、迴圈腳本改用 `sudo -n cat` / `test -f` / `ssh-keygen -y -P ''` 讀（只讀，同一個檔案只問一次）；
正式站第一輪盤點就是卡在這裡，只認出金鑰剛好放在 `/home/ubuntu` 的那一台。

**沒寫金鑰的服務**：hdre 遷移腳本遇到舊通道沒指定 `-i` 時，新 unit 也不寫，ssh 就用執行帳號的預設金鑰
（`~/.ssh/id_ed25519`、`id_ecdsa`、`id_rsa`…）。指令沒寫金鑰檔、明確連到這台 gateway 的 port、又有 `-R` 時，就拿執行帳號
（程序的擁有者；unit 的 `User=`、plist 的 `UserName`，系統層沒寫 = root；其他 = 登入帳號）的預設金鑰比對。預設金鑰是那個人自己的
檔案，刪除時不會刪。

**plist 與 OpenWrt**：launchd 的 plist 把每個參數放在自己的 `<string>`，比對前先接成一行（`text_of`），否則 `-p` / `-i` 都讀不到；
OpenWrt 的 procd 腳本（`/etc/init.d/*`，有 `/etc/rc.common` 才看）與 `/etc/rc.local` 的行也照同樣規則認——刪除時 init 腳本
`disable` 後由停止腳本 `stop` + 刪掉，rc.local 只拿掉那一行。init 腳本不會自動改名（`unsupported`）：重跑一行指令加入就會用私人名稱。

**指令長度**：OpenWrt 路由器常用 dropbear，它不收超過 9000 字的 exec 指令，而這支腳本有 25KB。超過 6000 字的腳本改成先分段
`printf >> <暫存檔>`、最後一個 exec 跑它並刪掉（`exec::script_commands` / `run_script`），任何 sshd 都收得下；也在 BusyBox ash
（Alpine）跑過。

**連到別台伺服器的不碰**：同一把金鑰可能同時服務兩台 Telepy（hdre 與新站就是），以前「依金鑰比對」會把 hdre 的 unit 一起拆掉。
現在檔案或命令列寫了 port（`-p N`、`'-p' 'N'`、`Port=N`、`SSH_REMOTE_PORT=N`）而且沒有一個是這台 gateway 的
`REVERSE_SERVER_SSH_PORT`，就是別台的（`kept other-server`），刪除、盤點、改名都跳過。沒寫 port 的照舊認。

**改名，先接上再拆舊的**：指令本身就是經這條通道送過去的，先停舊的等於先把自己切斷。所以：
1. 重新盤點，`plan::plan` 從正在跑的 ssh（`parse_ssh`：`-i`、`-p`、`-R` 的目標、`user@host`、ProxyCommand）與找到的舊服務排出
   計畫：同一種方式（systemd system → system unit 以原本的 `User=`；--user / LaunchAgent / 迴圈 → 跑它的那個帳號；系統層要
   root 或 `sudo -n`），金鑰、伺服器、port、轉發目標都照舊，known_hosts 改寫成這台 gateway 的 host key。擋下的原因（Windows、
   要 root、讀不懂指令、相對金鑰路徑…）回成 `blocker`，網頁照著說明。
2. gateway `arm_handover(port)`：這段時間同一條通道（同一把通道金鑰認出的）第二條連線的 `tcpip-forward` 不被拒，而是記成
   **備援**（`standby`；回成功，新 ssh 的 `ExitOnForwardFailure` 不會退出），forward 仍在舊連線上。事件 `standby_forward`。
3. 經舊連線跑安裝腳本（`plan::install_script`：檔案先寫旁邊再改名、啟動新服務）。
4. 等備援出現（預設 45 秒）；`device::connect_standby` 經備援登入一次。
5. `promote`：forward 移到新連線（事件 `handover`，記新的 endpoint）。舊連線還活著但不再帶通道。
6. 經**新**連線跑移除腳本的 `T_MODE=relabel`：跟刪除一樣找出這條通道的東西，但跳過用代號取名的（`kept_new`）、留下金鑰，
   舊 unit / plist / 迴圈 / crontab 行 / 舊 known_hosts（沒人再用的話）/ 舊的 uninstall 腳本拿掉，停止腳本照舊在背景跑。
7. `finish_relabel`：舊連線斷了、forward 還在新連線上、13 秒內沒有別的連線冒出來（還有東西在重啟舊的）；再盤點一次存起來。
   事件 `service_renamed`。

2–5 任何一步失敗就經舊連線跑 `undo_script` 把剛裝的拆掉，關掉交接——舊的完全沒動過，通道一直在線。舊連線剛好在途中自己
斷了，備援會自動接手（`on_disconnect`），所以那也不會離線。代價：舊連線關掉時，這台裝置上開著的網頁終端機與檔案管理會重連一次
（它們的 channel 在舊的 TCP 上）。

**哪些名稱要改**：只有「不是 Telepy 取的」名稱（手寫或遷移腳本建立的，例如 `telepy-natlee.service`、`info.natlee.telepy`）會被標成
要改、列表出現標記。Telepy 以前自己的標準名稱——一鍵加入的 `telepy-tunnel-<n>.service` / `com.telepy.tunnel.<n>` /
`telepy-tunnel-<n>.sh`、autossh 的 `telepy-tunnel.service`、容器 `telepy-tunnel`——不帶人名、刪除腳本也認得，只顯示「Telepy 先前的
名稱」，要改也可以（`plan::earlier_name`）。

**同一台機器多人、多台伺服器**：不同 Telepy 帳號不能把通道指到同一台機器（第七節）。不同 OS 帳號、或連到不同伺服器時，以前會互相
覆蓋的系統共用名稱（`telepy-tunnel.service`、容器 `telepy-tunnel`、`/etc/ssh/telepy_known_hosts`、`~/.ssh/telepy_known_hosts`、
用通道編號取名的 `telepy-tunnel-<n>`——兩台伺服器的資料庫是複製的話編號相同）都換成代號了。同一個 OS 帳號用**同一把金鑰**連兩台
伺服器時：刪除時只要還有連到別台的東西（unit、腳本、正在跑的 ssh）用這把金鑰，`~/.ssh/telepy_tunnel_*` 就留著
（`kept key … another server`）；一鍵加入的迴圈只停自己的 ssh（認 known_hosts 檔，不認金鑰）。盤點把連到別台的東西回成
`kept other-server "<檔案或 ssh> (port N)"`、共用金鑰回成 `note key-shared <路徑>`，網頁的「這台裝置連到哪裡」圖（`DeviceMap`）照這些
一台伺服器畫一列。注意：把資料庫整份複製去跑第二台
伺服器時，安裝代號也會一模一樣，兩台在同一台裝置上裝的東西會同名。

**刪除用代號清**：刪除的移除腳本拿到 `T_INSTALL`，認得新名稱的 unit / label / 迴圈 / uninstall / ws 檔與
`telepy-<id>.known_hosts`；known_hosts 只在沒有 unit、plist、迴圈、`~/.ssh/config` 或 CLI 設定還用它時才刪（裝置常常也是某人的
筆電，`~/.ssh/telepy_known_hosts` 可能是筆電 ssh config 的）。

一鍵加入重新跑時，若看到同一條通道舊名稱的安裝（`telepy-tunnel-<id>`），先停掉、拿掉再裝新的，兩個不會搶同一條通道。

**多出來的一份（看證據，不看名字）**：正式站 GL-AR750S 路由器（通道 #34）的盤點出現 `/etc/init.d/telepy-6m35fshq`，被標成「要改名」，
但改名又因為 init 腳本 `unsupported` 而做不了。實際上它是刪掉的通道 #33 留下的（那次刪除早於 init.d 支援），而重新加入把新金鑰寫進
**同一個** `~/.ssh/telepy_tunnel_ed25519`，所以它用的正是 #34 的金鑰——重開機時兩個 init 腳本都會起來搶這條通道。光看名字分不出
「人取的名字」和「另一個代號」（`telepy-natlee` 也長得像代號），所以判斷改成三個問題，只有最後一個跟名字有關：
1. **是不是這條通道的**：用這條通道的金鑰、連這台 gateway（原本就是這樣認的）。
2. **哪個在跑**：盤點看到的 ssh 全是用代號取名的那個（命令列帶 `telepy-<id>.known_hosts`）時，同一條通道的其他服務 / 容器都是
   **多出來的**（`Part.extra`，`plan::mark_extras`），不管叫什麼。它們不算「要改名」，改名的 `plan` 回 `extra`。
3. **名字看不看得出人**：只有代號取的名字是私人的。**帳本** `telepy_device_install_retired`：刪通道時把它的代號、名稱、擁有者記下
   （`db::device_install::retire`；新代號不會跟它們重複），名稱裡的 `telepy-<x>` / `com.telepy.tunnel.<x>`（`plan::id_in_name`，只是候選）
   對得上帳本才標成「刪掉的通道 X 留下的」（`Part.retired`；通道名稱只給同一個擁有者）。Telepy 以前的標準名稱（`earlier_name`）
   本來就是 Telepy 自己出過的版本，那份清單留在程式裡。

**拿掉多出來的**（`POST …/device-install/tidy`，`device_install::tidy`）：不用交接——多出來的不是連著的那個。重新盤點（`plan::tidy_check`：
要有多出來的、不是 Windows、系統層的要有 root 登入）→ 經**現在的**連線跑 `T_MODE=relabel`（跳過用代號取名的一切、留金鑰；init 腳本
`disable` 後由停止腳本 `stop` + 刪掉，只有它用的 known_hosts 一起刪）→ `finish_tidy` 看 13 秒：連線一直在、forward 沒換、沒有別的連線冒出來
→ 再盤點確認。事件 `service_extra_removed`。移除腳本也會掃 `~/.ssh/telepy-*.sh`，用這條通道金鑰連這台伺服器的迴圈就算這條通道的
（沒在跑的也算），刪掉的通道留下、沒在跑的迴圈因此也找得到。

測試：`tests/device_install.rs`（真的 `/bin/sh` 裝置、真的重連迴圈當舊服務、`<home>/bin` 放假的 crontab / ssh，
改名過程中 forward 一次都沒釋放；新服務連不上時自動復原；刪掉的通道留下的迴圈被認成多出來的、帳本標出來源、拿掉時通道不斷線），單元測試在 `device_install/plan.rs`、`names.rs`。
