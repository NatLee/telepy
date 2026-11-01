/**
 * Tapi：Telepy 的吉祥物（兩耳夾著青綠十字髮夾的柿子色小幽靈，沒有腳、眼睛一筆線、嘴巴 ω）。像素格與 `src/backend-api/src/mascot.rs` 同一份
 * （gateway 的 ssh 招呼與 `telepy` CLI 用它畫在終端機裡），`mascot.test.ts` 會讀那個檔比對；改一邊就要改另一邊。
 * Tapi, Telepy's mascot (a little persimmon-coloured ghost with teal cross clips on its ears: no feet, line eyes, an ω mouth). The grids are the same as
 * `src/backend-api/src/mascot.rs` (the gateway's ssh greeting and the `telepy` CLI draw them in a terminal);
 * `mascot.test.ts` reads that file to keep them equal. 純函式、不依賴 React。/ Pure, no React.
 */

/** 名字：Telepy 的 Tapi，也是日文的タピオカ（珍珠奶茶的粉圓）。/ From Telepy, and Japanese タピオカ (tapioca). */
export const MASCOT_NAME = "Tapi";

export const MASCOT_POSES = {
    idle: [
        "..........................",
        "..........................",
        "..........................",
        "......DDD........DDD......",
        "...DDDDFDDDDDDDDDDFDDDD...",
        "...DODFFFDOOOOOODFFFDOD...",
        "...DODDFDDOOOOOODDFDDOD...",
        "...DOODDDOOOOOOOODDDOOD...",
        "....DOOOOOOOOOOOOOOOOD....",
        "....DOOOOOOOOOOOOOOOOD....",
        "...DOHOOOOOOOOOOOOOOOOD...",
        "...DHOOOEEEOOOOEEEOOOOD...",
        "..DOHOOEOOOOOOOOOOEOOOOD..",
        "..DOOPOPOOOEOEOEOOPOPOOD..",
        "..DOOPOPOOOOEOEOOOPOPOSD..",
        ".DOOOOOOOOOOOOOOOOOOSSSSD.",
        ".DOOOOOOOOOOOOOOOOSSSSSSD.",
        ".DOOOOOOOOOOOOOOSSSSSSSSD.",
        ".DOOOOOOOOOOOOSSSSSSSSSSD.",
        ".DOOOODDOOOSDDSSSSDDSSSSD.",
        "..DOOD..DSSD..DSSD..DSSD..",
        "...DD....DD....DD....DD...",
    ],
    happy: [
        "..........................",
        "..........................",
        "..........................",
        "......DDD........DDD......",
        "...DDDDFDDDDDDDDDDFDDDD...",
        "...DODFFFDOOOOOODFFFDOD...",
        "...DODDFDDOOOOOODDFDDOD...",
        "...DOODDDOOOOOOOODDDOOD...",
        "....DOOOOOOOOOOOOOOOOD....",
        "....DOOOOOOOOOOOOOOOOD....",
        "...DOHOEEOOOOOOOOEEOOOD...",
        "...DHOEOOEOOOOOOEOOEOOD...",
        "..DOHOOOOOOOOOOOOOOOOOOD..",
        "..DOOPOPOOOEEEEOOOPOPOOD..",
        "..DOOPOPOOOETTEOOOPOPOSD..",
        ".DOOOOOOOOOOEEOOOOOOSSSSD.",
        ".DOOOOOOOOOOOOOOOOSSSSSSD.",
        ".DOOOOOOOOOOOOOOSSSSSSSSD.",
        ".DOOOOOOOOOOOOSSSSSSSSSSD.",
        ".DOOOODDOOOSDDSSSSDDSSSSD.",
        "..DOOD..DSSD..DSSD..DSSD..",
        "...DD....DD....DD....DD...",
    ],
    wave: [
        "..........................",
        "..........................",
        "..........................",
        "......DDD........DDD......",
        "...DDDDFDDDDDDDDDDFDDDD...",
        "...DODFFFDOOOOOODFFFDOD...",
        "...DODDFDDOOOOOODDFDDOD...",
        "...DOODDDOOOOOOOODDDOODDD.",
        "....DOOOOOOOOOOOOOOOODDOOD",
        "....DOOOOOOOOOOOOOOOODDOOD",
        "...DOHOEEOOOOOOOOEEOOOOOSD",
        "...DHOEOOEOOOOOOEOOEOOOOD.",
        "..DOHOOOOOOOOOOOOOOOOOOD..",
        "..DOOPOPOOOEEEEOOOPOPOOD..",
        "..DOOPOPOOOETTEOOOPOPOSD..",
        ".DOOOOOOOOOOEEOOOOOOSSSSD.",
        ".DOOOOOOOOOOOOOOOOSSSSSSD.",
        ".DOOOOOOOOOOOOOOSSSSSSSSD.",
        ".DOOOOOOOOOOOOSSSSSSSSSSD.",
        ".DOOOODDOOOSDDSSSSDDSSSSD.",
        "..DOOD..DSSD..DSSD..DSSD..",
        "...DD....DD....DD....DD...",
    ],
    surprised: [
        "..........................",
        "..........................",
        "..........................",
        "......DDD........DDD......",
        "...DDDDFDDDDDDDDDDFDDDD...",
        "...DODFFFDOOOOOODFFFDOD...",
        "...DODDFDDOOOOOODDFDDOD...",
        "...DOODDDOOOOOOOODDDOOD...",
        "....DOOOOOOOOOOOOOOOOD....",
        "....DOOOOOOOOOOOOOOOOD....",
        "...DOHOOEOOOOOOOOEOOOOD...",
        "...DHOOEOEOOOOOOEOEOOOD...",
        "..DOHOOOEOOOOOOOOEOOOOOD..",
        "..DOOPOPOOOOEEOOOOPOPOOD..",
        "..DOOPOPOOOOEEOOOOPOPOSD..",
        ".DOOOOOOOOOOOOOOOOOOSSSSD.",
        ".DOOOOOOOOOOOOOOOOSSSSSSD.",
        ".DOOOOOOOOOOOOOOSSSSSSSSD.",
        ".DOOOOOOOOOOOOSSSSSSSSSSD.",
        ".DOOOODDOOOSDDSSSSDDSSSSD.",
        "..DOOD..DSSD..DSSD..DSSD..",
        "...DD....DD....DD....DD...",
    ],
    sideA: [
        "............",
        ".D........D.",
        ".DD.DDDD.DD.",
        ".DFDOOOODFD.",
        "DOOOOOOOOOOD",
        "DHEEOOEEOOOD",
        "DPOOEOOPOSSD",
        "DOOOOOOOSSSD",
        "DOOOOOOSSSSD",
        "DDOODDSSDDSD",
        "D.DD..DD..DD",
        "............",
    ],
    sideB: [
        "............",
        ".D........D.",
        ".DD.DDDD.DD.",
        ".DFDOOOODFD.",
        "DOOOOOOOOOOD",
        "DHEEOOEEOOOD",
        "DPOOEOOPOSSD",
        "DOOOOOOOSSSD",
        "DOOOOOOSSSSD",
        "DODDOODDSSDD",
        "DD..DD..DD.D",
        "............",
    ],
} as const;

