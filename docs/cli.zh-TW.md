# `telepy` 命令列與個人 API token

<p align="center"><a href="./cli.md">English</a> | <b>繁體中文</b> | <a href="./cli.ja.md">日本語</a></p>

`telepy` 就是終端機裡的 Telepy。它能列出你的通道、用 `ssh`、`scp`、`sftp` 直接連進裝置、在一台裝置或所有帶某個標籤的裝置上跑指令、複製檔案、查看與結束即時連線、播放終端機錄影，還能執行工具箱片段。為了跑一個 `uptime` 還得打開網頁，覺得太大費周章的人，用這個就對了。

腳本和 CI 用的是同一套指令，只是不走瀏覽器登入，而是帶一把**個人 API token**。

token 和 CLI 登入都在網頁的 **API** 頁面管理（側邊欄**開發者 → API**），裡面有四個分頁：

- **CLI 登入**：每一台執行過 `telepy login` 的電腦。
- **你的 token**：建立、查看、撤銷 token。
- **token 能呼叫什麼**：每一個端點，附上可直接複製的 `curl` 與對應的 `telepy` 指令。
- **活動**：你的 token 和 CLI 登入做了哪些事。

## 安裝

最省事的做法是網頁上的 **CLI** 頁面（側邊欄**開發者 → CLI**）。它會依你的瀏覽器挑出這台電腦的安裝指令、給你這台伺服器的登入指令，範例也直接填好你自己的通道、帳號、標籤、群組和片段。

手動安裝也不難。從 `v2.8.0` 起，每個 Telepy 發行版都附有這些平台的 CLI：

- macOS arm64 與 x86_64
- Linux x86_64 與 arm64（靜態連結、musl）
- Windows x86_64

每個平台的 CLI 都從該發行版的 tag 建置，回報的版本也一樣（`telepy --version`）。檔名不帶版本號，所以 `releases/latest/download/…` 永遠拿到最新版。

```sh
# macOS / Linux
TARGET=aarch64-apple-darwin   # x86_64-apple-darwin, x86_64-unknown-linux-musl, aarch64-unknown-linux-musl
curl -fsSL "https://github.com/NatLee/telepy/releases/latest/download/telepy-$TARGET.tar.gz" | tar xz telepy
sudo mkdir -p /usr/local/bin && sudo install -m 755 telepy /usr/local/bin/ && rm telepy
telepy --version
```

```powershell
# Windows：解壓縮到 %LOCALAPPDATA%\telepy，並把它加進 PATH（只會加一次）
$dir = "$env:LOCALAPPDATA\telepy"
Invoke-WebRequest https://github.com/NatLee/telepy/releases/latest/download/telepy-x86_64-pc-windows-msvc.zip -OutFile "$env:TEMP\telepy.zip"
Expand-Archive "$env:TEMP\telepy.zip" $dir -Force
$p = [Environment]::GetEnvironmentVariable("Path", "User")
if (($p -split ";") -notcontains $dir) { [Environment]::SetEnvironmentVariable("Path", "$p;$dir", "User") }
$env:Path += ";$dir"
telepy --version
```

要指定版本，就改用 `…/releases/download/v2.11.0/telepy-$TARGET.tar.gz`。

`ssh`、`scp`、`sftp` 另外需要 PATH 裡有系統的 OpenSSH 用戶端，`telepy doctor` 會幫你檢查。

### 確認下載的檔案

每個壓縮檔旁邊都有一個 `.sha256`，每個發行版也都有一份 `SHA256SUMS`：`curl -fsSL …/telepy-$TARGET.tar.gz.sha256 | sha256sum -c`（macOS 用 `shasum -a 256 -c`）。

這個執行檔沒有 Apple 或 Microsoft 的簽章。如果你是用瀏覽器而不是 `curl` 下載，macOS 要先執行 `xattr -d com.apple.quarantine telepy` 才肯讓它跑。

另外還有兩種方法，能證明發行檔真的出自 Telepy，兩種都不需要任何帳號：

- **建置來源證明**：發行版的每個檔案都由建置流程本身出具證明（GitHub artifact attestation）。`gh attestation verify telepy-$TARGET.tar.gz --repo NatLee/telepy` 會告訴你是哪個 commit、哪一次 workflow 執行產出了這些位元組。
- **簽過名的雜湊清單**：`SHA256SUMS` 用 Telepy 的發行金鑰簽名。那是一把 OpenSSH ed25519 金鑰，公鑰放在 [`src/backend-api/src/release_key.rs`](../src/backend-api/src/release_key.rs)。簽章檔是 `SHA256SUMS.sig`，採用 OpenSSH 的簽章格式，所以光靠 OpenSSH 就能驗證：

  ```sh
  echo "telepy-release $(sed -n 's/^ *"\(ssh-ed25519 [^"]*\)".*/\1/p' release_key.rs | head -1)" > allowed_signers
  ssh-keygen -Y verify -f allowed_signers -I telepy-release -n telepy-release -s SHA256SUMS.sig < SHA256SUMS
  sha256sum -c --ignore-missing SHA256SUMS
  ```

  也可以手動把那個檔案裡的公鑰貼進去：`allowed_signers` 只有一行，就是 `telepy-release <公鑰>`。

