/**
 * 終端機按鍵編碼：把「字元 + 修飾鍵」或「特殊鍵名稱」轉成要送進 PTY 的位元組序列。
 * Terminal key encoding: turn a char + modifiers, or a named special key, into the
 * byte sequence to send into the PTY. Pure functions, no UI — easy to reason about/test.
 *
 * 參考 xterm 的預設序列（VT100/xterm）：
 *   Ctrl+@A-Z[\]^_ → 0x00–0x1F（ctrl mask 0x1F）
 *   Alt/Meta       → ESC 前綴
 *   方向/功能鍵     → CSI / SS3 序列
 */

/** 命名的特殊鍵序列（無修飾）。 */
export const SEQ = {
    esc: "\x1b",
    tab: "\t",
    enter: "\r",
    backspace: "\x7f",
    space: " ",

    up: "\x1b[A",
    down: "\x1b[B",
    right: "\x1b[C",
    left: "\x1b[D",

    home: "\x1b[H",
    end: "\x1b[F",
    pageUp: "\x1b[5~",
    pageDown: "\x1b[6~",
    insert: "\x1b[2~",
    delete: "\x1b[3~",

    f1: "\x1bOP",
    f2: "\x1bOQ",
    f3: "\x1bOR",
    f4: "\x1bOS",
    f5: "\x1b[15~",
    f6: "\x1b[17~",
    f7: "\x1b[18~",
    f8: "\x1b[19~",
    f9: "\x1b[20~",
    f10: "\x1b[21~",
    f11: "\x1b[23~",
    f12: "\x1b[24~",
} as const;

export type SeqName = keyof typeof SEQ;

/** 方向鍵在 Ctrl 修飾下的序列（跳詞用），對應 xterm 的 modifyOtherKeys。 */
const CTRL_ARROW: Partial<Record<SeqName, string>> = {
    up: "\x1b[1;5A",
    down: "\x1b[1;5B",
    right: "\x1b[1;5C",
    left: "\x1b[1;5D",
};

/** 方向鍵在 Alt 修飾下的序列。 */
const ALT_ARROW: Partial<Record<SeqName, string>> = {
    up: "\x1b[1;3A",
    down: "\x1b[1;3B",
    right: "\x1b[1;3C",
    left: "\x1b[1;3D",
};

export interface KeyModifiers {
    ctrl?: boolean;
    alt?: boolean;
}

/**
 * 編碼一個「可見字元」按鍵（單一字元）。
 * - Ctrl：對 @A-Z[\]^_ 套 0x1F 遮罩（涵蓋 Ctrl+C=0x03、Ctrl+[=ESC、Ctrl+Space=NUL）。
 * - Alt/Meta：加 ESC 前綴。
 * Ctrl 與 Alt 可同時作用（例如 Alt+Ctrl+C → ESC + 0x03）。
 */
export function encodeChar(char: string, mods: KeyModifiers = {}): string {
    if (!char) return "";
    let out = char;

    if (mods.ctrl && char.length === 1) {
        const code = char.toUpperCase().charCodeAt(0);
        // 0x40('@')–0x5F('_') 映射到 0x00–0x1F；其餘字元 Ctrl 無定義，維持原樣。
        if (code >= 0x40 && code <= 0x5f) {
            out = String.fromCharCode(code & 0x1f);
        } else if (code === 0x20) {
            out = "\x00"; // Ctrl+Space → NUL
        }
    }

    if (mods.alt) {
        out = "\x1b" + out;
    }

    return out;
}

/**
 * 編碼一個「命名特殊鍵」。
 * - 方向鍵在 Ctrl/Alt 下改用對應的 CSI 修飾序列。
 * - 其它特殊鍵在 Alt 下加 ESC 前綴。
 */
export function encodeSeq(name: SeqName, mods: KeyModifiers = {}): string {
    if (mods.ctrl && CTRL_ARROW[name]) {
        return CTRL_ARROW[name]!;
    }
    if (mods.alt && ALT_ARROW[name]) {
        return ALT_ARROW[name]!;
    }

    let out: string = SEQ[name];
    // 對非方向的特殊鍵，Alt 仍以 ESC 前綴表示（例如 Alt+Backspace 刪一個詞）。
    if (mods.alt && !ALT_ARROW[name]) {
        out = "\x1b" + out;
    }
    return out;
}
