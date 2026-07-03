# 我只是想遠端開個瀏覽器

## ——一場 KasmVNC 遷移的踩雷實錄

> 從一個 2010 年的 HTTP header,到殭屍行程圍城:
> 七個 commit、四十五個測試、與若干次「這次真的好了」的完整記錄。

---

## 序章:交接文件說「就差最後一哩」

Telepy 有個功能叫 remote browser:`ssh -D` 建一條 SOCKS 隧道,容器裡開一隻
Chromium 走那條隧道上網,再把桌面用 VNC 串流到網頁上。效果是「用目標機器的
IP 上網」,人肉操作,真桌面,真瀏覽器。

原本用 TigerVNC + stock noVNC,能動。但為了更好的動態編碼、seamless 剪貼簿、
中文輸入,決定升級成 KasmVNC。這裡有一個改變一切的事實:

**KasmVNC 已經脫離 RFB 規範。** 它只開 WebSocket、不開傳統 VNC 埠,而且要用
它自家 fork 過的 web client——stock noVNC 連上去就是一片黑。所以後端要做
WS↔WS 中繼,前端要整組換掉。

我接手時,交接文件寫著:後端完成、測試全綠,「只剩」驗證連線跟換前端。

有經驗的人都知道,「只剩」是軟體工程裡最貴的兩個字。

---

## 第一章:2026 年,一個 2010 年的 header 攔住了我

交接文件預言的最後一雷是密碼檔路徑(`$HOME` 在 build 時和 runtime 不是同一個,
於是任何帳密都 401)。修法已備好,rebuild、驗證——帳密對了。

然後 `/websockify` 給了我一個 404。

不是 401(帳密錯),是 404(查無此人)。改密碼是沒有用的,這時候唯一正確的
動作是去看 server 自己的 log,而它其實用 INFO 等級把答案印在臉上:

```
websocket 0: /websockify request failed websocket checks,
             missing Sec-WebSocket-Origin header
```

`Sec-WebSocket-Origin`。這是 WebSocket 還在 Hixie 草案時代(約 2010 年)的
header,RFC 6455 在 2011 年就把它改名成 `Origin` 了。瀏覽器不送這個東西已經
十五年,Python 的 `websockets` 更是聽都沒聽過。但 KasmVNC 的 websocket 檢查:
沒帶?404,再見。

修復:在 upgrade 請求裡補上這個 header(值隨便,它不驗)。一行。

考古時間:遠遠不只一行。

> **雷 #1** —— 當 401 變成 404,別再猜密碼了。server 的 log
> 通常已經把答案印出來,只是沒人去看。

---

## 第二章:器官移植——vendor 別人家的 noVNC fork

前端要換成 KasmVNC 自家的 client。問題:`@kasmtech/novnc` 沒有發佈到 npm,
image 裡躺的是 vite build 完的成品(不可 import)。於是從 GitHub 的 v1.3.0
tag(對齊 server 1.4.0 內建的 client 版本)把 `core/` 原封不動搬進
`src/vendor/`。

然後開始收驚喜:

**驚喜一:** constructor 比 stock 多一個參數——
`new RFB(target, touchInput, urlOrChannel, options)`。那個 `touchInput` 是一個
要「可聚焦但看不見」的 textarea,中文輸入的 composition 事件全靠它。文件?
文件就是去讀他們自家 `vnc.html` 怎麼寫的。

**驚喜二:** `core/input/keyboard.js` 裡面 `import UI from '../../app/ui.js'`
——core 模組回頭 import 整包應用程式 UI,只為了讀一個 boolean
(`UI.rfb.translateShortcuts`)。解法:寫一個九行的 shim 冒充整個 app。
史上最划算的器官捐贈。

**驚喜三:** QOI 解碼器是 16 條 Web Worker + WebAssembly 的豪華套餐。好在它
需要 `SharedArrayBuffer` 而且要顯式開啟才會醒。讓它睡。

**驚喜四:** `util/browser.js` 在 import 的**當下**就伸手摸 `document`,
Next.js 的 SSR prerender 會當場爆炸。解法:dynamic import,順便把 700KB
的 client 從首屏 bundle 裡切出去。工程師稱之為「因禍得福」,PM 稱之為
「本來就該做的效能優化」。

> **雷 #2** —— vendor 一個「只設計給自家 UI 用」的 library,
> 就是器官移植:器官是好的,排斥反應要自己吃藥。把隱藏需求寫進
> vendor README,下一個升級的人會為你立牌位。

---

## 插曲:薛丁格的 tailwind-merge

`npm run build`:

```
Module not found: Can't resolve 'tailwind-merge'
```

`ls node_modules/tailwind-merge`:在。`npm ls`:好好的。`require.resolve`:
找得到。Turbopack:找不到。

