/**
 * 量測手機原生鍵盤佔用的高度（用於把特殊鍵列與終端機頂到鍵盤上方）。
 * Measure the on-screen (native) keyboard height so the accessory bar and terminal
 * can be lifted above it.
 *
 * 原理：原生鍵盤彈出時 layout viewport 不變，但 visualViewport 會縮小；
 * 兩者高度差即約略為鍵盤高度。這是跨瀏覽器的最佳可用近似（iOS Safari / Android Chrome）。
 * 只在手機寬度（<768px）計算，桌機回傳 0。
 */
import { useEffect, useState } from "react";

const MOBILE_MAX_WIDTH = 768;
// 過濾位址列/工具列微幅變動造成的假訊號；真正的鍵盤通常遠高於此。
const KEYBOARD_MIN_HEIGHT = 80;

export function useKeyboardViewport(): number {
    const [keyboardHeight, setKeyboardHeight] = useState(0);

    useEffect(() => {
        const vv = typeof window !== "undefined" ? window.visualViewport : null;
        if (!vv) return;

        const update = () => {
            if (window.innerWidth >= MOBILE_MAX_WIDTH) {
                setKeyboardHeight(0);
                return;
            }
            const diff = window.innerHeight - vv.height - vv.offsetTop;
            setKeyboardHeight(diff > KEYBOARD_MIN_HEIGHT ? Math.round(diff) : 0);
        };

        update();
        vv.addEventListener("resize", update);
        vv.addEventListener("scroll", update);
        window.addEventListener("resize", update);
        return () => {
            vv.removeEventListener("resize", update);
            vv.removeEventListener("scroll", update);
            window.removeEventListener("resize", update);
        };
    }, []);

    return keyboardHeight;
}
