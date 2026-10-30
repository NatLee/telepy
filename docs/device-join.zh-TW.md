# 一鍵加入裝置：腳本做什麼、支援哪些平台、怎麼診斷

<p align="center"><a href="./device-join.md">English</a> | <b>繁體中文</b> | <a href="./device-join.ja.md">日本語</a></p>

![為什麼用反向通道：沒有 Telepy 時、裝置往外撥、你從通道進來](images/zh-TW/setup-story.gif)

對應 `src/backend-api/templates/join_install.sh`（`GET /api/join/install.sh`）、`api/join.rs`、`join/mod.rs`，
前端 `components/tunnels/JoinPanel.tsx` / `JoinScriptFlow.tsx`、`lib/joinScript.ts`。
測試：`tests/join_api.rs`（API）、`tests/join_script.rs`（真的 `/bin/sh` 跑腳本對著 lab 的 gateway）、
Docker 的真平台驗證在第五節。

## 一、腳本依「實際能力」決定做法

![裝置執行一行指令，頁面一路顯示每一步](images/zh-TW/join-live.gif)

腳本不假設裝置有 bash、GNU 工具、python、curl 或完整的 OpenSSH；每一步都印出**找到什麼、為什麼這樣選**。

| 要看的 | 怎麼判斷 | 不這樣做的理由 |
|---|---|---|
| shell | `sh --help` 第一行有 BusyBox → ash；否則 bash / dash / sh | 腳本本身只用 POSIX sh（BusyBox ash 驗過），不是用 shell 來分支 |
| HTTP 工具 | `curl` → `wget`（要支援 `--post-data`）→ `uclient-fetch` | 原廠 OpenWrt 沒有 curl，`wget` 是 uclient-fetch：沒有 `--header`，看不到狀態碼，錯誤時連 body 都不存。所以裝置端點都用 `?soft=1`：一律 200、第一行 `STATUS=<原狀態碼>`；註冊也不看 Content-Type |
| SSH client | 對 `ssh`、`dbclient` 各跑 `-V`：印 `OpenSSH_` 才是 OpenSSH，印 `Dropbear` 就是 dbclient | 原廠 OpenWrt 的 `/usr/bin/ssh` 是 dropbear 的連結；`command -v ssh` 成功不代表是 OpenSSH |
| OpenSSH 的選項 | `ssh -G` 帶著通道會用的全部選項解析一次 | 不認得的選項會直接報錯，而不是連上以後才發現 |
| dbclient 的能力 | `dbclient -o help` 要列出 `ExitOnForwardFailure`（2016.73+）、`-h` 要有 `-K` 與 `-R` | dbclient 對不認得的 `-o` 只印一行 `Ignoring unknown configuration option` 然後**照常執行、exit 0**（2022.82 實測），不能靠退出碼 |
| 金鑰工具 | OpenSSH → `ssh-keygen`；dbclient → `dropbearkey` | dbclient 2022.82 讀不了 OpenSSH 格式的私鑰（`Exited: String too long`，實測）；兩種 client 的金鑰檔分開：`telepy_tunnel_ed25519`（OpenSSH）、`telepy_tunnel_dropbear`（Dropbear）。有 `dropbearconvert` 時互轉，沿用同一條通道；沒有時新金鑰 = Telepy 眼中的新裝置，腳本會說 |
| SSH server | 先從 `/proc/net/tcp` 看誰在聽那個 port、聽在哪個位址；再用 `nc -w 3` 讀 banner（`SSH-2.0-dropbear_2022.82` / `OpenSSH_9.6`）；沒有 nc 就用 `ssh -v` 的 `remote software version` | Dropbear 若只綁 LAN 介面（`option Interface 'lan'`），127.0.0.1 不會回應：host key 的核對與通道的回送目標 `-R 0:<位址>:<port>` 都改用那個 LAN 位址（同一個端點） |
| host key | 候選來源：root 的 `dropbearkey -y /etc/dropbear/*_host_key`、`/etc/ssh/ssh_host_*_key.pub`、`ssh-keyscan`（**不帶 `-T`**）、最後 OpenSSH 經 loopback `accept-new` 學一次。每個候選都用 `StrictHostKeyChecking=yes` + 只放那把金鑰的 known_hosts 握手一次，只有握手成功（走到 `Permission denied`）才接受 | 檔案存在不等於是現在在聽的那個 server 的金鑰；`ssh-keyscan -T` 在有 ppoll 問題的機器上一個金鑰都印不出來（事件 A）。沒有任何候選通過時，訊息說的是「連得到但讀不到金鑰 / 沒有東西在聽」，不再叫人裝 openssh-server |
| authorized_keys 位置 | OpenWrt + Dropbear + root → `/etc/dropbear/authorized_keys`（OpenWrt 的 patch）；OpenSSH 且 `sshd -T` 讀得到 → `AuthorizedKeysFile` 第一個（展開 `%h` `%u`）；否則 `~/.ssh/authorized_keys`；`--authorized-keys` 可覆寫 | 「~/.ssh」只是候選，不是事實 |
| 服務管理器 | root 且 `/sbin/procd` 在跑 + `/etc/rc.common` → procd；systemd（system / `--user`）；launchd；否則背景迴圈 + `@reboot` crontab | 每種都在裝完後**再查一次**：procd `running` / `enabled`，`systemctl is-active` / `is-enabled`，`launchctl print`，`pgrep` + crontab 內容 |
| 持久儲存 | `/proc/mounts` 查 `--ssh-dir` 所在的檔案系統，tmpfs / ramfs 就警告 | OpenWrt 的 `/tmp` 重開機就沒了 |
| 套件管理器 | PATH 上有哪個：opkg / apk / apt / dnf / yum / zypper / pacman / brew / pkg（像 tailscale 的 install.sh，不看發行版名稱） | 只用來把「缺 X」的訊息寫成這台機器能照抄的指令（`opkg install dropbear && /etc/init.d/dropbear start`、`apk add openssh-client openssh-keygen`…）；腳本本身不裝任何東西 |

