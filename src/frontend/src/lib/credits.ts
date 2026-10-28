/**
 * 彩蛋：片尾名單。做成一段 asciicast（跟終端機錄影同一種格式），用錄影播放器 CastPlayer 播：
 * 字從下面捲上來，貢獻者排第一段，段落之間有像素圖，最後 Tapi 飄進來謝幕。
 * 像素圖用「有背景色的空白格」畫（一個像素 = 兩欄 × 一列）：xterm 的 DOM 渲染會讓 ▀▄ 半格字元之間留縫，
 * 但背景色會填滿整格。標題由畫面翻譯後傳進來，名字與授權不翻。
 * Easter egg: the credits roll, built as an asciicast (the terminal-recording format) and played by CastPlayer:
 * lines scroll up from the bottom, the contributors come first, pixel art sits between the sections, and Tapi
 * floats in at the end. Pixels are background-coloured spaces (one pixel = two columns × one row): xterm's DOM
 * renderer leaves seams between ▀▄ half blocks, but a background fills the whole cell. Section titles arrive
 * translated; names and licences are not translated. 純函式，`credits.test.ts` 有測試。/ Pure; tested in credits.test.ts.
 */
import { CLIP_COLORS, dressTapi, MASCOT_POSES, type MascotPose, type TapiLook } from "./mascot.ts";

/** 一張像素圖：格子 + 色票（`.` 或色票裡沒有的字 = 透明）。/ A pixel image: grid + palette (`.` or unknown = transparent). */
export interface PixelArt {
    rows: readonly string[];
    palette: Record<string, string>;
}

export interface CreditSection {
    title: string;
    lines: string[];
    /** 名字下面一句淡色的話。/ A dim line under the names. */
    note?: string;
    /** 標題上面的插圖。/ The picture above the title. */
    art?: PixelArt;
}

/**
 * 每段的名字（標題的翻譯 key 在畫面那邊）。貢獻者照 GitHub 的貢獻數排（`gh api repos/NatLee/telepy/contributors`），
 * 有新的人就加在這裡。/ The names per section (title keys live in the component). Contributors are in GitHub's
 * contribution order (`gh api repos/NatLee/telepy/contributors`); add new people here.
 */
export const CREDIT_LINES = {
    contributors: ["Nat Lee (@NatLee)", "halice (@h-alice)", "Boris.Lok (@boris-lok)"],
    typefaces: ["jf-openhuninn 2.1 (粉圓) · justfont", "0xProto · Hack · JetBrains Mono", "Fira Code · Cascadia Code · Meslo LG", "Nerd Fonts 3.5.1"],
    browser: ["Next.js · React · Tailwind CSS · Radix UI", "xterm.js · CodeMirror · client-zip", "guacamole-common-js (Apache-2.0)", "KasmVNC noVNC (MPL-2.0)", "RustDesk web client (AGPL-3.0)"],
    server: ["Rust · axum · tokio · russh · sqlx · SQLite"],
    alongside: ["Apache Guacamole guacd · KasmVNC · Chromium", "Traefik · OpenSSH"],
    data: ["DB-IP Lite (CC BY 4.0)", "IEEE OUI registry"],
    mascot: ["Tapi"],
} as const;

export type CreditSectionKey = keyof typeof CREDIT_LINES;

// 插圖（自己畫的）。D = Tapi 的深色外框，所以整套圖看起來是同一個人畫的。
// The pictures (our own). D is Tapi's dark outline, so every picture looks drawn by the same hand.
const OUTLINE = "#4a2026";

/** 貢獻者：一顆柿子色的心。/ Contributors: a persimmon-coloured heart. */
const HEART: PixelArt = {
    rows: [".DDD...DDD.", "DOOOD.DOOOD", "DOHHODOOOOD", "DOHOOOOOOSD", "DOOOOOOOOSD", ".DOOOOOOSD.", "..DOOOOSD..", "...DOOSD...", "....DSD....", ".....D....."],
    palette: { D: OUTLINE, O: "#f28a38", S: "#dc6a24", H: "#ffd9b0" },
};

