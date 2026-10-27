/**
 * 遠端桌面的聲音「卡在哪」（純函式，無 React；`desktopSound.test.ts` 有測試）。
 * 聲音要一路走過：遠端真的有在出聲 → 遠端肯送（RDP 伺服器接受聲音轉送 / RustDesk 抓得到系統聲音）→ 經 Telepy 到這一頁
 * → 瀏覽器讓它播（自動播放限制：AudioContext 要在使用者點過之後才會跑）。viewer 回報看到的東西
 * （`SoundSnapshot`：串流開了沒、最近有沒有資料、資料是不是全靜音、AudioContext 的狀態），這裡判斷是哪一種狀況，
 * 給工具列的聲音按鈕與資訊對話框的「這條連線上走哪些東西」用。
 * Where the remote desktop's sound stops. Sound has to pass: something actually plays on the remote → the remote
 * sends it (the RDP server redirects audio / RustDesk can capture system sound) → through Telepy to this tab → the
 * browser lets it play (autoplay: the AudioContext only runs after a user gesture). The viewers report what they see
 * and this decides which case it is, for the toolbar sound button and the streams diagram.
 */
import type { DesktopMode } from "@/lib/desktop";
import type { TranslationKey } from "@/locales/en";

/**
 * off = 沒開；unsupported = 這種連法沒有聲音；muted = 這一頁靜音；waiting = 剛連上、還在等遠端開聲音通道；
 * blocked = 聲音到了但瀏覽器擋著不播（要點一下）；playing = 在播；quiet = 聲音通道開著但遠端沒在出聲；
 * none = 等了一陣子遠端都沒開聲音通道（遠端不送）。
 * off · not on this way · muted here · waiting for the remote · arriving but the browser holds it · playing ·
 * channel open but silent · the remote sends nothing.
 */
export type SoundState = "off" | "unsupported" | "muted" | "waiting" | "blocked" | "playing" | "quiet" | "none";

/** viewer 看到的聲音狀況。/ What a viewer sees of the sound. */
export interface SoundSnapshot {
    /** 遠端開了聲音通道（guacd 的 `audio` 串流 / RustDesk 的 audio format）。/ The remote opened its sound channel. */
    opened: boolean;
    /** 最近有收到聲音資料。/ Sound data arrived recently. */
    receiving: boolean;
    /** 最近收到的資料不是全靜音。/ The recent data was not all silence. */
    loud: boolean;
    /** 播放用的 AudioContext 狀態（還沒建 = null）。/ The playing AudioContext's state, null before it exists. */
    context: string | null;
}

export const EMPTY_SNAPSHOT: SoundSnapshot = { opened: false, receiving: false, loud: false, context: null };

/** 「最近」：多久內有資料算收得到。/ How recent data must be to count as arriving. */
export const RECENT_MS = 2000;
/** 連上多久還沒開聲音通道就算遠端不送（RustDesk 在 Linux 要先起連線管理員，約 5 秒）。/ When no channel means none. */
export const NONE_AFTER_MS = 10_000;
/** 振幅超過這個才算有聲音（0..1）。/ Peak above which a block counts as audible. */
export const LOUD_PEAK = 0.002;

export interface SoundInput {
    mode: DesktopMode;
    /** 這個 session 要聲音。/ Sound was asked for this session. */
    wanted: boolean;
    /** 這一頁靜音（RDP）。/ Muted in this tab (RDP). */
    muted?: boolean;
    /** 瀏覽器解得了 RustDesk 的 Opus。/ The browser can decode RustDesk's Opus. */
    decoder: boolean;
    /** 連上多久了（毫秒）。/ How long the session has been connected. */
    connectedMs: number;
    snapshot: SoundSnapshot;
    /** RustDesk 對端的平台（peer info 的 `platform`，例如 "Mac OS"）。/ The RustDesk peer's platform. */
    peerPlatform?: string | null;
}

