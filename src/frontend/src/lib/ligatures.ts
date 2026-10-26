/**
 * 網頁終端機的程式連字(純函式部分;套到 xterm 的在 lib/xterm.ts 的 applyLigatures)。
 *
 * 為什麼不用 @xterm/addon-ligatures:它在瀏覽器裡讀字型的方式是 Local Font Access API(只有 Chrome、要跳
 * 「允許查看已安裝字型」的權限、而且只看得到「安裝在系統上」的字型),我們用 @font-face 提供的字型它永遠讀不到
 * GSUB;讀不到時它就退回一份固定的連字序列清單 + 在 terminal.element 設 `font-feature-settings: "calt" on`。
 * 這裡做的就是那條退路,少掉 200 KB 的 opentype.js 與權限提示。xterm 5.3 的 DOM 畫法把同樣式的相鄰格子併成一個
 * span,所以真正把字連起來的是瀏覽器自己的塑形;character joiner 的工作只是讓這些序列即使被游標 / 選取切到也留在
 * 同一個 span,並把游標畫在整個連字上。letter-spacing(xterm 用它對齊格寬)會讓瀏覽器關掉 calt,所以 `"calt" on`
 * 一定要明寫;關閉時也明寫 off,免得某些字型預設就連。
 *
 * Programming ligatures for the web terminal (pure part; lib/xterm.ts applies it to xterm).
 * Why not @xterm/addon-ligatures: in a browser it reads fonts through the Local Font Access API (Chrome only,
 * a "see installed fonts" permission prompt, installed fonts only), so a font we serve with @font-face never
 * yields its GSUB table; without it the addon falls back to a fixed list of sequences plus
 * `font-feature-settings: "calt" on` on terminal.element. This is that fallback without the 200 KB of
 * opentype.js and the prompt. xterm 5.3's DOM renderer merges same-style neighbouring cells into one span, so the
 * browser's own shaping draws the ligature; the character joiner only keeps a sequence in one span when the
 * cursor or selection cuts through it and puts the cursor on the whole ligature. letter-spacing (which xterm
 * uses to align cell widths) makes browsers drop calt, hence the explicit `"calt" on`; off is explicit too.
 */

/** 常見的程式連字序列(Iosevka 的預設 calt 集,與 @xterm/addon-ligatures 的退路相同),長的先比。
 *  Common programming ligature sequences (Iosevka's default calt set, the same list the addon falls back to), longest first. */
export const LIGATURE_SEQUENCES: readonly string[] = [
    "<--", "<---", "<<-", "<-", "->", "->>", "-->", "--->",
    "<==", "<===", "<<=", "<=", "=>", "=>>", "==>", "===>", ">=", ">>=",
    "<->", "<-->", "<--->", "<---->", "<=>", "<==>", "<===>", "<====>", "::", ":::",
    "<~~", "</", "</>", "/>", "~~>", "==", "!=", "/=", "~=", "<>", "===", "!==", "!===",
    "<:", ":=", "*=", "*+", "<*", "<*>", "*>", "<|", "<|>", "|>", "+*", "=*", "=:", ":>",
    "/*", "*/", "+++", "<!--", "<!---",
].sort((a, b) => b.length - a.length);

/**
 * 一行文字裡要連在一起的 [start, end) 區間(xterm character joiner 的回傳形狀),不重疊、由左到右。
 * The [start, end) ranges to join in a line (the shape an xterm character joiner returns), non-overlapping, left to right.
 */
export function ligatureRanges(text: string, sequences: readonly string[] = LIGATURE_SEQUENCES): [number, number][] {
    const ranges: [number, number][] = [];
    for (let i = 0; i < text.length; i++) {
        for (const seq of sequences) {
            if (text.startsWith(seq, i)) {
                ranges.push([i, i + seq.length]);
                i += seq.length - 1;
                break;
            }
        }
    }
    return ranges;
}

/** 給 terminal.element 的 CSS:開 = `"calt" on`,關 = 明確關掉(有些字型預設就連)。/ The element's font-feature-settings. */
export function ligatureFeatureSettings(on: boolean): string {
    return on ? '"calt" on, "liga" on' : '"calt" off, "liga" off';
}