超時：有 `timeout` 就用，沒有（原廠 OpenWrt、macOS）就用自帶的 watchdog（背景執行 + 計時殺掉，watchdog 自己的輸出關掉，
否則 `$(...)` 會等它）。等待驗證用迴圈次數（60 × 2 s）而不是牆上時鐘：路由器開機後 NTP 校時不會讓它等到天荒地老或立刻放棄。

## 二、gateway 預檢與 keepalive（事件 B / C）

註冊（消耗 token）之前，腳本先向公開的 `GET /api/join/gateway` 拿 gateway 位址、port、帳號與 host key，釘住後做兩次握手：

1. 帶 `-o ServerAliveInterval=30 -o ServerAliveCountMax=3`；
2. 不帶。

兩次都是同一台 gateway、同一組選項，只差 ServerAlive；都不送金鑰（`PubkeyAuthentication=no`），完整的金鑰交換以
`Permission denied` 結束就算成功，gateway 不會留任何事件。判讀：

| 第一次 | 第二次 | 結論 |
|---|---|---|
| ok | — | `keepalive=ssh`（預設，照舊） |
| timeout | ok | 這個版本的 ssh 一設 timeout 就立刻逾時（OpenWrt #12574：fortify-headers 的 `ppoll` 把 64 位元 `time_t` 當 32 位元讀，big-endian 的 ath79 上 30 秒變成 30 奈秒；GL-AR750S）。自動改用 **compat 模式**：`ServerAliveInterval=0 -o TCPKeepAlive=yes`，`facts.compat = ["no_server_alive"]`，網頁與事件都標出來。`--no-compat` 禁止自動切換（改成報錯並說明），`--compat-no-server-alive` 強制 |
| timeout / unreachable | timeout / unreachable | 連不到 gateway：對外 TCP 被擋（或用 `--auto` / `--via-web`，有 python3 時改走網頁 port）。**不**套用 compat |
| hostkey | — | gateway 的 host key 跟它宣告的不符：停 |

compat 模式的限制會印在裝置上、記在 `facts` 與安裝紀錄裡：SSH 層心跳關了，斷線要等 TCP keepalive（內核預設常是 2 小時）才發現，
procd / systemd 只會在 ssh 結束後重啟它，程序存在不代表通道可用。這不是底層套件的修法，是避開它。
dbclient 走自己的 `-K 30`（三次沒回應就斷），不受這個問題影響，也不套 compat。

## 三、裝置上留下什麼、怎麼恢復、怎麼移除

- `~/.ssh/telepy_tunnel_ed25519[.pub]` 或 `telepy_tunnel_dropbear[.pub]`（金鑰）、`telepy-<id>.known_hosts`（OpenSSH 釘 gateway）、
  `telepy-<id>.install`（**安裝紀錄**：代號、通道、伺服器、安裝者 / 執行帳號 / 登入帳號、shell、client、server、authorized_keys 路徑、
  服務種類與檔案、keepalive、compat、建立的檔案清單；沒有 token、沒有私鑰）、`telepy-<id>-uninstall.sh`。
