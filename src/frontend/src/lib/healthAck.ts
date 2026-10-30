/**
 * 「伺服器狀態」的「已確認」：哪張卡能確認、卡片該怎麼畫、總覽的一行、備註的限制，以及
 * `POST /api/site/health/ack` 的錯誤怎麼對應。純函式，有測試（`healthAck.test.ts`）。
 * Server health acknowledgements: which card can be acknowledged, how a card is drawn, the overview's line, the
 * note's limits and how `POST /api/site/health/ack` errors map. Pure, tested (`healthAck.test.ts`).
 */
import { groupOf, isAcked, sortChecks, type HealthCheck, type HealthGroup, type HealthStatus, type StatusCounts } from "./serverHealth.ts";

/** 備註最長幾個字元（後端同一個上限）。/ The note's maximum length (the backend's limit too). */
export const ACK_NOTE_MAX = 500;

/**
 * 一張檢查卡的樣子：
 * - `plain`：一般（✓ / i，或還沒確認過的 ⚠ / ✗）；
 * - `acked`：確認過這個結果（中性、細節收起來）；
 * - `stale`：之前確認過、結果變了（照原本的紅 / 黃，最上面多一段說明）。
 * A check card's look: `plain`, `acked` (neutral, details folded away) or `stale` (red / amber again with a note
 * on top saying an earlier result was acknowledged).
 */
export type CardLook = "plain" | "acked" | "stale";

export function cardLook(c: HealthCheck): CardLook {
    if (isAcked(c)) return "acked";
    if (c.staleAck && (c.status === "warn" || c.status === "fail")) return "stale";
    return "plain";
}

/**
 * 能不能按「確認…」：沒確認過的 ⚠ / ✗，而且有 id 與指紋（較舊的後端沒有，就不能確認）。
 * Whether "Acknowledge…" shows: an unacknowledged warning / failure with an id and a fingerprint (older backends
 * send none, so nothing can be acknowledged there).
 */
export function canAcknowledge(c: HealthCheck): boolean {
    return (c.status === "warn" || c.status === "fail") && !isAcked(c) && !!c.id && c.fingerprint !== "";
}

/** 確認過的 ⚠ / ✗，✗ 在前。/ The acknowledged warnings and failures, failures first. */
export function ackedChecks(checks: HealthCheck[]): HealthCheck[] {
    return sortChecks(checks.filter(isAcked));
}

/** 總覽的「N 項已確認 — 前往第一項的分頁」。/ The overview's "N acknowledged — open the first one's tab". */
export function ackedSummary(checks: HealthCheck[]): { count: number; group: HealthGroup } | null {
    const acked = ackedChecks(checks);
    return acked.length ? { count: acked.length, group: groupOf(acked[0]) } : null;
}

/**
 * 總覽格子的色調：有問題照最嚴重那級；沒問題但有確認過的、或只有備註（或沒東西）= 灰；其餘 = 綠。
 * An overview tile's tone: the worst level when something is open; grey when only acknowledged problems, notes or
 * nothing at all; green otherwise.
 */
export function tileTone(worst: "ok" | "warn" | "fail", counts: StatusCounts): HealthStatus {
    if (worst !== "ok") return worst;
    if (counts.acked > 0 || counts.ok === 0) return "info";
    return "ok";
}

export type NoteProblem = "empty" | "tooLong";

/** 備註的問題（前後空白不算）。/ What is wrong with the note (surrounding whitespace ignored). */
export function noteProblem(note: string): NoteProblem | null {
    const n = [...note.trim()].length;
    if (n === 0) return "empty";
    if (n > ACK_NOTE_MAX) return "tooLong";
    return null;
}

/** 計字數：跟後端一樣算字元（不是 UTF-16）。/ Character count, by code points like the backend. */
export function noteLength(note: string): number {
    return [...note.trim()].length;
}

export type AckFailure =
    | { kind: "reauth"; methods: string[] }
    | { kind: "changed" }
    | { kind: "notAProblem" }
    | { kind: "note"; message: string }
    | { kind: "other"; message: string | null };

/**
 * `POST /api/site/health/ack`（或 DELETE）失敗時的意思：403 `reauth_required` → 再驗證；409 `changed` → 結果在你看的時候
 * 變了；400 `not_a_problem` → 已經不是問題了；400 `{note: [msg]}` → 備註欄的錯誤；其他 → 後端的訊息（或 null）。
 * What a failed acknowledgement means: re-authenticate, the result changed, it is no longer a problem, a note field
 * error, or anything else (the server's message, or null).
 */
export function classifyAckError(status: number, body: unknown): AckFailure {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    if (status === 403 && b.code === "reauth_required") {
        return { kind: "reauth", methods: Array.isArray(b.methods) ? b.methods.filter((m): m is string => typeof m === "string") : [] };
    }
    if (status === 409 || b.code === "changed") return { kind: "changed" };
    if (b.code === "not_a_problem") return { kind: "notAProblem" };
    if (Array.isArray(b.note) && typeof b.note[0] === "string") return { kind: "note", message: b.note[0] };
    if (typeof b.note === "string") return { kind: "note", message: b.note };
    const message = typeof b.error === "string" ? b.error : typeof b.detail === "string" ? b.detail : null;
    return { kind: "other", message };
}
