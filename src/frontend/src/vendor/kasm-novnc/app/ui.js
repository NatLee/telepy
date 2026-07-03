/*
 * Shim for the KasmVNC noVNC fork's `app/ui.js`.
 *
 * core/input/keyboard.js 只用到 `UI.rfb.translateShortcuts`(macOS Cmd→Ctrl 快捷鍵翻譯);
 * 我們不 vendor 整個 app UI,改提供這個可變 singleton。RemoteBrowserPanel 建立 RFB 後把
 * 實例掛上來(KasmUI.rfb = rfb),斷線時清掉,translateShortcuts 即照常生效。
 */
/** @type {{ rfb: any }} */
const KasmUI = { rfb: null };
export default KasmUI;
