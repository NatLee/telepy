/**
 * 遠端畫面（VNC）在手機上的「指標模式」：手指當觸控板用。單指滑動移動游標（不按下）、輕點 = 在游標位置點一下、
 * 長按後拖曳 = 按住拖曳、雙指輕點 = 右鍵、雙指滑動 = 捲動。這裡是純計算：游標怎麼動、捲幾格。
 * 為什麼：noVNC 預設的觸控模式是「點哪裡就在哪裡按下」，手指一碰就是點擊、拖動就是按住拖，在手機上很難只移動滑鼠；
 * 指標模式跟筆電觸控板一樣，先把游標移到位再點。
 * The remote screen's (VNC) "pointer mode" on phones: the finger works like a touchpad. One finger moves the cursor
 * (no button), a tap clicks at the cursor, long-press then drag holds the button, a two-finger tap right-clicks, a
 * two-finger slide scrolls. Pure maths here: how the cursor moves and how many scroll steps to send.
 * Why: noVNC's default touch mode presses wherever the finger lands, so any touch is a click and any drag holds the
 * button, which makes "just move the mouse" hard on a phone; pointer mode works like a laptop touchpad.
 */

export type TouchMode = "pointer" | "touch";
export const TOUCH_MODE_KEY = "telepy.browserTouchMode";

export function readTouchMode(raw: string | null | undefined): TouchMode {
    return raw === "touch" ? "touch" : "pointer";
}

export interface Point { x: number; y: number }

/**
 * 手指移動 (dx, dy) 後游標的新位置：慢慢移是精準（1 倍），快速甩動會加速（最多 3 倍），夾在畫面內。
 * Where the cursor goes after the finger moved (dx, dy): slow moves are precise (1×), quick flicks accelerate (up to 3×);
 * clamped to the screen.
 */
export function moveCursor(pos: Point, dx: number, dy: number, size: { width: number; height: number }): Point {
    const dist = Math.hypot(dx, dy);
    const gain = Math.min(3, 1 + Math.max(0, dist - 4) / 12);
    const clamp = (v: number, max: number) => Math.min(Math.max(0, max - 1), Math.max(0, v));
    return { x: clamp(pos.x + dx * gain, size.width), y: clamp(pos.y + dy * gain, size.height) };
}

/*
 * 觸控板的手勢判斷（純狀態機）。noVNC 自己的手勢要移動 50px 才算拖曳、不到就當點擊，微調游標時反而點下去，所以指標模式
 * 自己判斷：單指移動超過 8px 就跟著動、輕點（沒動、不到 0.4 秒）= 點擊、按住 0.45 秒沒動 = 按下左鍵（之後移動就是拖曳）、
 * 雙指輕點 = 右鍵、雙指移動 = 捲動。
 * The touchpad's gesture logic (a pure state machine). noVNC's own gestures need 50 px of travel before a drag counts and
 * treat anything less as a tap, so nudging the cursor clicked instead; pointer mode decides itself: one finger past
 * 8 px moves the cursor, a tap (no travel, under 0.4 s) clicks, holding still for 0.45 s presses the left button (moving
 * then drags), a two-finger tap right-clicks, two fingers moving scroll.
 */
export const MOVE_SLOP_PX = 8;
export const TAP_MAX_MS = 400;
export const HOLD_MS = 450;
export const SCROLL_PX = 30;

export type PadEvent =
    | { type: "start" | "move" | "end"; at: Point; fingers: number; t: number }
    | { type: "hold"; t: number };

export type PadAction =
    | { kind: "move"; dx: number; dy: number }
    | { kind: "click"; button: "left" | "right" }
    | { kind: "down" | "up" }
    | { kind: "scroll"; x: number; y: number };

export interface PadState {
    phase: "idle" | "one" | "moving" | "holding" | "two" | "scrolling";
    start: Point;
    startT: number;
    last: Point;
    fingers: number;
    acc: Point;
}

export const PAD_IDLE: PadState = { phase: "idle", start: { x: 0, y: 0 }, startT: 0, last: { x: 0, y: 0 }, fingers: 0, acc: { x: 0, y: 0 } };

const far = (a: Point, b: Point, d: number) => Math.hypot(a.x - b.x, a.y - b.y) > d;

/**
 * 一個觸控事件之後的新狀態與要送出的動作。`at` 是目前所有手指的中心；`fingers` 是事件之後還按著的手指數。
 * The next state and the actions to send after one touch event. `at` is the centre of the fingers down; `fingers` is how
 * many are still down after the event.
 */
export function padStep(s: PadState, e: PadEvent): { state: PadState; actions: PadAction[] } {
    const actions: PadAction[] = [];
    if (e.type === "hold") {
        if (s.phase === "one") { actions.push({ kind: "down" }); return { state: { ...s, phase: "holding" }, actions }; }
        return { state: s, actions };
    }
    if (e.type === "start") {
        if (s.phase === "idle") return { state: { ...PAD_IDLE, phase: e.fingers >= 2 ? "two" : "one", start: e.at, startT: e.t, last: e.at, fingers: e.fingers }, actions };
        // 再多一根手指：沒移動過就是雙指，手指數變了就從新的中心算。/ Another finger: two-finger unless already moving; re-base on the new centre.
        const phase = s.phase === "one" ? "two" : s.phase;
        return { state: { ...s, phase, last: e.at, start: phase === "two" && s.phase === "one" ? e.at : s.start, fingers: e.fingers }, actions };
    }
    if (e.type === "move") {
        if (e.fingers !== s.fingers) return { state: { ...s, last: e.at, fingers: e.fingers }, actions };
        const dx = e.at.x - s.last.x, dy = e.at.y - s.last.y;
        if (s.phase === "one") {
            if (!far(e.at, s.start, MOVE_SLOP_PX)) return { state: s, actions };
            actions.push({ kind: "move", dx, dy });
            return { state: { ...s, phase: "moving", last: e.at }, actions };
        }
        if (s.phase === "moving" || s.phase === "holding") {
            actions.push({ kind: "move", dx, dy });
            return { state: { ...s, last: e.at }, actions };
        }
        if (s.phase === "two" || s.phase === "scrolling") {
            if (s.phase === "two" && !far(e.at, s.start, MOVE_SLOP_PX)) return { state: s, actions };
            const acc = { x: s.acc.x + dx, y: s.acc.y + dy };
            const sx = Math.trunc(acc.x / SCROLL_PX), sy = Math.trunc(acc.y / SCROLL_PX);
            if (sx || sy) actions.push({ kind: "scroll", x: sx, y: sy });
            return { state: { ...s, phase: "scrolling", last: e.at, acc: { x: acc.x - sx * SCROLL_PX, y: acc.y - sy * SCROLL_PX } }, actions };
        }
        return { state: s, actions };
    }
    // end
    if (e.fingers > 0) return { state: { ...s, last: e.at, fingers: e.fingers }, actions };
    if (s.phase === "one" && e.t - s.startT <= TAP_MAX_MS) actions.push({ kind: "click", button: "left" });
    else if (s.phase === "holding") actions.push({ kind: "up" });
    else if (s.phase === "two" && e.t - s.startT <= TAP_MAX_MS) actions.push({ kind: "click", button: "right" });
    return { state: PAD_IDLE, actions };
}
