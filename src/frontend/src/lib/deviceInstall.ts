/**
 * 隧道在裝置上的名稱（安裝代號）與足跡：型別與純函式。後端見 `device_install/`。
 * - 盤點到的東西依種類分組，標出「用代號取的新名稱」或「舊名稱」（舊名稱可能看得出是誰裝的）。
 * - 改名是「先接上再拆舊的」七步：盤點 → 裝新服務 → 新服務連上當備援 → 經備援登入確認 → 備援接手 → 移除舊的 → 再確認。
 *   每一步的狀態、圖上「舊服務 / 新服務」兩條線現在是什麼樣子，都從回報的步驟算出來。
 * A tunnel's install names and footprint on its device: types and pure helpers (backend: `device_install/`). Parts
 * are grouped and marked private (named after the install id) or older; the make-before-break rename has seven steps,
 * and both the step list and the old / new lanes of the diagram are derived from the reported steps.
 */
import type { SpotState } from "@/lib/flow";
import type { TranslationKey } from "@/locales/en";

export type InstallMethod = "systemd" | "systemd_user" | "launchd_daemon" | "launchd_agent" | "loop";

export type RenameBlocker = "not_surveyed" | "windows" | "nothing_to_rename" | "no_process" | "unparsed" | "needs_root" | "unknown_owner" | "odd_command";

export interface InstallPart {
    kind: "service" | "process" | "cron" | "container" | "script" | "file";
    what: string;
    name: string;
    account: string;
    private: boolean;
    /** Telepy 以前的標準名稱（不帶人名，可以留著）。/ One of Telepy's earlier standard names (fine to keep). */
    earlier: boolean;
}

export interface DeviceInstallView {
    install_id: string;
    names: { systemd: string; launchd: string; loop: string; known_hosts: string; container: string; description: string };
    online: boolean;
    busy: boolean;
    surveyed_at: string | null;
    survey_error: string | null;
    accounts: { account: string; platform: "posix" | "windows" | null; os: string | null; error: string | null }[];
    parts: InstallPart[];
    /** 要改名的（可能看得出是誰裝的）。/ To rename (may show who set the device up). */
    older: string[];
    /** Telepy 以前的標準名稱：可以留著，要改也行。/ Earlier standard names: fine to keep, may be renamed. */
    earlier: string[];
    /** 裝置上連到別台伺服器的東西（從不碰）。/ Things dialing another server (never touched). */
    others: OtherServerPart[];
    /** 別台伺服器的通道也在用的金鑰檔（刪除時留著）。/ The key file another server's tunnel uses too (kept on delete). */
    shared_key: string | null;
    /** 這台伺服器的 gateway port。/ This server's gateway port. */
    server_port: string;
    rename: { possible: boolean; blocker: RenameBlocker | null; method?: InstallMethod; account?: string; run_user?: string; new_name?: string; old: string[] };
    renamed_at: string | null;
    renamed_from: string[];
}

export interface OtherServerPart {
    name: string;
    port: number | null;
    process: boolean;
    account: string;
}

/** 關係圖的一列：裝置上的服務 ─ 連到哪台伺服器。/ One row of the device map: services ─ the server they dial. */
export interface MapRow {
    kind: "this" | "other";
    /** 別台的 port（this = 這台的）。/ The port dialed. */
    port: string;
    services: { name: string; note: "private" | "earlier" | "older" | "process" | "other" }[];
}

/**
 * 裝置上的東西依「連到哪台伺服器」分列：先這條通道（這台伺服器），再每個別台的 port 一列。
 * 正在跑的 ssh 只在那一列沒有別的名字時才列出（unit / 腳本比較好認）。
 * Rows of the device map by the server each thing dials: this tunnel first, then one row per other port. A running ssh
 * is listed only when its row has no named service (a unit or script is easier to recognise).
 */
export function mapRows(view: Pick<DeviceInstallView, "parts" | "others" | "server_port">): MapRow[] {
    const mine = view.parts.filter((p) => p.kind === "service" || p.kind === "container");
    const thisRow: MapRow = {
        kind: "this",
        port: view.server_port,
        services: mine.map((p) => ({ name: p.name, note: p.private ? "private" : p.earlier ? "earlier" : "older" })),
    };
    if (thisRow.services.length === 0 && view.parts.some((p) => p.kind === "process")) thisRow.services.push({ name: "ssh", note: "process" });
    const byPort = new Map<string, OtherServerPart[]>();
    for (const o of view.others) {
        const key = o.port == null ? "?" : String(o.port);
        byPort.set(key, [...(byPort.get(key) ?? []), o]);
    }
    const rows: MapRow[] = [thisRow];
    for (const [port, list] of byPort) {
        const named = list.filter((o) => !o.process);
        const shown = named.length > 0 ? named : list.slice(0, 1);
        rows.push({ kind: "other", port, services: shown.map((o) => ({ name: o.process ? "ssh" : o.name, note: o.process ? "process" : "other" })) });
    }
    return rows;
}

export const RENAME_STEPS = ["survey", "install", "standby", "check", "switch", "remove", "confirm"] as const;
export type RenameStep = (typeof RENAME_STEPS)[number];

export interface ReportedStep {
    id: RenameStep;
    state: "done" | "failed";
    detail?: string;
}