export interface SoundReport {
    state: SoundState;
    /** 一句為什麼（也是工具列按鈕的提示）。/ Why, in one sentence (also the toolbar tooltip). */
    reason: TranslationKey;
}

/** RustDesk peer info 的平台是 macOS。/ Whether a RustDesk platform string is macOS. */
export function isMacPlatform(platform: string | null | undefined): boolean {
    return !!platform && /mac|darwin|os x/i.test(platform);
}

/** 連線中的聲音判斷。/ The sound case of a connected session. */
export function soundReport(i: SoundInput): SoundReport {
    if (i.mode === "vnc") return { state: "unsupported", reason: "desktop.streams.reason.soundVnc" };
    if (i.mode === "rustdesk" && !i.decoder) return { state: "unsupported", reason: "desktop.streams.reason.soundNoDecoder" };
    if (!i.wanted) return { state: "off", reason: i.mode === "rdp" ? "desktop.streams.reason.soundOffRdp" : "desktop.streams.reason.soundOffRd" };
    if (i.muted) return { state: "muted", reason: "desktop.streams.reason.soundMuted" };
    const s = i.snapshot;
    const mac = i.mode === "rustdesk" && isMacPlatform(i.peerPlatform);
    if (s.receiving && s.context !== "running") return { state: "blocked", reason: "desktop.sound.reason.blocked" };
    if (s.receiving && s.loud) return { state: "playing", reason: i.mode === "rdp" ? "desktop.streams.reason.soundRdp" : "desktop.streams.reason.soundRd" };
    if (s.opened) return { state: "quiet", reason: mac ? "desktop.sound.reason.quietMac" : "desktop.sound.reason.quiet" };
    if (i.connectedMs < NONE_AFTER_MS) return { state: "waiting", reason: "desktop.sound.reason.waiting" };
    if (i.mode === "rdp") return { state: "none", reason: "desktop.sound.reason.noneRdp" };
    return { state: "none", reason: mac ? "desktop.sound.reason.noneRdMac" : "desktop.sound.reason.noneRd" };
}

/** 有問題、要使用者處理的狀態（工具列按鈕用警告色）。/ States that need the user's attention. */
export function soundNeedsAttention(state: SoundState): boolean {
    return state === "blocked" || state === "none";
}

/**
 * 一塊原始 PCM（guacd 的 `audio/L8` / `audio/L16`，base64）的峰值 0..1；每 `step` 個樣本看一個（夠判斷靜音）。
 * L16 是 little-endian 有號、L8 是有號 8 位元（guacamole-common-js 的 RawAudioPlayer 也這樣讀）。壞資料回 0。
 * The peak (0..1) of one raw PCM blob from guacd, sampling every `step` samples; garbage gives 0.
 */
export function pcmPeak(base64: string, bytesPerSample: 1 | 2, step = 4): number {
    let bin: string;
    try {
        bin = atob(base64);
    } catch {
        return 0;
    }
    let peak = 0;
    const stride = bytesPerSample * Math.max(1, step);
    for (let o = 0; o + bytesPerSample <= bin.length; o += stride) {
        let v: number;
        if (bytesPerSample === 2) {
            v = bin.charCodeAt(o) | (bin.charCodeAt(o + 1) << 8);
            if (v >= 0x8000) v -= 0x10000;
            v = Math.abs(v) / 32768;
        } else {
            v = bin.charCodeAt(o);
            if (v >= 0x80) v -= 0x100;
            v = Math.abs(v) / 128;
        }
        if (v > peak) peak = v;
    }
    return peak;
}

/** guacd 的音訊 mimetype 每個樣本幾 byte（L8 = 1、L16 = 2；其他 = null）。/ Bytes per sample of a raw audio mimetype. */
export function rawBytesPerSample(mimetype: string): 1 | 2 | null {
    const m = /^audio\/L(8|16)\b/i.exec(mimetype.trim());
    if (!m) return null;
    return m[1] === "8" ? 1 : 2;
}