/** 字型：一杯珍珠奶茶（粉圓 = 珍珠，也是 Tapi 名字的由來）。/ Typefaces: bubble tea (粉圓 = the pearls, and Tapi's name). */
const BUBBLE_TEA: PixelArt = {
    rows: [
        "............KK.",
        "...........KK..",
        "..........KK...",
        "....DDDDDDKDD..",
        "...DLLLLLKLLLD.",
        "..DDDDDDDKDDDDD",
        "...DWMMMMKMMMD.",
        "...DWMMMMKMMMD.",
        "...DWMMMMKMMMD.",
        "....DWMMMKMMD..",
        "....DPMPMKMPD..",
        "....DMPMPMPMD..",
        ".....DPMPMPD...",
        ".....DDDDDDD...",
    ],
    palette: { D: OUTLINE, L: "#fff3dc", K: "#e9677a", M: "#e0b07a", W: "#fffaf0", P: "#3a2220" },
};

/** 在你的瀏覽器裡：一個瀏覽器視窗，裡面是終端機提示字元。/ In your browser: a browser window with a terminal prompt. */
const BROWSER: PixelArt = {
    rows: [
        "DDDDDDDDDDDDDDDD",
        "DRgYgVggggggggGD",
        "DDDDDDDDDDDDDDDD",
        "DkkkkkkkkkkkkkkD",
        "DkFkkkkkkkkkkkkD",
        "DkkFkkkkkkkkkkkD",
        "DkFkkOOOkkkkkkkD",
        "DkkkkkkkkkkkkkkD",
        "DDDDDDDDDDDDDDDD",
    ],
    palette: { D: OUTLINE, R: "#ff6b5e", Y: "#ffd36b", V: "#5fd38d", g: "#b3aa9e", G: "#d9d2c8", k: "#2a2324", F: "#8de6cf", O: "#f28a38" },
};

/** 在伺服器上：一座三層的機櫃，燈亮著。/ On the server: a three-unit rack with its lights on. */
const SERVER: PixelArt = {
    rows: [
        "DDDDDDDDDDDD",
        "DGGGGGGGGGGD",
        "DGAgBgGkkkGD",
        "DggggggggggD",
        "DDDDDDDDDDDD",
        "DGGGGGGGGGGD",
        "DGAgAgGkkkGD",
        "DggggggggggD",
        "DDDDDDDDDDDD",
        "DGGGGGGGGGGD",
        "DGBgAgGkkkGD",
        "DggggggggggD",
        "DDDDDDDDDDDD",
        ".DD......DD.",
    ],
    palette: { D: OUTLINE, G: "#d9d2c8", g: "#b3aa9e", A: "#5fd38d", B: "#f28a38", k: "#2a2324" },
};

/** 固定的插圖（吉祥物那段由畫面依使用者決定）。/ The fixed pictures (the mascot's depends on the viewer). */
export const CREDIT_ART: Partial<Record<CreditSectionKey, PixelArt>> = {
    contributors: HEART,
    typefaces: BUBBLE_TEA,
    browser: BROWSER,
    server: SERVER,
};

/** 去掉上下的空白列。/ Drop blank rows at the top and bottom. */
function trimRows(rows: readonly string[]): string[] {
    const filled = (r: string) => /[^.]/.test(r);
    const first = rows.findIndex(filled);
    if (first < 0) return [];
    let last = rows.length - 1;
    while (!filled(rows[last])) last--;
    return rows.slice(first, last + 1);
}

/** 穿好衣服的 Tapi（帳號的髮夾顏色、節日）。/ Tapi dressed in a look (clip colour, festival). */
export function tapiArt(pose: MascotPose, look: TapiLook): PixelArt {
    const { sprite, palette } = dressTapi(MASCOT_POSES[pose], look);
    return { rows: trimRows(sprite), palette };
}

/** 剪影：還沒找到 Tapi 的人只看得到影子（沒有臉、沒有髮夾）。/ A silhouette for people who have not found Tapi yet. */
export function shadowArt(art: PixelArt): PixelArt {
    const palette: Record<string, string> = {};
    for (const c of new Set(art.rows.join(""))) if (c !== "." && art.palette[c]) palette[c] = c === "D" ? "#6e6466" : "#3d3638";
    return { rows: art.rows, palette };
}

