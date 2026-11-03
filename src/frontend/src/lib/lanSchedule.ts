/**
 * 區網定時重掃的純函式：可以選的間隔（跟後端 `lan::watch::EVERY` 一樣，測試比對）、它的翻譯鍵、時間線上的點（上次 ─ 現在 ─
 * 接下來幾次），以及表單跟存下來的排程比有沒有變。
 * Pure helpers for scheduled LAN rescans: the intervals on offer (the backend's `lan::watch::EVERY`; a test compares),
 * their translation keys, the points on a timeline (last ─ now ─ the next few runs), and whether the form differs
 * from the saved schedule.
 */

/** 每小時、6 / 12 小時、每天、每週（秒）。/ Hourly, 6 / 12 hours, daily, weekly (seconds). */
export const EVERY: readonly number[] = [3600, 6 * 3600, 12 * 3600, 86_400, 7 * 86_400];

export type EveryKey = "1h" | "6h" | "12h" | "1d" | "1w";
const KEYS: Record<number, EveryKey> = { 3600: "1h", 21600: "6h", 43200: "12h", 86400: "1d", 604800: "1w" };

/** 間隔 → 翻譯鍵的尾巴（不認得 = null）。/ An interval's translation key suffix (null when unknown). */
export function everyKey(secs: number): EveryKey | null {
    return KEYS[secs] ?? null;
}

export interface TimelinePoint {
    /** 0–1，在時間線上的位置。/ Position on the line, 0–1. */
    at: number;
    time: number;
    kind: "last" | "now" | "next";
}

/**
 * 時間線：從上次（沒跑過 = 現在往前一個間隔）到接下來 `count` 次，每個點放在 0–1 之間。
 * The timeline: from the last run (never ran = one interval before now) to the next `count` runs, each point placed
 * between 0 and 1.
 */
export function timeline(lastAt: string | null, nextAt: string, everySecs: number, now: number, count = 3): TimelinePoint[] {
    const every = everySecs * 1000;
    const next = Date.parse(nextAt);
    if (Number.isNaN(next) || every <= 0) return [];
    const parsedLast = lastAt ? Date.parse(lastAt) : NaN;
    const start = Number.isNaN(parsedLast) ? Math.min(now, next) - every : parsedLast;
    const nexts = Array.from({ length: count }, (_, i) => Math.max(next, now) + i * every);
    const end = nexts[nexts.length - 1];
    const span = Math.max(1, end - start);
    const pos = (t: number) => Math.min(1, Math.max(0, (t - start) / span));
    const points: TimelinePoint[] = [];
    if (!Number.isNaN(parsedLast)) points.push({ at: 0, time: start, kind: "last" });
    points.push({ at: pos(now), time: now, kind: "now" });
    for (const t of nexts) points.push({ at: pos(t), time: t, kind: "next" });
    return points;
}

export interface ScheduleDraft {
    /** 0 = 不重複。/ 0 = no repeat. */
    every: number;
    subnets: string[];
    ports: number[];
    identify: boolean;
    username: string | null;
}

type Saved = { every_secs: number; subnets: string[] | null; ports: number[] | null; identify: boolean; username: string | null } | null | undefined;

const sameList = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * 表單跟存下來的排程不一樣嗎（要不要讓「只存排程」可以按）。`defaultPorts` = 沒存 port 時的預設清單。
 * Whether the form differs from the saved schedule (enables "Save schedule"). `defaultPorts` stands in for no saved ports.
 */
export function scheduleChanged(saved: Saved, draft: ScheduleDraft, defaultPorts: readonly number[]): boolean {
    if (!saved) return draft.every > 0;
    if (draft.every === 0) return true;
    return (
        saved.every_secs !== draft.every ||
        !sameList(saved.subnets ?? [], draft.subnets) ||
        !sameList([...(saved.ports ?? defaultPorts)].sort((a, b) => a - b), [...draft.ports].sort((a, b) => a - b)) ||
        saved.identify !== draft.identify ||
        (draft.username !== null && saved.username !== draft.username)
    );
}

/**
 * 哪些點寫標籤：先寫下一次，再上次、現在、之後幾次；離已經寫了標籤的點太近（< `minGap`）就不寫（滑過還看得到時間）。
 * Which points get a label: the next run first, then the last run, now and the later runs; one closer than `minGap` to
 * an already labelled point gets none (its time still shows on hover).
 */
export function labelled(points: TimelinePoint[], minGap = 0.16): boolean[] {
    const firstNext = points.findIndex((p) => p.kind === "next");
    const order = [firstNext, points.findIndex((p) => p.kind === "last"), points.findIndex((p) => p.kind === "now"), ...points.map((_, i) => i)].filter((i, k, a) => i >= 0 && a.indexOf(i) === k);
    const out = points.map(() => false);
    const taken: number[] = [];
    for (const i of order) {
        if (taken.every((at) => Math.abs(at - points[i].at) >= minGap)) {
            out[i] = true;
            taken.push(points[i].at);
        }
    }
    return out;
}
