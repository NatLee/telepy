# 那個「ms」是怎麼來的？—— Telepy 延遲偵測小元件

> **2026-10 更新：** 後端改寫為 Rust 後，第三、四、五節描述的「Bash 探測 → Redis → update_ports 輪詢」
> 供應鏈已被內建 SSH gateway 取代（那三節標了「Django 時代」，保留原文作為設計脈絡）。現在的樣子：
>
> - **上線 / 離線**是連線事件：gateway 收到 `tcpip-forward` 註冊或釋放時就更新 `StatusState`（`monitor/mod.rs`），不再取樣 `ss -tln`。
> - **延遲**：`Gateway::probe_latency`（`gateway/mod.rs`）每 15 秒（`GATEWAY_PROBE_INTERVAL_SECS`）對每條 forward 開一條
>   forwarded-tcpip 通道、讀裝置 sshd banner 的第一個 byte —— 同樣的量法，零子程序、零 Redis；全部平行、單一探測 4 秒逾時。
>   結果經 `StatusState::record_probes` 直接進記憶體。
> - **常駐播報員**是 `monitor/runner.rs`（每 5 秒一輪，`main.rs` 啟動）：去彈跳與節流規則原樣移植自 `update_ports`
>   （`monitor/ports.rs`：`FLAP_THRESHOLD` 2、5 ms / 6 輪 keep-alive）。
> - **量不到也是資訊**：forward 還在、但連續 2 次（`DEGRADED_AFTER`）讀不到 banner = 隧道 **degraded**（見第五節末的番外二）。
>
> 第一、二、六節描述的前端與 ping/pong 仍是現況（檔名已更新）。

> 一位 byte 的環球旅行，以及我們如何幫它計時。

你在 Telepy 終端機標題列看到的那個小徽章：

```
You ●──23ms──● Telepy ●──87ms──● Device   Σ 110ms
```

看起來人畜無害，對吧？背後其實是一條橫跨瀏覽器、Django、Redis、SSH 容器、
以及一段用 Bash 寫的「窮人版 ping」的完整供應鏈。
（那是 Django 時代；現在中間那幾站縮成一個 Rust 程序和它內建的 SSH gateway，但 byte 走的路一樣。）

---

## 一、世界被切成兩段

端到端延遲被拆成兩個 hop，各自量測、各自負責：

| Hop | 量什麼 | 誰量的 | 多久一次 |
|---|---|---|---|
| You → Telepy | 瀏覽器 ↔ 伺服器的 WebSocket RTT | 前端 `useTerminalPage` | 每 5 秒 |
| Telepy → Device | SSH gateway ↔ 遠端裝置 sshd 的隧道 RTT | 後端 `Gateway::probe_latency`（Django 時代：SSH 容器的 `probe_latency.sh`） | 每 15 秒 |

為什麼不直接量端到端？
因為量不到——瀏覽器碰不到裝置，裝置也不知道瀏覽器的存在。
所以我們採用會計師的做法：分開記帳，最後加總（Σ）。
兩個數字都是**往返** RTT，不是單程，請不要拿去跟光速吵架。

---

## 二、Hop 1：ping/pong，以及「為什麼 pong 是二進位的」

前端每 5 秒往終端機 WebSocket 丟一句：

```json
{ "action": "ping" }
```

後端（`src/backend-api/src/ws/terminal.rs`；Django 時代是 `tunnels/consumers.py`）回一個 `pong`。注意：是 **binary frame**，不是文字。

這不是工程師的行為藝術。
終端機的 `onmessage` 有一條鐵律：
> **所有文字 frame 一律用 `term.write()` 進畫面**——那是 PTY 輸出的高速公路。
如果 pong 用文字回，你的 vim 裡每 5 秒就會憑空出現一個 `pong`，像鬧鬼一樣。
改用 binary，前端一看「哦，不是字，是控制訊息」，接著看手錶、算 `Date.now() - pingSentAt`，更新 state，畫面毫髮無傷。

一個 frame 型別，救了無數次 code review。

後來這條「binary = 控制訊息」的規矩也被其他功能沿用：斷線保留的 `shell` 訊息、命令規則的 `command` 通知、
「誰在看」的 `watchers` 都是 binary JSON。前端（`lib/commandRules.ts` 的 `parseTerminalFrame`）先看內容是不是剛好 `pong`，
不是再當 JSON 解；文字 frame 照舊全進 `term.write()`。