export type MascotPose = keyof typeof MASCOT_POSES;

/** 色票（`.` = 透明），與 mascot.rs 的 PALETTE 相同。/ Palette, same as mascot.rs. */
export const MASCOT_PALETTE: Record<string, string> = {
    D: "#4a2026",
    O: "#f28a38",
    S: "#dc6a24",
    H: "#ffd9b0",
    E: "#4a2026",
    P: "#ff9a9a",
    T: "#e9677a",
    F: "#8de6cf",
};

export interface PixelRun {
    x: number;
    y: number;
    w: number;
    fill: string;
}

/** 每列連續同色的像素併成一段（SVG 的 rect 少很多）。/ Merge same-colour pixels per row into runs (fewer rects). */
export function pixelRuns(sprite: readonly string[], palette: Record<string, string> = MASCOT_PALETTE): PixelRun[] {
    const runs: PixelRun[] = [];
    sprite.forEach((row, y) => {
        let x = 0;
        while (x < row.length) {
            const c = row[x];
            let end = x + 1;
            while (end < row.length && row[end] === c) end++;
            const fill = palette[c];
            if (fill) runs.push({ x, y, w: end - x, fill });
            x = end;
        }
    });
    return runs;
}

export function spriteSize(sprite: readonly string[]): { w: number; h: number } {
    return { w: Math.max(0, ...sprite.map((r) => r.length)), h: sprite.length };
}

/** 左右翻轉（側面朝右）。/ Flip horizontally. */
export function mirrored(sprite: readonly string[]): string[] {
    return sprite.map((r) => [...r].reverse().join(""));
}

/** 十字髮夾可以選的顏色（順序、名字、色碼與 mascot.rs 的 CLIP_COLORS 相同；第一個 = 預設）。 */
/** The clip colours (same order, names and values as mascot.rs CLIP_COLORS; the first is the default). */
export const CLIP_COLORS = [
    ["teal", "#8de6cf"],
    ["sakura", "#ffb3c7"],
    ["lemon", "#ffe27a"],
    ["grape", "#c9a7ff"],
    ["sky", "#9fd3ff"],
    ["cream", "#fff3dc"],
] as const;
export type ClipColor = (typeof CLIP_COLORS)[number][0];
/** 「每天換一個」（看完片尾名單解鎖）。/ "A new one every day" (unlocked by the credits). */
export const DAILY = "daily";

/** 今天是第幾天（UTC，與 mascot.rs 同一條規則：同一天網頁、ssh、CLI 一致）。/ Today's UTC day number (same rule as mascot.rs). */
export function unixDay(now: number = Date.now()): number {
    return Math.floor(now / 86_400_000);
}

