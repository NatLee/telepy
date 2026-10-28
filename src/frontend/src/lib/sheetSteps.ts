/**
 * 指令速查頁的步驟（純函式，`sheetSteps.test.ts`）：① 裝置與準備 → ② 要做什麼 → ③ 填入數值 → ④ 複製並執行。
 * 每一步的狀態、打開頁面時先到哪一步、步驟列上「填入數值」那一格的一行摘要。
 * The command sheet's steps (pure, tested): ① device and setup → ② pick a task → ③ fill in → ④ copy and run —
 * each step's state, where the page opens, and the one-line summary under "fill in" on the step bar.
 */
import type { StepState } from "./stepTabs.ts";
import type { RecipeId, RecipeParams } from "./forwardRecipes.ts";

export type SheetStep = "device" | "task" | "fill" | "run";

export const SHEET_STEPS: readonly SheetStep[] = ["device", "task", "fill", "run"];

export interface SheetProgress {
    /** 第一次使用的設定做完幾項 / 共幾項，還在讀就是 loading。/ First-time setup: done / total, or still loading. */
    setupDone: number;
    setupTotal: number;
    setupLoading: boolean;
    /** 自己選過任務（點了卡片，或從別頁深連結帶 `?recipe=`）。/ A task was chosen (clicked or deep-linked). */
    picked: boolean;
    /** 填空改過值或已經往下走（或深連結已帶好數值）。/ Fill-in was edited or left behind (or a deep link prefilled it). */
    filled: boolean;
    /** 有填錯的值（埠不是數字、主機名稱不合法）。/ Some value is invalid. */
    invalid: boolean;
    /** 複製過這一行指令。/ The command was copied. */
    copied: boolean;
}

/**
 * 每一步的狀態：設定沒做完 = 要處理（琥珀色，但不擋人往下走）；填錯 = 要處理；其他做過就打勾。
 * Per-step state: unfinished setup = attention (amber, never blocking); an invalid value = attention; the rest
 * are ticked once done.
 */
export function sheetStates(p: SheetProgress): Record<SheetStep, StepState> {
    return {
        device: p.setupLoading ? "todo" : p.setupDone >= p.setupTotal ? "done" : "attention",
        task: p.picked ? "done" : "todo",
        fill: p.invalid ? "attention" : p.picked && p.filled ? "done" : "todo",
        run: p.copied ? "done" : "todo",
    };
}

/**
 * 打開時到哪一步：別頁帶著任務與數值深連結過來 → 直接填空；設定還沒做完 → 裝置與準備；否則挑任務。
 * Where the page opens: a deep link with a task → fill in; setup unfinished → device; otherwise pick a task.
 */
export function sheetOpenStep({ deepLinked, setupComplete }: { deepLinked: boolean; setupComplete: boolean }): SheetStep {
    if (deepLinked) return "fill";
    return setupComplete ? "task" : "device";
}

const local = (port: string) => `localhost:${port}`;

/**
 * 步驟列「填入數值」下面的一行：從哪裡到哪裡（已經過 `resolveParams`，空格子用預設值）。
 * The line under "fill in" on the step bar: from where to where (values already resolved, blanks = defaults).
 */
export function fillSummary(id: RecipeId, r: RecipeParams): string {
    switch (id) {
        case "local":
            return `${r.remotePort} → ${local(r.localPort)}`;
        case "lan":
            return `${r.lanHost}:${r.lanPort} → ${local(r.localPort)}`;
        case "socks":
            return `SOCKS5 ${local(r.localPort)}`;
        case "remote":
            return `${local(r.localPort)} → ${r.devicePort}`;
        case "jump":
            return `${r.lanUser}@${r.lanHost}${r.lanPort && r.lanPort !== "22" ? `:${r.lanPort}` : ""}`;
        case "copy":
            return r.direction === "download" ? `${r.remotePath} → ${r.localPath}` : `${r.localPath} → ${r.remotePath}`;
        case "rustdesk":
            return `${r.lanHost}:${r.remotePort} → 127.0.0.1:${r.localPort}`;
    }
}