- 服務：`/etc/init.d/telepy-<id>`（procd：`respawn 3600 10 0`、stdout / stderr 進 `logread`、`env HOME=`、非 root 時 `user`）、
  `telepy-<id>.service`、`com.telepy.tunnel.<id>`，或 `~/.ssh/telepy-<id>.sh` + crontab。
- dbclient 沒有 `UserKnownHostsFile`：gateway 的 host key 寫進執行帳號的 `~/.ssh/known_hosts`（`<gateway host> <type> <key>`，
  **不能加註解**——dbclient 把整行剩下的部分當金鑰解碼，實測加了註解就 mismatch）；加了哪幾行記在紀錄的 `KNOWN_HOSTS_LINE=`，
  uninstall 與刪除通道的移除腳本只刪那幾行。同一個主機名稱已經有另一把同類型的金鑰時停下來說明（dbclient 只比主機名稱、不比 port）。
- 下載壞掉：伺服器在腳本最後加 `# telepy-sha256: <hex>`，從檔案執行時腳本自己核對，內文少了字就說「下載壞了、再下載一次」。
  開頭掉字（事件：第二行變成 `in this machine as a device…`）或 CRLF / BOM 讓 sh 在第一行就停，腳本來不及說明，所以網頁的
  「先下載、`sh -n`、再執行」指令先用 `sh -n` 擋（`curl | sh` 讀不到自己，什麼都擋不了）；沒有 curl 的 wget 版也有；`--check` 不消耗 token。
- 註冊回應丟了：腳本不重送 POST，改問 `GET /api/join/<token>/status`；已經是 registered 以上就用 `GET /api/join/<token>/config`
  再拿一次同樣的設定（同一張票、同一條通道），否則叫人再跑一次（票還在 waiting）。
- 重跑：同一把金鑰 = 同一條通道（伺服器以金鑰認）；舊名稱的安裝（`telepy-tunnel-<n>`）會被清掉。
- 五個狀態分開報：files installed / starts at boot / process running / tunnel connected / login verified，只有伺服器真的登入過才是 Done。
- 刪除通道（`remove_tunnel.sh`）認得 `/etc/init.d` 的 init 腳本（`disable` 後由停止腳本 `stop` + 刪檔）、安裝紀錄與 dbclient 的 known_hosts 行；
  盤點（survey）把它們列成 `initd` / `record` / `known_hosts`。

## 三之二、實測才知道的兩個坑（都已處理）

- **Dropbear 的 exec 指令上限 9000 bytes（`MAX_CMD_LEN`）**：盤點 / 刪除腳本（`remove_tunnel.sh`，約 25 KB）塞進 `sh -c '…'`
  會被 Dropbear 直接關掉 channel（Telepy 看到 `the script stopped early (exit None)`）。長的 POSIX 腳本現在先分段寫進裝置的暫存檔再執行
  （`ssh::exec::script_commands` / `run_script`：每道指令 ≤ `MAX_COMMAND` 6000 字、`printf '%s' … >> "${TMPDIR:-/tmp}/telepy-script-<tag>.sh"`、
  `umask 077`，最後一道 `sh` 執行並刪掉；短腳本照舊一個 `sh -c`）；金鑰清單的 exec 寫入也分段（`exec::upload_commands` →
  `device_keys::remote::write_commands`）。lab 的假 sshd 只會 `sh -c`，所以這條路在 cargo 測試裡也走得到。
- **russh（gateway）對 Dropbear 的 strict kex 誤判**：OpenWrt 23.05 把 Terrapin 修補（`kex-strict-c-v00@openssh.com`）回移到 Dropbear
  2022.82，而 Dropbear 的 kex 清單以 `kexguess2@matt.ucc.asn.au` 開頭、永遠帶著 `first_kex_packet_follows` 的猜測封包。russh 0.64.1
  忽略猜錯的封包後，真正的 `KEX_ECDH_INIT` 落在序號 2，被 `validate_client_msg_strict_kex` 當成 strict kex 違規
  （`strict kex violated at sequence no. 2, message type: 30`）而斷線——**任何** Dropbear 客戶端（新版 2024.86 也會猜、也支援 strict kex）
  都連不上 russh 伺服器。OpenSSH 客戶端不猜，所以從沒遇過。這是 russh 的 bug（RFC 4253 §7.1 允許猜測；OpenSSH 伺服器一直接受 Dropbear），
  修法是忽略過猜測封包後把序號檢查往後挪一格——約 20 行，放在 [`docs/russh-dropbear-strict-kex.patch`](russh-dropbear-strict-kex.patch)，
  用這個 patch 的 gateway 在 Docker 的原廠 OpenWrt 上實測 dbclient 2022.82 connected → verified。Telepy **不**自己揹這份修補
  （不 fork、不 vendor），改向上游 Eugeny/russh 回報；在上游釋出前，**純 dbclient 的裝置列為「等 gateway 修正」**：腳本在消耗 token
  之前的 gateway 預檢會拿到 `closed`，印出「gateway 在金鑰交換時關閉連線；請更新 Telepy，或裝 OpenSSH client 後用 `--client openssh`」。
  有 OpenSSH client 的 OpenWrt（兩台 GL 路由器都是）不受影響。
