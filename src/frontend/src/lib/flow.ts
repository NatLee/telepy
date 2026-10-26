/**
 * 路徑圖（瀏覽器 ─ Telepy ─ 裝置 ─ 目標）共用的型別與純函式：每個節點 / 每段線的狀態，以及「失敗在哪一段」
 * 的通用算法。遠端桌面（lib/desktop.ts）與終端機（lib/terminalFlow.ts）各自定義階段，但畫法一樣。
 * Shared types and pure helpers for the path diagrams (browser ─ Telepy ─ device ─ target): the state of every
 * node / link and the generic "where it stopped" rule. Remote desktop and the terminal define their own phases
 * but draw the same way.
 */

/** 待命 / 進行中 / 通了 / 卡在這。/ Waiting / in progress / working / stopped here. */
export type SpotState = "waiting" | "active" | "ok" | "failed";

/**
 * 沿著路徑標狀態：`failedAt` 之前通、那一段失敗、之後待命；沒有失敗時 `activeFrom..activeTo` 進行中、
 * 之前通、之後待命（`activeFrom` 為 null = 全部待命，`done` = 全部通）。
 * States along an ordered path: everything before `failedAt` is ok, that spot failed, the rest waits; otherwise the
 * `activeFrom..activeTo` range is active, earlier spots ok, later ones waiting (`activeFrom` null = all waiting).
 */
export function statesAlong<S extends string>(
    order: readonly S[],
    spec: { done?: boolean; failedAt?: S | null; activeFrom?: S | null; activeTo?: S | null; okUntil?: S | null },
): Record<S, SpotState> {
    const out = {} as Record<S, SpotState>;
    const idx = (s: S | null | undefined) => (s === null || s === undefined ? -1 : order.indexOf(s));
    const failed = idx(spec.failedAt);
    const from = idx(spec.activeFrom);
    const to = spec.activeTo === undefined ? from : idx(spec.activeTo);
    const okUntil = idx(spec.okUntil);
    order.forEach((s, i) => {
        if (spec.done) out[s] = "ok";
        else if (failed >= 0) out[s] = i < failed ? "ok" : i === failed ? "failed" : "waiting";
        else if (from >= 0) out[s] = i < from ? "ok" : i <= to ? "active" : "waiting";
        else out[s] = i <= okUntil ? "ok" : "waiting";
    });
    return out;
}