/** 謝幕：飄進來時一格一格換的圖，以及停下來的那張。/ The finale: frames while floating in, and the one it rests on. */
export interface Finale {
    float: PixelArt[];
    rest: PixelArt;
}

/**
 * 依看的人決定謝幕：`owned` = 已經有 Tapi；`unlock` = 這次看完會解鎖每天換色，飄進來時髮夾輪流換六種顏色；
 * `shadow` = 還沒找到 Tapi，只飄進來一個影子。/ The finale per viewer: `owned` = has Tapi; `unlock` = finishing
 * unlocks the daily colour, so the clips cycle through all six while floating in; `shadow` = has not found Tapi yet.
 */
export type FinaleKind = "owned" | "unlock" | "shadow";

export function tapiFinale(kind: FinaleKind, look: TapiLook): Finale {
    const a = tapiArt("sideA", look);
    const b = tapiArt("sideB", look);
    if (kind === "shadow") return { float: [shadowArt(a), shadowArt(a), shadowArt(b), shadowArt(b)], rest: shadowArt(a) };
    if (kind === "unlock") {
        // 每兩格換一種顏色，下襬也跟著擺。/ A new colour every two frames, the hem swinging along.
        const float = CLIP_COLORS.flatMap(([, clip]) => [tapiArt("sideA", { ...look, clip }), tapiArt("sideB", { ...look, clip })]);
        return { float, rest: a };
    }
    return { float: [a, a, b, b], rest: a };
}

