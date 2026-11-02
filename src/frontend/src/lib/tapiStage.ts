/**
 * Tapi 版登入頁（網站設定 → 登入 → Tapi）的純函式：Tapi 的心情（跟著表單：打帳號時盯著看、輸入密碼時轉過身、
 * 密碼顯示出來時嚇一跳、送出時想一下、失敗驚訝、成功開心）、轉過身的圖、像素字標「Telepy」，以及背景一杯珍奶裡
 * 慢慢浮上來的粉圓（決定性的亂數，伺服器與瀏覽器算出一樣的東西）。畫面在 components/auth/TapiShell.tsx。
 * Pure helpers for the Tapi sign-in look (Site settings → Sign-in → Tapi): Tapi's mood, which follows the form
 * (watching while you type the username, turned around while you type the password, startled when the password is
 * shown, thinking while signing in, surprised on a failure, happy on success), the turned-around sprite, the pixel
 * wordmark and the tapioca pearls rising through the cup of bubble tea behind it all (seeded, so every render agrees).
 * The page itself is components/auth/TapiShell.tsx. 不依賴 React。/ No React.
 */
import { MASCOT_POSES, mirrored, type MascotPose } from "./mascot.ts";

/* ── 心情 / Mood ─────────────────────────────────────────────── */

export type TapiMood = "idle" | "watching" | "shy" | "peek" | "thinking" | "oops" | "yay" | "mfa" | "wave" | "poke" | "sleepy" | "careful" | "stamp" | "bye" | "done";
/**
 * 一下子就過去的反應（幾秒後回到跟著表單的心情）。授權頁另有三個：勾了會改東西的權限（careful）、按允許（stamp）、按拒絕（bye）。
 * Short reactions that pass after a few seconds. The approval page adds three: a scope that can change things ticked
 * (careful), approve (stamp) and deny (bye).
 */
export type TapiFlash = "oops" | "yay" | "poke" | "careful" | "stamp" | "bye";
/** 焦點在哪：帳號、密碼（含旁邊的顯示按鈕）、兩步驟的驗證碼、其他。/ Where focus is: username, password (and its toggle), the code, other. */
export type TapiFocus = "username" | "password" | "code" | "other" | null;

export interface StageInput {
    focus: TapiFocus;
    /** 密碼欄現在是明碼。/ The password field currently shows the password. */
    passwordShown: boolean;
    submitting: boolean;
    flash: TapiFlash | null;
    /** 滑鼠停在 Tapi 身上。/ The pointer rests on Tapi. */
    hovering: boolean;
    /** 多久沒動了（秒）。/ Seconds since the last interaction. */
    idleSecs: number;
}

/** 這麼久沒人理就睡著。/ Falls asleep after this long without anyone around. */
export const SLEEP_AFTER_SECS = 40;
/** 反應持續多久（毫秒）。/ How long each reaction lasts (ms). */
export const FLASH_MS: Record<TapiFlash, number> = { oops: 2600, yay: 2400, poke: 1500, careful: 3400, stamp: 4000, bye: 3000 };

/**
 * 心情的優先順序：剛發生的反應 > 送出中 > 密碼（轉身 / 嚇一跳）> 驗證碼 > 帳號 > 滑鼠在身上 > 睡著 > 平常。
 * Priority: a fresh reaction > signing in > password (turned around / startled) > code > username > hover > asleep > idle.
 */
export function moodFor(i: StageInput): TapiMood {
    if (i.flash) return i.flash;
    if (i.submitting) return "thinking";
    if (i.focus === "password") return i.passwordShown ? "peek" : "shy";
    if (i.focus === "code") return "mfa";
    if (i.focus === "username") return "watching";
    if (i.hovering) return "wave";
    if (i.idleSecs >= SLEEP_AFTER_SECS) return "sleepy";
    return "idle";
}

/** 每種心情用哪張圖（`back` = 轉過身）。/ Which sprite each mood uses (`back` = turned around). */
export const MOOD_POSE: Record<TapiMood, MascotPose | "back"> = {
    idle: "idle",
    watching: "happy",
    shy: "back",
    peek: "surprised",
    thinking: "idle",
    oops: "surprised",
    yay: "happy",
    mfa: "happy",
    wave: "wave",
    poke: "happy",
    sleepy: "idle",
    careful: "surprised",
    stamp: "happy",
    bye: "wave",
    done: "happy",
};

