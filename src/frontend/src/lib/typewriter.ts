/**
 * 打字機（低調登入頁 Telepy 下面的句子）：一句一句打出來、停一下、往回刪掉、換下一句；只有一句時打完就留著。
 * 這裡只有純函式——拆成字素（中文一次一個字、emoji 不會被拆開）、每一步的下一個狀態與要等多久、句子被改掉時
 * 怎麼接著打——由 hooks/useTypewriter 用 setTimeout 推進。
 *
 * 游標（caret）的規則也在這裡決定：打字 / 刪除時不閃（實心），停下來才閃，跟編輯器一樣；只有一句、打完之後
 * 閃幾下就淡出，不會一直像個輸入框；行尾剛打的空白換成不換行空白，否則瀏覽器會把行尾空白吃掉、游標先停在字後面
 * 再跳一格。
 *
 * The typewriter under "Telepy" on the discreet sign-in page: each line is typed, held, erased and the next one typed;
 * a single line is typed once and kept. Pure helpers only — splitting into graphemes (one CJK character at a time,
 * emoji kept whole), the next state and how long to wait, and how to carry on when a line is edited — driven by
 * hooks/useTypewriter with setTimeout.
 *
 * The caret rules live here too: solid while typing or erasing, blinking only when idle, like an editor; a single
 * kept line blinks a few times and fades so it never looks like an input field; a just-typed trailing space becomes a
 * no-break space, otherwise the browser drops trailing spaces and the caret would sit after the word, then jump.
 */

export type TypePhase =
    /** 空的一行，準備打 `line`。/ An empty line, about to type `line`. */
    | "waiting"
    | "typing"
    /** 打完了，停一下再刪。/ Typed, pausing before erasing. */
    | "holding"
    | "erasing"
    /** 打完而且留著（只有一句，或預覽正在看某一句）。/ Typed and kept (a single line, or the preview pinned one). */
    | "kept";

export interface TypeState {
    /** 哪一句。/ Which line. */
    line: number;
    /** 打出來幾個字素。/ How many graphemes are on screen. */
    shown: number;
    phase: TypePhase;
}

export const START: TypeState = { line: 0, shown: 0, phase: "waiting" };

/** 節奏（毫秒）。/ Timing in milliseconds. */
export const TIMING = {
    /** 第一句等「Telepy」浮出來之後才開始。/ The first line waits for the wordmark to rise. */
    start: 1100,
    /** 每個半形字 / 全形字。/ Per narrow / wide character. */
    type: 62,
    typeWide: 125,
    /** 標點後多停一下。/ Extra pause after punctuation. */
    punct: 260,
    /** 打完停多久：基本 + 每字，最多。/ Hold: base + per character, capped. */
    hold: 1700,
    holdPerChar: 32,
    holdMax: 4200,
    erase: 26,
    eraseWide: 48,
    /** 刪完後空一下再打下一句。/ The empty pause before the next line. */
    gap: 420,
} as const;

type SegmenterCtor = new (locale?: string, options?: { granularity: "grapheme" }) => { segment(text: string): Iterable<{ segment: string }> };

/** 拆成字素（使用者眼中的「一個字」）。/ Split into graphemes (what a reader sees as one character). */
export function graphemes(text: string): string[] {
    const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
    if (Segmenter) return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
    return Array.from(text);
}

// 中日韓、全形、emoji：佔兩格，打慢一點。/ CJK, full-width and emoji: wide, typed a little slower.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]|\p{Extended_Pictographic}/u;
const PAUSE = /^[,.;:!?…，。、；：！？]$/;

export const isWide = (g: string) => WIDE.test(g);

/** 一點固定的「手感」：同一句同一個位置永遠一樣，測得出來。/ A fixed human wobble: same line + position = same value. */
function wobble(line: number, index: number): number {
    const n = (index * 7919 + line * 104729 + 17) % 101;
    return 0.78 + (n / 100) * 0.44;
}

/** 打第 `index` 個字之前要等多久。/ How long before typing grapheme `index`. */
export function typeDelay(chars: string[], index: number, line = 0): number {
    const g = chars[index] ?? "";
    const base = (isWide(g) ? TIMING.typeWide : TIMING.type) * wobble(line, index);
    const prev = chars[index - 1];
    return Math.round(base + (prev && PAUSE.test(prev) ? TIMING.punct : 0));
}

/** 打完一句停多久（長的句子多給一點時間讀）。/ How long a typed line stays (longer lines get more reading time). */
export const holdFor = (chars: string[]) => Math.min(TIMING.holdMax, TIMING.hold + chars.length * TIMING.holdPerChar);

const eraseDelay = (g: string | undefined) => (g && isWide(g) ? TIMING.eraseWide : TIMING.erase);