其他幾條 WebSocket（通知、單一隧道狀態、檔案管理）的應用層 ping 回的是文字 `{"type":"pong"}`，因為它們沒有 xterm 要保護。
終端機、檔案管理、遠端瀏覽器另有伺服器端的 WebSocket Ping 心跳（`ws::Heartbeat`，20 秒一次、40 秒沒回應就斷）抓「人走了卻沒送
close」的連線 —— 那是存活偵測，不拿來量延遲。

---

## 三、Hop 2：kernel 說謊的那一天

最直覺的做法是問 kernel：`ss -ti` 本來就會回報每條 TCP 連線的 RTT，免費又即時。
我們一開始也這麼想。

然後 docker-proxy 出現了。

當裝置的 control TCP 在前面被 docker-proxy 或 L4 load balancer **終結**時，
kernel 看到的「對端」其實是同一台機器上的 proxy。於是它自信滿滿地報告：

> RTT ≈ 0ms。這位裝置就住在隔壁！

實際上裝置在幾百公里外的一間機房，透過三層 NAT 跟你揮手。用 kernel RTT 量延遲，
等於用「你家到你家大門」的距離估算「你家到火車站」——精確地測量了錯誤的東西。

### 解法：主動探測（Active Probe），主演：Bash（Django 時代）

`ssh/custom_scripts/custom-services.d/probe_latency.sh` 的做法流氓但正確：

1. 用 `ss -tln` 找出所有反向隧道埠（sshd 綁在 `127.0.0.1` 的 `-R` 轉發埠）。
2. 對每個埠，用 Bash 的隱藏技 `/dev/tcp` 直接開 TCP 連線——不用裝 nc，不用 ICMP，
   Bash 本人就是網路工具。
3. 用 `$EPOCHREALTIME`（微秒級）看手錶，然後**只讀 1 個 byte**。

```bash
s=$EPOCHREALTIME
exec 3<>/dev/tcp/127.0.0.1/$port
IFS= read -r -N1 _b <&3        # 等目標裝置 sshd banner 的第一個 byte
e=$EPOCHREALTIME
```
這 1 個 byte 是遠端裝置 sshd 的 banner（`SSH-2.0-...` 的那個 `S`）。
關鍵在於：
連線請求沿著**已建立的反向隧道**送到裝置，banner 再沿著隧道游回來——一去一回，就是一個真實的網路往返。

docker-proxy 可以騙 kernel，但它變不出裝置的 banner。
byte 必須真的跑完全程，物理不接受賄賂。

### 平行化：慢的裝置只准拖累自己

探測是平行發射的（`&` + `wait`），單一探測 4 秒逾時。一台睡死的裝置只會吃掉自己那 4 秒，不會讓其他 20 台陪葬——總耗時 ≈ 最慢的一台，而不是全部相加。

也因此，這支腳本刻意跟 3 秒週期的更新port使用狀況的監控腳本（也就是下面會提到的 update_ports）取樣**分家**：延遲探測再怎麼逾時，都不准卡住 online/offline 的判定。也就是量心跳的和量血壓的，是兩個不同的護理師。

### 現在：同一招，由 gateway 親自敲門

Rust 版的 gateway 本身就是反向隧道的另一端，所以不必再繞 `127.0.0.1` 上的埠：`Gateway::probe_latency`
（`src/backend-api/src/gateway/mod.rs`）對每條 forward 直接開一條 forwarded-tcpip 通道 —— 就是 `ssh -R` 收到外部連線時
會開的那種 —— 裝置上的 ssh client 把它接到自己的 sshd，然後一樣**只讀 1 個 byte**，計時到 0.1 ms。

- 平行（`join_all`）、單一探測 4 秒逾時（`PROBE_TIMEOUT`）、每 15 秒一輪（`GATEWAY_PROBE_INTERVAL_SECS`）。
- 量心跳和量血壓還是兩個護理師：上線 / 離線看的是 forward 註冊 / 釋放事件，探測再怎麼逾時都不會讓隧道變離線 ——
  但連續失敗會讓它變 **degraded**（第五節的番外二）。