/** 每種心情的動作（tapi.css 的 class）。/ Each mood's motion (classes in tapi.css). */
export const MOOD_MOTION: Record<TapiMood, "bob" | "still" | "shake" | "jump" | "quick" | "sink" | "wiggle"> = {
    idle: "bob",
    watching: "bob",
    shy: "still",
    peek: "shake",
    thinking: "quick",
    oops: "shake",
    careful: "shake",
    stamp: "jump",
    bye: "wiggle",
    done: "bob",
    yay: "jump",
    mfa: "bob",
    wave: "wiggle",
    poke: "jump",
    sleepy: "sink",
};

/**
 * 對話框裡說的話：null = 輪流打出來的句子（管理員寫的或內建的）；其他 = 這個心情自己的那句（字典 `tapiLook.<mood>`）。
 * What the speech bubble says: null = the typed lines (the admin's or the built-in ones); otherwise the mood's own
 * line (`tapiLook.<mood>` in the dictionaries).
 */
export function moodLine(mood: TapiMood): Exclude<TapiMood, "idle" | "sleepy"> | null {
    return mood === "idle" || mood === "sleepy" ? null : mood;
}

/* ── 圖 / Sprites ────────────────────────────────────────────── */

/**
 * 轉過身的 Tapi：左右翻過來（光從另一邊來），臉上的東西（眼睛、嘴、腮紅、亮點）都變回身體的顏色，只剩耳朵上的十字。
 * Tapi turned around: mirrored (the light comes from the other side) with every face pixel (eyes, mouth, blush,
 * highlight) painted as body, so only the clips on the ears remain.
 */
export function backView(sprite: readonly string[]): string[] {
    return mirrored(sprite).map((r) => r.replace(/[EPTH]/g, "O"));
}

/** 某個心情的像素格。/ The grid for a mood. */
export function moodSprite(mood: TapiMood): readonly string[] {
    const pose = MOOD_POSE[mood];
    return pose === "back" ? backView(MASCOT_POSES.idle) : MASCOT_POSES[pose];
}

/* ── 像素字標 / The pixel wordmark ────────────────────────────── */