真相:`dist/` 裡的 ESM bundle(`bundle-mjs.mjs`)憑空消失,CJS 版還在。
Node 走 `require` 條件——解析成功;Turbopack 走 `import` 條件——指向一個
不存在的檔案。同一個套件,同時存在又不存在,取決於誰在觀測。

解法:`rm -rf node_modules && npm ci`。宇宙重開機,波函數塌縮,build 過了。

> **雷 #3** —— 當兩個工具對「這個檔案存在嗎」意見分歧,
> 先懷疑 node_modules 的屍塊,不要懷疑人生。

---

## 第三章:滑鼠之死

第一波人肉測試回報:畫面有了,鍵盤能打,**滑鼠完全沒反應,連點都不能點**。

鍵盤活著滑鼠死了——這個不對稱直接排除了網路和權限,兇手必在 client 端的
滑鼠路徑上。然後就找到了這兩行的組合技:

```js
// rfb.js:206
this.mouseButtonMapper = null;

// rfb.js:1631,每一個 mousedown/mouseup/mousemove 都會經過:
const mappedButton = this.mouseButtonMapper.get(ev.button);
```

也就是說,這個 client 的**出廠預設**,是對每一次滑鼠事件擲出一顆
`TypeError: Cannot read properties of null`。它能在官方場景動,是因為他們
自家的 `app/ui.js` 會在外面注入一個 mapper——這件事,理所當然地,沒有寫在
任何文件裡。

修復:照他們 UI 的預設值注入(0→左鍵、1→中鍵、2→右鍵、3→上一頁、4→下一頁)。
滑鼠復活。

---

## 第四章:IME 復讀機

第二個回報更有戲劇性:輸入「測試」,遠端出現「測試」。再輸入一次,出現
「**測試測試**」。第三次,「**測試測試測試**」。輸入法成精,學會了等差數列。

原理:`keyboard.js` 靠「textarea 目前值 vs 上次的基準值」做差分,決定要送
哪些字。而 `compositionend` 和最後一個 `input` 事件誰先誰後,是瀏覽器 ×
輸入法的排列組合題。基準一旦脫鉤,下一輪組字就把整段舊值從頭重播——於是
第 N 次輸入送出 N 份。

重現這種 bug,開瀏覽器按 F12 是下下策。上策:`keyboard.js` 的 handler 只讀
`e.target.value` 和幾個旗標,**假事件可以走真邏輯**——寫一個 Node harness
直接驅動它,十秒跑完四種事件順序:

```
A: 正常 Chrome 順序           → 測試測試測試   (3 次組字,正確)
C: 基準脫鉤(缺陷態,無修法)  → 測試測試測試   (2 次組字,復讀!)
D: 基準脫鉤 + 修法            → 測試測試測試   (3 次組字,正確)
```

修法:每次 `compositionend` 之後,把 textarea 的值和差分基準**一起**歸零
(deferred,讓同輪殘餘的 input 事件先跑完;組字進行中則跳過)。從此每輪組字
都從乾淨狀態開始,任何事件順序都復讀不起來。

> **雷 #4** —— 瀏覽器行為難重現?把邏輯抽出來在 Node 裡驅動。
> 假事件走真程式碼,比在真瀏覽器裡瞎按快十倍。

---

## 第五章:開兩個分頁,兩敗俱傷

第三個回報:「開了第二個頁面執行這個功能,會失效。」而且不是第二個壞——
是**兩個一起壞**。

log 裡有一行話,一行道盡所有:

```
Opening in existing browser session.
```

當初為了讓 cookie 跨 session 累積、少跳 CAPTCHA,同一個目標機器的 session
共用同一個 Chromium profile 目錄。而 Chromium 對每個 profile 目錄有一把
SingletonLock:第二隻 chromium 啟動時發現同 profile 已有人在用,就自動降格
成**快遞員**——通知第一隻「幫我開個分頁」,然後光榮退出。

於是:session 2 的桌面上沒有瀏覽器(它的 chromium 進門就走了),分頁卻開到
了 session 1 的桌面上(還走錯 proxy),session-manager 看到行程退出開始收攤,
連鎖反應,一屍兩命。

這時使用者說:「另外,我需要不保留歷史記錄。」

有時候需求變更是災難,有時候需求變更是救贖。**每個 session `mkdtemp` 一個
專屬 profile、停止時整個刪掉**——隱私需求(不留歷史)和併發 bug
(SingletonLock)一次解決。順帶一提,「不指定 profile 目錄」也是不行的:
那樣兩隻 chromium 會一起用 `~/.config/chromium`,鎖還是同一把。

> **雷 #5** —— Chromium 的 `--user-data-dir` 不是建議,是隔離邊界。
> 併發 = 每人一間,沒有例外。

---

## 第六章:黃色警告條與不死鳥

