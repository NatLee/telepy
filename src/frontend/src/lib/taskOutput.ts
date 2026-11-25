/**
 * 指令速查的任務「跑起來長這樣」與指令解說的連動（純函式）。
 * - `taskOutput`：這個任務用現在填的值跑起來，終端機會印什麼。`telepy forward` 印的兩行照 CLI 的格式字串組
 *   （`src/cli/src/lib.rs`；測試讀那個檔比對），網址還是 `localhost:<port>` 照同一張網頁 port 表（`lib/lanWeb.ts`）。
 *   單純的 `ssh -N`、`telepy ssh -N` 成功時什麼都不印——那就不放假的輸出，只給一句說明（`note`）。
 *   rsync 的那段是 CLI 範例真的跑出來的（`examples.rs` 的 `output`），所以裡面是範例資料夾的檔名。
 * - `segmentFields` / `fieldSegments`：指令的某一段用到填空句的哪幾格、某一格出現在指令的哪幾段（滑到一邊，另一邊亮起來）。
 * What a task on the command sheet prints when run, and the link between a command's parts and the sentence's blanks
 * (pure). `taskOutput`: with the values filled in right now. The two lines `telepy forward` prints follow the CLI's
 * format string (`src/cli/src/lib.rs`; the test reads that file), and URL versus `localhost:<port>` follows the same
 * web-port table (`lib/lanWeb.ts`). A plain `ssh -N` / `telepy ssh -N` prints nothing when it works, so there is no
 * made-up output for it, only a note. The rsync lines are the CLI example's real output (`output` in examples.rs),
 * hence the sample folder's file names. `segmentFields` / `fieldSegments`: which blanks a part of the command uses and
 * which parts a blank appears in (hover one side, the other lights up).
 */
import type { TranslationKey } from "../locales/en.ts";
import { CLI_EXAMPLES } from "./cliExamples.gen.ts";
import { webScheme } from "./lanWeb.ts";
import { TELEPY_RSYNC_EXAMPLE, type ConnectMode, type FieldDef, type ForwardOptions, type RecipeId, type RecipeParams, type Segment } from "./forwardRecipes.ts";

export interface TaskOutput {
    /** 終端機印出來的（原文，不翻譯）。/ What the terminal prints, verbatim. */
    lines: string[];
    /** 一句說明：接下來會怎樣（翻譯過的，不是終端機印的）。/ One sentence on what happens next (translated; not printed by the terminal). */
    note: TranslationKey;
    vars?: Record<string, string>;
}

/** `telepy forward` 接通後印的位址：網頁 port 是網址，其他是 `localhost:<port>`。/ What `telepy forward` prints once up. */
export function forwardShown(remotePort: string, localPort: string): string {
    const scheme = webScheme(Number(remotePort));
    return scheme ? `${scheme}://localhost:${localPort}/` : `localhost:${localPort}`;
}

/** CLI 的那一行（格式字串在 `src/cli/src/lib.rs`）。/ The CLI's line (the format string lives in `src/cli/src/lib.rs`). */
export const FORWARDING_LINE = "Forwarding {shown} → {target_text} behind {}. Press Ctrl+C to stop.";

function forwardLines(tunnel: string, host: string, remotePort: string, localPort: string): string[] {
    const shown = forwardShown(remotePort, localPort);
    const target = host.includes(":") ? `[${host}]:${remotePort}` : `${host}:${remotePort}`;
    return [shown, FORWARDING_LINE.replace("{shown}", shown).replace("{target_text}", target).replace("{}", tunnel)];
}

export function taskOutput(id: RecipeId, p: RecipeParams, tunnel: string, mode: ConnectMode, options: ForwardOptions): TaskOutput {
    const telepy = mode === "telepy";
    const quiet: TaskOutput = { lines: [], note: !telepy && options.background ? "sheet.out.background" : "sheet.out.silent" };
    switch (id) {
        case "local":
            return telepy ? { lines: forwardLines(tunnel, "localhost", p.remotePort, p.localPort), note: "sheet.out.holds" } : quiet;
        case "lan":
            return telepy ? { lines: forwardLines(tunnel, p.lanHost, p.lanPort, p.localPort), note: "sheet.out.holds" } : quiet;
        case "rustdesk":
            return telepy ? { lines: forwardLines(tunnel, p.lanHost, p.remotePort, p.localPort), note: "sheet.out.holds" } : quiet;
        case "socks":
        case "remote":
            return quiet;
        case "jump":
            return { lines: [], note: "sheet.out.shell", vars: { host: p.lanHost } };
        case "copy":
            if (p.tool === "rsync") return { lines: [...(CLI_EXAMPLES.find((e) => e.id === TELEPY_RSYNC_EXAMPLE)?.output ?? [])], note: "sheet.out.rsync" };
            return { lines: [], note: "sheet.out.scp" };
        case "vpn":
            return { lines: [], note: "sheet.out.vpn" };
    }
}

const pieces = (text: string): string[] => [text, ...text.split(/[\s:@,/=]+/)].filter((s) => s !== "");

/** 指令的這一段用到哪幾格（比對那一格現在的值）。/ The blanks this part of the command uses (matched by their current value). */
export function segmentFields(seg: Segment, fields: readonly FieldDef[], resolved: RecipeParams): string[] {
    const texts = seg.tokens.map((tk) => tk.text);
    const have = new Set(texts.flatMap(pieces));
    // 路徑寫在 `主機:路徑` 的冒號後面（可能被引號包住）。/ A path sits after the colon of `host:path` (maybe quoted).
    const hit = (v: string) => have.has(v) || have.has(`'${v}'`) || texts.some((x) => x.endsWith(`:${v}`) || x.endsWith(`:'${v}'`));
    return fields.filter((f) => f.kind !== "choice" && (resolved[f.key] ?? "") !== "" && hit(resolved[f.key])).map((f) => f.key);
}

/** 這一格出現在指令的哪幾段。/ The parts of the command a blank appears in. */
export function fieldSegments(key: string, segments: readonly Segment[], fields: readonly FieldDef[], resolved: RecipeParams): number[] {
    return segments.flatMap((seg, i) => (seg.explain && segmentFields(seg, fields, resolved).includes(key) ? [i] : []));
}