/** 5 × 9 的小字（第 7–8 列是下伸部）。只放得下這個字需要的字母。/ A 5 × 9 font (rows 7–8 are descenders), only the letters needed. */
const FONT: Record<string, readonly string[]> = {
    T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#..", ".....", "....."],
    e: [".....", ".....", ".###.", "#...#", "#####", "#....", ".####", ".....", "....."],
    l: ["##...", ".#...", ".#...", ".#...", ".#...", ".#...", ".##..", ".....", "....."],
    p: [".....", ".....", "####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
    y: [".....", ".....", "#...#", "#...#", "#...#", ".####", "....#", "....#", "####."],
};
const CELL = 3;
const GAP = 2;

export interface WordGlyph {
    /** 這個字母自己的像素格（F 填色、D 描邊、S 陰影）。/ This letter's own grid (F fill, D outline, S shadow). */
    rows: string[];
}

/**
 * 一個字母：每個字型格放大成 3 × 3，外面一圈描邊、右下兩格陰影（像遊戲的標題）。每個字母自己一張，畫面上才能一個一個跳。
 * One letter: each font cell becomes 3 × 3, with a one-pixel outline and a shadow down-right (a game-title look).
 * Each letter is its own grid so the page can make them hop one by one.
 */
export function pixelGlyph(ch: string): WordGlyph | null {
    const font = FONT[ch];
    if (!font) return null;
    // 比例字寬：用到的最右一欄為止（l 比 T 窄）。/ Proportional width: up to the rightmost column used (l is narrower than T).
    const cols = Math.max(...font.map((row) => row.lastIndexOf("#") + 1));
    const w = cols * CELL + 3;
    const h = 9 * CELL + 4;
    const grid = Array.from({ length: h }, () => Array<string>(w).fill("."));
    const filled = new Set<string>();
    font.forEach((row, y) =>
        [...row].forEach((c, x) => {
            if (c !== "#") return;
            for (let a = 0; a < CELL; a++) for (let b = 0; b < CELL; b++) filled.add(`${1 + x * CELL + a},${1 + y * CELL + b}`);
        }),
    );
    const at = (k: string) => k.split(",").map(Number) as [number, number];
    // 從邊緣灌進來的空格 = 字的外面；描邊與陰影只畫在外面，e、p 的小洞才不會被塞滿。
    // Empty cells reachable from the edge are outside the letter; the outline and shadow stay outside, so the
    // counters of e and p are not filled in.
    const outside = new Set<string>();
    const queue: [number, number][] = [];
    for (let x = 0; x < w; x++) queue.push([x, 0], [x, h - 1]);
    for (let y = 0; y < h; y++) queue.push([0, y], [w - 1, y]);
    while (queue.length) {
        const [x, y] = queue.pop()!;
        const k = `${x},${y}`;
        if (x < 0 || y < 0 || x >= w || y >= h || outside.has(k) || filled.has(k)) continue;
        outside.add(k);
        queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    const paint = (x: number, y: number, c: string) => {
        if (y >= 0 && y < h && x >= 0 && x < w && outside.has(`${x},${y}`) && grid[y][x] === ".") grid[y][x] = c;
    };
    for (const k of filled) {
        const [x, y] = at(k);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) paint(x + dx, y + dy, "D");
    }
    for (const k of filled) {
        const [x, y] = at(k);
        paint(x + 1, y + 2, "S");
    }
    for (const k of filled) {
        const [x, y] = at(k);
        grid[y][x] = "F";
    }
    return { rows: grid.map((r) => r.join("")) };
}

/** 整個字（字母之間的距離）。/ The whole word (with the spacing between letters). */
export function pixelWord(text: string): { glyphs: WordGlyph[]; advance: number } {
    return { glyphs: [...text].map(pixelGlyph).filter((g): g is WordGlyph => g !== null), advance: 5 * CELL + GAP };
}

/** 字標的顏色：跟 Tapi 同一組（固定，不跟主題走）。/ The wordmark's colours: Tapi's own (fixed, like the art). */
export const WORD_PALETTE: Record<string, string> = { F: "#f28a38", D: "#4a2026", S: "#4a2026" };

/* ── 珍奶裡的粉圓 / The tapioca pearls ─────────────────────────── */

/** 8 × 8 的粉圓：R 外圈、B 身體、M 下半的反光、L 亮點。/ An 8 × 8 pearl: R rim, B body, M lower glow, L highlight. */
export const PEARL_SPRITE = ["..RRRR..", ".RBBBBR.", "RBLBBBBR", "RBLBBBBR", "RBBBBMBR", "RBBBMMBR", ".RBBBBR.", "..RRRR.."];
/** 淺色主題 = 奶茶裡的黑糖粉圓；深色主題亮一點才看得到。/ Light = brown-sugar pearls in milk tea; dark = lighter to stay visible. */
export const PEARL_PALETTE: Record<"light" | "dark", Record<string, string>> = {
    light: { R: "#24130d", B: "#3d2219", M: "#5c3627", L: "#f3e3cf" },
    dark: { R: "#2a1710", B: "#6b4331", M: "#8a5a43", L: "#f6d9bd" },
};

/** 三層：後面小、慢、淡，前面大、快、濃。`unit` = 一個像素幾 px。/ Three depths: back = small, slow, faint; front = big, fast, solid. */
export const PEARL_LAYERS = [
    { unit: 3, speed: 16, alpha: 0.3, sway: 5, period: 7 },
    { unit: 4, speed: 26, alpha: 0.55, sway: 8, period: 6 },
    { unit: 6, speed: 40, alpha: 0.9, sway: 11, period: 5 },
] as const;

export interface Pearl {
    /** 水平位置（0–1，乘上寬度）。/ Horizontal position, 0–1 of the width. */
    x: number;
    /** 一開始在第幾段高度（0–1），大家不會同時出發。/ Starting height, 0–1, so they don't all start together. */
    y0: number;
    layer: 0 | 1 | 2;
    phase: number;
}

/** 決定性的亂數（mulberry32）。/ A seeded random generator (mulberry32). */
export function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** 畫面多大放幾顆：每 4 萬平方 px 一顆，10–36 顆。/ How many pearls for an area: one per 40,000 px², 10–36. */
export function pearlCount(width: number, height: number): number {
    const n = Math.round((Math.max(0, width) * Math.max(0, height)) / 40_000);
    return Math.min(36, Math.max(10, n));
}

/** 一杯的粉圓：一半在後面、三分之一在中間、其餘在前面。/ A cup's pearls: half at the back, a third in the middle, the rest in front. */
export function makePearls(count: number, seed = 7): Pearl[] {
    const rand = seeded(seed);
    return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, i) => {
        const r = (i * 0.6180339887) % 1;
        const layer: 0 | 1 | 2 = r < 0.5 ? 0 : r < 0.83 ? 1 : 2;
        return { x: rand(), y0: rand(), layer, phase: rand() * Math.PI * 2 };
    });
}

