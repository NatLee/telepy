/**
 * 對話框內容區「只差一點點」的處理：內容超出的量不比底部留白多時，超出的只是留白，沒有東西被擋住——這時把底部留白拿掉，
 * 整頁剛好放得下，就不會出現只捲幾 px 的捲軸。超出更多（真的有內容在下面）就照常捲動，配「往下還有」。
 * A dialog body that "only just" overflows: when it overflows by no more than its bottom padding, nothing but padding is
 * hidden — drop that padding so everything fits, instead of a scrollbar that moves a few pixels. A larger overflow
 * (real content below) scrolls as usual, with "More below".
 */

/**
 * 要不要收掉底部留白。`overflow` = 現在的 scrollHeight − clientHeight（`snug` 時已經沒有留白），`pad` = 平常的底部留白。
 * 用「沒收掉時會超出多少」來判斷，所以收掉之後不會又打開（不會來回跳）。
 * Whether to drop the bottom padding. `overflow` = scrollHeight − clientHeight right now (without padding while
 * `snug`), `pad` = the usual bottom padding. Decided on the overflow it would have with the padding, so turning it
 * on never turns it off again (no flip-flop).
 */
export function snugFits(overflow: number, snug: boolean, pad: number): boolean {
    const natural = overflow + (snug ? pad : 0);
    return natural > 0.5 && natural <= pad + 0.5;
}
