# `telepy` 命令列與個人 API token

<p align="center"><a href="./cli.md">English</a> | <b>繁體中文</b> | <a href="./cli.ja.md">日本語</a></p>

`telepy` 就是在終端機裡用的 Telepy：列出通道、用 `ssh` / `scp` / `sftp` 直接連進裝置、在單一裝置或所有帶某個標籤的裝置上執行指令、
複製檔案、查看並結束即時連線、播放終端機錄影，以及執行工具箱片段。腳本與 CI 用同一組指令，只是改用**個人 API token** 取代瀏覽器登入。

原始碼：`src/cli/`（獨立的 crate，伺服器的建置不依賴它）。後端：`auth/api_tokens.rs`、
`api/api_tokens.rs`、`db/api_tokens.rs`、`db/api_calls.rs` + `api_calls.rs`（呼叫紀錄）、`api/ai.rs` 裡的 REST exec 路由，
以及 `api/browser.rs` 裡的腳本化瀏覽器路由。

token 在 **API** 頁面（`/tunnels/api`，側邊欄「開發者」→ API）管理，分成四個分頁：**CLI 登入**（每一台執行過 `telepy login` 的
電腦）、**你的 token**、**token 能呼叫什麼**（所有端點，附可直接複製的 `curl` 與對應的 `telepy` 指令）和**活動**（你的 token 與 CLI 登入做過什麼）。

## 四種存取方式，四把鑰匙

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

同一張圖還有即時版，在 **API** 頁面的**四種存取方式**按鈕後面（附「如果我…」開關：撤銷 token、登出 CLI、
中斷 app 或登出網頁，各自只會切斷自己那一條路），每個 token 也有各自的版本，在**你的 token → 怎麼運作**。

- token **就是你本人**：你的通道、你在通道上可用的帳號、管理員為你設定的功能開關，以及指令規則全都照樣適用。它拿不到比你更多的權限。
- 它不能登入網頁、不能改你的密碼或兩步驟驗證設定，也不能建立更多 token：只有允許清單 `auth::api_tokens::ROUTES` 裡的 REST 路由對它開放，
  每條路由各需要一個範圍（scope）。API 頁面的**token 能呼叫什麼**分頁就是由同一張表產生（`GET /api/auth/tokens/routes`），所以不會和伺服器的實際行為不一致。
- 要求你確認「是你本人」的通道（**step-up**）會拒絕 token，和 MCP agent 一樣。
- 每個 token 都會過期（最長一年）。撤銷立即生效。
- 管理員可以對所有人、某個使用者群組或單一個人關閉 **API token** 功能（管理 → 使用者與權限 → 功能權限，`/tunnels/admin/access`）：
  該使用者的 token 就會失效。管理員替你關掉的其他功能（網頁終端機、檔案管理員……）也會拒絕你的 token（403 `feature_disabled`）。
- 如果管理員停用你的帳號，你的 token 與 CLI 登入會被暫停而不是撤銷：帳號停用期間會被拒絕，重新啟用後就恢復可用。

## 範圍（Scopes）

| 範圍 | 讓 token 可以 | CLI 指令 |
| --- | --- | --- |
| `tunnels:read` | 列出通道、狀態、上線時間、帳號、產生的 ssh config、即時連線 | `ls`、`status`、`ssh`、`scp`、`sftp`、`config install`、`sessions`、`lan ls` |
| `ssh:exec` | 開啟 exec 連線並執行指令（指令規則照樣適用）、讀取錄影與片段 | `exec`、`run`、`recordings`、`snippets` |
| `ssh:files` | 所有 SFTP 操作 | `cp` |
| `network:scan` | 區網掃描（MCP 的 `lan_scan`、掃描用的 REST 路由） | — |
| `browser:use` | 經由裝置使用腳本化瀏覽器：MCP 瀏覽器工具與 `/api/browser/sessions*` | `browse` |
| `tunnels:manage` | 建立 / 修改 / 刪除 / 分享通道、標籤、區網主機、結束連線（僅限 token） | `sessions end`、`lan add` / `rm` |

`tunnels:read` 也能列出裝置背後的區網主機（`telepy lan ls`、`GET /api/reverse/lan/topology`）。