/**
 * 某一顆粉圓在 `t` 秒時的位置（左上角，px）：從底下往上浮，出了頂端再從底下出現，左右輕輕擺；座標對齊那一層的像素格，
 * 所以動起來也是清楚的方格。
 * Where a pearl is at `t` seconds (top-left corner, px): it rises from the bottom, comes back from below after
 * leaving the top, and sways a little; snapped to its layer's pixel size so it stays crisp while moving.
 */
export function pearlAt(p: Pearl, t: number, width: number, height: number): { x: number; y: number; size: number } {
    const l = PEARL_LAYERS[p.layer];
    const size = 8 * l.unit;
    const travel = height + size * 2;
    const risen = (p.y0 * travel + Math.max(0, t) * l.speed) % travel;
    const y = height + size - risen;
    const x = p.x * Math.max(0, width - size) + Math.sin((t / l.period) * Math.PI * 2 + p.phase) * l.sway;
    const snap = (v: number) => Math.round(v / l.unit) * l.unit || 0;
    return { x: snap(x), y: snap(y), size };
}

/* ── 每一頁的場景 / A scene per page ─────────────────────────── */

/**
 * Tapi 版每一頁照它做的事換一個場景：登入 = 一杯珍奶；應用程式連接 = 紙飛機把應用程式的請求送來，Tapi 拿著信；
 * CLI 登入（與登入完成頁）= 終端機；授權 = 審核櫃台，Tapi 戴著墨鏡蓋章。
 * Each Tapi page gets a scene that matches what it does: sign-in = a cup of bubble tea; app connection = paper planes
 * bringing the app's request, Tapi holding the letter; CLI sign-in (and its done page) = a terminal; approval = a
 * counter where Tapi, in sunglasses, does the stamping.
 */
export type TapiScene = "tea" | "mail" | "terminal" | "desk";
export const TAPI_SCENES: readonly TapiScene[] = ["tea", "mail", "terminal", "desk"];

export function sceneFor(page: "signin" | "oauth" | "cli" | "consent"): TapiScene {
    return page === "oauth" ? "mail" : page === "cli" ? "terminal" : page === "consent" ? "desk" : "tea";
}

/** 把一小張圖疊到 Tapi 上（`.` = 透明）。/ Lays a small grid over Tapi (`.` = see-through). */
export function overlay(sprite: readonly string[], pattern: readonly string[], x0: number, y0: number): string[] {
    const rows = sprite.map((r) => [...r]);
    pattern.forEach((row, j) => [...row].forEach((c, i) => c !== "." && rows[y0 + j]?.[x0 + i] !== undefined && (rows[y0 + j][x0 + i] = c)));
    return rows.map((r) => r.join(""));
}

// 墨鏡：上緣一條橫桿、鏡片塗黑（K）、每片左上一點反光（Q）；14 格寬、放在第 6 欄，正好以臉的中線（第 12.5 欄，
// 兩隻眼睛的正中間）對稱，蓋住第 9–12 列的眼睛，嘴巴留在下面照樣表情。信封：W 紙、G 陰影。（K / Q / W / G 在 mascot.ts 的節日色票裡。）
// Sunglasses: a bar across the top, blacked-out lenses (K) with a glint at each lens's top left (Q); 14 wide at column
// 6, so they sit on the face's centre line (column 12.5, right between the eyes), cover the eyes on rows 9–12 and leave
// the mouth below to show the mood. The envelope: W paper, G shade. (K / Q / W / G are in mascot.ts's festive palette.)
export const SUNGLASSES = ["DDDDDDDDDDDDDD", "DQKKKD..DQKKKD", "DKKKKD..DKKKKD", ".DKKD....DKKD."];
export const SUNGLASSES_AT = { x: 6, y: 9 } as const;
const ENVELOPE = ["DDDDDDDD", "DWDWWDWD", "DWWDDWWD", "DWWWWWWD", "DDDDDDDD"];

