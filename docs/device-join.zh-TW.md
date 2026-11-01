# 一行指令加入裝置

<p align="center"><a href="./device-join.md">English</a> | <b>繁體中文</b> | <a href="./device-join.ja.md">日本語</a></p>

要把一台 Linux、Mac 或 OpenWrt 路由器加進 Telepy，只要一行指令。把它貼到裝置上執行，一支小腳本會先看看裝置上有什麼，再設定金鑰、把反向通道裝成服務，最後一定要等 Telepy 真的透過通道登入成功，才算完成。

裝置只會主動往外連到 Telepy，路由器上不用開任何連接埠。這行指令只能用一次、30 分鐘後失效，而且只能把裝置加到你自己的帳號。

![為什麼用反向通道：沒有 Telepy 時、裝置往外撥、你從通道進來](images/zh-TW/setup-story.gif)

這一頁依序說明怎麼執行、裝置上會留下什麼、怎麼移除，接著是幾種特殊情況：OpenWrt 與 Dropbear、沒有可用 SSH client 的裝置、擋掉 SSH 連接埠的網路，以及相容模式。如果已經失敗了，直接跳到[失敗時怎麼辦](#八失敗時怎麼辦)。

這裡不談 Windows：腳本不在 Windows 上執行，請改用「逐步設定」。

## 一、執行

### 取得指令

1. 到「通道 → 建立通道」，保留預設的「一行指令（Linux / macOS / OpenWrt）」。
2. 裝置名稱可以不填。在「這台裝置上你的 SSH 金鑰」選「裝上我的金鑰」，裝置一連上，Telepy 就把你的個人金鑰放上去，你就能從自己的電腦 ssh 進去。
3. 選「裝置怎麼連到 Telepy」：「自動」（預設，也是建議的選擇）、「SSH port」或「只有網頁 port」。詳見[擋掉 SSH 連接埠的網路](#五擋掉-ssh-連接埠的網路)。
4. 按「產生指令」。

接著選執行方式：

- **使用 sudo（建議）**：裝成系統服務，登出或重開機後通道都會自己的連回來。Telepy 會用執行 sudo 的那個帳號登入。
- **不使用 sudo**：改裝成使用者服務，登出後可能會停。不能用 sudo，或本來就是 root（例如 OpenWrt 路由器）時選這個。
- **貼進 shell**：一般的做法。
- **先下載、檢查、再執行**：給路由器或序列埠主控台用，那種地方貼上時可能會掉字。檔案先下載下來，用 `sh -n` 檢查語法後才執行。沒有 curl 的機器也有 `wget` 版本。

真正的指令請從頁面上複製，長得像這樣：

```sh
curl -fsSL '<telepy>/api/join/install.sh' | sudo sh -s -- --token tpj_… --auto
```

想先看過再執行，可以點「查看腳本內容」。把腳本本身的內文貼進終端機執行，不在支援範圍內。

### 先用 `--check` 測一次

`--check` 會做到註冊之前的每一步，不消耗 token。它會說出找到哪個 shell、HTTP 工具、SSH client 和服務管理器，用嚴格握手核對這台機器的 SSH 伺服器與主機金鑰，並確認連得到 Telepy 的 gateway，連這個版本的 SSH keepalive 正不正常都會測。它不寫任何檔案，也不註冊。

頁面上的「先測試，不消耗指令」就是它：

```sh
curl -fsSL '<telepy>/api/join/install.sh' -o /tmp/telepy-join.sh && sh /tmp/telepy-join.sh --check
```

### 裝置上會發生什麼事

腳本分七步，每一步都會印出它找到什麼、為什麼這樣選：

1. 看裝置有什麼：shell、HTTP 工具、SSH client、SSH 伺服器、服務管理器。
2. 讀取這台機器的 SSH 主機金鑰，用嚴格握手核對。
3. 確認 Telepy 的 gateway 有回應，釘住它的主機金鑰，並測試 keepalive。
4. 建立通道金鑰，用一次性的 token 註冊裝置。
5. 把 Telepy 的服務金鑰加到這個 SSH 伺服器讀金鑰的位置。只追加，而且只加一次。
6. 把通道裝成服務並啟動。
7. 等 Telepy 透過通道登入。

第 1–3 步發生在用掉 token 之前，這裡出問題不會浪費任何東西。

![裝置執行一行指令，頁面一路顯示每一步](images/zh-TW/join-live.gif)

頁面會同步顯示進度：等待中、已註冊、通道已連線、Telepy 已登入。Telepy 自己只看得到註冊、通道與登入，在那之前的事都印在裝置上。

最後腳本會分開回報五個狀態：files installed（檔案已安裝）、starts at boot（開機會啟動）、process running（程序在跑）、tunnel connected（通道已連線）、login verified（登入已驗證）。只有 Telepy 真的登入過，它才會說 Done。

腳本會等這次登入大約兩分鐘。等待是用迴圈圈數算的（60 × 2 秒），不看時鐘：路由器開機後 NTP 一校時，時鐘可能一口氣穿越好幾年，用圈數算才不會因此等到天荒地老，或是馬上放棄。

### 它會檢查哪些東西

腳本什麼都不預設：不假設有 bash、GNU 工具、python、curl，也不假設有完整的 OpenSSH。它會檢查：

- **Shell**：BusyBox ash、bash、dash 或一般的 sh。腳本本身只用 POSIX sh（在 BusyBox ash 上測過），所以這項只是回報。
- **HTTP 工具**：`curl`，沒有就 `wget`（要支援 `--post-data`），再沒有就 `uclient-fetch`。
- **SSH client**：優先用真正的 OpenSSH，沒有就用 [Telepy 內建的 client](#一之二內建的-ssh-clienttelepy-carrier-tunnel)，再沒有才用 Dropbear 的 dbclient。`--client openssh|builtin|dbclient` 可以指定。
- **SSH 伺服器**：誰在聽 SSH 連接埠、聽在哪個位址、是哪一種伺服器。
- **主機金鑰**：找得到的候選金鑰全部拿來，逐一跟現在正在聽的伺服器核對。
- **金鑰要放哪**：這個 SSH 伺服器實際上替那個帳號讀的檔案。
- **服務管理器**：procd（OpenWrt 上的 root）、systemd（系統或 `--user`）、launchd，都沒有就用背景迴圈加一筆 `@reboot` crontab。裝完後會再確認一次服務有在跑、也有設成開機啟動。
- **儲存空間**：金鑰目錄放在 tmpfs 或 ramfs 上時會警告，那種地方重開機就清空了（例如 OpenWrt 的 `/tmp`）。這時請加 `--ssh-dir`。
- **套件管理器**：opkg、apk、apt、dnf、yum、zypper、pacman、brew 或 pkg。它只用來把「缺了 X」寫成這台機器能照抄的指令，腳本本身不會安裝任何東西。

<details>
<summary>每一項怎麼查，以及為什麼不走看起來比較快的捷徑</summary>

- **Shell**：`sh --help` 第一行有 BusyBox 就是 ash，否則是 bash、dash 或 sh。腳本從不依 shell 分支。
- **HTTP 工具**：原廠 OpenWrt 沒有 curl，它的 `wget` 其實是 uclient-fetch：沒有 `--header`、看不到狀態碼，出錯時連回應內容都不留。所以給裝置用的端點都接受 `?soft=1`（一律回 200，真正的狀態碼放在第一行 `STATUS=<狀態碼>`），註冊也不看 Content-Type。
- **SSH client**：對 `ssh` 和 `dbclient` 各跑一次 `-V`，印出 `OpenSSH_` 才是 OpenSSH，印出 `Dropbear` 就是 dbclient；`command -v ssh` 成功什麼也證明不了。原廠的 dbclient 跟 Telepy 的 gateway 完成不了金鑰交換（見 [OpenWrt 與 Dropbear](#四openwrt-與-dropbear)），所以排最後。
- **OpenSSH 的選項**：通道會用到的所有選項，先用 `ssh -G` 解析一次。不認得的選項當場報錯，不會等連上之後才出事。
- **dbclient 的選項**：遇到不認得的 `-o`，dbclient 只印一行 `Ignoring unknown configuration option`，然後照常執行、exit 0（2022.82 實測），退出碼完全不能信。所以改看 `dbclient -o help` 有沒有列出 `ExitOnForwardFailure`（Dropbear 2016.73 以上），以及 `-h` 有沒有 `-K` 和 `-R`。
- **金鑰工具**：OpenSSH 用 `ssh-keygen`；內建 client 有 `ssh-keygen` 就用它，沒有就用 `telepy-carrier keygen`（ed25519、OpenSSH 格式、權限 0600、旁邊放 `.pub`）；dbclient 用 `dropbearkey`。
- **SSH 伺服器**：從 `/proc/net/tcp` 看誰在聽那個連接埠、聽在哪個位址。banner 用 `nc -w 3` 讀（`SSH-2.0-dropbear_2022.82`、`OpenSSH_9.6`），沒有 nc 就看 `ssh -v` 的 `remote software version` 那一行。只綁在 LAN 介面的 Dropbear（`option Interface 'lan'`）不會回應 127.0.0.1，這時主機金鑰的核對與通道的目標 `-R 0:<位址>:<port>` 都改用那個 LAN 位址。
- **主機金鑰**：檔案存在，不代表它就是現在正在聽的那個伺服器的金鑰，所以每個候選都要測。候選來源依序是 root 的 `dropbearkey -y /etc/dropbear/*_host_key`、`/etc/ssh/ssh_host_*_key.pub`、`ssh-keyscan`（不帶 `-T`，因為有 ppoll 問題的版本帶了 `-T` 會一把金鑰都印不出來，見[相容模式](#六相容模式compat)），最後才是讓 OpenSSH 經 loopback 用 `accept-new` 學一次。
- **主機金鑰怎麼測**：每個候選都用 `StrictHostKeyChecking=yes` 加上一份只放那把金鑰的 known_hosts 握手一次，要走到 `Permission denied` 才算數。
- **主機金鑰（內建 client）**：改用 `telepy-carrier tunnel --probe --host-key '<那把金鑰>'` 核對，這是一次只信那把金鑰、自己不送金鑰的完整金鑰交換。沒有 ssh-keyscan 時，同一個探測會先經 loopback 把金鑰讀出來。
- **一個都沒通過**：訊息會分清楚是「連得到但讀不到金鑰」還是「根本沒東西在聽」，不再叫人去裝 openssh-server。
- **金鑰要放哪**：`~/.ssh` 只是猜測。OpenWrt + Dropbear + root 讀的是 `/etc/dropbear/authorized_keys`（OpenWrt 的 patch）；OpenSSH 而且讀得到 `sshd -T` 時，用第一個 `AuthorizedKeysFile`（展開 `%h` 與 `%u`）；其他情況才是 `~/.ssh/authorized_keys`。`--authorized-keys` 可以覆寫。
- **服務管理器**：是 root、`/sbin/procd` 在跑、而且有 `/etc/rc.common` 時用 procd。裝完之後的檢查分別是 procd 的 `running` / `enabled`、`systemctl is-active` / `is-enabled`、`launchctl print`，以及 `pgrep` 加上 crontab 的內容。
- **儲存空間**：到 `/proc/mounts` 查 `--ssh-dir` 所在的檔案系統。
- **套件管理器**：看 PATH 上有哪一個，跟 tailscale 的安裝腳本一樣，不看發行版的名稱。提示長得像 `opkg install dropbear && /etc/init.d/dropbear start` 或 `apk add openssh-client openssh-keygen`。
- **逾時**：有 `timeout` 就用。沒有時（原廠 OpenWrt、macOS）用腳本自己的 watchdog：指令丟到背景執行，時間到就砍掉。watchdog 自己的輸出要關掉，否則外面包著的 `$(...)` 會一直等它。

</details>

<details>
<summary>腳本的所有選項</summary>

| 選項 | 作用 |
|---|---|
| `--token TOKEN` | Telepy 給的加入 token。除了 `--check` 以外都必填，只能用一次 |
| `--check` | 只做預檢，不消耗 token |
| `--user NAME` | Telepy 登入用的帳號。預設是執行 sudo 的使用者，否則是目前的使用者 |
| `--ssh-port PORT` | 這台機器 SSH 伺服器的連接埠。預設自動偵測，偵測不到就是 22 |
| `--ssh-host ADDR` | SSH 伺服器聽的位址。預設自動偵測 |
| `--authorized-keys PATH` | 這個 SSH 伺服器替該帳號讀金鑰的檔案。預設向伺服器查 |
| `--client openssh\|builtin\|dbclient` | 由哪個 SSH client 跑通道 |
| `--service procd\|systemd\|launchd\|loop` | 用什麼方式讓通道持續執行。預設看機器上有什麼 |
| `--no-service` | 等同 `--service loop` |
| `--name NAME` | 通道名稱：英文字母、數字、`.`、`_`、`-`。預設用 Telepy 上設定的名稱，沒有就用主機名稱 |
| `--auto` | 先走 SSH 連接埠，被擋時改走網頁連接埠 |
| `--via-web` | 只走網頁連接埠（SSH 包在 WebSocket 裡） |
| `--carrier auto\|binary\|python` | 網頁連接埠的小幫手。`auto`（預設）= 預編的 `telepy-carrier`，沒有就 python3 |
| `--compat-no-server-alive` | 強制使用相容模式（用 TCP keepalive 取代 SSH 的 ServerAlive） |
| `--no-compat` | 不要自動切換成相容模式 |
| `--ssh-dir DIR` | 金鑰、known_hosts、安裝紀錄與移除腳本放哪裡。預設 `~/.ssh` |

</details>

## 一之二、內建的 SSH client（`telepy-carrier tunnel`）

有些裝置有 SSH 伺服器，卻沒有能跟 Telepy 合作的 SSH client，以前都得先 `opkg install openssh-client`：

- 原廠 OpenWrt 只有 Dropbear 的 dbclient，跟 Telepy 的 gateway 完成不了金鑰交換（[原因](#dropbear-的-client-與-telepy-的-gateway)）。
- 有些版本的 ssh 一設 ServerAliveInterval 就逾時（[相容模式](#六相容模式compat)）。
- dbclient 也讀不了 OpenSSH 格式的金鑰。

現在預編的 `telepy-carrier` 可以自己跑反向通道。它就是走網頁連接埠時用的那個小程式。

- **什麼時候用它**：沒有真正的 OpenSSH client，而且 Telepy 有這台 CPU 的 `telepy-carrier` 時。腳本會從 Telepy 下載，並核對 sha256。`--client builtin` 可以直接指定它。
- **哪些平台有**：x86-64、aarch64、armv7、armv6 的 Linux，以及 macOS。MIPS 路由器（例如 GL-AR750S）沒有，仍然需要 OpenSSH client。

服務執行的指令長得像這樣：

```sh
~/.ssh/telepy-<代號>-ws.bin tunnel --identity ~/.ssh/telepy_tunnel_ed25519 --known-hosts ~/.ssh/telepy-<代號>.known_hosts \
    --user telepy --server <SSH 主機>:<port> [--ws wss://<主機>/ws/gateway/] --no-proxy --forward 0:127.0.0.1:22 --keepalive 30
```

它會做這些事：

- 用通道金鑰登入 gateway。金鑰必須是 OpenSSH 格式、不能有 passphrase；裝置上沒有 ssh-keygen 時，由 `telepy-carrier keygen` 產生。
- 用腳本寫好的檔案核對 gateway 的主機金鑰，檔案裡是 Telepy 透過 `GET /api/join/gateway` 宣告的金鑰。金鑰不對就拒絕連線（結束碼 3），什麼都不會註冊。
- 要求 `tcpip-forward` 0，跟 `ssh -R 0:…` 一樣：Telepy 依金鑰認出是哪條通道，自己指派號碼。Telepy 開過來的每條連線，都接到這台機器的 SSH 伺服器（`--forward 0:<位址>:<port>`，Dropbear 只聽 LAN 位址時就用那個位址）。
- 連到 Telepy 的方式跟網頁連接埠小幫手一樣：SSH 連接埠、網頁連接埠（`--via-web`），或先試 SSH 連接埠、不通再走網頁連接埠（`--auto`）。安裝時有設 `HTTPS_PROXY`，就經那個 HTTP CONNECT 代理出去。
- 沒有流量 30 秒就送一次 SSH keepalive，連續三次沒回應就放棄。這些計時器是它自己的，不是 ssh 的，所以[相容模式](#六相容模式compat)背後的 ppoll 問題碰不到它：只探一次，永遠不需要相容模式。
- 連線結束就以非 0 結束，交給服務管理器重新啟動（procd 的 `respawn`、systemd 的 `Restart=always`、launchd 的 `KeepAlive`，或背景迴圈）。收到 SIGTERM 會乾淨的結束。

它不做的事：沒有 shell、不轉送 agent 或 X11、不讀 `~/.ssh/config`，而且只有一個 forward。有 passphrase 的金鑰會被拒絕。

怎麼認出它：

- 在裝置上它是 `~/.ssh/telepy-<代號>-ws.bin`，由服務直接執行，沒有包裝腳本。
- 安裝紀錄寫 `CLIENT=builtin (…)`；加入時回報的事實是 `client: builtin (…)`，頁面上顯示為「內建 client」。
- Telepy 盤點裝置、替服務改名、切換連線方式或刪除通道時，會像讀 `ssh -R` 一樣讀懂它的指令列：金鑰看 `--identity`、forward 看 `--forward`、伺服器看 `--server`（別台伺服器的連接埠一律不碰）、known_hosts 看 `--known-hosts`。

## 二、裝置上會留下什麼

服務和它的檔案都以一組隨機的安裝代號命名（下面寫成 `<代號>`），從不用使用者、伺服器或通道的名稱。這樣 Telepy 之後要清理時，才知道哪些東西是它的。

在 `~/.ssh`（或 `--ssh-dir` 指定的地方）：

- **通道金鑰**：`telepy_tunnel_ed25519` 和它的 `.pub`（OpenSSH 與內建 client），或是 `telepy_tunnel_dropbear` 和它的 `.pub`（dbclient）。
- **`telepy-<代號>.known_hosts`**：釘住的 gateway 主機金鑰。dbclient 用不了這種檔案，做法不同，見[由 dbclient 跑通道時](#由-dbclient-跑通道時)。
- **`telepy-<代號>.install`**：安裝紀錄，記著代號、通道、伺服器、誰安裝的、執行帳號與登入帳號、shell、client、SSH 伺服器、authorized_keys 路徑、服務種類與檔案、keepalive、相容模式，以及建立過的每個檔案。裡面沒有 token，也沒有私鑰。
- **`telepy-<代號>-uninstall.sh`**：移除腳本。
- **內建 client 或網頁連接埠小幫手**：`telepy-<代號>-ws.bin`（用 python3 時是 `telepy-<代號>-ws.py`）。小幫手另外有個包裝腳本 `telepy-<代號>-ws.sh`，內建 client 不需要。

服務本身，看裝置上有什麼：

- **procd**：`/etc/init.d/telepy-<代號>`。每次結束 10 秒後就重新啟動，永不放棄（`respawn 3600 10 0`），輸出進 `logread`，會設定 `HOME`，執行帳號不是 root 時也會指定帳號。
- **systemd**：`telepy-<代號>.service`，系統服務；沒用 sudo 時是 `--user` 服務。
- **launchd**：`com.telepy.tunnel.<代號>`，有 sudo 是 LaunchDaemon，沒有就是 LaunchAgent。
- **都沒有**：`~/.ssh/telepy-<代號>.sh` 的背景迴圈，加上一筆 `@reboot` crontab。

另外，帳號的 authorized_keys 裡會多一行：Telepy 的服務金鑰，只追加一次。

## 三、重跑與移除

### 重跑

- **同一把金鑰就是同一條通道**：Telepy 用通道金鑰認裝置，所以在同一台裝置上執行新的指令，會沿用原本的通道。之前用 Telepy 舊命名方式（`telepy-tunnel-<n>`）裝的東西，會順手清掉。
- **登入測試失敗之後**：照頁面上的原因修好，產生一行新的指令，在同一台裝置上執行，就會接回同一條通道。

### 下載或回應在半路弄丟了

- **下載不完整**：Telepy 會在腳本最後加上 `# telepy-sha256: <hex>`。從檔案執行時，腳本會自己核對，少了任何內容就會說下載壞了。
- **第一行就壞掉**：開頭掉字（曾經發生過第二行變成 `in this machine as a device…`）、Windows 換行或 BOM，都會讓 sh 在第一行就停下來，腳本連說明的機會都沒有。所以「先下載、檢查、再執行」會先跑 `sh -n`。`curl | sh` 檢查不了自己，什麼都擋不住。
- **註冊的回應弄丟了**：腳本絕不重送註冊。它會先問 `GET /api/join/<token>/status`，如果裝置已經註冊或走得更遠，就用 `GET /api/join/<token>/config` 再拿一次同樣的設定（同一張票、同一條通道）；否則請你重新執行同一行指令，因為那張票還在等。

`--check` 從不消耗 token，想跑幾次都可以。

### 移除

**在裝置上**：執行移除腳本。安裝結束時會印出確切的那一行（`Uninstall: sh ~/.ssh/telepy-<代號>-uninstall.sh`）；安裝時用了 sudo，移除時也要用 sudo。它會停止並移除服務，以及安裝時建立的檔案。

通道金鑰和 authorized_keys 裡 Telepy 那一行會刻意留著，不需要的話請自己刪掉。用 dbclient 時，它只刪安裝時加進 known_hosts 的那幾行，其他一行都不碰。

**從 Telepy**：刪除通道。裝置在線上時，「從裝置移除通道服務」（預設開啟）會找到這次的安裝並移除，包括 procd 的 init 腳本（先停用，再停止並刪檔）、安裝紀錄，以及 dbclient 的 known_hosts 行。裝置盤點會把這些列成 `initd`、`record` 和 `known_hosts`。

## 四、OpenWrt 與 Dropbear

原廠 OpenWrt 是最難搞的情況，這支腳本大部分的樣子也是被它磨出來的：BusyBox ash、沒有 curl、SSH 伺服器和 client 都是 Dropbear、用 procd，`/tmp` 重開機就不見。腳本對每一項的處理：

- **沒有 curl**：OpenWrt 的 `wget` 是 uclient-fetch，腳本應付得來。「先下載、檢查、再執行」也有 `wget` 版本。
- **SSH client**：原廠 OpenWrt 的 `ssh` 其實是 Dropbear 掛名的。x86-64 與 ARM 路由器上由內建 client 跑通道，不用另外裝套件；MIPS 路由器請裝 OpenSSH client（`opkg install openssh-client openssh-keygen`），腳本就會用它。
- **SSH 伺服器**：以 root 用 `dropbearkey -y` 讀主機金鑰。Dropbear 只聽 LAN 位址時，就從那個位址連。
- **Telepy 的金鑰**：root 的金鑰在 `/etc/dropbear/authorized_keys`，服務金鑰就加在那裡。
- **服務**：procd 的 init 腳本 `/etc/init.d/telepy-<代號>`，每次結束 10 秒後重新啟動，log 在 `logread`。
- **儲存空間**：`--ssh-dir` 落在 tmpfs 上時，腳本會警告。

### Dropbear 的 client 與 Telepy 的 gateway

只有 dbclient、又沒有內建 client 的路由器（實際上就是 MIPS），目前還接不起通道。每個 Dropbear client 在金鑰交換時都會先送一個「猜測」的封包，而 Telepy 的 gateway 在嚴格金鑰交換（strict kex）開啟時會把它算錯，接著斷線。

這是 russh 的 bug，也就是 gateway 底下的 SSH 函式庫。大約 20 行的修正已經送到上游：[Eugeny/russh PR #805](https://github.com/Eugeny/russh/pull/805)（issue [#804](https://github.com/Eugeny/russh/issues/804)）。

Telepy 不自己揹一份修補版，等上游釋出；Telepy 升級之後，腳本不用改就能用 dbclient。

在那之前，腳本在用掉 token 之前的 gateway 檢查就會抓到，停在 `the gateway closed the connection during the key exchange`，並建議更新 Telepy，或裝 OpenSSH client 後加 `--client openssh` 重跑。有 OpenSSH client 的 OpenWrt 路由器（測過的兩台 GL.iNet 都是）不受影響。

<details>
<summary>嚴格金鑰交換 bug 的細節</summary>

OpenWrt 23.05 把 Terrapin 修補（`kex-strict-c-v00@openssh.com`）回移到 Dropbear 2022.82。Dropbear 的金鑰交換清單以 `kexguess2@matt.ucc.asn.au` 開頭，而且永遠會送出 `first_kex_packet_follows` 的猜測封包。

russh 0.64.1 忽略猜錯的封包之後，真正的 `KEX_ECDH_INIT` 落在序號 2，被當成違反嚴格金鑰交換（`strict kex violated at sequence no. 2, message type: 30`）而斷線。所有 Dropbear client 都會中，新版的 2024.86 一樣會猜、也一樣支援嚴格金鑰交換。OpenSSH client 從來不猜，所以以前從沒遇過。

RFC 4253 §7.1 允許猜測，OpenSSH 伺服器也一直接受 Dropbear。修法是忽略過猜測封包後，把序號檢查往後挪一格。套用這個修正的 gateway，在 Docker 裡的原廠 OpenWrt 上用 dbclient 2022.82 實測過：先連上，再驗證成功。

</details>

### 由 dbclient 跑通道時

等 gateway 接受 Dropbear 的 client 之後，或你用 `--client dbclient` 強制指定時，下面這些細節才派得上用場：

- **版本**：dbclient 需要 `ExitOnForwardFailure`（Dropbear 2016.73 以上），以及 `-K` 和 `-R` 兩個選項。
- **Keepalive**：dbclient 用自己的 `-K 30`，三次沒回應就斷線。它不受 ppoll 問題影響，也永遠不會進相容模式。
- **自己的金鑰格式**：dbclient 2022.82 讀不了 OpenSSH 格式的私鑰（`Exited: String too long`，實測），所以兩種 client 的金鑰檔分開放。有 `dropbearconvert` 時會轉換金鑰、沿用同一條通道；沒有的話，新金鑰在 Telepy 眼中就是一台新裝置，腳本會講清楚。原廠 OpenWrt 沒有 `dropbearconvert`。
- **known_hosts**：dbclient 沒有 `UserKnownHostsFile` 也沒有 `HostKeyAlias`，所以 gateway 的主機金鑰寫進執行帳號的 `~/.ssh/known_hosts`，格式是 `<gateway host> <type> <key>`。金鑰後面不能加註解：dbclient 會把整行剩下的部分當成金鑰解碼，加了註解就對不上（實測）。
- **只動那幾行**：加了哪幾行，會記在安裝紀錄的 `KNOWN_HOSTS_LINE=`，移除腳本和刪除通道都只刪這幾行。
- **主機名稱衝突**：dbclient 只比主機名稱、不比連接埠。同一個主機名稱已經有另一把同類型的金鑰時，腳本會停下來說明。
- **寫死路徑**：服務會直接寫 `/usr/bin/dbclient` 本尊。原廠 OpenWrt 的 `ssh` 指向 dropbear，但之後 `opkg install openssh-client` 會把它換成 OpenSSH；服務如果呼叫的是 `ssh`，就會拿 dbclient 的參數去跑 OpenSSH（`-K 30 -I 0` 被當成別的選項，最後連到 `0.0.0.30`）。
- **網頁連接埠**：dbclient 透過同一個小幫手包裝腳本，用 `-J` 連出去。

## 五、擋掉 SSH 連接埠的網路

有些網路只放行網頁的連接埠，有些網頁名稱則躲在只轉送網頁流量的代理後面。這時通道可以包在 WebSocket 裡，走 Telepy 的網頁連接埠。裡面的 SSH 連線、金鑰和主機金鑰的核對都不變。

- **「自動」**（`--auto`，頁面上的預設）：先走 SSH 連接埠，被擋時改走網頁連接埠，每次連線都重新判斷。
- **「只有網頁 port」**（`--via-web`）：一律走網頁連接埠。

不管哪一種，裝置上都需要一個小幫手：

- **預編的 `telepy-carrier`**：對應裝置 CPU 的版本，從 Telepy 下載並核對 sha256。用內建 client 時，它自己就是小幫手。
- **python3**：那顆 CPU 沒有預編版本時用。
- **兩者都沒有**：選「自動」時通道就只走 SSH 連接埠，腳本會說明；選「只有網頁 port」則會報錯。

想自己決定小幫手，用 `--carrier auto|binary|python`。

裝置要經 HTTP 代理才能連外的話，執行指令時設好 `HTTPS_PROXY`（或 `https_proxy`）。服務沒有自己的環境變數，所以腳本會把代理直接寫進服務的指令裡。

註冊前的 gateway 檢查會告訴你需不需要這麼做：兩次測試握手都逾時或連不上，代表往 gateway 連接埠的對外 TCP 被擋了。請放行，或改用 `--auto`、`--via-web`。Telepy 這一端怎麼處理網頁連接埠，寫在[裝置連線](device-connections.zh-TW.md)。

## 六、相容模式（compat）

註冊（會用掉 token）之前，腳本會透過公開的 `GET /api/join/gateway` 向 Telepy 拿 gateway 的位址、連接埠、帳號與主機金鑰，釘住金鑰後連兩次：

1. 帶 `-o ServerAliveInterval=30 -o ServerAliveCountMax=3`；
2. 不帶。

同一台 gateway、同一組選項，只差 ServerAlive。兩次都不送金鑰（`PubkeyAuthentication=no`）：完整的金鑰交換以 `Permission denied` 結束就算成功，gateway 也不會留下任何事件。

| 第一次 | 第二次 | 腳本怎麼做 |
|---|---|---|
| ok | — | 照常使用 SSH keepalive（`keepalive=ssh`） |
| 逾時 | ok | 切換到相容模式 |
| 逾時或連不上 | 逾時或連不上 | 停下來：往 gateway 的對外 TCP 被擋。改用 `--auto` 或 `--via-web`。不套用相容模式 |
| 主機金鑰不符 | — | 停下來：gateway 的主機金鑰不是 Telepy 宣告的那把 |

第二列是真實存在的 bug：OpenWrt #12574。某些版本的 fortify-headers 裡，`ppoll` 把 64 位元的 `time_t` 當 32 位元讀，在 big-endian 的 ath79 路由器上（例如 GL-AR750S），30 秒就變成 30 奈秒。連眨眼都不夠，更別說做完金鑰交換了：只要設了任何逾時，ssh 立刻逾時。

相容模式會關掉 SSH keepalive：`ServerAliveInterval=0 -o TCPKeepAlive=yes`。加入時回報的事實會記成 `facts.compat = ["no_server_alive"]`，頁面和通道的事件也都會標出來（「相容模式：這台裝置關閉了 SSH keepalive」）。

- `--no-compat`：禁止自動切換，腳本會停下來說明。
- `--compat-no-server-alive`：強制使用相容模式。

代價如下，會印在裝置上，也記在事實與安裝紀錄裡：

- **沒有 SSH 心跳**：斷線只能靠 TCP keepalive 發現，而核心的預設值常常是兩小時。
- **程序在跑不代表通道能用**：procd 和 systemd 只會在 ssh 結束後才重啟它。
- **這是繞道，不是修好**：底層套件的 bug 還在。

dbclient（有自己的 `-K 30`）和內建 client（只探一次、計時器是自己的）都不需要相容模式。

## 七、加入之後能用哪些功能

在小台的 Dropbear / BusyBox 裝置上，Telepy 大部分的功能照常可用：

| 功能 | 在 Dropbear / BusyBox 裝置上 |
|---|---|
| 終端機 | 可用（PTY shell；ash） |
| 檔案管理 / SFTP | 沒有 sftp-server 時（OpenWrt 上是 `opkg install openssh-sftp-server`），檔案管理改走 exec 的備援；SFTP REST API 需要 sftp |
| 裝置金鑰清單（分享時把別人的金鑰裝上去） | 沒有 sftp 子系統時改用 exec 寫入（`cat`，再寫暫存檔、`mv -f`）。OpenWrt + Dropbear 的 root 寫的是 `/etc/dropbear/authorized_keys`，跟加入腳本同一個檔案 |
| 裝置狀況、區網掃描 | 腳本相容 POSIX / BusyBox。`ip` 沒有 `-o` 時改用 `ifconfig`；沒有 `getent` 就不解析名稱 |
| 替服務改名、切換連線方式 | procd 可以（`/etc/init.d/telepy-<代號>`，跟一行指令裝的一樣）。盤點和刪除也都可以 |
| 遠端桌面 / 瀏覽器 | 走裝置 sshd 的 direct-tcpip，Dropbear 預設允許 |
| Windows 原生 | 不支援一行指令加入，請用「逐步設定」 |

還有一個 Dropbear 的限制，Telepy 已經替你繞過去了：它不接受超過 9000 bytes 的 exec 指令。

Telepy 的盤點與刪除腳本大約 25 KB，所以長腳本會分段寫進裝置上的暫存檔（每段最多 6000 字元，`umask 077`），再用 `sh` 執行後刪掉；短腳本照舊用一個 `sh -c`。透過 exec 寫金鑰清單也一樣分段。

以前 Dropbear 會直接把 channel 關掉，Telepy 只看到 `the script stopped early (exit None)`。

## 八、失敗時怎麼辦

腳本停下來時，訊息會告訴你下一步。比起留給你一個裝到一半的服務和一團謎，它寧可停下來把話講清楚。下面整理常見的幾種，照腳本印出來的原文引用，依發生的時間點分組。

### 用掉 token 之前

這時還沒有註冊任何東西，修好原因後重跑同一行指令即可。

- `cannot reach <Telepy 位址>`：裝置連不到 Telepy 的網址。用 wget 或 uclient-fetch 時，https 還需要 CA 憑證（訊息會寫出這台機器該裝的套件），時鐘不對也會讓 TLS 失敗。
- `no SSH server answers on <位址>:<port>`：那裡沒有東西在聽。啟動一個 SSH 伺服器（訊息會附上這台機器的安裝指令），或用 `--ssh-port` / `--ssh-host` 指到正確的那個。Mac 請到「系統設定 > 一般 > 共享」打開「遠端登入」。
- `the SSH server on … answers, but its host key could not be read`：用 root 執行，或裝 openssh-client（為了 ssh-keyscan）。非 root 的 OpenWrt 常見。
- `none of the host keys found … matched the server`：那個連接埠上可能是另一個 SSH 伺服器。用 `--ssh-port` / `--ssh-host` 指到正確的那個。
- `no SSH client: no OpenSSH, no built-in client … and no dbclient`：裝 OpenSSH client（訊息會寫怎麼裝），或請 Telepy 管理員準備好 `telepy-carrier`（`telepy-server fetch-carriers`）。
- `cannot connect to <gateway>` 或 `cannot complete an SSH handshake with <gateway>`：往 gateway 連接埠的對外 TCP 被擋了。請放行，或改用 `--auto` / `--via-web`（見[擋掉 SSH 連接埠的網路](#五擋掉-ssh-連接埠的網路)）。
- `the gateway's host key does not match what Telepy announced`：在 gateway 位址上回應的，不是 Telepy 描述的那台 gateway，所以腳本停下來。
- `the handshake times out as soon as ServerAliveInterval is set`：你在有 ppoll 問題的版本上加了 `--no-compat`。拿掉它重跑，或改加 `--compat-no-server-alive`（見[相容模式](#六相容模式compat)）。
- `the gateway closed the connection during the key exchange`：Dropbear 的 client 跟 gateway 目前還處不來。裝 OpenSSH client，加 `--client openssh` 重跑（見 [Dropbear 的 client 與 Telepy 的 gateway](#dropbear-的-client-與-telepy-的-gateway)）。
- `… has Windows line endings (CRLF)`、`… starts with a UTF-8 byte-order mark` 或 `… is damaged or incomplete (checksum mismatch)`：用 `curl -o` 或 `wget -O` 重新下載腳本，不要經過編輯器存檔。
- `<known_hosts 檔> already has a different … key for <gateway host>`（只有 dbclient）：那一行過時了就刪掉，或裝 OpenSSH 後加 `--client openssh` 重跑。

### 註冊時

- `This join command is invalid or has expired.` 或 `This join command was already used.`：指令只能用一次、30 分鐘後失效。請在 Telepy 重新產生一行。
- `This machine is already managed by another Telepy account`：這台機器的 SSH 主機金鑰已經被另一個帳號的通道釘住了。請那個帳號把裝置分享給你。如果這台是複製出來的機器，請重新產生主機金鑰（`ssh-keygen -A`）再試一次。
- `this machine is already your tunnel '<名稱>'`：只是警告。兩條通道連同一台機器可以運作，但帳號和金鑰會各管各的；通常把這個帳號加到既有的通道會比較整齊。

### 註冊之後

- `the tunnel did not come up within 120 seconds`：服務會每 10 秒重試一次，裝置一連上，Telepy 就會顯示它。看腳本印出的 `Logs:` 那一行（`logread -e telepy-<代號>`、`journalctl -u telepy-<代號> -f`，或對背景迴圈的 log 檔 `tail -f`），並確認往 gateway 連接埠的對外 TCP 有放行。
- `login verified` 顯示 `NO: …`（頁面上：通道已連上，但測試登入失敗）：照顯示的原因修好，在同一台裝置上執行一行新的指令，會沿用同一條通道。
- `the tunnel is up, but Telepy has not finished checking the login`：從腳本印出的連結到 Telepy 看這台裝置。
- `the tunnel stops when <使用者> logs out`：沒用 sudo 裝成的使用者服務。執行 `sudo loginctl enable-linger <使用者>`，或用 sudo 重跑。Mac 上沒用 sudo 時，LaunchAgent 同樣只在你登入時執行。
- `started in the background, but it will NOT come back after a reboot`：沒有服務管理器，crontab 也失敗了。重開機後要自己再啟動一次，或修好 crontab 後重跑。
- `<目錄> is on tmpfs: everything written there is lost at reboot`：用 `--ssh-dir` 指定一個重開機後還在的目錄。

## 九、已知限制

- **Windows**：Windows 原生（PowerShell、排程工作、ACL）仍然用「逐步設定」，一行指令的腳本不在 Windows 上執行。沒有實作或沒有驗證過的能力，Telepy 不宣稱支援。
- **只有 dbclient、又沒有內建 client 的路由器（MIPS）**：在 russh 的修正釋出前連不上 gateway（[細節](#dropbear-的-client-與-telepy-的-gateway)）。腳本會在用掉 token 之前說明；裝 OpenSSH client 就能解決。
- **dbclient 的 known_hosts**：只比主機名稱，所以同一個主機名稱不能有兩把同類型的金鑰，也沒有 `UserKnownHostsFile` 或 `HostKeyAlias`。沒有 `dropbearconvert` 時（原廠 OpenWrt 就沒有），換 client 時金鑰無法互轉。
- **相容模式**：是繞道，不是修好。SSH 心跳關閉，斷線發現得慢。
- **非 root 的 OpenWrt**：讀不到 `/etc/dropbear/*_host_key`，又沒有 `/etc/ssh/*.pub` 和 ssh-keyscan 時，主機金鑰沒有來源，腳本會停下來說明。
- **`/etc/rc.local`**：那裡手寫的通道指令，不會被自動改名或切換。
- **網頁連接埠沒有小幫手**：ARM 路由器（aarch64、armv7、armv6）有預編的 `telepy-carrier`。其他 CPU（MIPS）又沒有 python3 的路由器沒有小幫手，所以「改成自動」會裝一個只走 SSH 連接埠的新服務，並說明這件事（`no_carrier`）。
- **多個位址**：腳本把 SSH 伺服器綁定的位址當成通道的目標。伺服器綁了多個非 loopback 位址時，取第一個。

## 十、測試過的環境

真實平台上的結果，截至 2026-10-30（內建 client 是 2026-11-01）：

- **原廠 OpenWrt 23.05.5**（x86-64，在 Docker 裡）：用內建 client、不裝任何額外套件，加入並驗證成功；另外裝上 OpenSSH client 後也測過。容器重開後，procd 自己把通道帶回來。
- **GL.iNet GL-AR750S**（OpenWrt 22.03.4、MIPS、OpenSSH client、Dropbear 伺服器）：`--check` 通過，在真機上重現了 ppoll 問題；以相容模式完整加入並驗證成功，之後也乾淨的移除。
- **GL.iNet GL-MT3000**（aarch64、OpenSSH client、Dropbear 2024.86）：`--check` 通過，keepalive 正常。只做預檢，沒有加入。
- **Alpine 3.20**（ash、Dropbear 伺服器、OpenSSH client、沒有 procd）：以背景迴圈加 crond 的 `@reboot` 加入並驗證成功；移除後程序與 crontab 那一行都不見了。

此外，Telepy 每次 CI 都會用真的 `/bin/sh` 執行伺服器送出的腳本，對著真的 gateway 跑自動化測試。

<details>
<summary>完整的測試紀錄與 Docker 做法</summary>

**自動化測試（每次 CI）**

- 後端的單元測試涵蓋事實的白名單、soft 回應、校驗碼，以及 exec 寫入指令。
- API 測試涵蓋 soft 回應、`/api/join/gateway`、透過 `/config` 復原、表單的 content type，以及事實寫進票、事件與裝置安裝資訊。
- 腳本測試用真的 `/bin/sh` 執行伺服器送出的腳本（含校驗碼），對著測試 lab 的真 gateway 與真的 HTTP listener，由 lab 的機器扮演裝置的 sshd。
- 這項測試涵蓋壞檔案與 CRLF、`--check` 不消耗 token 也不寫檔、連接埠錯誤時的訊息、真的加入到驗證成功、紀錄的內容，以及移除後通道斷開。在 macOS 的 `/bin/sh` 與 OpenSSH 10.3 上全數通過。

**原廠 OpenWrt 23.05.5 rootfs**（x86-64，在 OrbStack 下模擬；ash、BusyBox 1.36、Dropbear 2022.82 伺服器與 dbclient、uclient-fetch、procd 以 `/sbin/init` 啟動、`--privileged`）：

- `--check` 通過：兩把主機金鑰都來自 `dropbearkey -y`，並以嚴格握手驗過；gateway 的兩把主機金鑰也釘住了。
- 真的加入，從連上到驗證成功（root，經 `/etc/dropbear/authorized_keys`），dbclient 用的是套了修正的 gateway。容器重開後，procd 自己把通道帶回來。
- 伺服器重開後，dbclient 靠 `-K 30` 在一分鐘左右發現斷線，procd 10 秒後重新連上。
- 裝置金鑰清單走 exec 備援（`installed`、`verified`），面板顯示 `/etc/dropbear/authorized_keys`。
- 盤點找到 procd 服務、程序、金鑰與紀錄。移除後 init.d 與 rc.d 的項目和程序都不見了，金鑰留著，gateway 也釋放了 forward。

**同一個 rootfs 再裝 `opkg install openssh-client openssh-keygen`**（Dropbear 伺服器、OpenSSH 9.8 client、沒有 ssh-keyscan）：`--check` 通過，主機金鑰一樣來自 `dropbearkey -y`，keepalive 用 OpenSSH 的 ServerAlive。

**內建 client（2026-11-01）**：原廠 rootfs、沒有 `openssh-client`（沒有 ssh、ssh-keygen、ssh-keyscan，只有 dbclient），在 `CARRIER_DIR` 放一份 `x86_64-unknown-linux-musl` 的 `telepy-carrier`，由 `/api/join/carrier/<target>` 照原樣提供。

- `--check` 選了內建 client：`dropbearkey -y` 的 ed25519 主機金鑰用 `tunnel --probe` 驗過，gateway 探測經 SSH 連接埠成功，沒有相容模式。
- 真的加入時用 `telepy-carrier keygen` 產生金鑰，從連上到驗證成功，跑的是 procd 服務 `telepy-<代號>`，執行 `telepy-<代號>-ws.bin tunnel …`（RSS 約 7 MB）。容器重開後 procd 自己把它帶回來。
- 「改成自動」先接上新的再拆舊的，換到新的安裝代號，同時帶 `--server` 與 `--ws`。
- 連同服務與服務金鑰一起刪除通道後，`/etc/init.d` 與 `/root/.ssh` 裡沒有任何 Telepy 的檔案，也沒有程序。

**Alpine 3.20**（ash、Dropbear 2024.85 伺服器、OpenSSH 9.7 client、沒有 procd）：`--check` 通過，keyscan 與 dropbearkey 兩種來源都驗過；真的加入成背景迴圈加 crond 的 `@reboot`，驗證成功；移除後程序與 crontab 那一行都不見了。

**真實裝置（2026-10-30，從正式環境的伺服器透過 `telepy exec` 執行，開發用伺服器在同一個 LAN）**：

- **GL-AR750S**（OpenWrt 22.03.4、mips、BusyBox 1.35、OpenSSH 8.9p1 client、Dropbear 2022.82 伺服器、curl）：
  - `--check` 通過。來自 `dropbearkey -y` 的兩把主機金鑰正確，`/etc/ssh/*.pub` 的兩把被正確判定為「不是現在在聽的伺服器」而忽略。
  - gateway 探測帶 ServerAlive 會逾時、不帶就成功，於是腳本自己切到相容模式。
  - 真的加入裝了 procd 服務 `telepy-caqgap9k`，從連上到驗證成功（root、相容模式）。
  - 移除後只剩正式環境自己的 `telepy-47xzwr2e`，而且仍在執行。開發用伺服器的 forward 已釋放，金鑰與 authorized_keys 那一行照設計留著（開發用的那一行手動刪掉）。
  - Dropbear 與網路設定完全沒碰。
- **GL-MT3000**（GL 21.02-SNAPSHOT、aarch64、BusyBox 1.33、OpenSSH 8.4p1、Dropbear 2024.86）：`--check` 通過，keepalive 維持 SSH（ServerAlive 握手正常），主機金鑰來自 `dropbearkey -y`，含 ecdsa。只做預檢。
- 兩台的 BusyBox `nc` 都沒有 `-w`（會印出用法），banner 改由 `ssh -v` 取得。腳本現在遇到 `-w` 失敗時，會在 watchdog 底下再跑一次 `nc`。

**Docker 做法**，主機上直接執行一個 Telepy 伺服器（API 在 18872、gateway 在 24872、`SERVER_DOMAIN=host.docker.internal`）：

```sh
docker run -d --platform linux/amd64 --privileged --cgroupns=host --name telepy-wrt openwrt/rootfs:x86-64-23.05.5 /sbin/init
docker exec telepy-wrt sh -c 'wget -O /root/j.sh http://host.docker.internal:18872/api/join/install.sh && sh /root/j.sh --check'
docker exec telepy-wrt sh /root/j.sh --token tpj_…        # 原廠：內建 client（CARRIER_DIR 裡有 telepy-carrier）+ procd
docker exec telepy-wrt sh -c 'opkg update && opkg install openssh-client openssh-keygen' && docker exec telepy-wrt sh /root/j.sh --check
```

</details>
