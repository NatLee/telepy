/**
 * 裝置怎麼連 Telepy（自動 / 只走 SSH 的 port / 只走網頁的 port）的純函式：換的對話框一開始選哪個、某個方式在「SSH 的
 * port 被擋 / 網頁的 port 被擋」時走哪條路（說明圖用），以及三種方式的對照表。不碰 React。
 * Pure helpers for how a device reaches Telepy (automatic / the SSH port only / the web port only): which way the
 * switch dialog starts on, which lane a way takes when the SSH port or the web port is blocked (for the diagram), and
 * the comparison table of the three. No React.
 */
import type { WayInSetup } from "./deviceInstall.ts";
import type { TranslationKey } from "../locales/en.ts";

/** 三種方式，建議的（自動）在前。/ The three ways, the recommended one (automatic) first. */
export const WAY_CHOICES: readonly WayInSetup[] = ["auto", "ssh", "websocket"];

/** 換的對話框一開始選哪個：還不是自動就選自動（建議），已經是自動就不先選，讓人自己挑。/ The switch dialog's first pick. */
export function initialChoice(current: WayInSetup | null | undefined): WayInSetup | null {
    return current === "auto" ? null : "auto";
}

/** 選了現在這一種 = 重新安裝（換成這台伺服器現在的 SSH 主機與小幫手版本）。/ The current way again = a reinstall. */
export function isReinstall(choice: WayInSetup | null, current: WayInSetup | null | undefined): boolean {
    return choice !== null && choice === current;
}

/** 假設哪個 port 被擋（說明圖的「如果…」開關）。/ Which port is assumed blocked (the diagram's "what if" switches). */
export interface Blocked {
    ssh: boolean;
    web: boolean;
}

export const NOTHING_BLOCKED: Blocked = { ssh: false, web: false };

/**
 * 圖上一條路的角色：走這條 / 備著（自動時網頁的 port 等 SSH 的 port 被擋）/ 想走但被擋 / 不走這條。
 * A lane's role: used / on standby (automatic's web port waits for the SSH port to be blocked) / wanted but blocked /
 * not used.
 */
export type LaneState = "used" | "standby" | "blocked" | "unused";

export interface Outcome {
    ssh: LaneState;
    web: LaneState;
    /** 通道最後走哪條；null = 離線（重試到通為止）。/ Where the tunnel ends up; null = offline (retrying). */
    via: "ssh" | "web" | null;
}

/** 某個方式在某種封鎖下的結果。/ The outcome of a way under the given blocks. */
export function outcome(way: WayInSetup, blocked: Blocked = NOTHING_BLOCKED): Outcome {
    if (way === "ssh") return { ssh: blocked.ssh ? "blocked" : "used", web: "unused", via: blocked.ssh ? null : "ssh" };
    if (way === "websocket") return { ssh: "unused", web: blocked.web ? "blocked" : "used", via: blocked.web ? null : "web" };
    // 自動：SSH 的 port 先；通的話網頁的 port 只是備著。/ Automatic: the SSH port first; the web port only waits.
    if (!blocked.ssh) return { ssh: "used", web: "standby", via: "ssh" };
    return { ssh: "blocked", web: blocked.web ? "blocked" : "used", via: blocked.web ? null : "web" };
}

/** 圖下面那一句。/ The sentence under the diagram. */
export function outcomeKey(way: WayInSetup, blocked: Blocked = NOTHING_BLOCKED): TranslationKey {
    const o = outcome(way, blocked);
    if (way === "ssh") return o.via ? "wayIn.out.sshOk" : "wayIn.out.sshBlocked";
    if (way === "websocket") return o.via ? "wayIn.out.webOk" : "wayIn.out.webBlocked";
    if (o.via === "ssh") return "wayIn.out.autoOk";
    return o.via === "web" ? "wayIn.out.autoFallback" : "wayIn.out.autoBoth";
}

export type CellTone = "good" | "bad" | "neutral";

export interface WayRow {
    label: TranslationKey;
    cells: Record<WayInSetup, { text: TranslationKey; tone: CellTone }>;
}

const cell = (text: TranslationKey, tone: CellTone = "neutral") => ({ text, tone });

/** 三種方式的對照表（列 = 一件事，欄 = 一種方式）。/ The comparison table (rows = one fact, columns = one way). */
export const WAY_ROWS: readonly WayRow[] = [
    { label: "wayIn.row.port", cells: { auto: cell("wayIn.c.portAuto"), ssh: cell("wayIn.c.portSsh"), websocket: cell("wayIn.c.portWeb") } },
    { label: "wayIn.row.speed", cells: { auto: cell("wayIn.c.speedAuto", "good"), ssh: cell("wayIn.c.speedSsh", "good"), websocket: cell("wayIn.c.speedWeb", "bad") } },
    { label: "wayIn.row.blocked", cells: { auto: cell("wayIn.c.blockedAuto", "good"), ssh: cell("wayIn.c.blockedSsh", "bad"), websocket: cell("wayIn.c.blockedWeb", "good") } },
    { label: "wayIn.row.back", cells: { auto: cell("wayIn.c.backAuto", "good"), ssh: cell("wayIn.c.backSsh"), websocket: cell("wayIn.c.backWeb", "bad") } },
    { label: "wayIn.row.needs", cells: { auto: cell("wayIn.c.needsAuto"), ssh: cell("wayIn.c.needsSsh", "good"), websocket: cell("wayIn.c.needsWeb") } },
    { label: "wayIn.row.when", cells: { auto: cell("wayIn.c.whenAuto", "good"), ssh: cell("wayIn.c.whenSsh"), websocket: cell("wayIn.c.whenWeb") } },
];

