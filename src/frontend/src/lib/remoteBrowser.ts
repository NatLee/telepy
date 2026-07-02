/**
 * Remote Browser (CDP screencast) WebSocket client.
 *
 * 對應後端 tunnels/consumers.py 的 RemoteBrowserConsumer:
 *  - 連上 /ws/remote-browser/<session_id>/ 後,第一則訊息即認證 {type:"auth", token}
 *    (沿用 FirstMessageAuthConsumer 慣例:JWT 只在 payload,不進 URL)。
 *  - 收:{type:"frame", data:<base64 jpeg>} 畫面幀、{type:"tabs", tabs:[...]} 分頁列。
 *  - 送:滑鼠/鍵盤/文字/導覽/分頁/resize 事件。
 *
 * 鍵盤:CDP Input.dispatchKeyEvent 需要 windowsVirtualKeyCode/code/key/text。這裡用一份
 * 美式鍵盤 keymap 從 KeyboardEvent 產生這些欄位(取自 puppeteer USKeyboardLayout 的常用子集)。
 * 中文等 IME 輸入不走 keydown,而是攔 compositionend 的最終字串,以 {type:"text"} 送出,
 * 後端用 Input.insertText 落字(Phase 0 G7 已驗證)。
 */
import { getWsOrigin } from "@/lib/wsCommon";

export interface TabInfo {
    target_id: string;
    title: string;
    url: string;
    active: boolean;
}

export interface RemoteBrowserClientOptions {
    wsPath: string;                          // e.g. /ws/remote-browser/<id>/
    getToken: () => string | null;
    onFrame: (dataUrl: string) => void;      // ready-to-draw data: URL
    onTabs?: (tabs: TabInfo[]) => void;
    onOpen?: () => void;
    onClose?: (code: number) => void;
    onError?: (msg: string) => void;
}

type KeyFields = {
    windowsVirtualKeyCode?: number;
    code?: string;
    key?: string;
    text?: string;
    unmodifiedText?: string;
};

// CDP modifier 位元:Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8
export function cdpModifiers(e: {
    altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean;
}): number {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

// 常見鍵 → windowsVirtualKeyCode。字母/數字直接由字碼推,其餘查表。
const VK: Record<string, number> = {
    Backspace: 8, Tab: 9, Enter: 13, ShiftLeft: 16, ShiftRight: 16,
    ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18,
    Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Delete: 46, MetaLeft: 91, MetaRight: 92,
    Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190,
    Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220,
    BracketRight: 221, Quote: 222,
    Digit0: 48, Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52,
    Digit5: 53, Digit6: 54, Digit7: 55, Digit8: 56, Digit9: 57,
    F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
    F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};

/** 由瀏覽器 KeyboardEvent 推出 CDP 需要的鍵欄位。/ Map a KeyboardEvent to CDP key fields. */
export function keyEventToCdp(e: {
    key: string; code: string; keyCode?: number;
}): KeyFields {
    let vk = VK[e.code];
    if (vk === undefined && e.code.startsWith("Key") && e.code.length === 4) {
        vk = e.code.charCodeAt(3);                 // KeyA..KeyZ -> 65..90
    }
    if (vk === undefined && e.code.startsWith("Numpad") && /Numpad\d/.test(e.code)) {
        vk = 96 + Number(e.code.slice(6));          // Numpad0..9 -> 96..105
    }
    if (vk === undefined && typeof e.keyCode === "number" && e.keyCode) {
        vk = e.keyCode;
    }
    const fields: KeyFields = { code: e.code, key: e.key };
    if (vk !== undefined) fields.windowsVirtualKeyCode = vk;
    // 可列印字元才帶 text(讓 CDP 產生實際輸入);功能鍵(key 長度 > 1)不帶。
    if (e.key.length === 1) {
        fields.text = e.key;
        fields.unmodifiedText = e.key;
    }
    return fields;
}

export class RemoteBrowserClient {
    private ws: WebSocket | null = null;
    private opts: RemoteBrowserClientOptions;
    private closedByUs = false;

    constructor(opts: RemoteBrowserClientOptions) {
        this.opts = opts;
    }

    connect() {
        const url = `${getWsOrigin()}${this.opts.wsPath}`;
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.onopen = () => {
            ws.send(JSON.stringify({ type: "auth", token: this.opts.getToken() }));
            this.opts.onOpen?.();
        };
        ws.onmessage = (ev) => {
            if (typeof ev.data !== "string") return;
            let msg: any;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.type === "frame") {
                this.opts.onFrame(`data:image/jpeg;base64,${msg.data}`);
            } else if (msg.type === "tabs") {
                this.opts.onTabs?.(msg.tabs || []);
            }
        };
        ws.onerror = () => this.opts.onError?.("WebSocket error");
        ws.onclose = (ev) => { if (!this.closedByUs) this.opts.onClose?.(ev.code); };
    }

    private send(obj: unknown) {
        const ws = this.ws;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    }

    // --- input ------------------------------------------------------------
    sendMouse(event: string, x: number, y: number, extra: Record<string, unknown> = {}) {
        this.send({ type: "mouse", event, x: Math.round(x), y: Math.round(y), ...extra });
    }
    sendKey(event: "keyDown" | "keyUp", fields: KeyFields, modifiers: number) {
        this.send({ type: "key", event, modifiers, ...fields });
    }
    sendText(text: string) {
        if (text) this.send({ type: "text", text });
    }
    navigate(url: string) { this.send({ type: "navigate", url }); }
    back() { this.send({ type: "navigate", action: "back" }); }
    forward() { this.send({ type: "navigate", action: "forward" }); }
    reload() { this.send({ type: "navigate", action: "reload" }); }
    resize(width: number, height: number) {
        this.send({ type: "resize", width: Math.round(width), height: Math.round(height) });
    }
    // --- tabs -------------------------------------------------------------
    newTab() { this.send({ type: "tab", action: "new" }); }
    switchTab(targetId: string) { this.send({ type: "tab", action: "switch", target_id: targetId }); }
    closeTab(targetId: string) { this.send({ type: "tab", action: "close", target_id: targetId }); }
    listTabs() { this.send({ type: "tab", action: "list" }); }

    close() {
        this.closedByUs = true;
        try { this.ws?.close(); } catch { /* noop */ }
        this.ws = null;
    }
}
