/**
 * 「一步步做」的步驟清單共用的狀態與純函式（`components/flow/ProgressSteps.tsx` 畫它）：每一步待命 / 進行中 / 做完 /
 * 要注意 / 失敗 / 略過，從「事先的計畫」+「後端即時送來的事件」+「整件事現在在哪」算出來，也算等待的倒數。
 * Shared states and pure helpers for step-by-step progress lists (drawn by `components/flow/ProgressSteps.tsx`):
 * every step is waiting / active / done / warn / failed / skipped, derived from the plan, the live events the backend
 * pushes and where the whole run is; plus the countdown of a step that waits.
 */

export type StepState = "waiting" | "active" | "done" | "warn" | "failed" | "skipped";

/** 後端送來的一步：開始（active）或結束。/ One step event from the backend: its start (active) or its end. */
export interface StepEvent<Id extends string = string> {
    step: Id;
    state: Exclude<StepState, "waiting">;
    /** 這一步最多等幾秒（active 時）。/ The longest wait in seconds (while active). */
    secs?: number;
    /** 前端收到的時間（倒數用）。/ When the browser received it (for the countdown). */
    at?: number;
}

/** 事先的計畫：這一步會不會做、不做的原因。/ The plan: whether a step runs, and why not. */
export interface PlannedStep<Id extends string = string> {
    id: Id;
    run: boolean;
    reason?: string;
}

/** 整件事：還沒開始 / 跑著 / 做完（有回報）/ 請求失敗。/ The whole run: idle / running / done / the request failed. */
export type RunPhase = "idle" | "running" | "done" | "failed";

export interface StepView<Id extends string = string> {
    id: Id;
    state: StepState;
    /** 最後一個事件（結束的那個優先）。/ The latest event (an end wins over a start). */
    event?: StepEvent<Id>;
    /** 不做的原因（計畫或事件說的）。/ Why it is skipped (from the plan or the event). */
    reason?: string;
}

const ENDED: readonly StepState[] = ["done", "warn", "failed", "skipped"];

/**
 * 每一步現在的狀態。
 * - idle：計畫要做 = 待命，不做 = 略過。
 * - running：有結束事件就照它；有開始事件 = 進行中；都沒有時，計畫略過的 = 略過，其他待命——但如果沒有任何一步在進行中，
 *   第一個還沒結束的就算進行中（通知掉了也不會整排停在待命）。
 * - done：照結束事件；沒有的（舊後端沒回報）計畫要做 = 做完。
 * - failed：結束的照舊；沒有哪一步自己報失敗時，進行中（或第一個還沒結束的）那步算失敗；其餘待命。
 * Each step's state. idle: planned = waiting, not planned = skipped. running: an end event wins, a start = active,
 * otherwise skipped / waiting — and when nothing is active the first unfinished step is (a lost notification never
 * freezes the list). done: the end events; missing ones count as done when planned. failed: unless a step reported its
 * own failure, the step in progress (or the first unfinished one) failed; the rest waits.
 */
export function stepViews<Id extends string>(order: readonly Id[], plan: readonly PlannedStep<Id>[], events: readonly StepEvent<Id>[], phase: RunPhase): StepView<Id>[] {
    const planned = new Map(plan.map((p) => [p.id, p]));
    const latest = new Map<Id, StepEvent<Id>>();
    for (const e of events) {
        const prev = latest.get(e.step);
        // 結束的事件不會被晚到的開始事件蓋掉。/ A late start never replaces an end.
        if (prev && ENDED.includes(prev.state) && !ENDED.includes(e.state)) continue;
        latest.set(e.step, e);
    }
    const views: StepView<Id>[] = order.map((id) => {
        const p = planned.get(id);
        const e = latest.get(id);
        const reason = (e as { reason?: string } | undefined)?.reason ?? (p && !p.run ? p.reason : undefined);
        if (e) return { id, state: e.state, event: e, reason };
        if (p && !p.run) return { id, state: "skipped", reason };
        return { id, state: phase === "done" ? "done" : "waiting", reason };
    });
    if (phase === "running" && !views.some((v) => v.state === "active")) {
        const next = views.find((v) => v.state === "waiting");
        if (next) next.state = "active";
    }
    // 已經有一步報了失敗就是它，不再多標一步。/ A step that reported its own failure is the one; don't mark another.
    if (phase === "failed" && !views.some((v) => v.state === "failed")) {
        const at = views.find((v) => v.state === "active") ?? views.find((v) => v.state === "waiting");
        if (at) at.state = "failed";
    }
    return views;
}

/** 進行中那步的序號（1 起算；沒有 = 0）。/ The 1-based number of the step in progress (0 = none). */
export function activeNumber(views: readonly StepView[]): number {
    return views.findIndex((v) => v.state === "active") + 1;
}

/** 有結果的步驟裡最嚴重的：failed > warn > done。/ The worst ending among the steps. */
export function worstEnding(views: readonly StepView[]): "failed" | "warn" | "done" {
    if (views.some((v) => v.state === "failed")) return "failed";
    if (views.some((v) => v.state === "warn")) return "warn";
    return "done";
}

/**
 * 等待中的步驟的倒數：已經等了多久、還剩多少、進度 0..1（沒有 `secs` / `at` = null）。
 * The countdown of a waiting step: elapsed, left and progress 0..1 (null without `secs` / `at`).
 */
export function countdown(event: Pick<StepEvent, "secs" | "at"> | undefined, now: number): { elapsed: number; left: number; progress: number } | null {
    if (!event?.secs || event.at === undefined) return null;
    const elapsed = Math.max(0, Math.floor((now - event.at) / 1000));
    const left = Math.max(0, event.secs - elapsed);
    return { elapsed, left, progress: Math.min(1, (now - event.at) / (event.secs * 1000)) };
}