`telepy update` 會自己做這個檢查，Telepy 伺服器從發行版下載裝置端的輔助程式時也一樣。只要 `SHA256SUMS` 不見了、或不是 Telepy 發行金鑰簽的，兩者都會拒絕。用自己的金鑰重新簽名的鏡像站，可以設定 `TELEPY_RELEASE_KEYS`（一行或多行公鑰，用換行或 `;` 分隔）來取代內建的公鑰。

### 自己建置

需要 Rust 1.88 以上：

```sh
cargo install --locked --git https://github.com/NatLee/telepy telepy-cli
```

這樣建出來的版本會是 Cargo.toml 裡的 `0.1.0`。建置時設定 `TELEPY_VERSION`，就能標上別的版本。

### 更新

```sh
telepy update --check        # 有新版了嗎？
telepy update                # 下載新版，對照發行版簽過名的 SHA256SUMS 檢查後，換掉現在這個 telepy
telepy update --to v2.9.0    # 指定某個發行版（也能用來退回舊版）
```

`telepy update` 會做這幾件事：

1. 從發行版下載這個平台的壓縮檔。
2. `SHA256SUMS` 不是 Telepy 發行金鑰簽的，或壓縮檔的 SHA-256 對不上，就拒絕使用。
3. 把新的執行檔寫在舊檔旁邊，把舊檔移開，再執行新檔的 `--version`。
4. 如果失敗，就把舊檔放回去。

它需要 telepy 所在資料夾的寫入權限（裝在 `/usr/local/bin` 就要用 `sudo telepy update`）。用 `cargo install` 或 Homebrew 裝的 telepy，就交給那些工具更新。在 Windows 上，執行中的檔案刪不掉，所以舊的 `.exe` 會先改名，下次執行時再清掉。

發行版建置也會自己留意有沒有新版：

- 每天最多一次，在背景進行，逾時兩秒；
- 只在 stderr 是終端機、而且沒有設定 `CI` 時才檢查；
- 有新版時，會在指令成功之後多印一行提醒。

設定 `TELEPY_NO_UPDATE_CHECK=1` 就能關掉。`TELEPY_RELEASES_URL` 可以讓檢查和 `telepy update` 都改用 `https://github.com/NatLee/telepy/releases` 的鏡像。最新的 tag 是從 `/latest` 的重新導向讀出來的，所以不受 GitHub API 的速率限制。

`telepy doctor` 會顯示版本，以及有沒有新版（只是警告，不算失敗）。自己建置的 telepy 不會主動檢查。

## 登入

```sh
telepy login https://telepy.example.com                 # 瀏覽器登入：OAuth + PKCE，回呼到本機
telepy login https://telepy.example.com --scope "tunnels:read ssh:exec ssh:files network:scan"
telepy login https://telepy.example.com --no-browser    # 只印出登入網址，不自動開瀏覽器
telepy login https://telepy.example.com --token tpt_…   # 用個人 API token（API 頁面 → 你的 token）；--with-token 也可以
telepy whoami                                           # 你是誰、用哪個 token / app、scope、通道與到期日
telepy logout
```

