/**
 * 重新封存審計鏈（伺服器狀態頁）：`GET /api/site/health/audit` 的試算怎麼解析、哪張卡能封存、每張表的名稱與問題、
 * 總數，以及原因代碼對應的翻譯 key（日誌頁的「驗證完整性」也用）。純函式，有測試（`auditReseal.test.ts`）。
 * Re-sealing the audit chain (Server health): parse the `GET /api/site/health/audit` dry run, which card offers it,
 * each table's name and problem, the totals, and the reason codes' translation keys (shared with the Logs page's
 * "Verify integrity"). Pure, tested (`auditReseal.test.ts`).
 */
import type { TranslationKey } from "@/locales/en";
import type { HealthCheck, HealthStatus } from "./serverHealth.ts";

/** 三張審計表的名稱。/ The three audit tables' names. */
export const AUDIT_TABLE_LABEL: Record<string, TranslationKey> = {
    telepy_gateway_event: "logs.verify.table.gateway",
    telepy_sign_in_event: "logs.verify.table.signIn",
    telepy_ai_audit_event: "logs.verify.table.ai",
};

/** 斷在哪裡的原因代碼 → 一句話。/ Reason codes → a sentence. */
export const AUDIT_REASON: Record<string, TranslationKey> = {
    hash_mismatch: "logs.verify.reason.hash_mismatch",
    link_mismatch: "logs.verify.reason.link_mismatch",
    missing_hash: "logs.verify.reason.missing_hash",
    checkpoint_mismatch: "logs.verify.reason.checkpoint_mismatch",
    checkpoint_missing: "logs.verify.reason.checkpoint_missing",
};

/** 一次重新封存（一張表）。/ One table of one re-seal. */
export interface AuditReseal {
    resealId: string;
    at: string;
    table: string;
    /** 之後的鏈頭（0 = 沒有有 hash 的列）。/ The head afterwards (0 = no hashed rows). */
    rowId: number;
    rehashed: number;
    fromRow: number | null;
    retired: number;
    problem: string;
    username: string;
    note: string;
}

/** 一張表：驗證結果 + 封存會做什麼。/ One table: the verification plus what re-sealing would do. */
export interface AuditResealTable {
    table: string;
    ok: boolean;
    checked: number;
    /** 鏈本身最早的問題。/ The chain's own first issue. */
    chainAt: number | null;
    chainReason: string | null;
    chainIssues: number;
    /** 與錨點檔最早的不符。/ The first mismatch with the anchors file. */
    checkpointAt: number | null;
    checkpointReason: string | null;
    checkpointsMismatched: number;
    /** doctor 的說法（失敗的表才有）。/ The doctor's words (failing tables only). */
    problem: string | null;
    rehash: number;
    fromRow: number | null;
    retire: number;
}

export interface AuditResealPlan {
    status: HealthStatus;
    fingerprint: string;
    detail: string;
    canReseal: boolean;
    tables: AuditResealTable[];
    /** 之前的封存，新的在前。/ Earlier re-seals, newest first. */
    reseals: AuditReseal[];
    anchorsFile: boolean;
}

const int = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** 一筆封存紀錄；形狀不對回 null。/ One re-seal record; null when the shape is wrong. */
export function parseReseal(v: unknown): AuditReseal | null {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o.reseal_id !== "string" || typeof o.table !== "string" || typeof o.at !== "string") return null;
    return {
        resealId: o.reseal_id,
        at: o.at,
        table: o.table,
        rowId: int(o.row_id),
        rehashed: int(o.rehashed),
        fromRow: intOrNull(o.from_row),
        retired: int(o.retired),
        problem: str(o.problem),
        username: str(o.username),
        note: str(o.note),
    };
}

const STATUSES: HealthStatus[] = ["ok", "info", "warn", "fail"];

