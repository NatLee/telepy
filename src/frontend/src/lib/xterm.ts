/**
 * xterm.js 共用的載入:動態 import(模組層快取)與終端機字型就緒。終端機頁與網路頁的內嵌終端機共用。
 * 外觀(字型 / 字級 / 配色)來自 hooks/useTerminalAppearance(個人預設 + 這台裝置的覆寫),清單在
 * lib/terminalAppearance.ts;開著的終端機由 useLiveTerminalLook 即時套用變更。
 * Shared xterm.js loading: cached dynamic import and terminal-font readiness, used by the terminal page
 * and the network page's embedded terminals. The look comes from hooks/useTerminalAppearance (personal
 * default + device override; catalogue in lib/terminalAppearance.ts) and useLiveTerminalLook applies changes.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { terminalFontPrimary, type TerminalFont } from "@/lib/terminalAppearance";

// xterm 動態載入(模組層快取,多分頁只 import 一次)。/ Module-level cache: import xterm once.
let xtermDepsPromise: Promise<{ Terminal: any; FitAddon: any }> | null = null;
export function loadXtermDeps() {
    if (!xtermDepsPromise) {
        xtermDepsPromise = Promise.all([import("xterm"), import("xterm-addon-fit")]).then(
            ([xtermMod, fitMod]) => ({ Terminal: xtermMod.Terminal, FitAddon: fitMod.FitAddon })
        );
    }
    return xtermDepsPromise;
}

/** 讀 next/font 給的 CSS 變數(0xProto 的實際 family 名稱)。/ Reads a next/font CSS variable (0xProto's real family). */
export function resolveCssVar(name: string): string {
    return getComputedStyle(document.body).getPropertyValue(name);
}

// 每個字型一個載入 promise(模組層快取);只等終端機要用的那一個,不等大型 CJK 字體。
// One cached load promise per font; only the font a terminal uses, never the large CJK UI font.
const fontLoads = new Map<string, Promise<boolean>>();

/** 字型載好 → true;字體字串無法解析或下載失敗 → false(用後備字型)。/ true once loaded; false on failure (fallback stack). */
export function loadTerminalFont(font: TerminalFont): Promise<boolean> {
    let p = fontLoads.get(font.id);
    if (!p) {
        p = document.fonts.load(`16px ${terminalFontPrimary(font, resolveCssVar)}`)
            .then((faces) => faces.length > 0)
            .catch(() => false);
        fontLoads.set(font.id, p);
    }
    return p;
}

/** 最多等 1.5 s;之後才載好的由 useLiveTerminalLook 讓 xterm 重新量字寬。/ Wait at most 1.5 s; a later load re-measures. */
export function waitForFont(font: TerminalFont): Promise<unknown> {
    return Promise.race([loadTerminalFont(font), new Promise((resolve) => setTimeout(resolve, 1500))]);
}
