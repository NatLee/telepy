# 那個「ms」是怎麼來的？—— Telepy 延遲偵測小元件

> 一位 byte 的環球旅行，以及我們如何幫它計時。

你在 Telepy 終端機標題列看到的那個小徽章：

```
You ●──23ms──● Telepy ●──87ms──● Device   Σ 110ms
```

看起來人畜無害，對吧？背後其實是一條橫跨瀏覽器、Django、Redis、SSH 容器、
以及一段用 Bash 寫的「窮人版 ping」的完整供應鏈。

---

## 一、世界被切成兩段

端到端延遲被拆成兩個 hop，各自量測、各自負責：

| Hop | 量什麼 | 誰量的 | 多久一次 |
|---|---|---|---|
| You → Telepy | 瀏覽器 ↔ 伺服器的 WebSocket RTT | 前端 `useTerminalPage` | 每 5 秒 |
| Telepy → Device | SSH 伺服器 ↔ 遠端裝置的隧道 RTT | SSH 容器的 `probe_latency.sh` | 每 15 秒 |

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

後端（`tunnels/consumers.py`）回一個 `b'pong'`。注意：是 **binary frame**，不是文字。

這不是工程師的行為藝術。
終端機的 `onmessage` 有一條鐵律：
> **所有文字 frame 一律用 `term.write()` 進畫面**——那是 PTY 輸出的高速公路。
如果 pong 用文字回，你的 vim 裡每 5 秒就會憑空出現一個 `pong`，像鬧鬼一樣。
改用 binary，前端一看「哦，不是字，是控制訊息」，接著看手錶、算 `Date.now() - pingSentAt`，更新 state，畫面毫髮無傷。

一個 frame 型別，救了無數次 code review。

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

### 解法：主動探測（Active Probe），主演：Bash

`ssh/custom_scripts/custom-services.d/probe_latency.sh` 的做法流氓但正確：

1. 用 `ss -tln` 找出所有反向隧道埠（sshd 綁在 `127.0.0.1` 的 `-R` 轉發埠）。
2. 對每個埠，用 Bash 的隱藏技 `/dev/tcp` 直接開 TCP 連線——不用裝 nc，不用 ICMP，
   Bash 本人就是網路工具。
3. 用 `$EPOCHREALTIME`（微秒級）看手錶，然後**只讀 1 個 byte**。

``bash
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

---

## 四、Redis：兩個世界的交接櫃檯

腳本把結果彙整成多行 `port rtt_ms`，一口氣覆寫進 Redis：

``
cat "$TMPDIR"/* | redis-cli -x SET ss_probe_latency
``

後端這邊有個小陷阱：這個 key 是 `redis-cli` 裸寫的，**沒有** Django cache 的 key 前綴包裝，所以 `cache.get("ss_probe_latency")` 只會得到一個誠實的 `None`。
我們程式中因此用 redis-py 直連去讀（順便省下以前每輪 spawn 一個 `redis-cli` subprocess 的開銷）。

> 這邊讀不到就回 `None`——但你要知道「這輪取樣不可用」和「延遲是 0」是兩件事，混為一談的系統遲早會半夜叫醒你。

---

## 五、update_ports --loop：常駐播報員

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

- **主頁面**：往每位使用者的群組推送延遲，payload 只含**該使用者有權限**的 port。
  > 你看不到別人隧道的延遲，這是隱私，也是禮貌。
- **終端機頁**：往 web terminal 群組推送延遲，單條隧道即時更新。

### 本節番外：int 當 key，全站陪葬

payload 裡的 port 必須轉成**字串** key。channel layer 用 msgpack 序列化，新版預設 `strict_map_key=True`——int 當 map key 會在**解包端**炸出 `ValueError`。

更精彩的是，channels_redis 的共用接收迴圈會讓這顆雷在同一個 worker 的**任意** consumer 身上引爆，包括正在用終端機的無辜使用者：全面斷線。

> 一個 `str(port)` 的差距，介於「功能正常」和「靈異集體掉線事件」之間。

---

## 六、前端：把數字穿上衣服

- **首頁**用 REST（`/api/reverse/server/status/latency`）拿一份 `{port: rtt_ms}` 墊底，之後全靠 WebSocket 餵，這個端點掛了也只是首頁沒數字。
- **`LatencyIndicator`**：手機訊號風格的 4 格條。<60ms 四格綠（極佳）、60–150 三格黃（良好）、150–300 兩格橙（普通）、>300 一格紅（不佳，建議檢查是不是把裝置部署到月球）。量不到怎辦？就用灰格 + `—`，絕不直接亂寫 0ms。
- **`TerminalLatencyBadge`**：終端機頁的雙 hop 流程路徑：
      `You ●──● Telepy ●──● Device`，線上跑著資料流光點動畫
- **防跑版強迫症**：所有會變的數字都住在固定寬度 + `tabular-nums` 的格子裡。
  `72ms` 長成 `115ms` 時版面一動不動——沒有什麼比一個因為延遲變高而跳來跳去的延遲徽章更諷刺的了。

---

## 七、總結：一個 byte 的履歷表

1. Bash 每 15 秒沿著每條反向隧道寄出一次「敲門」，掐錶等 banner 的第一個 byte 游回來。
2. 成績單以 `port rtt_ms` 寫進 Redis（`ss_probe_latency`）。
3. 常駐的 `update_ports` 每 5 秒來收件，節流後透過 channel layer 分發給有權限的人（key 記得轉字串，除非你想體驗集體掉線）。
4. 前端把它畫成訊號格與流程路徑，另外自己用 ping/pong（binary！）量瀏覽器到伺服器那段。
5. 兩段相加 ≈ 你和你的裝置之間，真實世界的距離。

設計哲學一句話：**不信任何轉述（kernel、proxy），只信親自跑完全程的 byte。**