- **`/usr/bin/ssh` 不是固定的**：原廠 OpenWrt 的 `ssh` 是 dropbear 的連結；之後 `opkg install openssh-client` 會把它換成 OpenSSH。
  dbclient 的服務必須寫 `/usr/bin/dbclient` 本尊，否則裝了 OpenSSH 之後 procd 用 dbclient 的參數去跑 OpenSSH（`-K 30 -I 0` 被
  解讀成別的選項，連到 `0.0.0.30`）。

## 四、加入之後：其他功能在這類裝置上

| 功能 | Dropbear / BusyBox 裝置 |
|---|---|
| 終端機 | 可用（PTY shell；ash） |
| 檔案管理 / SFTP | Dropbear 沒有 sftp-server（OpenWrt 要 `opkg install openssh-sftp-server`）時，檔案管理走 exec 的備援；SFTP REST 需要 sftp |
| 金鑰清單（分享給別人時裝他的金鑰） | `device_keys/remote.rs`：沒有 sftp 子系統就改走 exec（`cat`、暫存檔 + `mv -f`）；root 在 OpenWrt + Dropbear 寫 `/etc/dropbear/authorized_keys`（與加入腳本同一個檔） |
| 裝置狀況（device facts）、區網掃描 | 腳本是 POSIX / BusyBox 相容（`ip` 沒有 `-o` 時退回 `ifconfig`；沒有 `getent` 就不解析名稱） |
| 在裝置上改名（device_install rename） | procd 尚未支援（blocker），刪除與盤點支援 |
| 遠端桌面 / 瀏覽器 | 走裝置 sshd 的 direct-tcpip，Dropbear 預設允許 |
| Windows 原生 | 一鍵加入不支援（逐步設定）；見第六節 |

## 五、驗證（分清楚是哪一種）

**單元 / 整合（cargo，每次 CI）**
- `join::tests`、`device_keys::remote::tests`：facts 白名單、soft 回應、校驗碼、exec 寫入指令。
- `tests/join_api.rs`：soft、`/api/join/gateway`、`/config` 復原、form content-type、facts 進票 / 事件 / device-install。
- `tests/join_script.rs`：真的 `/bin/sh` 跑伺服器送出的腳本（含校驗碼），對著 lab 的真 gateway 與真 HTTP listener，lab 機器當裝置的 sshd：
  壞檔案 / CRLF 被抓到、`--check` 不消耗 token、錯 port 的訊息、真的加入到 verified（服務金鑰寫進 lab sshd 讀的檔案）、紀錄內容、uninstall 後通道斷。

**真平台（Docker，手動；指令見下）** — 2026-10-30 的結果：
- 原廠 OpenWrt 23.05.5 rootfs（x86-64 於 OrbStack 下模擬；ash、BusyBox 1.36、Dropbear 2022.82 server + dbclient、uclient-fetch、
  procd 以 `/sbin/init` 起、`--privileged`）：`--check` 通過（host key 來自 `dropbearkey -y`，兩把都以嚴格握手驗過；gateway 兩把 host key
  釘住）；真的加入 **connected → verified**（root 經 `/etc/dropbear/authorized_keys`）；**容器重啟後 procd 自己把通道帶回來**；
  伺服器重啟後 dbclient 以 `-K 30` 在約一分鐘內發現斷線、procd 10 秒後重連；金鑰清單（分享給別人時裝金鑰）走 exec 備援：
  `installed` / `verified`、面板顯示 `/etc/dropbear/authorized_keys`；盤點找到 `procd` 服務、程序、金鑰、紀錄；uninstall 後
  init.d / rc.d / 程序都沒了、金鑰留著、gateway 的 forward 釋放。
- 同一個 rootfs 加 `opkg install openssh-client openssh-keygen`（Dropbear server + OpenSSH 9.8 client，沒有 ssh-keyscan）：`--check` 通過，
  host key 一樣來自 `dropbearkey -y`，keepalive 用 OpenSSH 的 ServerAlive。