const ORANGE = "\x1b[38;2;227;119;14m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** 終端機欄寬：東亞全形字算 2。/ Terminal columns: East Asian wide characters count as 2. */
export function displayWidth(s: string): number {
    let w = 0;
    for (const ch of s.replace(/\x1b\[[0-9;]*m/g, "")) {
        const c = ch.codePointAt(0) ?? 0;
        const wide =
            (c >= 0x1100 && c <= 0x115f) ||
            (c >= 0x2e80 && c <= 0xa4cf) ||
            (c >= 0xac00 && c <= 0xd7a3) ||
            (c >= 0xf900 && c <= 0xfaff) ||
            (c >= 0xfe30 && c <= 0xfe4f) ||
            (c >= 0xff00 && c <= 0xff60) ||
            (c >= 0xffe0 && c <= 0xffe6) ||
            c >= 0x20000;
        w += wide ? 2 : 1;
    }
    return w;
}

export function center(s: string, width: number): string {
    return " ".repeat(Math.max(0, Math.floor((width - displayWidth(s)) / 2))) + s;
}

/** 圖有幾欄寬（一個像素兩欄）。/ How many columns a picture takes (two per pixel). */
export function artColumns(art: PixelArt): number {
    return 2 * Math.max(0, ...art.rows.map((r) => r.length));
}

function bg(hex: string): string {
    const n = parseInt(hex.slice(1), 16);
    return `\x1b[48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

/**
 * 圖的一列，左上角在第 `x` 欄（0 起算，可以是負的或超出右邊：超出畫面的像素不畫）。後面的透明格不輸出。
 * One row of a picture with its left edge at column `x` (0-based; may be negative or past the right edge —
 * pixels off screen are skipped). Trailing transparent cells are left out.
 */
export function artRow(row: string, palette: Record<string, string>, x: number, width: number): string {
    const cells: (string | null)[] = Array.from({ length: width }, () => null);
    [...row].forEach((c, i) => {
        const fill = palette[c];
        if (!fill) return;
        for (const col of [x + 2 * i, x + 2 * i + 1]) if (col >= 0 && col < width) cells[col] = fill;
    });
    while (cells.length && cells[cells.length - 1] === null) cells.pop();
    let out = "";
    let current: string | null = null;
    for (const fill of cells) {
        if (fill !== current) out += fill ? bg(fill) : RESET;
        current = fill;
        out += " ";
    }
    return current ? out + RESET : out;
}

export interface CreditsOptions {
    title: string;
    tagline: string;
    thanks: string;
    /** 謝謝下面一句淡色的話（提示怎麼找到 Tapi）。/ A dim line under the thank-you (how to find Tapi). */
    hint?: string;
    /** Tapi 從右邊飄進來謝幕；沒有就讓謝謝停在畫面中間。/ Tapi floats in from the right; without it the thank-you rests mid-screen. */
    finale?: Finale;
    width?: number;
    height?: number;
    /** 每一列間隔幾秒。/ Seconds between lines. */
    step?: number;
}

/** 謝幕動畫每一格幾秒。/ Seconds per finale frame. */
const FRAME = 0.12;

/** 整段 asciicast v2 文字（CastPlayer 用 parseCast 讀）。/ The whole asciicast v2 text (read with parseCast). */
export function creditsCast(sections: CreditSection[], opts: CreditsOptions): string {
    const width = opts.width ?? 56;
    const height = opts.height ?? 20;
    const step = opts.step ?? 0.35;
    const events: [number, "o", string][] = [];
    let t = 0;
    const at = () => Number(t.toFixed(2));
    // 游標移到最底下、藏起來：之後每一列都從底部捲上來。/ Cursor to the bottom, hidden: every line scrolls up from there.
    events.push([0, "o", `\x1b[?25l\x1b[${height};1H`]);
    const line = (text: string, gap = step) => {
        t += gap;
        events.push([at(), "o", `\r\n${text}`]);
    };
    const blank = (n = 1) => {
        for (let i = 0; i < n; i++) line("");
    };
    const picture = (art: PixelArt) => {
        const x = Math.max(0, Math.floor((width - artColumns(art)) / 2));
        for (const row of art.rows) line(artRow(row, art.palette, x, width));
    };
    line(`${ORANGE}${center(opts.title, width)}${RESET}`);
    line(`${DIM}${center(opts.tagline, width)}${RESET}`);
    blank(3);
    for (const s of sections) {
        if (s.art) {
            picture(s.art);
            blank();
        }
        line(`${ORANGE}${center(s.title, width)}${RESET}`);
        for (const l of s.lines) line(center(l, width));
        if (s.note) line(`${DIM}${center(s.note, width)}${RESET}`);
        blank(2);
    }
    blank(2);
    line(center(opts.thanks, width));
    if (opts.hint) line(`${DIM}${center(opts.hint, width)}${RESET}`);
    const finale = opts.finale;
    const tall = finale ? Math.max(finale.rest.rows.length, ...finale.float.map((f) => f.rows.length)) : 0;
    // 謝幕放在最下面（留一列空白），謝謝停在它上面三列；畫面不夠高就不演。
    // The finale sits at the bottom (one blank row below), the thank-you three rows above it; skipped when the screen is too short.
    const top = height - tall;
    const thanksRow = top - 3;
    if (finale && thanksRow >= 1) {
        blank(height - thanksRow - (opts.hint ? 1 : 0));
        const wide = Math.max(artColumns(finale.rest), ...finale.float.map(artColumns));
        // 從右邊畫面外飄到中間，一次兩欄（一個像素）。/ From off screen on the right to the middle, two columns (one pixel) at a time.
        const stop = Math.floor((width - wide) / 4) * 2;
        const draw = (art: PixelArt, x: number) => {
            let out = RESET;
            for (let r = 0; r < tall; r++) out += `\x1b[${top + r};1H\x1b[2K${artRow(art.rows[r] ?? "", art.palette, x, width)}`;
            t += FRAME;
            events.push([at(), "o", out]);
        };
        let i = 0;
        for (let x = width + (width % 2); x > stop; x -= 2) draw(finale.float[i++ % finale.float.length], x);
        draw(finale.rest, stop);
    } else {
        // 再捲幾列，讓謝謝停在畫面中間。/ Scroll a little more so the thank-you rests mid-screen.
        blank(Math.max(0, Math.floor(height / 2) - 1 - (opts.hint ? 1 : 0)));
    }
    events.push([Number((t + 2).toFixed(2)), "o", RESET]);
    const header = { version: 2, width, height, title: opts.title };
    return [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n";
}
