import { test } from "node:test";
import assert from "node:assert/strict";
import { rowClickAction, type RowClickInput } from "./rowLink.ts";

const click = (over: Partial<RowClickInput> = {}): RowClickInput => ({
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    inside: true,
    onControl: false,
    selecting: false,
    ...over,
});

test("a plain click anywhere on the card opens the page", () => {
    assert.equal(rowClickAction(click()), "open");
});

test("controls, portals, selections and handled clicks are left alone", () => {
    assert.equal(rowClickAction(click({ onControl: true })), "ignore");
    // 浮層（portal）裡的點擊照 React 樹冒上來，但不在卡片的 DOM 裡。/ A popover's click bubbles through React, not the DOM.
    assert.equal(rowClickAction(click({ inside: false })), "ignore");
    assert.equal(rowClickAction(click({ selecting: true })), "ignore");
    assert.equal(rowClickAction(click({ defaultPrevented: true })), "ignore");
    assert.equal(rowClickAction(click({ button: 2 })), "ignore");
    assert.equal(rowClickAction(click({ altKey: true })), "ignore");
});

test("middle, Ctrl, ⌘ and Shift clicks open a new tab like a link", () => {
    assert.equal(rowClickAction(click({ button: 1 })), "newTab");
    assert.equal(rowClickAction(click({ ctrlKey: true })), "newTab");
    assert.equal(rowClickAction(click({ metaKey: true })), "newTab");
    assert.equal(rowClickAction(click({ shiftKey: true })), "newTab");
    // 中鍵點在按鈕上也交給按鈕。/ A middle click on a control is still the control's.
    assert.equal(rowClickAction(click({ button: 1, onControl: true })), "ignore");
});
