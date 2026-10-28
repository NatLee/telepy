/**
 * 彩蛋：片尾名單。做成一段 asciicast（跟終端機錄影同一種格式），用錄影播放器 CastPlayer 播：
 * 字從下面捲上來，最後停在一句謝謝（Tapi 畫在對話框裡：xterm 的 DOM 渲染會在半格字元之間留縫）。
 * 標題由畫面翻譯後傳進來，名字與授權不翻。
 * Easter egg: the credits roll, built as an asciicast (the terminal-recording format) and played by CastPlayer:
 * lines scroll up from the bottom and it ends on a thank-you (Tapi is drawn in the dialog — xterm's DOM renderer
 * leaves seams between half blocks). Section titles arrive translated; names and
 * licences are not translated. 純函式，`credits.test.ts` 有測試。/ Pure; tested in credits.test.ts.
 */
export interface CreditSection {
    title: string;
    lines: string[];
}

/** 每段的名字（標題的翻譯 key 在畫面那邊）。/ The names per section (title keys live in the component). */
export const CREDIT_LINES = {
    typefaces: ["jf-openhuninn 2.1 (粉圓) · justfont", "0xProto · Hack · JetBrains Mono", "Fira Code · Cascadia Code · Meslo LG", "Nerd Fonts 3.5.1"],
    browser: ["Next.js · React · Tailwind CSS · Radix UI", "xterm.js · CodeMirror · client-zip", "guacamole-common-js (Apache-2.0)", "KasmVNC noVNC (MPL-2.0)", "RustDesk web client (AGPL-3.0)"],
    server: ["Rust · axum · tokio · russh · sqlx · SQLite"],
    alongside: ["Apache Guacamole guacd · KasmVNC · Chromium", "Traefik · OpenSSH"],
    data: ["DB-IP Lite (CC BY 4.0)", "IEEE OUI registry"],
    mascot: ["Tapi"],
} as const;

export type CreditSectionKey = keyof typeof CREDIT_LINES;

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

export interface CreditsOptions {
    title: string;
    tagline: string;
    thanks: string;
    width?: number;
    height?: number;
    /** 每一列間隔幾秒。/ Seconds between lines. */
    step?: number;
}

/** 整段 asciicast v2 文字（CastPlayer 用 parseCast 讀）。/ The whole asciicast v2 text (read with parseCast). */
export function creditsCast(sections: CreditSection[], opts: CreditsOptions): string {
    const width = opts.width ?? 56;
    const height = opts.height ?? 18;
    const step = opts.step ?? 0.5;
    const events: [number, "o", string][] = [];
    let t = 0;
    // 游標移到最底下、藏起來：之後每一列都從底部捲上來。/ Cursor to the bottom, hidden: every line scrolls up from there.
    events.push([0, "o", `\x1b[?25l\x1b[${height};1H`]);
    const line = (text: string, gap = step) => {
        t += gap;
        events.push([Number(t.toFixed(2)), "o", `\r\n${text}`]);
    };
    const blank = (n = 1) => {
        for (let i = 0; i < n; i++) line("");
    };
    line(`${ORANGE}${center(opts.title, width)}${RESET}`);
    line(`${DIM}${center(opts.tagline, width)}${RESET}`);
    blank(3);
    for (const s of sections) {
        line(`${ORANGE}${center(s.title, width)}${RESET}`);
        for (const l of s.lines) line(center(l, width));
        blank(2);
    }
    blank(2);
    line(center(opts.thanks, width));
    // 再捲幾列，讓謝謝停在畫面中間。/ Scroll a little more so the thank-you rests mid-screen.
    blank(Math.max(0, Math.floor(height / 2) - 1));
    events.push([Number((t + 2).toFixed(2)), "o", RESET]);
    const header = { version: 2, width, height, title: opts.title };
    return [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n";
}