`ssh` / `scp` / `sftp` 只需要 `tunnels:read`：它們取得 ssh config 之後，由你系統上的 OpenSSH 用**你的個人 SSH 金鑰**
經過閘道登入，做法和網頁上的 SSH config 對話框一樣。

## 安裝

網頁上有 **CLI** 頁面（`/tunnels/cli`，側邊欄「開發者」→ CLI），內含適合你電腦的安裝指令（依瀏覽器判斷）、
對應你伺服器的登入指令，以及用你自己的通道、帳號、標籤、群組和片段填好的範例。手動執行的指令如下：

從 `v2.8.0` 起，每個 Telepy 發行版都附有 CLI，涵蓋 macOS arm64 / x86_64、Linux x86_64 / arm64（靜態、musl）和
Windows x86_64，由同一個 tag 建置，回報的版本也相同（`telepy --version`）。檔名不含版本號，所以
`releases/latest/download/…` 永遠指向最新版：

```sh
# macOS / Linux
TARGET=aarch64-apple-darwin   # x86_64-apple-darwin, x86_64-unknown-linux-musl, aarch64-unknown-linux-musl
curl -fsSL "https://github.com/NatLee/telepy/releases/latest/download/telepy-$TARGET.tar.gz" | tar xz telepy
sudo mkdir -p /usr/local/bin && sudo install -m 755 telepy /usr/local/bin/ && rm telepy
telepy --version
```

```powershell
# Windows: unpacks into %LOCALAPPDATA%\telepy and adds it to your PATH once
$dir = "$env:LOCALAPPDATA\telepy"
Invoke-WebRequest https://github.com/NatLee/telepy/releases/latest/download/telepy-x86_64-pc-windows-msvc.zip -OutFile "$env:TEMP\telepy.zip"
Expand-Archive "$env:TEMP\telepy.zip" $dir -Force
$p = [Environment]::GetEnvironmentVariable("Path", "User")
if (($p -split ";") -notcontains $dir) { [Environment]::SetEnvironmentVariable("Path", "$p;$dir", "User") }
$env:Path += ";$dir"
telepy --version
```

每個壓縮檔旁邊都有一個 `.sha256`，每個發行版還有一份 `SHA256SUMS`
（`curl -fsSL …/telepy-$TARGET.tar.gz.sha256 | sha256sum -c`；macOS 用 `shasum -a 256 -c`）。指定版本：
`…/releases/download/v2.11.0/telepy-$TARGET.tar.gz`。這個執行檔沒有簽章也沒有經過公證：如果是用瀏覽器而不是
`curl` 下載，macOS 需要先執行 `xattr -d com.apple.quarantine telepy`。

也可以自己建置（Rust 1.88 以上）：`cargo install --locked --git https://github.com/NatLee/telepy telepy-cli`
（回報的版本是 Cargo.toml 裡的 `0.1.0`；建置時設定 `TELEPY_VERSION` 可以標上別的版本）。`ssh`、`scp` 和 `sftp` 還需要
PATH 裡有系統的 OpenSSH 用戶端（`telepy doctor` 會檢查）。

**維護者：**發佈 GitHub release（`gh release create v2.7.0 …`）會執行 `.github/workflows/release-cli.yml`：
從該 tag 建置五個目標平台，`TELEPY_VERSION` 為去掉 `v` 的 tag，並做冒煙測試
（`telepy --version` 必須印出它），再連同 `.sha256` 檔和 `SHA256SUMS` 附到 release 上。也可以在 Actions 分頁手動執行：帶 tag 就是
（重新）附到既有的 release，不帶 tag 則是試建置，檔案只留在該次執行的 artifacts 裡。版本標記機制出現之前的 tag（例如 `v2.8.0`）也能用同樣方式
建置，它的 CLI 會回報 Cargo.toml 的 `0.1.0`。從 `v2.8.0` 起每個 Telepy 發行版都附有由它建置的 CLI；沒有
獨立的 CLI tag。

### 更新

```sh
telepy update --check        # is a newer release out?
telepy update                # download it, check it against the release's SHA256SUMS and replace this telepy
telepy update --to v2.9.0    # a given release (also to go back)
```

