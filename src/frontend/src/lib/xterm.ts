/**
 * xterm.js 共用的載入:動態 import(模組層快取)、終端機字型(含粗體字體)就緒、外觀 → xterm 選項、連字。
 * 終端機頁與網路頁的內嵌終端機、錄影播放器共用。外觀(字型 / 字級 / 配色 / 粗體畫法 / 連字)來自
 * hooks/useTerminalAppearance(個人預設 + 這台裝置的覆寫),清單在 lib/terminalAppearance.ts;開著的終端機由
 * useLiveTerminalLook 即時套用變更。
 * Shared xterm.js loading: cached dynamic import, terminal-font readiness (bold face included), look → xterm
 * options and ligatures; used by the terminal page, the network page's embedded terminals and the cast player.
 * The look comes from hooks/useTerminalAppearance (personal default + device override; catalogue in
 * lib/terminalAppearance.ts) and useLiveTerminalLook applies changes.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ligatureFeatureSettings, ligatureRanges } from "@/lib/ligatures";
import { terminalFontFamily, terminalFontPrimary, xtermBoldOptions, type ResolvedTerminalAppearance, type TerminalFont } from "@/lib/terminalAppearance";

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

// 每個字型 × 字體一個載入 promise(模組層快取);只等終端機要用的那一個,不等大型 CJK 字體。
// One cached load promise per font × face; only the font a terminal uses, never the large CJK UI font.
const fontLoads = new Map<string, Promise<boolean>>();

/**
 * 字型(Regular,或 bold = 粗體字體)載好 → true;字體字串無法解析或下載失敗 → false(用後備字型)。
 * 字型沒有該字體時直接 true(瀏覽器會合成)。
 * true once the face is loaded (Regular, or the bold face with `bold`); false on failure (fallback stack).
 * A font without that face resolves true at once (the browser synthesises it).
 */
export function loadTerminalFont(font: TerminalFont, bold = false): Promise<boolean> {
    if (bold && !font.faces.includes("bold")) return Promise.resolve(true);
    const key = `${font.id}:${bold ? "bold" : "regular"}`;
    let p = fontLoads.get(key);
    if (!p) {
        p = document.fonts.load(`${bold ? "bold " : ""}16px ${terminalFontPrimary(font, resolveCssVar)}`)
            .then((faces) => faces.length > 0)
            .catch(() => false);
        fontLoads.set(key, p);
    }
    return p;
}

/**
 * 開 shell 前最多等 1.5 s(粗體畫法用真實字體時連 Bold 一起等,否則第一個粗體字會先用後備字型量寬);
 * 之後才載好的由 useLiveTerminalLook 讓 xterm 重新量字寬。
 * Wait at most 1.5 s before a shell (the Bold face too when the bold style uses it — otherwise the first bold
 * cell is measured with the fallback font); a later load re-measures via useLiveTerminalLook.
 */
export function waitForFont(font: TerminalFont, bold = false): Promise<unknown> {
    const loads = bold ? Promise.all([loadTerminalFont(font), loadTerminalFont(font, true)]) : loadTerminalFont(font);
    return Promise.race([loads, new Promise((resolve) => setTimeout(resolve, 1500))]);
}

/**
 * 外觀 → `new Terminal(...)` 的選項(字型 / 字級 / 配色 / 粗體)。`allowProposedApi`:registerCharacterJoiner(連字)在
 * xterm 5 還是 proposed API,沒開會丟錯。/ Look → the options for `new Terminal(...)`. `allowProposedApi`:
 * registerCharacterJoiner (ligatures) is still a proposed API in xterm 5 and throws without it.
 */
export function xtermLookOptions(look: ResolvedTerminalAppearance): Record<string, unknown> {
    return {
        allowProposedApi: true,
        theme: look.scheme.theme,
        fontFamily: terminalFontFamily(look.font, resolveCssVar),
        fontSize: look.fontSize,
        lineHeight: 1.2,
        ...xtermBoldOptions(look.bold),
    };
}

// 每個 xterm 記住它的 joiner id(dispose 時隨 xterm 一起消失)。/ Each xterm's joiner id (gone with the xterm on dispose).
const joiners = new WeakMap<object, number>();

/**
 * 連字開 / 關(open() 之後呼叫;可重複呼叫)。見 lib/ligatures.ts 的說明:瀏覽器自己塑形,joiner 只負責讓序列留在
 * 同一個 span。/ Ligatures on / off (after open(); idempotent). See lib/ligatures.ts: the browser shapes, the joiner
 * only keeps a sequence in one span.
 */
export function applyLigatures(term: any, on: boolean) {
    const el: HTMLElement | undefined = term.element;
    if (!el) return;
    el.style.fontFeatureSettings = ligatureFeatureSettings(on);
    const existing = joiners.get(term);
    if (on && existing === undefined) {
        joiners.set(term, term.registerCharacterJoiner((text: string) => ligatureRanges(text)));
    } else if (!on && existing !== undefined) {
        term.deregisterCharacterJoiner(existing);
        joiners.delete(term);
    }
    term.refresh(0, term.rows - 1);
}