- 前面有 L4 proxy、Docker 改寫來源位址也一樣量得準：byte 走的是隧道裡面，不是 kernel 看到的那條 TCP。

---

## 四、Redis：兩個世界的交接櫃檯（Django 時代）

腳本把結果彙整成多行 `port rtt_ms`，一口氣覆寫進 Redis：

```bash
cat "$TMPDIR"/* | redis-cli -x SET ss_probe_latency
```

後端這邊有個小陷阱：這個 key 是 `redis-cli` 裸寫的，**沒有** Django cache 的 key 前綴包裝，所以 `cache.get("ss_probe_latency")` 只會得到一個誠實的 `None`。
我們程式中因此用 redis-py 直連去讀（順便省下以前每輪 spawn 一個 `redis-cli` subprocess 的開銷）。

> 這邊讀不到就回 `None`——但你要知道「這輪取樣不可用」和「延遲是 0」是兩件事，混為一談的系統遲早會半夜叫醒你。

**現在：** 沒有交接櫃檯了。探測結果由 `StatusState::record_probes`（`monitor/mod.rs`）直接放進記憶體，量不到的 port
就不在表裡（不是 0）。「不可用」和「0」的區分還在：gateway 沒啟動時 `StatusState::latency()` 回 `None`，那一輪就不廣播。

---

## 五、update_ports --loop：常駐播報員（Django 時代；現在是 `monitor/runner.rs`）

> **現在：** `monitor::runner::run` 是同一個播報員的 Rust 版，每 5 秒一輪；下面的步驟、節流與兩路廣播都照搬，
> 只是第 1 步不必再從 Redis 收件，直接讀 `StatusState`。

`update_ports` 是個每 5 秒跑一輪的常駐 Django management command（`--loop` 模式；以前每 5 秒冷啟動一整個 Django，CPU 會準時出現心律不整的尖峰）。

每輪步驟如下：
1. 從 Redis 讀 `ss_probe_latency`，寫入 cache `ports_latency`。
2. 廣播延遲——而且**刻意排在「狀態沒變就早退」之前**
   > 不然一條穩定連線的隧道（狀態永遠不變）延遲就永遠停在第一次的數字，成為博物館展品。

### 節流：不是每次心跳都值得發新聞稿

RTT 天生會抖個幾毫秒。87、89、86、88……如果每輪都廣播，等於全體前端每 5 秒
為了一個沒人看得出差異的數字 re-render 一次。所以：

- 有任何 port 變化 **≥ 5ms**，或有 port 出生/失蹤 → 廣播。
- 否則沉默，但最多憋 6 輪就強制廣播一次（keep-alive）——照顧剛連上、錯過上一班車的前端。

### 廣播分兩路

- **主頁面**：往每位使用者推送延遲，payload 只含**該使用者有權限**的 port（擁有者 + 分享對象）。
  現在是通知 `UPDATE-TUNNEL-LATENCY {latency: {"<port>": rtt_ms}}`，走 `/ws/notifications/`。
  > 你看不到別人隧道的延遲，這是隱私，也是禮貌。
- **終端機頁**：單條隧道即時更新。Django 時代是往 web terminal 群組推；現在是 hub 的 `tunnel_update` →
  `/ws/tunnel_connection/{id}/` 上的 `latency_update {tunnel_id, reverse_port, rtt_ms}`（終端機頁和建立精靈都訂這條）。

### 本節番外：int 當 key，全站陪葬

payload 裡的 port 必須轉成**字串** key。channel layer 用 msgpack 序列化，新版預設 `strict_map_key=True`——int 當 map key 會在**解包端**炸出 `ValueError`。

更精彩的是，channels_redis 的共用接收迴圈會讓這顆雷在同一個 worker 的**任意** consumer 身上引爆，包括正在用終端機的無辜使用者：全面斷線。

> 一個 `str(port)` 的差距，介於「功能正常」和「靈異集體掉線事件」之間。

現在沒有 channel layer 了（通知走行程內的 hub，序列化成 JSON），但 key 照樣是字串 —— 前端和 JSON 本來就這麼期待。

### 番外二：量不到，也是一種量到