/** 打到最後一個字之後是停一下（會輪播）還是留著。/ After the last character: pause (rotating) or keep. */
const afterTyped = (loop: boolean): TypePhase => (loop ? "holding" : "kept");

/**
 * 下一步：多久之後換成哪個狀態；null = 停在這裡（只有一句而且打完了）。`loop` = 有兩句以上、沒有被預覽釘住。
 * The next step: which state after how long; null = stay (a single line that is fully typed). `loop` = two or more
 * lines and none pinned by the preview.
 */
export function step(state: TypeState, lines: string[][], loop: boolean): { next: TypeState; delay: number } | null {
    const n = lines.length;
    if (!n) return null;
    const index = Math.min(state.line, n - 1);
    const chars = lines[index];
    const next = (line: number, shown: number, phase: TypePhase) => ({ line, shown, phase });
    const following = (index + 1) % n;

    switch (state.phase) {
        case "waiting":
        case "typing": {
            if (state.shown >= chars.length) {
                // 空的一句（不該發生）或已經打完：照規則收尾。/ Nothing (more) to type: finish by the rules.
                if (!chars.length) return loop ? { next: next(following, 0, "waiting"), delay: TIMING.gap } : null;
                return { next: next(index, chars.length, afterTyped(loop)), delay: 0 };
            }
            const delay = state.phase === "waiting" ? TIMING.gap : typeDelay(chars, state.shown, index);
            const shown = state.shown + 1;
            return { next: next(index, shown, shown >= chars.length ? afterTyped(loop) : "typing"), delay };
        }
        case "holding":
            if (!loop) return { next: next(index, state.shown, "kept"), delay: 0 };
            return { next: next(index, Math.max(0, state.shown - 1), state.shown > 1 ? "erasing" : "waiting"), delay: holdFor(chars) };
        case "erasing": {
            const shown = Math.max(0, state.shown - 1);
            const delay = eraseDelay(chars[shown]);
            return shown > 0 ? { next: next(index, shown, "erasing"), delay } : { next: next(following, 0, "waiting"), delay };
        }
        case "kept":
            // 預覽放開了、而且有好幾句：從這句接著輪播。/ The preview let go and there are several lines: rotate on.
            return loop ? { next: next(index, state.shown, "holding"), delay: 0 } : null;
    }
}

/** 兩串字素開頭有幾個一樣。/ How many leading graphemes two lines share. */
export function sameStart(a: string[], b: string[]): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
}

/**
 * 句子被改了（管理員在設定頁打字）或預覽釘住某一句時，接著打：畫面上跟新句子開頭一樣的部分留著，其餘重打。
 * 被釘住的句子停在打完的樣子（kept），放開之後才繼續輪播。
 * Carry on after the lines change (an admin typing in the settings) or the preview pins a line: what is on screen
 * and still matches the new text stays, the rest is typed again. A pinned line stays typed (kept) until released.
 */
export function reconcile(state: TypeState, before: string[][], after: string[][], pin: number | null): TypeState {
    const n = after.length;
    if (!n) return START;
    const onScreen = (before[state.line] ?? []).slice(0, state.shown);
    if (pin !== null && pin >= 0 && pin < n) {
        const keep = sameStart(onScreen, after[pin]);
        return { line: pin, shown: keep, phase: keep >= after[pin].length ? "kept" : "typing" };
    }
    if (state.line >= n) return START;
    const keep = sameStart(onScreen, after[state.line]);
    if (keep === state.shown) {
        // 畫面上的字沒變；句子變長了就接著打。/ Nothing on screen changed; a longer line is typed on.
        if ((state.phase === "holding" || state.phase === "kept") && keep < after[state.line].length) return { ...state, phase: "typing" };
        return state;
    }
    // 畫面上有字不一樣了（換語言、句子被改）：留下一樣的開頭，其餘重打。/ Keep the shared start, type the rest again.
    return { line: state.line, shown: keep, phase: keep === 0 ? "waiting" : "typing" };
}

export type CaretMode = "solid" | "blink" | "rest";

/** 游標的樣子：動的時候實心、停下來閃、留著的那句閃幾下淡出（被釘住時一直閃）。/ Caret: solid while moving, blinking when idle. */
export function caretMode(phase: TypePhase, pinned: boolean): CaretMode {
    if (phase === "typing" || phase === "erasing") return "solid";
    if (phase === "kept" && !pinned) return "rest";
    return "blink";
}

/** 畫面上的字：行尾剛打的空白換成不換行空白，游標才會在空白後面。/ On-screen text, a trailing space kept visible. */
export function shownText(chars: string[], shown: number): string {
    const text = chars.slice(0, Math.max(0, shown)).join("");
    return text.endsWith(" ") ? `${text.slice(0, -1)} ` : text;
}
