/**
 * 手機鍵盤彈起時讓遠端畫面（VNC）維持原本大小：判斷鍵盤開了沒、畫面要往上推多少。
 * 為什麼：noVNC 一收到視窗大小變化就把遠端桌面改成畫面元素的大小，鍵盤一彈起（會縮小頁面的瀏覽器）遠端就變扁，
 * 收起又改回來；不縮小頁面的瀏覽器（iOS、新版 Chrome）則是鍵盤直接蓋住下半部。所以鍵盤開著時遠端大小不動，
 * 畫面往上推到剛剛點的地方在鍵盤上方。
 * Keep the remote screen (VNC) its size while a phone keyboard is up: whether it is up, and how far to push the screen.
 * Why: noVNC resizes the remote desktop to its element on every window resize, so a keyboard that shrinks the page
 * squashed the remote browser and a second resize followed when it closed; browsers that don't shrink the page (iOS,
 * current Chrome) just cover the bottom half. So while the keyboard is up the remote size stays put and the picture is
 * pushed up until the spot just tapped sits above the keyboard.
 */

/** 可見高度比同寬度的最高紀錄少這麼多，就當作鍵盤開著（位址列伸縮只有幾十 px）。/ This much below the tallest height seen at this width means a keyboard (the address bar only moves tens of px). */
export const KEYBOARD_MIN_PX = 120;

/** 同一個寬度下看過最高的可見高度；寬度變了（轉向）就重來。/ The tallest visible height seen at this width; a new width (rotation) starts over. */
export function nextBaseline(prev: { width: number; height: number } | null, width: number, height: number): { width: number; height: number } {
    if (!prev || Math.abs(prev.width - width) > 1) return { width, height };
    return { width, height: Math.max(prev.height, height) };
}

export function isKeyboardOpen(baseline: { height: number } | null, height: number): boolean {
    return !!baseline && baseline.height - height > KEYBOARD_MIN_PX;
}

/**
 * 畫面往上推多少 px：讓點的位置（相對於未推移的畫面頂端）落在看得到的範圍底部往上 `margin` 處；不推過頭、不往下推。
 * How far to push the picture up (px): the tapped spot (from the unpushed top) ends `margin` above the bottom of what is
 * visible; never past the end, never down.
 */
export function keyboardShift({ tapY, frozenHeight, visibleHeight, margin = 56 }: { tapY: number | null; frozenHeight: number; visibleHeight: number; margin?: number }): number {
    const max = Math.max(0, frozenHeight - visibleHeight);
    if (tapY === null) return max;
    return Math.round(Math.min(max, Math.max(0, tapY - (visibleHeight - margin))));
}

/**
 * 觸控裝置上什麼時候才請遠端改大小：寬度變了（轉向、分割畫面）或高度變了超過四分之一。網址列伸縮、鍵盤這類小變化都不算，
 * 畫面照比例縮放就好——每次改大小遠端瀏覽器都要重排、整個畫面重送，看起來就是閃一下。
 * When a touch device should ask the remote to resize: the width changed (rotation, split screen) or the height changed by
 * more than a quarter. Small changes such as the address bar or a keyboard don't count; the picture just scales — every
 * resize makes the remote browser re-lay out and resend the whole screen, which shows as a flicker.
 */
/** 比這矮的畫面不要求遠端改大小（手機橫放時標題列幾乎吃掉整個高度），照比例縮放就好。/ Below this height the remote isn't resized (a phone on its side leaves almost no height under the headers); the picture just scales. */
export const MIN_REMOTE_HEIGHT_PX = 160;

export function needsRemoteResize(asked: { width: number; height: number } | null, now: { width: number; height: number }): boolean {
    if (now.height < MIN_REMOTE_HEIGHT_PX) return false;
    if (!asked) return true;
    if (Math.abs(asked.width - now.width) > 1) return true;
    return asked.height > 0 && Math.abs(asked.height - now.height) / asked.height > 0.25;
}
