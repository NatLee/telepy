/**
 * 讓 xterm 的格子寬跟得上目前的字型 / 字級。
 * xterm 5.3 的 DOM renderer 用兩份量測排字:格子寬來自 CharSizeService(量測元素在 .xterm 裡,量到 0 就沿用舊值,
 * 而且只在 fontFamily / fontSize 改變或 resize 時才量),每個字的寬度來自 WidthCache(掛在 <body> 下,永遠量得到)。
 * 兩者的差被當成 letter-spacing 加在每個字上,所以格子寬一旦停在舊字型,字是新的大小、格子還是舊的 → 字距被撐開。
 * 已知的成因是隱藏時換字型(終端機頁的背景分頁、網路頁縮小或非作用中的終端機:markIfHidden 記下);其他走到同一個
 * 狀態的路徑則靠自我檢查:ensureMeasured 比對 xterm 正在用的格子寬和目前字型 / 字級實際量到的寬度,
 * 對不上就重新量。在每次 fit 之前、視窗取得焦點 / 分頁變回可見時、以及每隔幾秒(useLiveTerminalLook)呼叫。
 * Keeping xterm's cell width in step with the current font and size.
 * xterm 5.3's DOM renderer lays text out from two measurements: the cell width from CharSizeService (its measuring
 * element sits inside .xterm, a reading of 0 keeps the old value, and it only measures when fontFamily / fontSize
 * change or on a resize) and each character's width from WidthCache (attached to <body>, always measurable). The
 * difference becomes letter-spacing on every character, so once the cell width is stuck on an old font, new-size
 * glyphs sit in old-size cells, spaced apart. The known cause is a font change while hidden (background shell tabs,
 * minimised or inactive dock terminals: markIfHidden records them); any other path to the same state is caught by
 * a self-check: ensureMeasured compares the cell width xterm lays rows out with with what the current font and
 * size measure, and re-measures when they differ. Called before every fit, on window focus / when
 * the tab becomes visible, and every few seconds (useLiveTerminalLook).
 */

/** 用得到的 xterm 部分。/ The part of an xterm used here. */
export interface MeasurableTerminal {
    element?: HTMLElement | { getClientRects(): { length: number } } | null;
    options: { fontFamily?: string; fontSize?: number };
}

/** 量到的兩個格子寬(px;量不到 = null)。/ The two cell widths (px; null = could not measure). */
export interface CellWidths {
    /** xterm 排字用的。/ What xterm lays rows out with. */
    applied: number | null;
    /** 目前字型 / 字級實際的寬度。/ What the current font and size actually measure. */
    actual: number | null;
}

/** 差多少 px 才算對不上(xterm 自己的量法和這裡一樣,正常時差不到 0.05)。/ Mismatch threshold; normally < 0.05 px apart. */
export const CELL_TOLERANCE_PX = 0.25;

/** 兩個寬度都量得到而且差太多 = 格子寬過期了。/ Both measured and too far apart = the cell width is stale. */
export function cellMismatch({ applied, actual }: CellWidths): boolean {
    if (applied === null || actual === null || !(applied > 0) || !(actual > 0)) return false;
    return Math.abs(applied - actual) > CELL_TOLERANCE_PX;
}

/** 重新量過還是對不上時,同一個字型 / 字級多久後再試。/ After a re-measure that didn't help, wait this long before retrying. */
export const RETRY_AFTER_MS = 10_000;

const hiddenChange = new WeakSet<object>();
// 重新量過還是對不上的:同一個字型 / 字級隔一段時間才再試,警告只記一次。
// Re-measured and still off: the same font / size waits before the next try, and warns once.
const failed = new WeakMap<object, { key: string; until: number }>();

function rendered(term: MeasurableTerminal): boolean {
    return !!term.element && term.element.getClientRects().length > 0;
}

function fontKey(term: MeasurableTerminal): string {
    return `${term.options.fontFamily}|${term.options.fontSize}`;
}

