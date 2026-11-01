/**
 * Tapi 什麼時候可以出來串門子（彩蛋）。Tapi 不放在一般介面上（空清單之類天天看到的地方會太多），所以出場只有三種：
 * 1. 自己找的（點 logo 七下、搜尋 `tapi`、輸入上上下下左右左右 BA）——想看幾次都可以；
 * 2. 偶爾探頭（躲貓貓）：在安靜的頁面待一陣子、沒在打字時，從畫面底下探頭幾秒；最多三天一次、輪到的那天也只有一半機會，
 *    節日（生日、新年、萬聖節）當天保證一次；在帳號設定關掉就不來；
 * 3. 里程碑：第一條通道驗證成功時出來恭喜一次（一輩子一次，而且只給已經找到 Tapi 的人）。
 * 這裡只有規則（純函式、有測試），畫面在 components/brand/TapiVisits.tsx。
 * When Tapi may drop by (easter eggs). Tapi stays out of ordinary UI (empty lists and the like are seen every day, which
 * was too much), so it only shows up in three ways:
 * 1. found on purpose (seven clicks on the logo, searching `tapi`, the Konami code) — as often as you like;
 * 2. a rare peek: after a while on a calm page without typing, it peeks up from the bottom edge for a few seconds; at
 *    most once every three days and only on half of the days that qualify, guaranteed once on a festival day
 *    (birthday, Lunar New Year, Halloween); an account setting turns it off;
 * 3. a milestone: once, when the first tunnel is verified (only for people who already found Tapi).
 * Rules only (pure, tested); the page part is components/brand/TapiVisits.tsx.
 */

/** 兩次探頭之間至少隔幾天。/ The minimum days between two peeks. */
export const PEEK_GAP_DAYS = 3;
/** 輪到的那天出來的機會。/ The chance on a day that qualifies. */
export const PEEK_CHANCE = 0.5;
/** 在頁面待多久之後（毫秒）：45 秒到 2.5 分鐘之間。/ How long after landing on a page (ms): 45 s to 2.5 min. */
export const PEEK_DELAY_MS = { min: 45_000, max: 150_000 } as const;
/** 最近這麼久有打字就先不出來。/ No peek while someone typed this recently. */
export const QUIET_MS = 20_000;
/** 探頭多久（毫秒）：抓不到就躲回去。/ How long a peek lasts before Tapi ducks back (ms). */
export const PEEK_MS = 6_500;

/**
 * 安靜的頁面（看清單、讀紀錄的地方）。終端機、遠端桌面、網路拓撲的終端機、檔案、看別人的終端機、建立精靈這些正在做事的頁面不出來。
 * Calm pages (lists, logs, reading). Pages where people are busy — terminal, desktop, the network page's terminals,
 * files, watching a terminal, the create wizard — are never visited.
 */
const CALM = [
    /^\/tunnels\/?$/,
    /^\/tunnels\/keys(\/.*)?$/,
    /^\/tunnels\/logs\/?$/,
    /^\/tunnels\/recordings\/?$/,
    /^\/tunnels\/activity\/?$/,
    /^\/tunnels\/webhooks\/?$/,
    /^\/tunnels\/commands\/?$/,
    /^\/tunnels\/cli\/?$/,
    /^\/tunnels\/api\/?$/,
    /^\/tunnels\/mcp\/?$/,
];

export function calmPage(pathname: string): boolean {
    return CALM.some((re) => re.test(pathname));
}

/** 記在這個瀏覽器的：上次探頭的時間、出現過的一次性場合。/ What this browser remembers: the last peek and the one-off moments seen. */
export interface CameoMemory {
    /** 上次探頭（毫秒）。/ The last peek (ms). */
    peekAt: number | null;
    /** 出現過的一次性場合（`firstTunnel`、`festival:<kind>:<year>`）。/ One-off moments already shown. */
    seen: string[];
}

export const EMPTY_MEMORY: CameoMemory = { peekAt: null, seen: [] };

/** localStorage 的字串 → 記憶；看不懂就當沒有。/ The stored string → memory; anything odd = nothing remembered. */
export function parseMemory(raw: string | null | undefined): CameoMemory {
    try {
        const o = JSON.parse(raw ?? "") as Record<string, unknown>;
        const peekAt = typeof o.peekAt === "number" && Number.isFinite(o.peekAt) ? o.peekAt : null;
        const seen = Array.isArray(o.seen) ? o.seen.filter((x): x is string => typeof x === "string").slice(-20) : [];
        return { peekAt, seen };
    } catch {
        return EMPTY_MEMORY;
    }
}

