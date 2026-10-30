/**
 * 列表列的「安靜」寫法：圖示 + 文字、沒有框也沒有底色，hover 才變深；要提醒的只把字換成警示色。
 * 表格檢視（≥1200px）每一列原本把埠、連線方式、OS、外網、內網、每個警告……各做成一個小框往下堆（一列堆到十個），
 * 整欄灰框像雜訊，真正要緊的（狀態、風險）反而看不見。卡片還是用小框（`variant="chip"`，預設），表格列用這組
 * （`variant="text"`）；小框只留給罕見又一定要看到的旗標（host key 變了）。
 * The list row's "quiet" style: icon + text, no border or background, darker on hover; only warnings tint the text.
 * The table view used to stack port, way in, OS, public / LAN IP and every warning as its own chip (ten per row): a
 * column of grey boxes reads as noise and hides what matters (state, risk). Cards keep the chips (`variant="chip"`,
 * the default), table rows use these (`variant="text"`); chips stay only for the rare, must-see flag (a changed host key).
 */
import { cn } from "@/lib/utils";

export type RowVariant = "chip" | "text";

const QUIET =
    "inline-flex max-w-full items-center gap-1 rounded-sm whitespace-nowrap text-[0.75rem] leading-5 transition-colors [&>svg]:size-3 [&>svg]:shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

const TONE = {
    /** 平常的附註。/ An ordinary note. */
    muted: "text-muted-foreground hover:text-foreground",
    /** 跟內容同色（埠號、IP、擁有者）。/ Content tone (port, IP, owner). */
    plain: "text-foreground/80 hover:text-foreground",
    info: "text-info hover:text-info/80",
    success: "text-success hover:text-success/80",
    warning: "text-warning hover:text-warning/80",
    danger: "text-destructive hover:text-destructive/80",
} as const;

export type QuietTone = keyof typeof TONE;

/** 安靜文字的 class；`extra` 接在後面（例如 `font-mono`）。/ The quiet-text class, `extra` appended (e.g. `font-mono`). */
export function quiet(tone: QuietTone = "muted", ...extra: (string | false | null | undefined)[]): string {
    return cn(QUIET, TONE[tone], ...extra);
}
