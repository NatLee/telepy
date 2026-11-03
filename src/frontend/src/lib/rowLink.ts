/**
 * 整張卡片 / 整列都能點進去（不只名稱那幾個字）：點在空白、文字、圖示上 = 開那一頁；點在按鈕、連結、輸入框、選單上 = 交給它
 * 自己；選字中、從浮層（portal）冒上來的點擊不算；中鍵 / Ctrl / ⌘ / Shift = 開新分頁，跟一般連結一樣。純函式，不碰 React。
 * A whole card / row opens its page (not just the name): a click on empty space, text or an icon opens it; a click on a
 * button, link, field or menu is left to that control; selecting text and clicks bubbling up from a popover (a portal)
 * don't count; middle / Ctrl / ⌘ / Shift click open a new tab like an ordinary link. Pure; no React.
 */

/** 這些東西自己會處理點擊，整列不跟著開頁。/ Controls that handle their own click; the row leaves it to them. */
export const ROW_CONTROLS =
    "a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=option],[contenteditable=true],[data-row-ignore]";

export type RowClick = "ignore" | "open" | "newTab";

export interface RowClickInput {
    /** MouseEvent.button：0 左鍵、1 中鍵。/ 0 = primary, 1 = middle. */
    button: number;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    /** 別的處理器已經處理過了。/ Something else already handled it. */
    defaultPrevented: boolean;
    /** 點的東西在這張卡片的 DOM 裡（不是浮層冒上來的）。/ The target is in the card's DOM (not a portal bubbling up). */
    inside: boolean;
    /** 點在卡片裡的某個控制項上。/ The target is (inside) a control in the card. */
    onControl: boolean;
    /** 正在卡片裡選字。/ Text in the card is being selected. */
    selecting: boolean;
}

export function rowClickAction(e: RowClickInput): RowClick {
    if (e.defaultPrevented || !e.inside || e.onControl || e.selecting) return "ignore";
    if (e.button === 1) return "newTab";
    if (e.button !== 0 || e.altKey) return "ignore";
    return e.ctrlKey || e.metaKey || e.shiftKey ? "newTab" : "open";
}