`telepy update` 會從發行版下載對應這個平台的壓縮檔，若它的 SHA-256 和
`SHA256SUMS` 不符就拒絕使用，把新的執行檔寫在舊檔旁邊，把舊檔移開，再執行新檔的 `--version`；
失敗的話就把舊檔放回去。它需要 telepy 所在資料夾的寫入權限（`/usr/local/bin` 要用 `sudo telepy update`）；
用 `cargo install` 或 Homebrew 安裝的 telepy 則交給那些工具處理。在 Windows 上，舊的
`.exe` 會被改名（執行中的檔案無法刪除），下次執行時再清掉。

發行版建置也會自己檢查有沒有新版：每天最多一次，在背景執行、逾時兩秒，而且只在 stderr 是終端機、且沒有設定 `CI` 時才進行。
有新版時，成功的指令之後會多印一行提示。設定 `TELEPY_NO_UPDATE_CHECK=1` 可以關掉；`TELEPY_RELEASES_URL` 可以讓兩者都改指向
`https://github.com/NatLee/telepy/releases` 的鏡像（最新的 tag 是從 `/latest` 的重新導向讀出來的，所以不受 GitHub API
速率限制）。`telepy doctor` 會印出版本以及是否有新版（只是警告，不算失敗）。
自己在本機建置的 telepy（版本來自 Cargo.toml）不會自動檢查。

## 登入

```sh
telepy login https://telepy.example.com                 # browser: OAuth + PKCE, loopback callback
telepy login https://telepy.example.com --scope "tunnels:read ssh:exec ssh:files network:scan"
telepy login https://telepy.example.com --no-browser    # print the sign-in URL instead of opening a browser
telepy login https://telepy.example.com --token tpt_…   # a personal API token (the API page → Your tokens); --with-token works too
telepy whoami                                           # who, and with which token / app, scopes, tunnels and expiry
telepy logout
```

核准之後，瀏覽器會停在 Telepy 的「已登入」頁面（`/oauth/done`：CLI 現在可以做什麼，以及幾個可以試試的
指令；它的外觀跟隨核准頁面，設定在網站設定 → 登入）。較舊的 Telepy 伺服器沒有這個頁面，
就會顯示 CLI 自己繪製的小頁面。

瀏覽器登入使用和 MCP app 相同的 OAuth 核准流程，所以核准頁面看起來很像，但
CLI 不是 MCP app：它列在 **API 頁面 → CLI 登入**（每台電腦一筆，它的呼叫會出現在 API
活動裡），不會出現在 MCP app 之間，登出也是在那裡，或用 `telepy logout`。在同一台電腦上再次執行 `telepy login`
時，會詢問要不要取代之前的登入，而且每個人最多保留 10 筆 CLI 登入：第 11 筆
會把最久沒用的那筆登出。瀏覽器登入遵循管理員可以關閉的 **MCP app** 功能（管理 →
使用者與權限 → 功能權限）；token 則不受影響，照樣可用。CLI 會儲存 access token 與 refresh token。憑證存放在
macOS 鑰匙圈或 Windows 認證管理員；在 Linux（以及設定 `TELEPY_NO_KEYRING=1`，或鑰匙圈失敗時）則放在設定目錄裡權限為 0600 的 `credentials.json`
（`TELEPY_CONFIG_DIR`，否則是 `$XDG_CONFIG_HOME/telepy` 或 `~/.config/telepy`；Windows 為 `%APPDATA%\telepy`）。`logout` 會忘記登入資料，
並在伺服器上撤銷瀏覽器登入；token 則要到 API 頁面撤銷之前都有效。

在 CI 裡不需要儲存任何東西：設定 `TELEPY_URL` 和 `TELEPY_TOKEN`（或傳入 `--server` / `--token`）。

在終端機裡，`telepy login` 和一次乾淨的 `telepy doctor` 會在結果旁邊顯示 Tapi，也就是 Telepy 的小幽靈（輸出被導向管線時不會顯示；`NO_COLOR` 會讓它不上色）。
旁邊的文字會依終端機寬度換行；終端機很窄時文字會移到 Tapi 下方，非常窄時就省略 Tapi。設定 `TELEPY_NO_MASCOT=1` 可以不顯示它。

## 指令

![CLI 怎麼連到你的裝置](images/zh-TW/cli-flow.png)