Rust 版多算了一件事：forward 明明還在，banner 卻一直不回來 —— 裝置的 sshd 停了、被防火牆擋了或卡住了。
隧道看起來上線，其實什麼都連不進去。所以 `StatusState::record_probes` 每輪替每個 port 記「連續失敗幾次」（成功歸零），
連續 `DEGRADED_AFTER`（2）次失敗就是 **degraded**（`monitor::health`：online / degraded / offline / never，參考 Cloudflare Tunnel）：

- gateway 寫 `degraded` / `recovered` 事件（隧道的 Logs 頁看得到）。
- runner 在「狀態沒變就早退」之前比對降級的 port，變了就推 `UPDATE-TUNNEL-HEALTH {tunnel_id, name, port, health}` 給看得到的人，
  也餵給訂了狀態事件的 webhook（各自的延遲計時）。
- 列表項目帶 `health`，前端 `lib/tunnelHealth.liveHealth` 把它和即時的 port 狀態合起來：琥珀色的點、開啟按鈕看起來像離線、
  降級時跳一個警告 toast。

一次失敗不算：裝置偶爾忙到 4 秒內回不了 banner 很正常。

---

## 六、前端：把數字穿上衣服

- **首頁**（隧道列表）用一次 REST（`/api/reverse/server/dashboard`，一個請求拿 `{tunnels, ports, latency}`；以前是三個平行請求，
  其中之一是還在的 `/api/reverse/server/status/latency`）拿一份 `{port: rtt_ms}` 墊底，之後全靠 `UPDATE-TUNNEL-LATENCY` 餵；
  取樣不可用時 `latency` 是 `{}`，也只是首頁沒數字。
- **`LatencyIndicator`**：手機訊號風格的 4 格條。<60ms 四格綠（極佳）、60–150 三格綠（良好）、150–300 兩格琥珀（普通）、>300 一格紅（不佳，建議檢查是不是把裝置部署到月球）。量不到怎辦？就用灰格 + `—`，絕不直接亂寫 0ms。
- **`TerminalLatencyBadge`**：終端機頁標題列（`TerminalHeader`）的雙 hop 流程路徑：
      `You ●──● Telepy ●──● Device`，線上跑著資料流光點動畫。You → Telepy 是這個分頁自己的 ping/pong，
      Telepy → Device 來自 `/ws/tunnel_connection/{id}/` 的 `rtt_ms`；hover / 點一下看分段明細。
- **路徑圖**：終端機頁的 info 對話框（`TerminalFlow`）在「你 ─ Telepy」與「Telepy ─ 裝置」兩段線上標同樣兩個往返時間；
  遠端桌面的串流統計（[`remote-desktop.md`](remote-desktop.md)）也把 monitor 量到的隧道延遲當成其中一段（`tunnel_ms`）。
- **健康狀態**：列表的狀態點 / 標籤分 online（綠）、degraded（琥珀）、offline（灰）、never（虛線圈），見第五節番外二。
- **防跑版強迫症**：所有會變的數字都住在固定寬度 + `tabular-nums` 的格子裡。
  `72ms` 長成 `115ms` 時版面一動不動——沒有什麼比一個因為延遲變高而跳來跳去的延遲徽章更諷刺的了。

---

## 七、總結：一個 byte 的履歷表

1. gateway 每 15 秒沿著每條反向隧道寄出一次「敲門」（一條 forwarded-tcpip 通道），掐錶等 banner 的第一個 byte 游回來。
2. 成績單直接進記憶體（`StatusState`）；連續兩次沒回來的，記成 degraded。
3. 常駐的 `monitor/runner.rs` 每 5 秒來收件，節流後透過行程內的 hub 分發給有權限的人（key 照樣是字串）。
4. 前端把它畫成訊號格與流程路徑，另外自己用 ping/pong（binary！）量瀏覽器到伺服器那段。
5. 兩段相加 ≈ 你和你的裝置之間，真實世界的距離。

（Django 時代的版本：第 1 步是 SSH 容器裡的 Bash、第 2 步是 Redis 的 `ss_probe_latency`、第 3 步是 `update_ports` + channel layer。）

設計哲學一句話：**不信任何轉述（kernel、proxy），只信親自跑完全程的 byte。**