/** 存的選擇 → 這一天的顏色名字（daily 依日期輪流，不認得 = 預設）。/ Stored choice → today's colour name. */
export function clipName(choice: string | null | undefined, day: number): ClipColor {
    if (choice === DAILY) return CLIP_COLORS[((day % CLIP_COLORS.length) + CLIP_COLORS.length) % CLIP_COLORS.length][0];
    return CLIP_COLORS.find(([n]) => n === choice)?.[0] ?? CLIP_COLORS[0][0];
}

export function clipHex(name: ClipColor): string {
    return CLIP_COLORS.find(([n]) => n === name)?.[1] ?? CLIP_COLORS[0][1];
}

export type TapiFestival = "lunarNewYear" | "birthday" | "halloween" | null;

export interface TapiLook {
    /** 十字髮夾的顏色。/ The clip colour. */
    clip: string;
    /** 節日換裝（只在網頁：終端機那端算不了農曆）。/ Festive outfit (web only). */
    festival: TapiFestival;
}

// 節日換裝用的顏色（終端機沒有，所以不在 mascot.rs）；W / G / K = 萬聖節的床單、床單陰影、眼洞。
// Festive colours (web only, so not in mascot.rs); W / G / K = the Halloween sheet, its shade and the eye holes.
const FESTIVE: Record<string, string> = { R: "#e8433a", Y: "#ffd36b", Z: "#ff7aa8", Q: "#ffffff", W: "#f6f2ea", G: "#d8cfc1", K: "#2a1d1f" };
// 生日的派對帽（放在兩個十字中間、頭頂上）。/ The birthday party hat, on the head between the clips.
const PARTY_HAT = ["...Y...", "..DZD..", "..DQD..", ".DZZZD.", ".DQQQD.", "DZZZZZD"];
const HAT_AT = { x: 9, y: 0 };
// 萬聖節：幽靈扮成幽靈——披一條床單，挖兩個眼洞，下擺露出一截橘色（看得出是 Tapi 躲在裡面），十字從床單上露出來。
// Halloween: the ghost dresses up as a ghost — a bedsheet with two eye holes, the orange hem showing below (so it is
// clearly Tapi under there), the clips poking through. Holes and hem row per sprite width (front 26, side 12).
const SHEET = {
    front: { hem: 19, holes: [8, 9, 15, 16].flatMap((x) => [11, 12, 13].map((y) => [x, y] as const)) },
    side: { hem: 9, holes: [2, 3, 6, 7].map((x) => [x, 5] as const) },
};

/**
 * 依外觀換色、換裝：十字 → 選的顏色；新年 = 紅十字、金色中心；生日 = 戴派對帽（只套在正面的大圖）；萬聖節 = 披床單。
 * 回傳像素格與這張圖要用的色票。/ Apply a look: clips in the chosen colour; Lunar New Year = red crosses with
 * gold centres; birthday = a party hat (front poses only); Halloween = a bedsheet costume. Returns the grid and the palette to draw it with.
 */
export function dressTapi(sprite: readonly string[], look: TapiLook): { sprite: string[]; palette: Record<string, string> } {
    const rows = sprite.map((r) => [...r]);
    const palette: Record<string, string> = { ...MASCOT_PALETTE, ...FESTIVE, F: look.clip };
    const front = (rows[0]?.length ?? 0) >= 20;
    if (look.festival === "lunarNewYear") {
        const isF = (x: number, y: number) => rows[y]?.[x] === "F";
        const centres: [number, number][] = [];
        rows.forEach((r, y) => r.forEach((c, x) => c === "F" && isF(x - 1, y) && isF(x + 1, y) && isF(x, y - 1) && isF(x, y + 1) && centres.push([x, y])));
        rows.forEach((r, y) => r.forEach((c, x) => c === "F" && (rows[y][x] = "R")));
        for (const [x, y] of centres) rows[y][x] = "Y";
    }
    if (look.festival === "birthday" && front) {
        PARTY_HAT.forEach((r, j) => [...r].forEach((c, i) => c !== "." && (rows[HAT_AT.y + j][HAT_AT.x + i] = c)));
    }
    if (look.festival === "halloween") {
        const sheet = front ? SHEET.front : SHEET.side;
        // 轉過身（沒有臉）就沒有眼洞。/ Turned around (no face) = no eye holes.
        const face = rows.some((r) => r.includes("E"));
        rows.forEach((r, y) => {
            if (y >= sheet.hem) return;
            r.forEach((c, x) => {
                if ("OHPTE".includes(c)) r[x] = "W";
                else if (c === "S") r[x] = "G";
            });
        });
        if (face) for (const [x, y] of sheet.holes) if (rows[y]?.[x] && rows[y][x] !== ".") rows[y][x] = "K";
    }
    return { sprite: rows.map((r) => r.join("")), palette };
}