/**
 * 從 DOM 量兩個格子寬。實際寬度:在終端機元素裡用目前字型 / 字級量 32 個 W(和 xterm 的量法一樣)。xterm 用的格子寬:
 * 實際寬度加上 xterm 給 .xterm-rows 的預設 letter-spacing(= 格子寬 − 字寬,正常時 ≈ 0)。不用「列寬 ÷ 欄數」,
 * 因為終端機剛變回可見時 xterm 會延後調整列寬,欄數卻已經變了,會誤判。
 * Measures both from the DOM. Actual: 32 × "W" in the current font and size inside the terminal element (the way
 * xterm measures). Applied: that plus the default letter-spacing xterm puts on .xterm-rows (= cell − glyph width,
 * ≈ 0 when healthy). Not row width ÷ cols: right after a terminal shows again xterm defers resizing its rows while
 * cols have already changed, which would read as a mismatch.
 */
export function measureCells(term: MeasurableTerminal): CellWidths {
    const el = term.element as HTMLElement | null | undefined;
    if (!el || typeof el.querySelector !== "function") return { applied: null, actual: null };
    const probe = el.ownerDocument.createElement("span");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;display:inline-block;white-space:pre;font-kerning:none;line-height:normal";
    probe.style.fontFamily = term.options.fontFamily ?? "";
    probe.style.fontSize = `${term.options.fontSize}px`;
    probe.textContent = "W".repeat(32);
    el.appendChild(probe);
    const width = probe.offsetWidth / 32;
    probe.remove();
    const actual = width > 0 ? width : null;
    const spacing = parseFloat(el.querySelector<HTMLElement>(".xterm-rows")?.style.letterSpacing ?? "");
    return { applied: actual !== null && Number.isFinite(spacing) ? actual + spacing : null, actual };
}

/**
 * 強迫 xterm 重新量字寬:它只在值改變時才量,所以先換成 monospace 再換回來。
 * Forces xterm to re-measure: it only measures when the value changes, hence the monospace round trip.
 */
export function remeasure(term: MeasurableTerminal) {
    const family = term.options.fontFamily;
    term.options.fontFamily = "monospace";
    term.options.fontFamily = family;
}

/** 剛換了字型 / 字級:終端機正隱藏著就記下來。/ Just changed the font or size: remember the terminal if it is hidden. */
export function markIfHidden(term: MeasurableTerminal) {
    if (!rendered(term)) hiddenChange.add(term);
}

/**
 * 終端機看得到時,格子寬過期(隱藏時換過字型,或量到的寬度對不上)就重新量。fit 之前呼叫;回傳是否量了(呼叫端
 * 要 refit)。`measure` 只給測試換掉。
 * When the terminal is visible and its cell width is stale (font changed while hidden, or the widths disagree),
 * re-measures it. Call before fitting; returns whether it re-measured (the caller should refit). `measure` is for tests.
 */
export function ensureMeasured(
    term: MeasurableTerminal,
    measure: (t: MeasurableTerminal) => CellWidths = measureCells,
    now: number = Date.now(),
): boolean {
    if (!rendered(term)) return false;
    const marked = hiddenChange.delete(term);
    const key = fontKey(term);
    const last = failed.get(term);
    const waiting = last?.key === key && now < last.until;
    const before = waiting ? null : measure(term);
    const off = before !== null && cellMismatch(before);
    if (!marked && !off) return false;
    remeasure(term);
    if (off && before) {
        const after = measure(term);
        if (!cellMismatch(after)) {
            failed.delete(term);
            // 隱藏時換字型是已知原因,不用警告;其他原因留一行給除錯。/ Hidden-change is a known cause; anything else leaves a line for debugging.
            if (!marked) console.warn(`[telepy] terminal cell width was ${px(before.applied)} but ${term.options.fontSize}px ${term.options.fontFamily} measures ${px(before.actual)}; re-measured → ${px(after.applied)}`);
        } else {
            if (last?.key !== key) {
                console.warn(`[telepy] terminal cell width ${px(before.applied)} disagrees with ${term.options.fontSize}px ${term.options.fontFamily} (${px(before.actual)}) and re-measuring did not help; retrying every ${RETRY_AFTER_MS / 1000} s`);
            }
            failed.set(term, { key, until: now + RETRY_AFTER_MS });
        }
    }
    return true;
}

function px(v: number | null): string {
    return v === null ? "?" : `${v.toFixed(3)}px`;
}