沒加 `--scope` 時，瀏覽器登入會要求 `tunnels:read ssh:exec ssh:files`。每個 scope 能做什麼，請看 [Scope](#scope)。

核准之後，瀏覽器會停在 Telepy 的「已登入」頁面，列出 CLI 現在能做什麼，再附上幾個可以試試的指令。它的外觀跟著**網站設定 → 登入**裡核准頁面的設定走。較舊的 Telepy 伺服器沒有這個頁面，就改由 CLI 自己畫一個小頁面。

### CLI 登入不是 MCP app

瀏覽器登入和 MCP app 用的是同一套 OAuth 核准流程，所以核准頁面看起來似曾相識。不過 CLI 並不是 MCP app：

- 它列在 **API** 頁面的 **CLI 登入**分頁，每台電腦一筆，它的呼叫也算在 API 活動裡。它不會出現在 MCP app 之中。
- 要登出，就到那裡登出，或執行 `telepy logout`。
- 在同一台電腦上再執行一次 `telepy login`，會問你要不要取代之前的登入。
- 每個人最多保留 10 筆 CLI 登入，第 11 筆會把最久沒用的那筆登出。
- 瀏覽器登入受 **MCP app** 功能控制，管理員可以把它關掉（**管理 → 使用者與權限 → 功能權限**）。token 不受影響，照樣能用。

### 登入資料存在哪

CLI 會存下一組 access token 與 refresh token：

- **macOS**：存在鑰匙圈。
- **Windows**：存在認證管理員。
- **Linux**，以及設定了 `TELEPY_NO_KEYRING=1`、或鑰匙圈出問題的環境：存在設定目錄裡的 `credentials.json`，權限 0600。設定目錄是 `TELEPY_CONFIG_DIR`，沒設的話就是 `$XDG_CONFIG_HOME/telepy` 或 `~/.config/telepy`（Windows 為 `%APPDATA%\telepy`）。

`telepy logout` 會忘掉登入資料；如果是瀏覽器登入，還會在伺服器上撤銷它。token 則要等你到 API 頁面撤銷才會失效。

在 CI 裡什麼都不用存，請看[在 CI 裡](#在-ci-裡)。

### 認識 Tapi

在終端機裡，`telepy login` 和一次全部通過的 `telepy doctor` 會在結果旁邊顯示 Tapi，也就是 Telepy 的小幽靈。旁邊的文字會依終端機寬度換行；終端機窄一點時，文字會移到 Tapi 下方，非常窄時就乾脆不畫 Tapi。

輸出導到管線時不會出現 Tapi，`NO_COLOR` 會讓它不上色。怕見鬼的話，設定 `TELEPY_NO_MASCOT=1` 就再也不會看到它。

## 日常指令

![CLI 怎麼連到你的裝置](images/zh-TW/cli-flow.png)

目標就是一條通道，也可以加上裝置帳號：`box` 用這條通道的預設帳號，`box@pi` 用 `pi`（寫成 `pi@box` 也行）。`telepy <指令> --help` 會列出該指令的所有選項。

### 找出你的通道

```sh
telepy ls                                  # NAME  HEALTH  LATENCY  ACCOUNTS  LABELS  GROUP  SEEN
telepy ls --label env=prod --online --json
telepy ls --group "Lab"
telepy status box                          # 健康狀態、上線時間、裝置資訊與警告
```

### SSH、scp 與 sftp

```sh
telepy ssh box                             # 用這條通道的預設帳號
telepy ssh box@pi -- uname -a              # <通道>@<帳號>（寫成 pi@box 也行）
telepy ssh box -L 8080:localhost:80        # 轉發一個連接埠；SOCKS 用 -D 1080
telepy ssh box -i ~/.ssh/id_work           # 兩段連線都用指定的金鑰
telepy ssh box --ssh-opt "-o ServerAliveInterval=30"   # 其他任何 ssh 選項（可重複；scp / sftp 也適用）
telepy scp ./build.tar.gz box@pi:/tmp/
telepy scp -r box@pi:/var/log/app ./logs
telepy sftp box@pi
```

這些指令執行的是你系統上的 OpenSSH，用**你的個人 SSH 金鑰**登入，經過 Telepy 的閘道和通道連到裝置。走的路就是網頁上 **SSH 設定**對話框幫你設好的那一條。

每次執行都會在 `~/.ssh/telepy/` 寫入兩個檔案（可以用 `TELEPY_SSH_DIR` 換資料夾）：

- `<alias>.conf`：產生出來的設定檔，裡面的 ProxyCommand 指回這個檔案本身；
- `known_hosts-<server>`：釘選好的 Telepy 閘道主機金鑰。

接著用 `-F` 啟動 OpenSSH。你自己的 `~/.ssh/config` 完全不會被碰到。

### 網頁連接埠還是 SSH 連接埠

`telepy ssh`、`scp`、`sftp` 預設經由 Telepy 的**網頁連接埠**連線。`telepy` 自己就是通往 Telepy 那一段的 ProxyCommand，把 SSH 包在 WebSocket 裡傳送（`/ws/gateway/`，不需要 python3）。

裡面的 SSH 完全一樣：你的金鑰、釘選的主機金鑰、裝置自己的 sshd。差別在於 Telepy 這樣才記得到你真正的位址，而 SSH 連接埠前面的東西（OrbStack 或 Docker 的連接埠轉發、NAT）常常會把它藏起來。

SSH 那一段每 30 秒送一次 keepalive，所以網頁連接埠前面的代理（CDN、負載平衡器）不會把閒置的連線切掉。

```sh
telepy ssh box --via ssh                   # 不走網頁連接埠，直接連 Telepy 的 SSH 連接埠
telepy config fallback always              # 這台伺服器：網頁連接埠連不上時，不必問就改走 SSH 連接埠
```

網頁連接埠連不上時，`telepy` 一定要先得到你的同意，才會改走 SSH 連接埠：

| `--fallback` / `telepy config fallback` | 會怎樣 |
| --- | --- |
| `ask`（預設） | 在終端機問你：**y** 這次可以、**a** 這台伺服器以後都可以（會記下來）、**N** 不要。沒有終端機時（CI、腳本）不會改走，並告訴你怎麼允許。 |
| `always` | 改走 SSH 連接埠，並在 stderr 說一聲。 |
| `never` | 直接失敗並說明原因。 |

這個選擇依伺服器存在 `<config dir>/prefs.json`，`telepy config fallback` 不帶值就會顯示目前的設定。`--fallback` 或 `TELEPY_SSH_FALLBACK` 只覆寫這一次執行。`--via ssh` 或 `TELEPY_SSH_VIA=ssh` 則完全不走網頁連接埠。`telepy doctor` 兩者都會顯示。

### 你的 `~/.ssh/config`

想把 Telepy 的區塊放進你自己的設定檔，就像網頁的 SSH 設定對話框那樣：

```sh
telepy config install box nas              # 替你執行網頁對話框的安裝指令（~/.ssh/config、加了標記的區塊、備份）
telepy config install --all --print        # 你能用的每一條通道；只印出區塊、不寫入（--file <path> 改寫到別的檔案）
```

它會留一份 `config.bak`，並把主機金鑰存到 `~/.ssh/telepy_known_hosts`。和網頁對話框一樣，它不會去動屬於另一台 Telepy 伺服器的同名裝置。想讓兩邊並存，就在 SSH 設定對話框的「這台電腦上有好幾台 Telepy？」設一個名稱前綴。

`config tidy` 則是幫你簡化現有的設定檔：

```sh
telepy config tidy                         # 簡化 ~/.ssh/config：列出改了什麼與 diff，問過才寫入，並留下 config.bak
telepy config tidy --check                 # 只回報；還能更精簡或有值得一看的行，就以 1 結束（給 dotfiles 的 CI 用）
```

它不需要登入，也絕不會把檔案傳到任何地方。規則和網頁上的 **SSH config 編輯器**一樣（同一套引擎，靠共用的測試案例確保一致）：

- 好幾台主機共用的行只寫一次，放在它們後面的 `Host a b c` 區塊裡。自己設了不同值的主機會保留自己的值。
- `Host web1` 底下的 `HostName web1.example.com` 會變成 `HostName %h.example.com`。
- ssh 永遠讀不到的重複行會被刪掉。

改完之後，檔案裡的每個名稱都會重新解析一次，結果必須和之前一模一樣。不會有東西被搬過 `Match` 或 `Include`，Telepy 自己的區塊也會保留標記。它還會列出永遠不會生效的行，以及 ssh 不認得的選項。

`--wildcards` 允許在檔案裡沒有其他名稱會對到時改寫成 `Host web-*`。`--yes` 不問直接寫入（一樣會先備份）。`--file <path>` 用來簡化別的檔案。

### 執行指令

```sh
telepy exec box -- systemctl is-active nginx
telepy exec --label env=prod -- uptime     # 每條帶這個標籤的通道，平行執行，每行加上「名稱 | 」前綴
telepy exec --group Lab -u root --timeout 300 -- apt-get -y upgrade   # 你的某個通道群組、指定一個帳號、逾時 ≤ 600 秒
telepy exec box nas --json -- df -h /
telepy exec box --wait-approval -- sudo reboot   # 指令規則把它攔下等核准時，繼續等下去
```

`exec` 會透過 Telepy 替每條通道開一個短暫的連線、執行指令、再把它關掉（`POST /api/ai/sessions`，接著 `POST /api/ai/sessions/{id}/exec`）。這些連線和 MCP agent 的待遇一樣：同樣的清理機制、指令規則與稽核。沒有指定的話，逾時是 60 秒。

這些指令會出現在 **AI 活動**頁面，顯示的是 token 的名稱；如果是瀏覽器登入，則顯示 CLI 的 app 名稱。

### 複製檔案

```sh
telepy cp box@pi:/var/log/syslog ./syslog
telepy cp ./config.yml box@pi:/etc/app/
```

`cp` 透過 Telepy 的 API 走 SFTP 複製，需要 `ssh:files` scope。`scp` 則是 OpenSSH 的做法，需要你的個人 SSH 金鑰。

### 連線、錄影與片段

```sh
telepy sessions                            # 你的通道上的即時連線
telepy sessions end 42
telepy recordings ls --tunnel box
telepy recordings play 17 --speed 2        # 照錄影的節奏播放，停頓最長 2 秒（--idle-limit 0 保留每一段停頓）
telepy snippets ls --tunnel box
telepy run "restart service" box --var svc=nginx   # -y 跳過「先確認」的確認
```

結束一條連線不等於撤銷權限：對方還是可以重新連上。

### 區網主機

```sh
telepy lan ls box                          # Telepy 知道的、在這台裝置背後的區網主機
telepy lan add box 192.168.1.20 --label nas --user pi --port 22
telepy lan rm box nas                      # 用 id、位址或標籤指定
```

列出只需要 `tunnels:read`。新增和移除需要 `tunnels:manage`，而這個 scope 只有 API token 拿得到。

### 裝置網路上的瀏覽器

```sh
ID=$(telepy browse box http://192.168.1.1/)   # 在裝置的網路上開一個瀏覽器（browser:use），印出它的 id
telepy browse text "$ID" --selector main
telepy browse shot "$ID" -o router.png
telepy browse click "$ID" --text "Status"
telepy browse type "$ID" "#q" "uptime" --enter
telepy browse go "$ID" http://192.168.1.1/logs
telepy browse ls
telepy browse close "$ID"
```

`browse` 操作的是一個**腳本化瀏覽器**：真正的 Chromium，瀏覽起來就像坐在裝置前面。它看得到裝置的區網、裝置的 localhost 和裝置的公網 IP，所以打得開路由器的管理頁面、內網的儀表板，或只允許那個 IP、那個地區的網站。

- 一次一個動作，每個動作最多 30 秒。
- 每個瀏覽器都是完整的 Chromium，會算進你個人的連線數上限（網站設定裡的「每位使用者的 AI 工作階段數」）。它適合腳本化的檢查、截圖和小規模的抓取；拿來大量爬網站的話，伺服器會先哭給你看。
- 瀏覽器閒置時會自己關掉。
- 每個動作都記在 AI 活動紀錄裡。輸入的文字只記長度，除非加上 `--show`。
- 要求先確認身分（step-up）的通道會拒絕它。

## 指令速查

每個指令也都接受 `--server <url>` 和 `--token tpt_…`（或 `TELEPY_URL`、`TELEPY_TOKEN`），用來指定這一次要用哪台伺服器、哪個憑證。

<details>
<summary>所有指令、用途與需要的 scope</summary>

| 指令 | 用途 | Scope |
| --- | --- | --- |
| `telepy login <url>` | 用瀏覽器登入；`--token` / `--with-token` 改用 token 登入，`--scope` 與 `--no-browser` 見上方 | — |
| `telepy logout` | 忘掉登入資料；瀏覽器登入還會在伺服器上撤銷 | — |
| `telepy whoami` | 你是誰、用哪個 token 或 app、scope、通道與到期日 | — |
| `telepy ls` | 列出通道與健康狀態、延遲、帳號、標籤和群組；`--label`、`--group`、`--online`、`--json` | `tunnels:read` |
| `telepy status <tunnel>` | 單一通道：健康狀態、上線時間、裝置資訊與警告 | `tunnels:read` |
| `telepy ssh <target>` | SSH 進裝置；`-L`、`-D`、`-i`、`--ssh-opt`、`--via`、`--fallback`，`--` 後面接指令 | `tunnels:read` + 你的 SSH 金鑰 |
| `telepy scp [-r] <from>… <to>` | 用 scp 複製；遠端寫成 `<tunnel>[@account]:<path>` | `tunnels:read` + 你的 SSH 金鑰 |
| `telepy sftp <target>` | 對裝置開 sftp | `tunnels:read` + 你的 SSH 金鑰 |
| `telepy config install` | 把 Telepy 的區塊放進 `~/.ssh/config`；指定通道或 `--all`、`--print`、`--file` | `tunnels:read` |
| `telepy config fallback` | 顯示或設定網頁連接埠連不上時怎麼辦：`ask`、`always`、`never` | — |
| `telepy config tidy` | 簡化 ssh 設定檔；`--check`、`--wildcards`、`--yes`、`--file`；不需要登入 | — |
| `telepy exec <targets> -- <command>` | 在一台或多台裝置上執行指令；`--label`、`--group`、`-u`、`--timeout`（預設 60，最多 600）、`--wait-approval`、`--json` | `ssh:exec` |
| `telepy cp <from> <to>` | 經 SFTP 在裝置與本機之間複製檔案 | `ssh:files` |
| `telepy sessions` | 你的通道上的即時連線 | `tunnels:read` |
| `telepy sessions end <id>` | 結束一條即時連線 | `tunnels:manage` |
| `telepy recordings ls` | 列出錄影，新的在前；`--tunnel` | `ssh:exec` |
| `telepy recordings play <id>` | 在這個終端機播放；`--speed`（預設 1）、`--idle-limit`（預設 2 秒） | `ssh:exec` |
| `telepy snippets ls` | 你的片段、全站的片段，加上 `--tunnel` 時再加該通道的 | `ssh:exec` |
| `telepy run <snippet> <target>` | 執行工具箱片段；`--var name=value`、`-y`、`--timeout` | `ssh:exec` |
| `telepy lan ls <tunnel>` | Telepy 知道的、在裝置背後的區網主機 | `tunnels:read` |
| `telepy lan add <tunnel> <address>` | 手動新增主機；`--label`、`--user`、`--port` | `tunnels:manage` |
| `telepy lan rm <tunnel> <host>` | 用 id、位址或標籤移除主機 | `tunnels:manage` |
| `telepy browse <target> [url]` | 開一個腳本化瀏覽器並印出它的 id（等同 `browse open`） | `browser:use` |
| `telepy browse ls` / `go` / `text` / `shot` / `click` / `type` / `close` | 列出這個登入開著的瀏覽器，或用 id 操作其中一個 | `browser:use` |
| `telepy api tokens` | 你的 token 與呼叫摘要 | — |
| `telepy api activity` | 你的 token 與 CLI 登入發出的呼叫（見[呼叫紀錄](#呼叫紀錄)） | — |
| `telepy doctor` | 檢查伺服器、登入、scope、到期日、本機的 ssh 工具與版本 | — |
| `telepy update` | 更新 telepy；`--check`、`--to <version>` | — |

</details>

### 結束碼

- 對單一目標執行的 `exec` 和 `run`，會以遠端指令的結束碼結束。逾時並被終止時是 124，Telepy 拒絕或無法執行時是 255。
- 有多個目標時，只要其中一個失敗，`exec` 就以 1 結束。
- `ssh`、`scp`、`sftp` 以 OpenSSH 的結束碼結束。
- Telepy 的其他錯誤一律以 1 結束，並印出伺服器的訊息。

## Token 與 scope

### 四種存取方式，四把鑰匙

![四種進入方式：撤銷其中一條，其他照常](images/zh-TW/ways-in.gif)

```
 這個瀏覽器 ─────────────────── 網頁登入工作階段 ────────────────────────┐
                                                                         │
 腳本 / CI ──────────────────── API token（範圍 · 通道 · 到期日） ───────┤
                                                                         │
 你電腦上的 telepy ──────────── CLI 登入（OAuth，每台電腦一個） ─────────├──▶ Telepy ──── 經由通道的 SSH ───▶ 你的裝置
                                                                         │
 一個 MCP app ───────────────── OAuth 授權（你核准過這個 app） ──────────┘

 撤銷 API token：
 腳本 / CI ─────────────✂── （立即被拒絕；它開著的 exec 連線會關閉）
 這個瀏覽器、CLI 登入、MCP app ── 照常運作
```

即時版的圖在 API 頁面的**四種存取方式**按鈕後面。上面的「如果我…」開關會讓你看到：撤銷 token、登出某台電腦的 CLI、中斷一個 app、或登出網頁，都只會切斷自己那一條路。每個 token 也有自己的版本，在**你的 token → 怎麼運作**。

### token 能做與不能做的事

- **token 就是你本人**：你的通道、你在通道上能用的帳號、管理員替你設的功能開關、指令規則，全都照樣適用。它永遠不會拿到比你更多的權限。
- **它管不了你的帳號**：它不能登入網頁、不能改密碼或兩步驟驗證的設定，也不能再建立 token。它只能呼叫白名單上的 REST 路由，每條各需要一個 scope。**token 能呼叫什麼**分頁就是用同一份清單產生的（`GET /api/auth/tokens/routes`），所以不可能和伺服器說的不一樣。
- **需要 step-up 的通道會拒絕它**：要求你先確認身分的通道一律拒絕 token，和 MCP agent 一樣。
- **它會過期**：每個 token 都有期限，最長是建立後一年。撤銷則是立即生效。
- **管理員可以關掉它**：管理員可以對所有人、某個使用者群組或單一個人關閉 **API token** 功能（**管理 → 使用者與權限 → 功能權限**），那個人的 token 就會失效。管理員替你關掉的其他功能（網頁終端機、檔案管理員……）一樣會拒絕你的 token，回應 403 `feature_disabled`。
- **帳號被停用時它會暫停**：管理員停用你的帳號時，你的 token 和 CLI 登入是暫停，不是撤銷。帳號停用期間一律被拒，重新啟用後就恢復可用。

### Scope

| Scope | 讓 token 可以 | CLI 指令 |
| --- | --- | --- |
| `tunnels:read` | 列出通道、狀態、上線時間、帳號、產生的 ssh 設定檔、即時連線 | `ls`、`status`、`ssh`、`scp`、`sftp`、`config install`、`sessions`、`lan ls` |
| `ssh:exec` | 開 exec 連線並執行指令（指令規則照樣適用）、讀取錄影與片段 | `exec`、`run`、`recordings`、`snippets` |
| `ssh:files` | 所有 SFTP 操作 | `cp` |
| `network:scan` | 區網掃描（MCP 的 `lan_scan`、掃描用的 REST 路由） | — |
| `browser:use` | 經由裝置使用腳本化瀏覽器：MCP 的瀏覽器工具與 `/api/browser/sessions*` | `browse` |
| `tunnels:manage` | 建立 / 修改 / 刪除 / 分享通道、標籤、區網主機、結束連線（僅限 token） | `sessions end`、`lan add` / `rm` |

`tunnels:read` 也涵蓋裝置背後的區網主機（`telepy lan ls`、`GET /api/reverse/lan/topology`）。

`ssh`、`scp`、`sftp` 只需要 `tunnels:read`。Telepy 把 ssh 設定檔交給你，接下來由你系統上的 OpenSSH 用你的個人 SSH 金鑰經過閘道登入。

## 腳本、CI 與其他用戶端

### 在 CI 裡

先在 API 頁面建立一把 token（**你的 token → 新增 token**），勾選這個工作需要的 scope。然後設定兩個環境變數，就不必登入：

```sh
export TELEPY_URL=https://telepy.example.com
export TELEPY_TOKEN=tpt_…
telepy exec --label env=prod -- uptime
```

也可以在每個指令上改用 `--server` 和 `--token`。runner 上不會存任何東西；設了 `CI` 時，CLI 也不會去檢查更新。

### 用 curl

```sh
curl -H "Authorization: Bearer $TELEPY_TOKEN" https://telepy.example.com/api/reverse/server/dashboard
```

**token 能呼叫什麼**分頁替每個端點都準備了一段 `curl`，基底網址已經填好，機密則寫成 `$TELEPY_TOKEN`。先 export 一次就好：頁面不會再顯示真正的機密。路徑變數也是 shell 變數（`$TUNNEL_ID`、`$ID`、`$HOST_ID`）。

### 在 MCP 用戶端裡

```json
{ "mcpServers": { "telepy": { "url": "https://telepy.example.com/mcp", "headers": { "Authorization": "Bearer tpt_…" } } } }
```

在 `/mcp` 上，token 的用法和 OAuth app 的 token 一樣：同樣的工具、scope 與通道限制。前提是你的 **API token** 和 **MCP app** 兩個功能都是開著的。工具清單請看 [mcp.zh-TW.md](mcp.zh-TW.md)。

## 呼叫紀錄

用個人 API token 或 CLI 的瀏覽器登入發出的每一個 REST 請求都會記下來，讀取也算在內。用個人 token 發出的每一次 MCP 工具呼叫也會記；MCP app 的工具呼叫則本來就在 AI 活動紀錄裡。

被拒絕的請求一樣會記下：`token_route`、`token_scope`，以及碰到 token 清單之外的通道時回應的 `404`。

每一筆包含時間、誰、哪個 token 或 app、方法與**路由範本**（絕不含查詢字串）、通道、狀態、耗時和 IP。MCP 的筆數寫成 `MCP <tool>`，狀態是 200；工具回傳錯誤時是 400，並附上錯誤訊息的開頭。

### 在網頁上

- **API → 活動**依日期列出你自己的呼叫。可以依 token 或 CLI 登入篩選（兩者的**呼叫紀錄**按鈕都會跳到這裡），也能依狀態（OK / 4xx / 5xx）、方法篩選或直接搜尋。
- **你的 token** 會顯示每個 token 最近 24 小時與 7 天的呼叫數、錯誤數和總數。舊的紀錄過期之後，總數（`call_count`）仍會繼續累計。
- 管理員可以在管理區的**全站活動 → API 活動**看到所有人的呼叫，並依人篩選。「管理使用者」對話框裡也有連結。

腳本也能讀同一份清單：`GET /api/auth/tokens/calls?scope=mine|all&token_id=&grant_id=&user_id=&username=&status=&method=&limit=&before=`。

### 在終端機裡

```sh
telepy api tokens                          # 你的 token：scope、到期日、最後使用、24 小時 / 7 天的呼叫數、錯誤
telepy api activity                        # 你的 token 與 CLI 登入最近 50 筆呼叫
telepy api activity --api-token ci --status 4xx --since 2h
telepy api activity --method DELETE --limit 200 --json
telepy api activity --follow               # 像 tail -f：每 2 秒印出新的呼叫，Ctrl+C 停止
telepy api activity --all --user bob       # 管理員：所有人的，或某一個人的
```

`telepy api activity` 會由新到舊印出清單：以你本地時區顯示的時間、token 或 app、方法、路由、通道、狀態、耗時和 IP。可用的篩選：

- `--api-token <name|id|prefix>`：只看某個 token 的呼叫。全域的 `--token` 已經拿去當登入的覆寫選項了，所以這個篩選換了名字。
- `--status ok|4xx|5xx|error` 與 `--method GET…|MCP`。
- `--since 30m|2h|7d|<RFC 3339>`。
- `--limit N`：預設 50，最多 1000。更舊的頁面會用 `before` 往前抓。
- `--all` / `--user <name|id>`：管理員檢視。其他人會看到「Only admins can see other people's API activity」。
- `--follow`：先由舊到新印出最近的呼叫，之後每來一筆新的就印一筆（每 2 秒一次；加上 `--json` 則每行一個物件）。它自己輪詢紀錄的請求不會列進去，免得一直盯著自己看。

`telepy api tokens` 會列出你的 token，附上同樣的每個 token 摘要。token 和 CLI 的瀏覽器登入不需要額外的 scope，就能讀這兩個端點（`GET /api/auth/tokens`、`GET /api/auth/tokens/calls`）。建立和撤銷 token 仍然只能在網頁上做。

### 還會記下什麼、保留多久

- 用 token 做的寫入操作（分享、標籤、區網主機、結束連線……）也會在該通道的**日誌**留下一筆 `token_call`。
- 紀錄是在背景批次寫入的。佇列滿了就丟棄並計數，請求絕不會因此卡住。
- 紀錄保留 90 天、最多 200,000 筆，使用者被刪除時一併移除。
- 呼叫紀錄沒有做雜湊鏈：量太大，而且只刪某個人的紀錄會把鏈弄斷。**日誌**裡的 `token_call` 事件則有雜湊鏈。

## 環境變數

| 變數 | 作用 |
| --- | --- |
| `TELEPY_URL` | Telepy 伺服器，等同 `--server` |
| `TELEPY_TOKEN` | 個人 API token，等同 `--token`；CI 用 |
| `TELEPY_CONFIG_DIR` | 設定目錄（預設 `$XDG_CONFIG_HOME/telepy` 或 `~/.config/telepy`；Windows 為 `%APPDATA%\telepy`） |
| `TELEPY_NO_KEYRING=1` | 登入資料存在 `credentials.json`，不用系統的鑰匙圈 |
| `TELEPY_SSH_DIR` | `ssh` / `scp` / `sftp` 寫設定檔與 known_hosts 的地方（預設 `~/.ssh/telepy`） |
| `TELEPY_SSH_VIA=ssh` | 直接連 Telepy 的 SSH 連接埠，等同 `--via ssh` |
| `TELEPY_SSH_FALLBACK` | 這次執行用 `ask`、`always` 或 `never`，等同 `--fallback` |
| `TELEPY_NO_UPDATE_CHECK=1` | 不做每天一次的新版檢查 |
| `TELEPY_RELEASES_URL` | 發行版頁面的鏡像，給更新檢查與 `telepy update` 用 |
| `TELEPY_RELEASE_KEYS` | 改信任這些發行公鑰，取代內建的（給重新簽名的鏡像用） |
| `TELEPY_NO_MASCOT=1` | `login` 與 `doctor` 旁邊不顯示 Tapi |
| `NO_COLOR` | Tapi 不上色 |
| `CI` | 有設定時不檢查新版 |
| `TELEPY_VERSION` | 建置時用：要標進執行檔的版本 |

## 疑難排解

先跑 `telepy doctor`：

```sh
telepy doctor                              # 伺服器、登入、scope、到期日、ssh / scp / sftp
```

它會檢查伺服器、你的登入、scope 與到期日、本機的 `ssh` / `scp` / `sftp`、連接埠設定，以及有沒有新版的 telepy。

- **macOS 不讓你開執行檔**：用瀏覽器下載的檔案會這樣。執行一次 `xattr -d com.apple.quarantine telepy` 就好。
- **`ssh`、`scp` 或 `sftp` 跑不起來**：它們需要 PATH 裡有系統的 OpenSSH 用戶端。
- **裝置不收你的 SSH 金鑰**：`ssh`、`scp`、`sftp` 是用你的個人 SSH 金鑰登入的。網頁上這條通道的 **SSH 設定**對話框會顯示你的金鑰進不進得去（「確認你的金鑰進得去」），也能幫你加上去。
- **網頁連接埠連不上**：在終端機裡，telepy 會先問過你才改走 SSH 連接埠。沒有終端機時不會改走：可以用 `--fallback always`、`TELEPY_SSH_FALLBACK=always` 或 `telepy config fallback always` 允許，或用 `--via ssh` 直接走 SSH 連接埠。
- **403 `token_scope`**：這個 token 缺少指令需要的 scope（見 [Scope](#scope)）。建立一把有這個 scope 的 token，或加上 `--scope` 重新登入。
- **403 `token_route`**：這個端點根本不開放給 token：你的帳號、兩步驟驗證和 token 本身，都只能在網頁上管理。
- **網頁上看得到的通道卻回 404**：這個 token 限定的是別的通道。
- **403 `feature_disabled`**：管理員替你關掉了那個功能，token 得到的回應和網頁一樣。
- **通道拒絕你的 token 或 `browse`**：它要求先確認身分（step-up）。token 和腳本化瀏覽器沒辦法確認是你本人，這條通道請改用網頁。
- **帳號被停用後什麼都被拒**：token 和 CLI 登入只是暫停，不是撤銷。管理員重新啟用帳號後就會恢復。
- **`exec` 卡在指令規則**：有規則把指令攔下來等核准。加上 `--wait-approval` 就會繼續等（最多 10 分鐘）。
- **`telepy update` 換不掉執行檔**：它需要 telepy 所在資料夾的寫入權限（`/usr/local/bin` 要用 `sudo telepy update`）。如果是用 `cargo install` 或 Homebrew 裝的，就用那些工具更新。
- **出現「Only admins can see other people's API activity.」**：拿掉 `--all` / `--user` 就能看你自己的。

## 給維護者：發行版建置

<details>
<summary>GitHub release 怎麼建置、簽名並附上 CLI</summary>

發佈 GitHub release（`gh release create v2.7.0 …`）會執行 `.github/workflows/release-cli.yml`：

1. 從那個 tag 建置五個目標平台，`TELEPY_VERSION` 設為去掉 `v` 的 tag。
2. 每個建置都做冒煙測試：`telepy --version` 必須印出那個版本。
3. 檔案出具來源證明後，連同各自的 `.sha256` 附到 release 上。
4. 再加上一份用 `RELEASE_SIGNING_KEY` secret（一把 OpenSSH ed25519 私鑰）簽名的 `SHA256SUMS`。沒有這個 secret，release 這一步就會失敗。

也可以在 Actions 分頁手動執行這個 workflow。帶 tag 就是把檔案（重新）附到那個既有的 release；不帶 tag 則是試建置，檔案只會留在那次執行的 artifacts 裡。

版本標記機制出現之前的 tag（例如 `v2.8.0`）也能用同樣方式補上建置，它的 CLI 會回報 Cargo.toml 的 `0.1.0`。從 `v2.8.0` 起，每個 Telepy 發行版都附有用它建置的 CLI，沒有另外的 CLI tag。

</details>
