/**
 * xterm.js 共用的載入與外觀：動態 import（模組層快取）、等寬字體就緒、配色。終端機頁與網路頁的內嵌終端機共用。
 * Shared xterm.js loading and look: cached dynamic import, monospace font readiness, colour theme. Used by
 * the terminal page and the network page's embedded terminals.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

// xterm 動態載入（模組層快取，多分頁只 import 一次）。/ Module-level cache: import xterm once.
let xtermDepsPromise: Promise<{ Terminal: any; FitAddon: any }> | null = null;
export function loadXtermDeps() {
    if (!xtermDepsPromise) {
        xtermDepsPromise = Promise.all([import("xterm"), import("xterm-addon-fit")]).then(
            ([xtermMod, fitMod]) => ({ Terminal: xtermMod.Terminal, FitAddon: fitMod.FitAddon })
        );
    }
    return xtermDepsPromise;
}

// 等寬字體就緒（1.5s 逾時保底；只等終端要用的字，不等大型 CJK 字體）。快取單一 promise。
// Wait only for the terminal's monospace font (1.5s cap), cached as a single promise.
let monoFontPromise: Promise<string> | null = null;
export function ensureMonoFont(): Promise<string> {
    if (!monoFontPromise) {
        monoFontPromise = (async () => {
            const computedMono = getComputedStyle(document.body)
                .getPropertyValue("--font-0xproto").trim();
            const family = computedMono
                ? `${computedMono}, 'Courier New', monospace`
                : "'Menlo', 'Consolas', 'Courier New', monospace";
            if (computedMono) {
                try {
                    await Promise.race([
                        document.fonts.load(`14px ${computedMono}`),
                        new Promise((resolve) => setTimeout(resolve, 1500)),
                    ]);
                } catch { /* 字體字串無法解析或載入失敗 → 照常初始化 */ }
            }
            return family;
        })();
    }
    return monoFontPromise;
}

export const TERMINAL_THEME = {
    background: "#000000",
    foreground: "#f0f0f0",
    cursor: "#f0f0f0",
    selectionBackground: "#3a3d41",
    black: "#000000",
    red: "#f44747",
    green: "#608b4e",
    yellow: "#d7ba7d",
    blue: "#569cd6",
    magenta: "#c586c0",
    cyan: "#4dc9b0",
    white: "#d4d4d4",
    brightBlack: "#808080",
    brightRed: "#f48771",
    brightGreen: "#89d185",
    brightYellow: "#d7ba7d",
    brightBlue: "#9cdcfe",
    brightMagenta: "#c586c0",
    brightCyan: "#4ec9b0",
    brightWhite: "#ffffff",
};