/**
 * 某個場景、某個心情的 Tapi：授權頁戴墨鏡、應用程式連接頁拿著信；轉過身時什麼都不加。
 * Tapi for a scene and mood: sunglasses at the approval page, a letter at the app connection page; nothing extra when
 * turned around.
 */
export function sceneSprite(mood: TapiMood, scene: TapiScene): string[] {
    const pose = MOOD_POSE[mood];
    const base = moodSprite(mood);
    if (pose === "back") return [...base];
    if (scene === "desk") return overlay(base, SUNGLASSES, SUNGLASSES_AT.x, SUNGLASSES_AT.y);
    if (scene === "mail") return overlay(base, ENVELOPE, 17, 13);
    return [...base];
}

/** 每個場景自己的三句內建台詞（管理員沒寫句子時）。/ Each scene's three built-in lines (when the admin wrote none). */
export const SCENE_LINES: Record<TapiScene, readonly [string, string, string]> = {
    tea: ["tapiLook.tea.line1", "tapiLook.tea.line2", "tapiLook.tea.line3"],
    mail: ["tapiLook.mail.line1", "tapiLook.mail.line2", "tapiLook.mail.line3"],
    terminal: ["tapiLook.terminal.line1", "tapiLook.terminal.line2", "tapiLook.terminal.line3"],
    desk: ["tapiLook.desk.line1", "tapiLook.desk.line2", "tapiLook.desk.line3"],
};

/* ── 紙飛機（應用程式連接頁）/ Paper planes (app connection) ─── */

/** 12 × 9 的紙飛機，往右飛。/ A 12 × 9 paper plane flying right. */
export const PLANE_SPRITE = ["DD..........", "DWDD........", ".DWWDDD.....", ".DWWWWWDDD..", "..DWWWWWWWDD", ".DGGGGDDDD..", ".DGGDD......", "DGD.........", "DD.........."];
export const PLANE_PALETTE: Record<"light" | "dark", Record<string, string>> = {
    light: { D: "#4a2026", W: "#fffaf0", G: "#d8cfc1" },
    dark: { D: "#120c0d", W: "#f6efe3", G: "#bfb3a2" },
};
/** 三層：後面小、慢、淡。/ Three depths: back = small, slow, faint. */
export const PLANE_LAYERS = [
    { unit: 2, speed: 34, alpha: 0.35, dip: 10, period: 9 },
    { unit: 3, speed: 52, alpha: 0.6, dip: 16, period: 7 },
    { unit: 4, speed: 76, alpha: 0.95, dip: 22, period: 6 },
] as const;

export interface Flyer {
    /** 高度（0–1）。/ Height, 0–1. */
    y: number;
    /** 一開始飛到哪（0–1），大家不會同時出發。/ Where along the way it starts, 0–1. */
    x0: number;
    layer: 0 | 1 | 2;
    phase: number;
}

/** 畫面多大放幾架：每 9 萬平方 px 一架，5–14 架。/ How many planes: one per 90,000 px², 5–14. */
export function planeCount(width: number, height: number): number {
    return Math.min(14, Math.max(5, Math.round((Math.max(0, width) * Math.max(0, height)) / 90_000)));
}

export function makePlanes(count: number, seed = 11): Flyer[] {
    const rand = seeded(seed);
    return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, i) => {
        const r = (i * 0.6180339887) % 1;
        const layer: 0 | 1 | 2 = r < 0.45 ? 0 : r < 0.8 ? 1 : 2;
        return { y: 0.08 + rand() * 0.84, x0: rand(), layer, phase: rand() * Math.PI * 2 };
    });
}

/**
 * 一架紙飛機在 `t` 秒時的位置（左上角，px）：從左往右飛，飛出右邊再從左邊進來，上下輕輕起伏；`trail` = 後面虛線的點。
 * Where a plane is at `t` seconds (top-left, px): left to right, back in from the left after leaving, gently dipping;
 * `trail` = the dots of the dashed line behind it.
 */