「You are using an unsupported command-line flag: --no-sandbox. Stability
and security will suffer.」——每個 session 頂著一條黃色警告,觀感很差。

先試正道:把 `--no-sandbox` 拿掉、開真的 sandbox。Docker 立刻表態:

```
$ su browsertest -c "unshare -U true"
unshare: unshare failed: Operation not permitted
```

預設 seccomp profile 封殺 unprivileged user namespace;setuid sandbox helper
也裝不上、缺 capability。要開真 sandbox 得在 compose 掛自訂 seccomp
profile——那是另一個 PR 的人生。今天的答案是 `--test-type`:Chromium 官方
唯一認證的遮羞布,專門用來蓋掉「unsupported flag」警告條。

「另外,chrome 被關掉的話,要可以再開。」——這個簡單:

```sh
while :; do chromium ...; sleep 2; done
```

不死鳥。使用者關掉、當掉,兩秒後原地復活,同 profile 同 proxy。session
停止時整個 process group 一起收,不會詐屍。

---

## 插曲二:我殺了我自己(以及殭屍圍城)

驗證不死鳥的時候,鬧劇開演。

**第一幕:我殺錯人。** `pkill -o -f "chromium --no-sandbox"`——`-f` 匹配
整條命令列,而 respawn 迴圈那隻 `sh` 的命令列裡就包含這串字;`-o` 挑最老的,
而 sh 比 chromium 老。於是我親手殺了保姆,然後對著「小孩還活著」的畫面宣布
重生機制運作正常。

**第二幕:殭屍假警報。** 停掉 session 後檢查:「chromium 還活著!」半天後
才發現,`docker compose exec sh -c '... pgrep -f "chromium --no-sandbox" ...'`
——pattern 就寫在外層 sh 自己的命令列裡,pgrep 永遠能找到「一隻」。兇手是
量測儀器本身。`ps ax | grep "[c]hromium"` 這個老掉牙的括號技巧,每一代
工程師都要親自被咬一次才會信。

**第三幕:真的有 bug。** 鬧劇裡也淘出兩隻真傢伙:

1. `_term` 用 `os.getpgid(p.pid)` 找 process group——如果 group leader
   (那隻 sh)已經先死,`getpgid` 直接 raise,整組 kill 被靜默跳過,孤兒
   chromium 逍遙法外。修法:直接 `killpg(p.pid)`。`start_new_session=True`
   保證 pgid == pid,而 **process group 只要還有任何成員活著就存在**,
   leader 死了照殺不誤。

2. 殭屍圍城:session-manager 是容器的 PID 1,卻不幫別人的小孩收屍——被
   reparent 過來的 chromium 孤兒全變 defunct,排隊排了二十個。compose 加一行
   `init: true`,請 tini 出任 PID 1 兼殯葬業者。殭屍歸零。

> **雷 #6** —— 你的量測方法也可能是 bug。先驗刀,再驗屍。
> `pgrep -f` 的自我匹配是成年禮,`ps | grep "[b]racket"` 是老人的智慧。

---

## 終章:戰果統計

| 項目 | 數量 |
|---|---|
| Commits | 7 |
| 測試(全綠) | 45(後端 34 + session-manager 11) |
| 2010 年的 header | 1 |
| 出廠即 TypeError 的 null | 1 |
| 復讀機 | 1(已下崗) |
| SingletonLock | 1(已繳械) |
| 被我誤殺的行程 | ≥1(對不起,保姆) |
| 假警報 | 2(皆為 pgrep 自我匹配) |
| 殭屍 | 20 → 0 |

### 帶得走的教訓

1. **交接文件是傳家寶。** 別人踩過的雷寫下來,你就只需要踩新的雷。
   本次全部的雷,也都已經寫回去了。
2. **401 和 404 是不同的問題。** 而 server log 通常早就把答案印出來了。
3. **Vendor 別人的 library 要驗屍。** 找到隱藏需求(那顆 null mapper、
   compositionend 歸零)就寫進 vendor README,功德無量。
4. **假事件走真程式碼。** 瀏覽器難重現的行為,抽出來在 Node 裡驅動。
5. **`--user-data-dir` 是隔離邊界**,不是效能選項。
6. **量測儀器要先校正。** pgrep/pkill `-f` 的自我匹配,人人有獎。
7. **容器裡的 Chromium sandbox** 不是你想開就能開;但警告條可以官方地蓋掉。

所謂遷移,就是把「應該可以直接用」翻譯成七個 commit 的過程。

至少現在:滑鼠會動,中文不復讀,兩個分頁和平共處,chrome 殺不死,殭屍有人
收,警告條下台一鞠躬。深夜的 `docker compose logs -f` 靜靜滾動,歲月靜好。

---

*Telepy remote-browser。技術細節見 `docs/remote-browser.md` 與
`src/frontend/src/vendor/kasm-novnc/README.md`。*
