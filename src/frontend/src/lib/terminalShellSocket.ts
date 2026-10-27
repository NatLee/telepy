"use client";

/**
 * 結束一個斷線保留中的 shell（分頁正在重連、手上沒有開著的 socket 時關分頁用）：開一條短命的 `/ws/terminal/`，
 * 帶 `resume` 接回來馬上送 `{action:"end"}`。伺服器照順序讀：先接手，再結束。
 * End a kept shell when the tab has no open socket (closing a tab while it reconnects): a short-lived socket that
 * resumes it and sends `{action:"end"}` right away; the server reads them in order.
 */
import { getWsOrigin } from "@/lib/wsCommon";
import { stepUpToken } from "@/lib/stepUp";

export function endKeptShell(auth: Record<string, unknown>, shellId: string): void {
    try {
        const ws = new WebSocket(`${getWsOrigin()}/ws/terminal/`);
        ws.binaryType = "arraybuffer";
        ws.onopen = () => {
            ws.send(JSON.stringify({ type: "auth", token: localStorage.getItem("accessToken"), step_up: stepUpToken() ?? undefined, ...auth, resume: shellId }));
            ws.send(JSON.stringify({ action: "end" }));
            setTimeout(() => {
                try { ws.close(); } catch { /* noop */ }
            }, 3000);
        };
        ws.onerror = () => { /* 盡力而為 / best effort */ };
    } catch {
        /* 盡力而為：沒結束的會在保留時間到時結束 / best effort; a missed one ends when its time is up */
    }
}
