"use client";

/**
 * 縮小的「另一個螢幕」：把 React 元件畫進同源的 iframe（portal），樣式表、主題 class、顯示大小從本頁同步過去，
 * 再依外框寬度等比縮小。iframe 有自己的視窗寬度，所以元件的 sm / lg 斷點、min-h-screen 都依「那個螢幕」計算——
 * 預覽就是真正的頁面元件，而不是另外畫的一張圖。內容不可互動（inert），也不會被讀到兩次。
 * A scaled-down "other screen": React content is portalled into a same-origin iframe whose stylesheets, theme class
 * and display scale mirror this page, then scaled to the frame's width. The iframe has its own viewport, so the
 * content's breakpoints and min-h-screen follow that screen — the preview is the real page components, not a picture.
 * The content is inert and hidden from assistive technology (the caller describes it).
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

const BLANK = "<!doctype html><html><head></head><body></body></html>";
const MIRRORED = "data-preview-mirror";

/** 本頁的樣式表 → iframe 的 head（每次全部換新，數量很少）。/ Copy this page's stylesheets into the iframe's head. */
function mirrorStyles(target: Document) {
    target.head.querySelectorAll(`[${MIRRORED}]`).forEach((n) => n.remove());
    document.head.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
        const copy = node.cloneNode(true) as HTMLElement;
        copy.setAttribute(MIRRORED, "");
        target.head.appendChild(copy);
    });
}

/** `<html>` 的屬性（dark class、lang、顯示大小的 font-size）與 `<body>` 的 class（字型變數）。/ Theme, lang, scale, font classes. */
function mirrorRoot(target: Document) {
    const from = document.documentElement;
    const to = target.documentElement;
    for (const attr of Array.from(to.attributes)) if (!from.hasAttribute(attr.name)) to.removeAttribute(attr.name);
    for (const attr of Array.from(from.attributes)) to.setAttribute(attr.name, attr.value);
    target.body.className = document.body.className;
}

export function PreviewFrame({
    width,
    height,
    title,
    className,
    children,
}: {
    /** 「那個螢幕」的 CSS 寬高（px）。/ The simulated screen in CSS px. */
    width: number;
    height: number;
    /** iframe 的標題（螢幕閱讀器）。/ The iframe's accessible title. */
    title: string;
    className?: string;
    children: React.ReactNode;
}) {
    const box = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(0);
    const [doc, setDoc] = useState<Document | null>(null);

    useLayoutEffect(() => {
        const el = box.current;
        if (!el) return;
        const measure = () => setScale(el.clientWidth / width);
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [width]);

    // 本頁換主題、換語言、換顯示大小，或載入新的樣式表（換頁時的 CSS chunk）：跟著同步。
    // Follow theme / language / scale changes and stylesheets added later (route CSS chunks).
    useEffect(() => {
        if (!doc) return;
        const root = new MutationObserver(() => mirrorRoot(doc));
        root.observe(document.documentElement, { attributes: true });
        root.observe(document.body, { attributes: true, attributeFilter: ["class"] });
        const head = new MutationObserver(() => mirrorStyles(doc));
        head.observe(document.head, { childList: true });
        return () => {
            root.disconnect();
            head.disconnect();
        };
    }, [doc]);

    const onLoad = (e: React.SyntheticEvent<HTMLIFrameElement>) => {
        const d = e.currentTarget.contentDocument;
        if (!d) return;
        mirrorStyles(d);
        mirrorRoot(d);
        setDoc(d);
    };

    return (
        <div ref={box} className={cn("relative overflow-hidden rounded-lg border border-border bg-background", className)} style={{ height: Math.round(height * scale) }}>
            <iframe
                title={title}
                srcDoc={BLANK}
                onLoad={onLoad}
                inert
                tabIndex={-1}
                className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
                style={{ width, height, transform: `scale(${scale})`, visibility: scale ? "visible" : "hidden" }}
            />
            {doc && createPortal(children, doc.body)}
        </div>
    );
}