```sh
telepy ls                                  # NAME  HEALTH  LATENCY  ACCOUNTS  LABELS  GROUP  SEEN
telepy ls --label env=prod --online --json
telepy ls --group "Lab"
telepy status box                          # health, uptime, device facts and warnings

telepy ssh box                             # the tunnel's default account
telepy ssh box@pi -- uname -a              # <tunnel>@<account> (pi@box works too)
telepy ssh box -L 8080:localhost:80        # forward a port; -D 1080 for SOCKS
telepy ssh box -i ~/.ssh/id_work           # a specific key for both hops
telepy ssh box --ssh-opt "-o ServerAliveInterval=30"   # any other ssh option (repeatable; scp / sftp take it too)
telepy ssh box --via ssh                   # straight to Telepy's SSH port instead of the web port (see "Which port" below)
telepy config fallback always              # this server: use the SSH port without asking when the web port can't be reached
telepy scp ./build.tar.gz box@pi:/tmp/
telepy scp -r box@pi:/var/log/app ./logs
telepy sftp box@pi
telepy config install box nas              # the web dialog's install command, done for you (~/.ssh/config, marked blocks, backup)
telepy config install --all --print        # every tunnel you can use; print the blocks instead of writing (--file <path> writes elsewhere)
telepy config tidy                         # simplify ~/.ssh/config: shows what changes + the diff, asks, keeps config.bak
telepy config tidy --check                 # report only; exit 1 when it could be simpler or has lines worth a look (dotfiles CI)

telepy exec box -- systemctl is-active nginx
telepy exec --label env=prod -- uptime     # every tunnel with the label, in parallel, "name | " prefixes
telepy exec --group Lab -u root --timeout 300 -- apt-get -y upgrade   # a tunnel group of yours, one account, timeout ≤ 600 s
telepy exec box nas --json -- df -h /
telepy exec box --wait-approval -- sudo reboot   # keep waiting while a command rule holds it for approval

telepy cp box@pi:/var/log/syslog ./syslog
telepy cp ./config.yml box@pi:/etc/app/

telepy sessions                            # live sessions on your tunnels
telepy sessions end 42
telepy recordings ls --tunnel box
telepy recordings play 17 --speed 2        # with its timing, pauses capped at 2 s (--idle-limit 0 keeps every pause)
telepy snippets ls --tunnel box
telepy run "restart service" box --var svc=nginx   # -y skips the "ask first" confirmation

telepy lan ls box                          # the LAN hosts Telepy knows behind a device
telepy lan add box 192.168.1.20 --label nas --user pi --port 22
telepy lan rm box nas                      # by id, address or label

ID=$(telepy browse box http://192.168.1.1/)   # a browser on the device's network (browser:use); prints its id
telepy browse text "$ID" --selector main
telepy browse shot "$ID" -o router.png
telepy browse click "$ID" --text "Status"
telepy browse type "$ID" "#q" "uptime" --enter
telepy browse go "$ID" http://192.168.1.1/logs
telepy browse ls
telepy browse close "$ID"

telepy api tokens                          # your tokens: scopes, expiry, last use, calls 24 h / 7 d, errors
telepy api activity                        # the last 50 calls made with your tokens and CLI sign-ins
telepy api activity --api-token ci --status 4xx --since 2h
telepy api activity --method DELETE --limit 200 --json
telepy api activity --follow               # like tail -f: new calls every 2 s, Ctrl+C stops
telepy api activity --all --user bob       # admins: everyone's, or one person's

telepy doctor                              # server, sign-in, scopes, expiry, ssh / scp / sftp
```

`ssh` / `scp` / `sftp` 會寫入 `~/.ssh/telepy/<alias>.conf`（產生的設定檔，其中的 ProxyCommand 指回
該檔案）和 `~/.ssh/telepy/known_hosts-<server>`（已釘選的 Telepy 閘道主機金鑰），然後用 `-F` 執行系統的 OpenSSH
（`TELEPY_SSH_DIR` 可以更換那個資料夾）。除非你執行
`telepy config install`，否則你自己的 `~/.ssh/config` 不會被動到；該指令會保留 `config.bak`，把主機金鑰存到 `~/.ssh/telepy_known_hosts`，並且和
網頁對話框一樣，不去動屬於另一台 Telepy 伺服器的同名裝置（設定名稱前綴 `ssh_alias_prefix`
就能讓兩邊並存）。