const DAY_MS = 86_400_000;

/** 本地日期的 yyyy-mm-dd。/ The local date as yyyy-mm-dd. */
export function dayKey(now: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 一個字串的雜湊（FNV-1a + murmur3 的收尾混合，相近的字串也分得開）。/ A string hash (FNV-1a + murmur3's finaliser, so similar strings spread out). */
function hash(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

/**
 * 今天輪不輪得到（每個瀏覽器、每一天固定：重新整理不會重抽）。`salt` = 這個瀏覽器自己的亂數。
 * Whether today is a lucky day (fixed per browser and day, so reloading never re-rolls). `salt` = this browser's own
 * random value.
 */
export function luckyDay(day: string, salt: string, chance = PEEK_CHANCE): boolean {
    return hash(`${salt}:${day}`) / 4294967296 < chance;
}

/** 節日當天的一次性場合名稱。/ The one-off key of a festival day. */
export const festivalKey = (kind: string, now: Date) => `festival:${kind}:${now.getFullYear()}`;

export interface PeekCheck {
    now: Date;
    memory: CameoMemory;
    salt: string;
    /** 今天的節日（沒有 = null）。/ Today's festival (none = null). */
    festival: string | null;
    /** 帳號設定：讓 Tapi 來串門子。/ The account setting: let Tapi drop by. */
    enabled: boolean;
    /** 要求減少動態。/ Reduced motion. */
    reduced: boolean;
}

/**
 * 今天可不可以自己探頭：關掉了、減少動態 = 不行；節日當天還沒來過 = 一定；否則距離上次至少三天、而且今天抽中。
 * Whether Tapi may peek on its own today: turned off or reduced motion = no; a festival day it hasn't visited yet =
 * yes; otherwise at least three days since the last peek and today must be a lucky day.
 */
export function peekDue(c: PeekCheck): boolean {
    if (!c.enabled || c.reduced) return false;
    if (c.festival && !c.memory.seen.includes(festivalKey(c.festival, c.now))) return true;
    if (c.memory.peekAt !== null && c.now.getTime() - c.memory.peekAt < PEEK_GAP_DAYS * DAY_MS) return false;
    return luckyDay(dayKey(c.now), c.salt);
}

/** 探過頭之後要記下的。/ What to remember after a peek. */
export function afterPeek(memory: CameoMemory, now: Date, festival: string | null): CameoMemory {
    const seen = festival ? [...new Set([...memory.seen, festivalKey(festival, now)])].slice(-20) : memory.seen;
    return { peekAt: now.getTime(), seen };
}

/** 一次性場合（第一條通道）出現過了沒，記下來。/ One-off moments (the first tunnel): already seen, and remembering it. */
export const seenOnce = (memory: CameoMemory, key: string) => memory.seen.includes(key);
export const rememberOnce = (memory: CameoMemory, key: string): CameoMemory => ({ ...memory, seen: [...new Set([...memory.seen, key])].slice(-20) });

/** 探頭的位置（0–1，主內容區的寬度裡），避開最左與最右。/ Where along the content's width (0–1), away from the very edges. */
export function peekSpot(day: string, salt: string): number {
    return 0.15 + (hash(`spot:${salt}:${day}`) / 4294967296) * 0.7;
}

/** 叫 Tapi 的視窗事件（components/brand/TapiVisits 在聽）。/ The window event that calls Tapi (TapiVisits listens). */
export const TAPI_EVENT = "telepy:tapi";
export type TapiSummons = "peek" | "tunnelUp";

/** 叫 Tapi 出來：探頭，或通道驗證成功的恭喜。/ Call Tapi: a peek, or the cheer when a tunnel is verified. */
export function summonTapi(kind: TapiSummons): void {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<TapiSummons>(TAPI_EVENT, { detail: kind }));
}

/** 上上下下左右左右 BA。/ The Konami code. */
export const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"] as const;

/**
 * 一路按下來的鍵是不是剛好按完上上下下左右左右 BA（`keys` = 最近按的，最舊的在前；字母不分大小寫）。
 * Whether the keys pressed so far just completed the Konami code (`keys` = the latest presses, oldest first; letters
 * ignore case).
 */
export function konamiDone(keys: readonly string[]): boolean {
    if (keys.length < KONAMI.length) return false;
    const tail = keys.slice(-KONAMI.length);
    return tail.every((k, i) => (k.length === 1 ? k.toLowerCase() : k) === KONAMI[i]);
}
