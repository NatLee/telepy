/**
 * 遠端桌面的「這條連線上有哪些資料流」（純函式，無 React）：畫面、輸入、剪貼簿、聲音、檔案，各自的方向與狀態。
 * info 對話框的路徑圖下面畫成並排的直線（DesktopStreams），讓人一眼看出「為什麼 VNC 沒有聲音」「為什麼這裡不能傳檔」。
 * 狀態：on = 這次連線有；oneWay = 只有一個方向（剪貼簿 to_remote）；off = 自己關了；blocked = 管理員的上限關掉；
 * unsupported = 這種連法本來就沒有（guacd 的 VNC 沒聲音、RDP / VNC 在瀏覽器裡不傳檔）。
 * The streams a desktop connection carries — picture, input, clipboard, sound, files — with their direction and
 * state, drawn as parallel lines under the path diagram so it is obvious why VNC has no sound or why files are
 * unavailable here.
 */
import type { TranslationKey } from "@/locales/en";
import type { ClipboardPolicy, DesktopMode } from "@/lib/desktop";
import { FILE_OP_KINDS, type FileActivity, type FileOpKind, type FileOpState } from "./rustdeskFileOps.ts";

export type StreamId = "picture" | "input" | "clipboard" | "sound" | "files";
export const STREAM_IDS: readonly StreamId[] = ["picture", "input", "clipboard", "sound", "files"];
export type StreamState = "on" | "oneWay" | "off" | "blocked" | "unsupported";
/** 資料往哪走：桌面 → 瀏覽器、瀏覽器 → 桌面、雙向。/ Which way the data flows. */
export type StreamDir = "toBrowser" | "toDesktop" | "both";

export interface StreamRow {
    id: StreamId;
    state: StreamState;
    dir: StreamDir;
    /** 這一列為什麼是這個狀態（一句話）。/ Why this row is in this state. */
    reason: TranslationKey;
    /** 「檔案」這一列底下的動作（下載 / 上傳 / 改名 / 刪除）與各自的狀態。/ The file actions under the Files row. */
    ops?: { kind: FileOpKind; state: FileOpState }[];
}

export interface StreamInput {
    mode: DesktopMode;
    /** 這次（或下次）的剪貼簿方向：使用者的選擇套上上限。/ The clipboard direction in effect. */
    clipboard: ClipboardPolicy | null;
    /** 站台上限。/ The site's ceiling. */
    clipboardLimit: ClipboardPolicy;
    /** 使用者要聲音（RDP：這次連線；RustDesk：目前的開關）。/ The user wants sound. */
    sound: boolean;
    /** RDP：這個分頁把聲音靜音了（串流照收）。/ RDP: muted in this tab (the stream keeps coming). */
    muted?: boolean;
    /** 瀏覽器播得了 RustDesk 的聲音（WebCodecs AudioDecoder）。/ The browser can decode RustDesk's sound. */
    soundDecoder: boolean;
    /** 站台允許 RustDesk 傳檔（`desktop_file_transfer`）。/ The site allows RustDesk file transfer. */
    fileTransfer: boolean;
    /** 「檔案」面板開著。/ The Files panel is open. */
    filesOpen: boolean;
    /** 面板裡各種檔案動作的狀態。/ The state of each kind of file action in the panel. */
    fileActivity?: FileActivity;
}

function clipboardRow(c: ClipboardPolicy | null, limit: ClipboardPolicy): StreamRow {
    const base = { id: "clipboard" as const };
    if (c === "off" || c === null) {
        return limit === "off"
            ? { ...base, state: "blocked", dir: "both", reason: "desktop.streams.reason.clipboardBlocked" }
            : { ...base, state: "off", dir: "both", reason: "desktop.streams.reason.clipboardOff" };
    }
    if (c === "to_remote") {
        return { ...base, state: "oneWay", dir: "toDesktop", reason: limit === "to_remote" ? "desktop.streams.reason.clipboardLimited" : "desktop.streams.reason.clipboardToRemote" };
    }
    return { ...base, state: "on", dir: "both", reason: "desktop.streams.reason.clipboardBoth" };
}

function soundRow(i: StreamInput): StreamRow {
    const base = { id: "sound" as const, dir: "toBrowser" as const };
    if (i.mode === "vnc") return { ...base, state: "unsupported", reason: "desktop.streams.reason.soundVnc" };
    if (i.mode === "rustdesk" && !i.soundDecoder) return { ...base, state: "unsupported", reason: "desktop.streams.reason.soundNoDecoder" };
    if (!i.sound) return { ...base, state: "off", reason: i.mode === "rdp" ? "desktop.streams.reason.soundOffRdp" : "desktop.streams.reason.soundOffRd" };
    if (i.muted) return { ...base, state: "off", reason: "desktop.streams.reason.soundMuted" };
    return { ...base, state: "on", reason: i.mode === "rdp" ? "desktop.streams.reason.soundRdp" : "desktop.streams.reason.soundRd" };
}

function filesRow(i: StreamInput): StreamRow {
    const base = { id: "files" as const, dir: "both" as const };
    if (i.mode !== "rustdesk") return { ...base, state: "unsupported", reason: "desktop.streams.reason.filesGuacd" };
    if (!i.fileTransfer) return { ...base, state: "blocked", reason: "desktop.streams.reason.filesBlocked" };
    const ops = FILE_OP_KINDS.map((kind) => ({ kind, state: i.fileActivity?.[kind] ?? "idle" }));
    if (!i.filesOpen) return { ...base, state: "off", reason: "desktop.streams.reason.filesClosed", ops };
    return { ...base, state: "on", reason: "desktop.streams.reason.filesOpen", ops };
}

/** 五條資料流，順序固定。/ The five streams in a fixed order. */
export function streamRows(i: StreamInput): StreamRow[] {
    return [
        { id: "picture", state: "on", dir: "toBrowser", reason: i.mode === "rustdesk" ? "desktop.streams.reason.pictureRd" : "desktop.streams.reason.pictureGuacd" },
        { id: "input", state: "on", dir: "toDesktop", reason: "desktop.streams.reason.input" },
        clipboardRow(i.clipboard, i.clipboardLimit),
        soundRow(i),
        filesRow(i),
    ];
}

/** 這個狀態下線上有沒有東西在走（決定畫實線 + 流動）。/ Whether data moves on the line in this state. */
export function streamFlows(state: StreamState): boolean {
    return state === "on" || state === "oneWay";
}

/** 瀏覽器能不能解 RustDesk 的聲音（Opus → WebCodecs）。/ Whether this browser can decode RustDesk's Opus sound. */
export function hasAudioDecoder(g: { AudioDecoder?: unknown; AudioContext?: unknown; webkitAudioContext?: unknown } | undefined): boolean {
    if (!g) return false;
    return typeof g.AudioDecoder === "function" && (typeof g.AudioContext === "function" || typeof g.webkitAudioContext === "function");
}
