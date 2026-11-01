# 那個「ms」是怎麼來的？

<p align="center"><a href="./latency-deep-dive.md">English</a> | <b>繁體中文</b> | <a href="./latency-deep-dive.ja.md">日本語</a></p>

終端機頁面的標題列上，有個小小的延遲徽章：

```
You ●──23ms──● Telepy ●──87ms──● Device   Σ 110ms
```

看起來很簡單。這篇說明每個數字從哪裡來、多久量一次，以及 Telepy 為了讓它是「真的」花了哪些功夫。

## 兩段路，分開量

![終端機的說明圖顯示每一段的來回時間](images/zh-TW/terminal-flow.png)

沒辦法一次量完整趟：瀏覽器碰不到裝置，裝置也不知道你的瀏覽器存在。所以 Telepy 把兩段分開計時，最後再加起來（就是那個 Σ）。

| 區段 | 量什麼 | 誰來量 | 多久一次 |
|---|---|---|---|
| 你 → Telepy | 瀏覽器和伺服器之間的 WebSocket 來回時間 | 瀏覽器裡的終端機頁面 | 每 5 秒 |
| Telepy → 裝置 | 經過通道、到裝置 SSH 伺服器的來回時間 | 後端內建的 SSH gateway | 每 15 秒 |

兩個數字都是來回時間（RTT），不是單程。加起來之後，就很接近你和裝置之間真正的一趟來回。

## 第一段：你的瀏覽器到 Telepy

終端機頁面每 5 秒會透過 WebSocket 送出一行：

```json
{ "action": "ping" }
```

後端回一個 `pong`，用的是 binary frame，不是文字 frame。頁面算一下花了多久，更新徽章。

為什麼要用 binary？終端機頁面會把每個文字 frame 直接寫到畫面上，因為 shell 的輸出就是走文字 frame。如果 pong 用文字回，你的 vim 裡每 5 秒就會冒出一個 `pong`，像有個非常準時的阿飄。用 binary frame，頁面就知道「這是控制訊息，不是輸出」，畫面完全不受影響。

終端機連線上的其他控制訊息也照這個規矩：斷線後保留 shell 的訊息、命令規則的提示、「誰在看」的名單，全都是 binary JSON。頁面收到 binary frame 時，先看內容是不是剛好 `pong`，不是才當 JSON 解析。

另外兩件事：

- 其他 WebSocket（通知、單一通道狀態、檔案管理）的 ping，回的是文字 `{"type":"pong"}`。它們沒有終端機畫面要保護。
- 伺服器也會每 20 秒對終端機、檔案管理和遠端瀏覽器的連線送一次 WebSocket Ping，40 秒都沒回應就斷線，用來抓那些沒說再見就消失的瀏覽器。這是存活檢查，不拿來量延遲。

## 第二段：Telepy 到裝置

### 為什麼不直接問 kernel？

最省事的做法是問 kernel：`ss -ti` 本來就會回報每條 TCP 連線的 RTT，免費又即時。一開始的想法也是這樣。

問題出在伺服器前面擋了 docker-proxy 或 L4 負載平衡器的時候。裝置的 TCP 連線其實在這個 proxy 就終止了，而 proxy 就在同一台機器上，於是 kernel 很有自信的回報：RTT 大約 0 ms。

實際上，裝置可能在幾百公里外的機房，隔著三層 NAT 跟你揮手。kernel 的數字很精確，只是量錯了距離。

### 敲門，然後只讀一個 byte

所以 Telepy 直接在通道裡量：

1. gateway 沿著裝置的反向通道開一條 channel，就是有人連到轉發埠時，`ssh -R` 會開的那種。
2. 裝置上的 ssh client 把這條 channel 接到裝置自己的 SSH 伺服器。
3. gateway 按下碼錶，只讀一個 byte：SSH 伺服器 banner 的第一個 byte（`SSH-2.0-...` 的那個 `S`）。

這個 byte 一定得沿著通道去一趟再回來，所以量到的是真正的網路來回。proxy 騙得了 kernel，卻變不出裝置的 banner。物理是不收紅包的。

也因為這樣，前面有 L4 proxy、或 Docker 改寫了來源位址，照樣量得準：byte 走的是通道裡面，不是 kernel 看到的那條連線。

細節：

- 每 15 秒一輪。進階的後端變數 `GATEWAY_PROBE_INTERVAL_SECS` 可以改這個間隔。
- 所有通道同時探測，每個 4 秒逾時。睡著的裝置只會用掉自己的 4 秒，不會拖累其他裝置。
- 碼錶精度到 0.1 ms。

探測只負責量。通道上線或離線，看的是通道本身：裝置註冊或釋放它的 forward。探測逾時再多次，都不會讓通道變成離線。不過連續失敗會改變一件事，下一節說明。

