# Vendored KasmVNC web client (noVNC fork)

- 來源：[kasmtech/noVNC](https://github.com/kasmtech/noVNC) 的 `v1.3.0` tag（commit `e7395e52`），也就是 KasmVNC server 1.4.0 內附的 client 版本（server 內的 package.json 同樣是 `@kasmtech/novnc` 1.3.0）。
- 授權：MPL-2.0（見 `LICENSE.txt`）；`vendor/pako` 是 MIT + Zlib（見它自己的 `LICENSE`）。

## 為什麼直接放原始碼，不用 npm 套件？

KasmVNC 跟一般的 `@novnc/novnc` 不相容，協定已經分岔，只能用 Kasm 自家 fork 的 client。

那個 fork 沒有發佈到 npm，改用 git 依賴的話，容器建置時又得有 git 和外網。直接把原始碼放進來最穩。

## 拿了哪些、改了什麼

- `core/` 與 `vendor/pako/`：原樣複製，一行都沒改。
- `app/ui.js`：這是我們自己寫的 shim，不是上游的檔案。上游的鍵盤模組 import 它，只是為了讀 `UI.rfb.translateShortcuts`；shim 提供一個可以改的 singleton，由遠端瀏覽器面板把 RFB 實例掛上去。
- QOI 解碼器以 Web Worker 加 wasm 執行，只有 `rfb.enableQOI = true` 而且瀏覽器有 `SharedArrayBuffer`（需要 COOP/COEP）時才會啟動。我們沒有啟用，檔案只是為了完整而保留。

## 用法

```ts
import RFB from "@/vendor/kasm-novnc/core/rfb.js";
import KasmUI from "@/vendor/kasm-novnc/app/ui.js";

const rfb = new RFB(screenEl, keyboardInputEl, openWebSocket, { shared: true });
KasmUI.rfb = rfb;   // translateShortcuts 要靠這行才會生效
```

注意第二個參數 `touchInput`：Kasm fork 的簽名是 `(target, touchInput, urlOrChannel, options)`，比原版多一個。這裡要傳一個可以聚焦的隱形 `<textarea>`，中文輸入法的組字事件全靠它。

### 嵌入時一定要做的兩件事

上游把這些留給它自家的 `app/ui.js` 處理，core 自己不會做。

1. 一定要設 `rfb.mouseButtonMapper`。它預設是 `null`，而每個滑鼠事件都會先呼叫 `.get(ev.button)`。不設的話，所有滑鼠事件都會丟 TypeError，滑鼠等於完全沒用。對應關係照上游的預設：0 → LEFT、1 → MIDDLE、2 → RIGHT、3 → BACK、4 → FORWARD。
2. 每次 `compositionend` 之後，延後呼叫 `keyboard._keyboardInputReset()`（組字進行中時跳過）。鍵盤模組靠比對 textarea 的值跟上一次的值，來決定要送出什麼；而 `compositionend` 和最後一個 input 事件的先後順序，會因瀏覽器和輸入法而不同。兩者一旦對不上，下一輪組字就會把舊的字整段重送：輸入「測試」變成「測試測試」，第三次變三倍。歸零之後，每一輪組字都從乾淨的狀態開始。

## 升級方式

1. 先確認 kasm-browser image 裡的 KasmVNC server 版本。
2. 查那個 server 內附的 client 版本（它的 package.json）。
3. 從 kasmtech/noVNC 對應的 tag 重新複製 `core/` 與 `vendor/pako/`。
4. 保留這份 README 和 `app/ui.js` shim，再確認鍵盤模組使用 shim 的方式沒有改變。
