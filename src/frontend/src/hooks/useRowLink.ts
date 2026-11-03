"use client";

/**
 * 讓整張卡片 / 整列點了就開某一頁（規則在 `lib/rowLink.ts`）。名稱本身仍是真的連結（鍵盤、右鍵選單），這個只是讓滑鼠
 * 點在其他地方也算數。回傳的處理器放在外框上；不該跟著開頁的一塊（按鈕列）加 `data-row-ignore`。
 * Makes a whole card / row open a page (rules in `lib/rowLink.ts`). The name stays a real link (keyboard, context
 * menu); this only makes a mouse click elsewhere count too. Spread the handlers on the frame; mark an area that must
 * not open the page (the button tray) with `data-row-ignore`.
 */
import { useRouter } from "next/navigation";
import type React from "react";
import { ROW_CONTROLS, rowClickAction } from "@/lib/rowLink";

export function useRowLink(href: string) {
    const router = useRouter();
    const read = (e: React.MouseEvent<HTMLElement>) => {
        const frame = e.currentTarget;
        const target = e.target instanceof Element ? e.target : null;
        const control = target?.closest(ROW_CONTROLS) ?? null;
        const selection = typeof window !== "undefined" ? window.getSelection() : null;
        return rowClickAction({
            button: e.button,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            defaultPrevented: e.defaultPrevented,
            inside: !!target && frame.contains(target),
            onControl: !!control && control !== frame && frame.contains(control),
            selecting: !!selection && !selection.isCollapsed && selection.toString().trim() !== "" && !!selection.anchorNode && frame.contains(selection.anchorNode),
        });
    };
    const go = (e: React.MouseEvent<HTMLElement>) => {
        const action = read(e);
        if (action === "open") router.push(href);
        else if (action === "newTab") window.open(href, "_blank", "noopener");
    };
    return {
        onClick: go,
        onAuxClick: (e: React.MouseEvent<HTMLElement>) => {
            if (e.button === 1) go(e);
        },
        // 中鍵按下在 Windows 會開自動捲動：卡片上不要。/ A middle press starts autoscroll on Windows: not on the card.
        onMouseDown: (e: React.MouseEvent<HTMLElement>) => {
            if (e.button === 1 && read(e) === "newTab") e.preventDefault();
        },
    };
}