export interface RenameReport {
    ok: boolean;
    steps: ReportedStep[];
    code?: string;
    error?: string;
    method?: InstallMethod;
    account?: string;
    new_name?: string;
    old: string[];
    log?: string;
}

/** 列表項目上的摘要（擁有者 / ADMIN）。/ The list item's summary for managers. */
export interface DeviceInstallSummary {
    id: string;
    older: string[];
}

/** 盤點到的東西分組（服務在最前）。/ Group the parts, services first. */
export function groupParts(parts: InstallPart[]): { kind: InstallPart["kind"]; parts: InstallPart[] }[] {
    const order: InstallPart["kind"][] = ["service", "container", "process", "cron", "script", "file"];
    return order.map((kind) => ({ kind, parts: parts.filter((p) => p.kind === kind) })).filter((g) => g.parts.length > 0);
}

/** 每一步現在的狀態：回報過的照回報、正在跑的下一步是進行中、其餘待命。/ Each step's state. */
export function stepStates(reported: ReportedStep[], running: boolean): Record<RenameStep, SpotState> {
    const out = {} as Record<RenameStep, SpotState>;
    let next: RenameStep | null = null;
    const failed = reported.some((s) => s.state === "failed" && s.id !== "remove" && s.id !== "confirm");
    for (const id of RENAME_STEPS) {
        const r = reported.find((s) => s.id === id);
        if (r) out[id] = r.state === "done" ? "ok" : "failed";
        else {
            if (next === null && running && !failed) {
                next = id;
                out[id] = "active";
            } else out[id] = "waiting";
        }
    }
    return out;
}

/** 圖上兩條線：舊服務（現在帶著隧道的）與新服務（備援 → 接手）。/ The diagram's old and new lanes. */
export function lanes(reported: ReportedStep[], running: boolean): { old: SpotState; new: SpotState; carrying: "old" | "new" } {
    const s = stepStates(reported, running);
    const switched = s.switch === "ok";
    const undone = (["install", "standby", "check", "switch"] as const).some((k) => s[k] === "failed");
    // 切換前舊的一直帶著隧道；切換後它被拆掉（拆完 = 待命 / 不在了）。/ Before the switch the old one carries the tunnel.
    const oldLane: SpotState = !switched ? "ok" : s.remove === "ok" ? "waiting" : s.remove === "active" ? "active" : s.remove === "failed" ? "failed" : "ok";
    const newLane: SpotState = undone ? "failed" : switched ? "ok" : s.standby === "ok" ? "active" : s.install === "active" || s.standby === "active" ? "active" : "waiting";
    return { old: oldLane, new: newLane, carrying: switched ? "new" : "old" };
}

export const BLOCKER_KEY: Record<RenameBlocker, TranslationKey> = {
    not_surveyed: "deviceInstall.block.not_surveyed",
    windows: "deviceInstall.block.windows",
    nothing_to_rename: "deviceInstall.block.nothing_to_rename",
    no_process: "deviceInstall.block.no_process",
    unparsed: "deviceInstall.block.unparsed",
    needs_root: "deviceInstall.block.needs_root",
    unknown_owner: "deviceInstall.block.unknown_owner",
    odd_command: "deviceInstall.block.odd_command",
};

const FAILURE_KEY: Record<string, TranslationKey> = {
    survey_failed: "deviceInstall.fail.survey_failed",
    login_failed: "deviceInstall.fail.login_failed",
    install_failed: "deviceInstall.fail.install_failed",
    standby_timeout: "deviceInstall.fail.standby_timeout",
    check_failed: "deviceInstall.fail.check_failed",
    switch_failed: "deviceInstall.fail.switch_failed",
    old_left: "deviceInstall.fail.old_left",
    old_came_back: "deviceInstall.fail.old_came_back",
    device_offline: "deviceInstall.fail.device_offline",
};

/** 失敗的說明：先看是不是盤點擋下（blocker），再看失敗代碼。/ Explain a failure: a blocker first, then the code. */
export function failureKey(code: string | undefined): TranslationKey {
    if (code && code in BLOCKER_KEY) return BLOCKER_KEY[code as RenameBlocker];
    return (code && FAILURE_KEY[code]) || "deviceInstall.fail.other";
}

/** 失敗之後舊服務還在不在帶隧道（切換之前失敗 = 一切照舊）。/ Did the old service keep the tunnel (failed before the switch)? */
export function untouched(report: RenameReport): boolean {
    return !report.ok && !report.steps.some((s) => s.id === "switch" && s.state === "done");
}

export const METHOD_KEY: Record<InstallMethod, TranslationKey> = {
    systemd: "deviceInstall.method.systemd",
    systemd_user: "deviceInstall.method.systemd_user",
    launchd_daemon: "deviceInstall.method.launchd_daemon",
    launchd_agent: "deviceInstall.method.launchd_agent",
    loop: "deviceInstall.method.loop",
};

/** 盤點結果裡要 root 才清得掉的指令（改名後回報）。/ Commands that still need root after a rename. */
export function rootCommands(report: RenameReport): string[] {
    const step = report.steps.find((s) => s.id === "remove");
    return step?.detail ? step.detail.split("\n").filter(Boolean) : [];
}