`config tidy` 不需要登入，也絕不會把檔案傳到任何地方。它套用網頁上 **SSH config 編輯器**的規則（同一套
引擎，由共用的測試案例確保一致）：多台主機共用的行只寫一次，放在它們後面的 `Host a b c` 區塊裡
（自己設了不同值的主機會保留自己的值），`Host web1` 底下的 `HostName web1.example.com` 會變成
`HostName %h.example.com`，ssh 永遠不會讀到的重複行會被移除。檔案中列出的每個名稱都會重新解析，結果必須與
之前完全相同；不會有任何東西被移到 `Match` / `Include` 的另一邊，Telepy 自己的區塊也會保留它們的標記。它還會
列出永遠不會生效的行，以及 ssh 不認得的選項。`--wildcards` 允許在檔案中沒有其他名稱會符合的情況下使用 `Host web-*`；`--yes` 不詢問直接寫入；
`--file <path>` 用來簡化另一個檔案。

`exec` 會透過後端為每條通道開一個短暫的連線（`POST /api/ai/sessions`，接著 `POST /api/ai/sessions/{id}/exec`，最後關閉）：
使用與 MCP agent 相同的清理機制（reaper）、指令規則和稽核。
這些指令會出現在 **AI 活動**頁面，以 token 的名稱顯示（瀏覽器登入之後則是 CLI 的 app 名稱）；
用 token 做的其他 REST 寫入操作（分享、標籤、區網主機、結束連線……）會在該通道的紀錄裡留下一筆 `token_call` 項目。

`browse` 驅動一個**腳本化瀏覽器**：一個真正的 Chromium，瀏覽時就像坐在裝置上一樣，所以它看得到
裝置的區網、它的 localhost 和它的公網 IP——路由器的管理頁面、內網儀表板、只允許該 IP 或地區的網站。
一次一個動作，每個動作限制在 30 秒內；每個瀏覽器都是完整的 Chromium，會計入你個人的
連線數上限（`ai_max_sessions_per_user`），所以它適合腳本化的檢查、截圖和小規模抓取，
不適合大量爬蟲。瀏覽器閒置時會自動關閉；每個動作都會記在 AI 活動紀錄裡（輸入的
文字只記長度，除非加上 `--show`），而且需要 step-up 的通道會拒絕它們。

結束碼：對單一目標執行的 `exec` / `run` 會以遠端指令的結束碼結束（逾時並被終止時是 124，
Telepy 拒絕或無法執行時是 255）；多個目標時只要有任何一個失敗就以 1 結束。`ssh` / `scp` / `sftp`
則以 OpenSSH 的結束碼結束。Telepy 的其他錯誤以 1 結束，並印出伺服器的訊息。

### `ssh / scp / sftp` 用哪個連接埠

它們預設透過 Telepy 的**網頁連接埠**連線：`telepy` 本身就是通往 Telepy 那一跳的 ProxyCommand，
把 SSH 包在 WebSocket 裡傳送（`/ws/gateway/`，不需要 python3）。裡面的 SSH 不變——你的金鑰、
已釘選的主機金鑰、裝置自己的 sshd——但 Telepy 現在能記錄到你的真實位址，而 SSH 連接埠前面的東西
（OrbStack 或 Docker 的連接埠轉發、NAT）常常會把它藏起來。SSH 這一跳每 30 秒送出一次 keepalive，所以網頁連接埠前面的
代理（CDN、負載平衡器）不會把閒置的連線關掉。

網頁連接埠連不上時，`telepy` 只有在你同意的情況下才會改用 SSH 連接埠：

| `--fallback` / `telepy config fallback` | 行為 |
| --- | --- |
| `ask`（預設） | 在終端機詢問：**y** 這次允許、**a** 這台伺服器一律允許（會儲存）、**N** 不允許。沒有終端機時（CI、腳本）不會退回，並說明如何允許。 |
| `always` | 使用 SSH 連接埠，並在 stderr 說明。 |
| `never` | 直接失敗並說明原因。 |

這個設定依伺服器儲存在 `<config dir>/prefs.json`（不帶值的 `telepy config fallback` 會顯示目前的設定）；
`--fallback` 或 `TELEPY_SSH_FALLBACK` 可以覆寫單次執行，而 `--via ssh` / `TELEPY_SSH_VIA=ssh` 則完全略過
網頁連接埠。`telepy doctor` 兩者都會顯示。