/** 卡片上的一句話（是什麼）。/ The one-line "what it is" on each card. */
export const WAY_WHAT: Record<WayInSetup, TranslationKey> = {
    auto: "wayIn.what.auto",
    ssh: "wayIn.what.ssh",
    websocket: "wayIn.what.websocket",
};

/** 換成某個方式之前要知道的（需要什麼、會怎樣）。/ What to know before switching to a way. */
export const WAY_NEEDS: Record<WayInSetup, TranslationKey> = {
    auto: "deviceInstall.switch.needs",
    ssh: "deviceInstall.switch.needsSsh",
    websocket: "deviceInstall.switch.needsWeb",
};

/** 換好之後的標題 / 內文（`no_carrier` = 自動卻沒有小幫手，只走 SSH 的 port）。/ The result after a switch. */
export function doneKeys(transport: WayInSetup | undefined, noCarrier: boolean): { title: TranslationKey; body: TranslationKey; toast: TranslationKey } {
    if (noCarrier) return { title: "deviceInstall.switch.doneNoCarrier", body: "deviceInstall.switch.doneNoCarrierBody", toast: "deviceInstall.switch.doneToastSsh" };
    if (transport === "ssh") return { title: "deviceInstall.switch.doneSsh", body: "deviceInstall.switch.doneSshBody", toast: "deviceInstall.switch.doneToastSsh" };
    if (transport === "websocket") return { title: "deviceInstall.switch.doneWeb", body: "deviceInstall.switch.doneWebBody", toast: "deviceInstall.switch.doneToastWeb" };
    return { title: "deviceInstall.switch.done", body: "deviceInstall.switch.doneBody", toast: "deviceInstall.switch.doneToast" };
}

/** `lib/devicePlatforms.wayInOf` 的結果裡這裡用到的部分。/ The part of `wayInOf`'s result used here. */
export interface WayInSeen {
    via: "ssh" | "wss" | "ws";
    state: "live" | "last" | "setup";
}

export interface WayPicture {
    /** 圖要畫哪一種。/ Which way to draw. */
    way: WayInSetup;
    /** 從實際連線推得的封鎖（自動卻走網頁 port = SSH port 這陣子連不上）。/ Blocks implied by the live connection. */
    blocked: Blocked;
    /** 圖上面那一句。/ The status line above the diagram. */
    status: TranslationKey;
    /** 實際走的跟設定的不同（例如在裝置上手動改過）。/ The way it came in differs from how it was set up. */
    differs: boolean;
}

/**
 * 「連線方式」分頁那張圖要畫什麼：設定的方式，加上實際連線告訴我們的事。自動卻正走網頁的 port，代表 SSH 的 port 這陣子
 * 連不上，就把那條畫成被擋；設定一種、實際走另一種，就畫實際的那種並說明。都不知道 = null。
 * What the "How it connects" tab draws: the way it was set up plus what the live connection says. Automatic but on the
 * web port means the SSH port did not answer lately, so that lane is drawn blocked; set up one way but in another, the
 * actual one is drawn with a note. Nothing known = null.
 */
export function wayPicture(setup: WayInSetup | null | undefined, seen: WayInSeen | null): WayPicture | null {
    const lane = seen && seen.state !== "setup" ? (seen.via === "ssh" ? "ssh" : "web") : null;
    const live = seen?.state === "live";
    const status = (fallback: boolean): TranslationKey => (!seen || seen.state === "setup" ? "wayIn.now.never" : !live ? "wayIn.now.offline" : fallback ? "wayIn.now.liveFallback" : "wayIn.now.live");
    if (setup === "auto") {
        const fellBack = live && lane === "web";
        return { way: "auto", blocked: fellBack ? { ssh: true, web: false } : NOTHING_BLOCKED, status: status(fellBack), differs: false };
    }
    if (setup === "ssh" || setup === "websocket") {
        const setupLane = setup === "ssh" ? "ssh" : "web";
        if (lane && lane !== setupLane) return { way: lane === "ssh" ? "ssh" : "websocket", blocked: NOTHING_BLOCKED, status: status(false), differs: true };
        return { way: setup, blocked: NOTHING_BLOCKED, status: status(false), differs: false };
    }
    if (!lane) return null;
    return { way: lane === "ssh" ? "ssh" : "websocket", blocked: NOTHING_BLOCKED, status: status(false), differs: false };
}

/**
 * 不能在這裡換的原因（盤點的 blocker 代碼，用換連線方式的說法；改名的說法在 `deviceInstall.block.*`）。
 * Why switching is not possible here, worded for switching (the rename's wording is `deviceInstall.block.*`).
 */
export const SWITCH_BLOCK_KEY: Record<string, TranslationKey> = {
    not_surveyed: "wayIn.block.not_surveyed",
    windows: "wayIn.block.windows",
    no_process: "wayIn.block.no_process",
    nothing_to_rename: "wayIn.block.no_process",
    unparsed: "wayIn.block.unparsed",
    needs_root: "wayIn.block.needs_root",
    unknown_owner: "wayIn.block.unknown_owner",
    odd_command: "wayIn.block.odd_command",
    unsupported: "wayIn.block.unsupported",
    extra: "wayIn.block.extra",
};

export function switchBlockKey(code: string | null | undefined): TranslationKey {
    return (code && SWITCH_BLOCK_KEY[code]) || "wayIn.block.other";
}