/** `GET /api/site/health/audit` → 型別；形狀不對回 null。/ The dry run, typed; null when the shape is wrong. */
export function parseResealPlan(raw: unknown): AuditResealPlan | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.fingerprint !== "string" || !Array.isArray(r.tables)) return null;
    const tables: AuditResealTable[] = r.tables.flatMap((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        if (typeof o.table !== "string") return [];
        return [
            {
                table: o.table,
                ok: o.ok === true,
                checked: int(o.checked),
                chainAt: intOrNull(o.chain_broken_at),
                chainReason: strOrNull(o.chain_reason),
                chainIssues: int(o.chain_issues),
                checkpointAt: intOrNull(o.checkpoint_broken_at),
                checkpointReason: strOrNull(o.checkpoint_reason),
                checkpointsMismatched: int(o.checkpoints_mismatched),
                problem: strOrNull(o.problem),
                rehash: int(o.rehash),
                fromRow: intOrNull(o.from_row),
                retire: int(o.retire),
            },
        ];
    });
    return {
        status: STATUSES.includes(r.status as HealthStatus) ? (r.status as HealthStatus) : "info",
        fingerprint: r.fingerprint,
        detail: str(r.detail),
        canReseal: r.can_reseal === true,
        tables,
        reseals: Array.isArray(r.reseals) ? r.reseals.flatMap((x) => parseReseal(x) ?? []) : [],
        anchorsFile: r.anchors_file === true,
    };
}

/**
 * 卡片上要不要有「重新封存…」：只有審計鏈、只在 ✗（確認過也可以，確認不等於修好）、要有指紋（舊後端沒有）。
 * Whether the card offers "Re-seal…": the audit-log check only, while it fails (acknowledged or not — an
 * acknowledgement is not a fix), with a fingerprint (older backends send none).
 */
export function canReseal(c: HealthCheck): boolean {
    return c.id === "audit_log" && c.status === "fail" && c.fingerprint !== "";
}

/** 封存會動到的表的總數：幾張表、重算幾列、作廢幾行、最早從哪一列。/ Totals over the failing tables. */
export function resealTotals(plan: AuditResealPlan): { tables: number; rehash: number; retire: number; fromRow: number | null } {
    const failing = plan.tables.filter((t) => !t.ok);
    const rows = failing.map((t) => t.fromRow).filter((v): v is number => v !== null);
    return {
        tables: failing.length,
        rehash: failing.reduce((n, t) => n + t.rehash, 0),
        retire: failing.reduce((n, t) => n + t.retire, 0),
        fromRow: rows.length ? Math.min(...rows) : null,
    };
}

/** 一張表的問題，拆成「鏈本身」與「錨點檔」兩句（各自的列與原因）。/ A table's problem as two parts: the chain and the anchors file. */
export function tableIssues(t: AuditResealTable): { kind: "chain" | "checkpoint"; row: number; reason: string; more: number }[] {
    const out: { kind: "chain" | "checkpoint"; row: number; reason: string; more: number }[] = [];
    if (t.chainAt !== null && t.chainReason) out.push({ kind: "chain", row: t.chainAt, reason: t.chainReason, more: Math.max(0, t.chainIssues - 1) });
    if (t.checkpointAt !== null && t.checkpointReason) out.push({ kind: "checkpoint", row: t.checkpointAt, reason: t.checkpointReason, more: Math.max(0, t.checkpointsMismatched - 1) });
    return out;
}

/**
 * 封存紀錄依那一次（同一個 id）合在一起，新的在前：誰、什麼時候、備註、動到的表。
 * Re-seal records grouped per re-seal (same id), newest first: who, when, the note and the tables.
 */
export interface ResealGroup {
    id: string;
    at: string;
    username: string;
    note: string;
    tables: AuditReseal[];
}

export function groupReseals(records: AuditReseal[]): ResealGroup[] {
    const out: ResealGroup[] = [];
    for (const r of records) {
        const g = out.find((x) => x.id === r.resealId);
        if (g) g.tables.push(r);
        else out.push({ id: r.resealId, at: r.at, username: r.username, note: r.note, tables: [r] });
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