## 用 curl 或 MCP 用戶端使用 token

```sh
curl -H "Authorization: Bearer $TELEPY_TOKEN" https://telepy.example.com/api/reverse/server/dashboard
```

```json
{ "mcpServers": { "telepy": { "url": "https://telepy.example.com/mcp", "headers": { "Authorization": "Bearer tpt_…" } } } }
```

在 `/mcp` 上，只要你的 **MCP app** 功能是開啟的（除了 **API token** 之外），token 的運作方式就和 OAuth app 的 token 一樣（同樣的工具、範圍和通道限制）。
工具請見 [mcp.zh-TW.md](mcp.zh-TW.md)。

**token 能呼叫什麼**分頁為每個端點提供一段 `curl`，已填入基底 URL，並把機密寫成
`$TELEPY_TOKEN`（匯出一次即可；頁面不會再顯示真正的機密）。路徑變數也是 shell 變數
（`$TUNNEL_ID`、`$ID`、`$HOST_ID`）。

## 呼叫紀錄

用個人 API token 或 OAuth app 的 token（CLI 的瀏覽器登入）發出的每一個 REST 請求都會被記錄——
包括讀取——用個人 token 發出的每一次 MCP 工具呼叫也是（MCP app 的工具呼叫本來就在
AI 活動紀錄裡）。每一筆包含：時間、誰、哪個 token / app、方法 + **路由範本**（絕不含查詢字串）、
通道、狀態、耗時、IP；MCP 的筆數是 `MCP <tool>`，狀態為 200 或 400（工具回傳錯誤），並附上
錯誤開頭的內容。被拒絕的請求（`token_route`、`token_scope`、token 通道範圍之外的 `404`）也會記錄。

- **API → 活動**依日期顯示你自己的呼叫，可依 token 或 CLI 登入篩選（token
  或 CLI 登入上的**呼叫紀錄**按鈕會跳到這裡），
  也能依狀態（OK / 4xx / 5xx）、方法和搜尋篩選。管理員可以在**管理 → 全站 API 活動**看到所有人的（可依人篩選；
  「管理使用者」對話框裡有連結）。`GET /api/auth/tokens/calls?scope=mine|all&token_id=&grant_id=&user_id=&username=&status=&method=&limit=&before=`。
- **`telepy api activity`** 在終端機印出同樣的清單（新的在前：以你本地時區顯示的時間、token 或 app、
  方法、路由、通道、狀態、耗時、IP）。篩選：`--api-token <name|id|prefix>`（全域的 `--token` 是
  登入的覆寫選項，所以這個篩選用了另一個名字）、`--status ok|4xx|5xx|error`、`--method GET…|MCP`、
  `--since 30m|2h|7d|<RFC 3339>`、`--limit N`（預設 50，最多 1000；更舊的頁面用 `before` 取得）。
  `--all` / `--user <name|id>` 是管理員檢視（其他人會看到「Only admins can see other people's API
  activity」）。`--follow` 先由舊到新印出最近的呼叫，之後每筆新的呼叫一出現就印出（每 2 秒檢查一次；加上
  `--json` 則每行一個物件）；它自己輪詢紀錄的請求會被排除。`telepy api tokens` 是 token 清單，並附上
  同樣的每個 token 摘要。token 和 CLI 的瀏覽器登入不需要任何額外範圍就能讀取這兩個端點（`GET /api/auth/tokens`、
  `GET /api/auth/tokens/calls`）；建立與撤銷 token 仍然只能在網頁應用程式中進行。
- **你的 token** 會顯示每個 token 最近 24 小時 / 7 天的呼叫、錯誤和總數（紀錄列過期之後，`call_count` 仍會
  繼續累計）。
- 寫入會在背景批次進行（佇列滿了就丟棄呼叫並計數；請求絕不會因此等待）。紀錄保留
  90 天、最多 200,000 筆，並會隨被刪除的使用者一起移除。這份紀錄沒有做雜湊鏈（量大，
  而且逐使用者刪除會破壞鏈）；用 token 做的寫入操作仍會在通道的紀錄裡留下一筆有雜湊鏈的 `token_call` 閘道事件。
