/**
 * 步驟分頁的純函式：每一步的狀態（done 做完 / working 處理中 / attention 要處理 / todo 還沒到），第一個沒做完的、
 * 下一步、完成幾步。/ Pure helpers for step tabs: per-step state, the first unfinished, the next one, how many are done.
 */

export type StepState = "done" | "working" | "attention" | "todo";

export interface StepLike<T extends string> {
    value: T;
    state: StepState;
}

/** 打開時先到哪一步：第一個沒做完的；全做完就最後一步。/ Where to open: the first unfinished step, else the last. */
export function firstOpenStep<T extends string>(steps: StepLike<T>[]): T | null {
    if (steps.length === 0) return null;
    return (steps.find((s) => s.state !== "done") ?? steps[steps.length - 1]).value;
}

/** 下一步（最後一步沒有）。/ The step after this one (none after the last). */
export function nextStep<T extends string>(steps: StepLike<T>[], current: T): T | null {
    const i = steps.findIndex((s) => s.value === current);
    return i >= 0 && i < steps.length - 1 ? steps[i + 1].value : null;
}

export function prevStep<T extends string>(steps: StepLike<T>[], current: T): T | null {
    const i = steps.findIndex((s) => s.value === current);
    return i > 0 ? steps[i - 1].value : null;
}

export function doneCount(steps: StepLike<string>[]): number {
    return steps.filter((s) => s.state === "done").length;
}
