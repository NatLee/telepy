/**
 * 重新整理的動態（純函式）：按鈕的圖示什麼時候停、列表一張張浮回來的延遲。
 * 請求常常幾十毫秒就回來，只在「載入中」轉圈會一閃即逝，看起來像沒反應；所以圖示至少轉滿一圈，
 * 而且只在一圈轉完的那一刻停（停在原本的角度，不會跳）。
 * Refresh motion (pure): when the button's icon stops and how the list's items stagger back in. A request often
 * answers within tens of milliseconds, so spinning only while loading was a flicker that read as "nothing
 * happened"; the icon turns at least once and stops only where a turn ends (back at its own angle, no jump).
 */

/** 一圈的時間（毫秒）。/ One turn (ms). */
export const SPIN_TURN_MS = 700;
/** 完成的勾勾留多久（毫秒）。/ How long the done check stays (ms). */
export const DONE_MS = 1400;

/** 一圈轉完時：還在忙就再轉一圈，不然停。/ At the end of a turn: keep turning while busy, else stop. */
export function keepSpinning(state: { working: boolean; busy: boolean }): boolean {
    return state.working || state.busy;
}

/** 列表項目的錯開延遲：每項 step 毫秒，第 cap 項之後不再加（96 張卡也不會拖到兩秒）。
 * Stagger delay of a list item: step ms each, flat after item `cap` (96 cards never drag on for seconds). */
export function rippleDelay(index: number, step = 28, cap = 12): number {
    if (!Number.isFinite(index) || index <= 0) return 0;
    return Math.min(Math.floor(index), cap) * step;
}

/** 最多動幾項；更後面的多半在畫面外，動了也看不到。/ How many items move at most; later ones are mostly off screen. */
export const RIPPLE_MAX_ITEMS = 48;
