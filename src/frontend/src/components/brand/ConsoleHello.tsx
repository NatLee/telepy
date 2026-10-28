"use client";

/**
 * 彩蛋：打開瀏覽器開發者工具的人會在 console 看到 Tapi 和兩句話（原始碼在哪、CLI 的 `telepy dig`）。
 * 每次載入頁面只印一次；稍等一下再印，語言才是使用者選的那個（translate 由 I18nProvider 同步）。
 * Easter egg: whoever opens the browser's devtools finds Tapi in the console plus where the source lives and a hint
 * at `telepy dig`. Printed once per page load, a moment after mount so the chosen language is in effect.
 */
import { useEffect, useRef } from "react";
import { tapiSvg } from "@/components/brand/Tapi";
import { useTapi } from "@/hooks/useTapi";
import { translate } from "@/lib/translate";

export const SOURCE_URL = "https://github.com/NatLee/telepy";

let printed = false;

export function ConsoleHello() {
    // 印的時候才讀（profile 可能還在路上）：帳號的顏色、今天的節日。/ Read at print time: the account's colour, today's festival.
    const tapi = useTapi();
    const look = useRef({ clip: tapi.clip, festival: tapi.festival });
    useEffect(() => {
        look.current = { clip: tapi.clip, festival: tapi.festival };
    }, [tapi.clip, tapi.festival]);
    useEffect(() => {
        if (printed) return;
        // 旗標在計時器裡才設：StrictMode 會先清掉第一次的計時器。/ Set inside the timer: StrictMode clears the first one.
        const timer = setTimeout(() => {
            if (printed) return;
            printed = true;
            const img = `data:image/svg+xml,${encodeURIComponent(tapiSvg("wave", look.current))}`;
            console.log("%c ", `font-size:1px;padding:42px 48px;background:url("${img}") no-repeat center/contain;`);
            console.log(`%c${translate("eggs.console.hi")}`, "font-size:14px;color:#c04815;");
            console.log(translate("eggs.console.source", { url: SOURCE_URL }));
            console.log(translate("eggs.console.cli"));
        }, 1200);
        return () => clearTimeout(timer);
    }, []);
    return null;
}