- Alpine 3.20（ash + Dropbear 2024.85 server + OpenSSH 9.7 client，沒有 procd）：`--check` 通過（keyscan 與 dropbearkey 兩種來源都驗過），
  真的加入成背景迴圈 + crond 的 `@reboot` → **verified**，uninstall 後程序與 crontab 行都沒了。
- cargo：`tests/join_script.rs`（macOS /bin/sh、OpenSSH 10.3、lab gateway）全程通過，含壞檔案、錯 port、`--check` 不寫檔不註冊、真的加入、
  紀錄、uninstall；`tests/join_api.rs` 兩個測試通過。

**真裝置（2026-10-30，透過 prod 的 `telepy exec` 執行，dev server 在同一個 LAN）**：
- GL-AR750S（OpenWrt 22.03.4、mips、BusyBox 1.35、OpenSSH 8.9p1 client、Dropbear 2022.82 server、curl）：`--check` 通過，host key 兩把來自
  `dropbearkey -y`、`/etc/ssh/*.pub` 的兩把正確被判為「不是現在在聽的 server」而忽略；gateway 探測 **ServerAlive 逾時 / 不帶則成功 →
  自動進 compat 模式**（事件 B / C 真機重現）。真的加入：procd 服務 `telepy-caqgap9k`，**connected → verified**（root，compat），
  uninstall 後只剩 prod 的 `telepy-47xzwr2e`（仍 running），dev server 的 forward 釋放，金鑰與 authorized_keys 行照設計留下
  （dev 的那行手動移除）。整個過程不碰 dropbear / 網路設定。
- GL-MT3000（GL 21.02-SNAPSHOT、aarch64、BusyBox 1.33、OpenSSH 8.4p1、Dropbear 2024.86）：`--check` 通過，keepalive 維持 SSH
  （ServerAlive 握手正常），host key 來自 `dropbearkey -y`（含 ecdsa）。只做預檢，沒有加入。
- 兩台的 BusyBox `nc` 都沒有 `-w`（印 usage），banner 由 `ssh -v` 取得；腳本已改成 `-w` 失敗再用 watchdog 跑一次 `nc`。

Docker 配方（`~/Library/Caches/telepy-join-e2e/env.sh` 起一個原生 telepy-server：API 18872、gateway 24872、`SERVER_DOMAIN=host.docker.internal`）：

```sh
docker run -d --platform linux/amd64 --privileged --cgroupns=host --name telepy-wrt openwrt/rootfs:x86-64-23.05.5 /sbin/init
docker exec telepy-wrt sh -c 'wget -O /root/j.sh http://host.docker.internal:18872/api/join/install.sh && sh /root/j.sh --check'
docker exec telepy-wrt sh /root/j.sh --token tpj_…        # 原廠：dbclient + procd
docker exec telepy-wrt sh -c 'opkg update && opkg install openssh-client openssh-keygen' && docker exec telepy-wrt sh /root/j.sh --check
```

## 六、已知限制

- **純 dbclient（沒有 OpenSSH client）的裝置暫時連不上 gateway**：russh 的 strict-kex 序號檢查不容許 Dropbear 的猜測封包（第三之二節）。
  腳本在消耗 token 前就會偵測並說明（裝 OpenSSH client 即可）；等上游 russh 修正釋出、Telepy 升版後，腳本不用改就能用 dbclient。
- Windows 原生（PowerShell、排程工作、ACL）仍是「逐步設定」；一鍵加入腳本不在 Windows 上執行。尚未實作或驗證的能力不宣稱支援。
- dbclient：known_hosts 只比主機名稱，同一個主機名稱不能有兩把同類型的金鑰；沒有 `UserKnownHostsFile` / `HostKeyAlias`；OpenWrt 原廠沒有
  `dropbearconvert`，所以換 client 時金鑰不能互轉。WebSocket 傳輸用 `-J`（仍需 python3）。
- compat 模式是繞開，不是修復：SSH 心跳關閉，斷線偵測慢。
- 非 root 的 OpenWrt：讀不到 `/etc/dropbear/*_host_key`，又沒有 `/etc/ssh/*.pub` 或 ssh-keyscan 時，host key 沒有來源，腳本會停下來說明。
- 在裝置上改名 / 換連線方式支援 procd（`/etc/init.d/telepy-<代號>`，跟一鍵加入裝的一樣；在 OpenWrt 23.05 rootfs 上實測）；`/etc/rc.local` 裡手寫的一行仍然不自動換。路由器通常沒有 python3，「改成自動」會裝成只走 SSH port 的新服務並說明（`no_python`）。
- 腳本把裝置的 SSH server 綁定位址當通道回送目標；若 server 綁了多個非 loopback 位址，取第一個。