## 敲了沒人應：降級

有時候 forward 還在，banner 卻一直沒回來：裝置的 sshd 停了、被防火牆擋住，或卡死了。通道看起來在線上，其實什麼都連不進去。

所以 Telepy 會替每條通道記錄探測失敗的次數。連續失敗兩次，通道就標成「降級」；成功一次就歸零。只失敗一次不算：裝置偶爾忙到 4 秒內回不了 banner，很正常。

通道列表會顯示四種狀態：

| 狀態 | 顯示 | 意思 |
|---|---|---|
| 上線 | 綠點 | 通道開著，裝置的 sshd 也透過它回應 |
| 降級 | 琥珀色點 | 通道開著，但 sshd 連續兩次探測都沒回應 |
| 離線 | 灰點 | 裝置以前連過，現在沒有通道 |
| 從未連線 | 虛線圈 | 沒有任何連線紀錄 |

通道降級或恢復時：

- 這條通道的日誌頁會記下「SSH 無回應」或「SSH 已恢復」事件。
- 看得到這條通道的人都會收到通知：列表亮起琥珀色的點，通道的開啟按鈕看起來像離線。降級時還會跳出警告訊息。
- 訂閱了狀態事件的 webhook 也會收到，各自照自己設定的延遲送出。

「量不到」絕不會顯示成 0。探測失敗的通道就是沒有數字，徽章顯示灰格加 `—`，不會編一個 0 ms 出來。gateway 根本沒在跑的時候，那一輪就不送延遲。

## 把數字送到你的畫面

後端有個迴圈每 5 秒跑一輪，收走最新的探測結果，送給有權限看的瀏覽器。

- **有變才送**：RTT 本來就會抖個幾毫秒（87、89、86、88…）。為了這種差異讓每個頁面每 5 秒重畫一次太浪費，所以只有某條通道變動 5 ms 以上，或有通道出現、消失時才送。其他時候保持安靜，但最多安靜 6 輪就一定送一次，剛連上的頁面不用等太久。
- **其他都沒變也照送**：延遲是在迴圈「沒變化就收工」的檢查之前送出的。不然一條穩定得不得了的通道，會永遠停在第一次量到的數字。
- **上線／離線有防彈跳**：通道狀態要連續兩輪都不一樣，才會宣布變更。
- **只送你的通道**：每個人只會收到自己擁有、或分享給自己的通道延遲。別人通道的延遲，你看不到。

數字分兩條路送：

- 通道列表從通知連線 `/ws/notifications/` 收到。
- 終端機頁面和「建立通道」精靈，訂閱單一通道的狀態連線 `/ws/tunnel_connection/{id}/`，即時拿到這條通道的數字。

## 數字怎麼畫出來

通道列表先從 `GET /api/reverse/server/dashboard` 載入一次（通道、連接埠、延遲一個請求全拿），之後跟著即時更新走。沒有取樣時 `latency` 是 `{}`，列表就只是不顯示數字。舊的 `/api/reverse/server/status/latency` 端點還在，回傳 `{"<port>": rtt_ms}`。

延遲用四格顯示，像手機的訊號：

| 來回時間 | 格數 | 標籤 |
|---|---|---|
| 60 ms 以下 | 4 格綠 | 極佳 |
| 60–150 ms | 3 格綠 | 良好 |
| 150–300 ms | 2 格琥珀色 | 普通 |
| 超過 300 ms | 1 格紅 | 不佳（建議確認一下，裝置是不是被裝到月球上了） |
| 量不到 | 灰格加 `—` | — |

在終端機頁面上：

- 標題列的徽章把兩段畫成一條路徑 `You ●──● Telepy ●──● Device`，線上有光點流動。第一段是這個分頁自己的 ping/pong，第二段是狀態連線送來的通道數字。滑鼠移上去或點一下，可以看到每段的明細和總和。
- 說明對話框「終端機怎麼運作」也在「你 ─ Telepy」和「Telepy ─ 裝置」兩段線上，標出同樣的兩個來回時間（就是本頁最上面那張圖）。

遠端桌面的串流統計，也把通道延遲當成其中一段。請看[遠端桌面](./remote-desktop.zh-TW.md)。

所有會變的數字，都放在固定寬度、等寬數字的格子裡，`72ms` 變成 `115ms` 時版面一動也不動。

## 一趟旅程，五個步驟

1. gateway 每 15 秒沿著每條反向通道敲一次門，計時裝置 SSH banner 的第一個 byte 多久回來。
2. 結果直接放進後端的記憶體。連續兩次敲門沒人應，通道就標成降級。
3. 後端迴圈每 5 秒來收一次，略過沒意思的變化，把其他的送給有權限看的人。
4. 你的瀏覽器畫出訊號格和路徑徽章，另外用 ping/pong（binary！）自己量到伺服器那一段。
5. 兩段相加，就很接近你和裝置之間在真實世界的距離。