export function planeAt(p: Flyer, t: number, width: number, height: number): { x: number; y: number; size: number; unit: number; trail: { x: number; y: number }[] } {
    const l = PLANE_LAYERS[p.layer];
    const size = 12 * l.unit;
    const travel = width + size * 2 + 160;
    const along = (p.x0 * travel + Math.max(0, t) * l.speed) % travel;
    const x = along - size - 160;
    const yAt = (xx: number) => p.y * Math.max(0, height - size) + Math.sin(((xx / Math.max(1, width)) * 2 + t / l.period) * Math.PI + p.phase) * l.dip;
    const snap = (v: number) => Math.round(v / l.unit) * l.unit || 0;
    const trail = [1, 2, 3, 4, 5].map((k) => {
        const tx = x - k * 6 * l.unit;
        return { x: snap(tx), y: snap(yAt(tx) + size * 0.55) };
    });
    return { x: snap(x), y: snap(yAt(x)), size, unit: l.unit, trail };
}

/* ── 終端機的字（CLI 頁）/ Terminal glyphs (CLI pages) ─────────── */

/** 往上飄的字（像資料穿過通道）。/ The characters drifting up (data through the tunnel). */
export const GLYPHS = "$>_~/{}[]|01-R:".split("");

/** 第 `i` 個字在 `t` 秒時是哪一個：每幾秒換一次。/ Which character particle `i` shows at `t`: it changes every few seconds. */
export function glyphAt(i: number, t: number, seed = 5): string {
    const step = Math.floor(Math.max(0, t) / (2.5 + (i % 5) * 0.7));
    const rand = seeded(seed + i * 7919 + step * 104729);
    return GLYPHS[Math.floor(rand() * GLYPHS.length)];
}

/* ── 印章（授權頁）/ Stamps (approval page) ──────────────────── */

/** 16 × 9 的圓形「OK」印章（O 與 K 各 4 × 5、中間空兩格）與 9 × 7 的勾勾。/ A 16 × 9 round "OK" stamp (O and K 4 × 5 each, two apart) and a 9 × 7 check mark. */
export const STAMP_OK = ["...BBBBBBBBBB...", "..BB........BB..", ".B..BB...B..B.B.", ".B.B..B..B.B..B.", "B..B..B..BB....B", ".B.B..B..B.B..B.", ".B..BB...B..B.B.", "..BB........BB..", "...BBBBBBBBBB..."];
export const STAMP_CHECK = [".......BB", "......BB.", ".....BB..", "BB..BB...", ".BBBB....", "..BB.....", "........."];

/** 同時最多幾個印子、一輪多久（秒）。/ How many marks at once and how long one round lasts (s). */
export const STAMP_SLOTS = 6;
export const STAMP_ROUND = 7;

/**
 * 第 `slot` 格在 `t` 秒時的印子：每輪在不固定的位置「蓋」下去（先大一點、很快縮回），停一下再淡掉；輪與輪之間錯開。
 * 沒有印子時回 null。`kind` = OK 印章或勾勾。
 * The mark in slot `slot` at `t` seconds: each round it is "stamped" somewhere new (a little large, quickly settling),
 * stays, then fades; slots are staggered. null between marks. `kind` = the OK stamp or a check mark.
 */
export function stampAt(slot: number, t: number, seed = 3): { x: number; y: number; kind: "ok" | "check"; alpha: number; scale: number; tilt: number } | null {
    const local = Math.max(0, t) + (slot * STAMP_ROUND) / STAMP_SLOTS;
    const round = Math.floor(local / STAMP_ROUND);
    const age = local - round * STAMP_ROUND;
    const life = 5;
    if (age > life) return null;
    const rand = seeded(seed + slot * 997 + round * 7907);
    const x = 0.06 + rand() * 0.88;
    const y = 0.08 + rand() * 0.84;
    const kind = rand() < 0.6 ? "ok" : "check";
    const tilt = (rand() - 0.5) * 0.5;
    const settle = Math.min(1, age / 0.18);
    const scale = 1.35 - 0.35 * settle;
    const alpha = age < 0.18 ? settle : age > life - 1.2 ? Math.max(0, (life - age) / 1.2) : 1;
    return { x, y, kind, alpha, scale, tilt };
}
