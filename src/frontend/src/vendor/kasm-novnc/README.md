# Vendored KasmVNC web client (noVNC fork)

- Source: https://github.com/kasmtech/noVNC, tag `v1.3.0` (commit `e7395e52`) —
  the client version shipped inside KasmVNC server 1.4.0 (`/usr/share/kasmvnc/www`
  的 package.json 同為 `@kasmtech/novnc` 1.3.0)。
- License: MPL-2.0(見 `LICENSE.txt`);`vendor/pako` 為 MIT+Zlib(見其 `LICENSE`)。

## 為什麼 vendor,而不是 npm 套件?

KasmVNC **不相容 stock `@novnc/novnc`**(協定已分岔),必須用它自家 fork 的 client。
該 fork 沒發佈到 npm registry,git dependency 又需要容器內有 git;直接 vendor 原始碼
最穩(Docker build 不需外網 git)。

## 拿了哪些、動了什麼

- `core/`、`vendor/pako/`:**原樣複製,零修改**。
- `app/ui.js`:**我們自己的 shim**(非上游檔案)。上游 `core/input/keyboard.js` import
  `../../app/ui.js` 只為讀 `UI.rfb.translateShortcuts`;shim 提供可變 singleton,
  由 `RemoteBrowserPanel` 掛上 RFB 實例。
- `core/decoders/qoi/`:QOI 解碼器以 **Web Worker + wasm** 執行(頁面相對路徑
  `core/decoders/qoi/decoder.js`),只有 `rfb.enableQOI = true` 且瀏覽器有
  `SharedArrayBuffer`(需 COOP/COEP)才會啟動 —— 我們不啟用,檔案僅為完整性保留。

## 用法(見 RemoteBrowserPanel.tsx)

```ts
import RFB from "@/vendor/kasm-novnc/core/rfb.js";
import KasmUI from "@/vendor/kasm-novnc/app/ui.js";

const rfb = new RFB(screenEl, keyboardInputEl, openWebSocket, { shared: true });
KasmUI.rfb = rfb;   // translateShortcuts 生效的前提
```

注意第二個參數 `touchInput`(上游 fork 的簽名是 `(target, touchInput, urlOrChannel,
options)`,比 stock 多一個):要傳一個**可聚焦**的隱形 `<textarea>`,IME(中文輸入)
composition 事件靠它。

## 升級方式

對齊 kasm-browser image 內 KasmVNC server 版本 → 查 `/usr/share/kasmvnc/www/package.json`
的 client 版本 → 從 kasmtech/noVNC 對應 tag 重新複製 `core/` 與 `vendor/pako/`,
保留本 README 與 `app/ui.js` shim,再確認 keyboard.js 對 shim 的用法沒變。