設計理念一句話：不信轉述（kernel、proxy），只信親自跑完全程的那個 byte。

## 底層細節

下面兩段是給讀原始碼、或對歷史好奇的人看的，內容不會改變 Telepy 對你的任何行為。

<details>
<summary>程式裡的名字（給貢獻者）</summary>

- 探測是 `Gateway::probe_latency`，逾時 `PROBE_TIMEOUT` 4 秒，間隔取自 `GATEWAY_PROBE_INTERVAL_SECS`（預設 15）。結果寫進 `StatusState::record_probes`，它替每個連接埠記下 RTT 和連續失敗次數。
- 量不到的連接埠不會出現在延遲表裡，而不是 0。gateway 沒在跑時，`StatusState::latency()` 回 `None`，那一輪就不廣播。
- 廣播迴圈是後端的連接埠監控（每 5 秒一輪）。常數：`FLAP_THRESHOLD` 2（上線／離線防彈跳）、5 ms 變動門檻、6 輪 keep-alive、`DEGRADED_AFTER` 2。
- 訊息：`/ws/notifications/` 上的 `UPDATE-TUNNEL-LATENCY {latency: {"<port>": rtt_ms}}`；`/ws/tunnel_connection/{id}/` 上的 `latency_update {tunnel_id, reverse_port, rtt_ms}`；健康狀態變化是 `UPDATE-TUNNEL-HEALTH {tunnel_id, name, port, health}`。
- 健康狀態有 `online` / `degraded` / `offline` / `never`，參考 Cloudflare Tunnel 的分法。gateway 會寫 `degraded` / `recovered` 事件。列表項目帶 `health`，前端再把它和即時的連接埠狀態合起來。
- 前端的標題列徽章、訊號格和說明圖，分別是 `TerminalLatencyBadge`、`LatencyIndicator` 和 `TerminalFlow`。遠端桌面的串流統計把通道那一段叫做 `tunnel_ms`。
- 這些 payload 裡的連接埠一律是字串 key，原因見下面 int key 的故事。

</details>

<details>
<summary>Django 時代的做法</summary>

後端在 2026 年 10 月改寫成 Rust 之前，同一個點子要動用更多零件：SSH 容器裡的一支 Bash 腳本、中間的 Redis，再加上負責廣播的 Django 指令。量法本身是一樣的。

**探測**：腳本用 `ss -tln` 找出 sshd 綁在 `127.0.0.1` 上的反向通道連接埠，對每一個用 Bash 內建的 `/dev/tcp` 開 TCP 連線（不用 nc，也不用 ICMP），用 `$EPOCHREALTIME`（微秒級）計時，然後讀一個 byte：

```bash
s=$EPOCHREALTIME
exec 3<>/dev/tcp/127.0.0.1/$port
IFS= read -r -N1 _b <&3        # 等目標裝置 sshd banner 的第一個 byte
e=$EPOCHREALTIME
```

探測平行執行（`&` + `wait`），每個 4 秒逾時，所以總耗時大約是最慢的那台，而不是全部相加。這支腳本也刻意跟 3 秒一次、記錄連接埠使用狀況的取樣分開，探測再慢，都卡不住上線／離線的判定。

**交接**：腳本把結果整理成多行 `port rtt_ms`，一口氣覆寫進 Redis：

```bash
cat "$TMPDIR"/* | redis-cli -x SET ss_probe_latency
```

這個 key 是直接寫進去的，沒有 Django cache 的 key 前綴，所以 `cache.get("ss_probe_latency")` 永遠只會拿到 `None`。後端因此改用 redis-py 直連去讀，順便省掉每輪啟動一個 `redis-cli` 子程序的開銷。

**播報員**：`update_ports --loop`，一個每 5 秒跑一輪的常駐 Django management command。更早的版本是每 5 秒冷啟動一整個 Django。上面那些規則（延遲排在「沒變化就收工」之前、5 ms 門檻、6 輪 keep-alive、兩條路線）都是從它原封不動搬過來的。

**int key 事件**：channel layer 用 msgpack 序列化，新版 msgpack 預設 `strict_map_key=True`，map 的 key 是整數時，會在解包那一端丟出 `ValueError`。channels_redis 每個 worker 共用一個接收迴圈，所以只要一份延遲 payload 用了整數連接埠當 key，同一個 worker 上的所有 consumer 都會出事，包括正在用終端機的人。一個 `str(port)` 就修好了。

現在已經沒有 channel layer（通知走程序內的 hub，序列化成 JSON），但 key 照樣是字串，因為前端和 JSON 本來就這樣期待。

</details>
