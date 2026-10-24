import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * 黏在 Header 下方的篩選列：量它的高度放進 `--sticky-bar`，讓下面的 sticky 標題（`TimelineDay`）黏在它下面。
 * 篩選列會換行、也會因內容變高，所以用 ResizeObserver 跟著更新。
 * A filter bar that sticks under the header: its height goes into `--sticky-bar` so sticky headings below it
 * (`TimelineDay`) stick right under it. The bar wraps and grows, so a ResizeObserver keeps it current.
 */
export function useStickyBar<T extends HTMLElement = HTMLDivElement>() {
    const ref = useRef<T>(null);
    const [height, setHeight] = useState(0);
    useEffect(() => {
        const bar = ref.current;
        if (!bar) return;
        const ro = new ResizeObserver(() => setHeight(bar.offsetHeight));
        ro.observe(bar);
        return () => ro.disconnect();
    }, []);
    return { ref, style: { "--sticky-bar": `${height}px` } as CSSProperties };
}
