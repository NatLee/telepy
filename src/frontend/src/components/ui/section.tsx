/**
 * 對話框與設定頁共用的區塊元件:
 * - SectionHeading:小圖示 + 標題 + 一行說明(+ 右側動作)。取代各處手刻的 h3/text-xs 標題。
 * - Section:標題 + 內容。放在 SectionPanels 裡面時畫成一張卡片(標題列 + 細線 + 內容),頁面上一塊一塊分得開;
 *   對話框裡照舊是平的(對話框本身就是一張卡片)。
 * - SectionOutline:SectionPanels 裡有哪些卡片,捲到哪一塊就標哪一塊,點了捲過去(通道頁面的左側欄)。
 * - PropertyList / Property:「標籤:值」的屬性清單(詳細資訊視窗用)。
 * - Chip:小圓角標籤(ID、埠號、權限等)。
 * Shared blocks for dialogs and settings pages: SectionHeading (icon + title + one-line description + optional action);
 * Section (heading + content — inside SectionPanels it is drawn as a card with a header strip, so a page's blocks read
 * apart; in dialogs it stays flat, the dialog already being the card); SectionOutline (the cards in SectionPanels, the
 * one in view marked, a click scrolls to it — the tunnel page's rail); PropertyList / Property (label : value rows for
 * details dialogs) and Chip.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { activeSection } from "@/lib/sectionOutline";

export function SectionHeading({
    icon,
    title,
    description,
    action,
    as: Tag = "h3",
    wrapTitle = false,
    className,
}: {
    icon?: React.ReactNode;
    title: React.ReactNode;
    description?: React.ReactNode;
    action?: React.ReactNode;
    as?: "h2" | "h3" | "h4";
    /** 標題放不下時換行，不截成「…」（窄面板裡的長標題）。/ Wrap a long title instead of cutting it to "…" (narrow panels). */
    wrapTitle?: boolean;
    className?: string;
}) {
    return (
        <div className={cn("flex items-start justify-between gap-3", className)}>
            <div className="min-w-0 flex-1">
                <Tag className="flex items-center gap-2 text-base leading-snug text-foreground [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
                    {icon}
                    <span className={cn("min-w-0", wrapTitle ? "[overflow-wrap:anywhere]" : "truncate")}>{title}</span>
                </Tag>
                {description && <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{description}</p>}
            </div>
            {action && <div className="shrink-0">{action}</div>}
        </div>
    );
}

type SectionLook = "plain" | "panel";
const LookContext = React.createContext<SectionLook>("plain");

interface OutlineEntry {
    id: string;
    title: React.ReactNode;
    el: HTMLElement | null;
}

/** SectionPanels 裡的卡片清單(給 SectionOutline 讀)。/ The cards inside SectionPanels, read by SectionOutline. */
class OutlineStore {
    private entries = new Map<string, OutlineEntry>();
    private listeners = new Set<() => void>();
    private snapshot: OutlineEntry[] = [];
    subscribe = (fn: () => void) => {
        this.listeners.add(fn);
        return () => void this.listeners.delete(fn);
    };
    get = () => this.snapshot;
    set(entry: OutlineEntry) {
        this.entries.set(entry.id, entry);
        this.emit();
    }
    remove(id: string) {
        if (this.entries.delete(id)) this.emit();
    }
    private emit() {
        // 照畫面上的順序(後來才載入的卡片可能插在中間)。/ In page order (a card that loads later may sit in between).
        this.snapshot = [...this.entries.values()].sort((a, b) => (a.el && b.el && a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1));
        this.listeners.forEach((fn) => fn());
    }
}
const OutlineContext = React.createContext<OutlineStore | null>(null);

/** 共用一份卡片清單:SectionPanels 與 SectionOutline 都放在它裡面。/ One list of cards shared by SectionPanels and SectionOutline. */
export function SectionOutlineProvider({ children }: { children: React.ReactNode }) {
    const [store] = React.useState(() => new OutlineStore());
    return <OutlineContext.Provider value={store}>{children}</OutlineContext.Provider>;
}

/** 裡面的每個 Section 畫成一張卡片;卡片裡的 Section 照舊是平的。/ Every Section inside becomes a card; Sections inside a card stay flat. */
export function SectionPanels({ children }: { children: React.ReactNode }) {
    return <LookContext.Provider value="panel">{children}</LookContext.Provider>;
}

/** 裡面的 Section 照舊是平的(對話框用)。/ Sections inside stay flat (dialogs). */
export function SectionFlat({ children }: { children: React.ReactNode }) {
    return <LookContext.Provider value="plain">{children}</LookContext.Provider>;
}

/** 一個區塊 = 標題 + 內容,區塊之間留固定間距(在 SectionPanels 裡是一張卡片)。/ Heading + content (a card inside SectionPanels). */
export function Section({
    children,
    className,
    tone,
    ...heading
}: React.ComponentProps<typeof SectionHeading> & { children: React.ReactNode; tone?: "danger" }) {
    const look = React.useContext(LookContext);
    const outline = React.useContext(OutlineContext);
    const ref = React.useRef<HTMLElement>(null);
    const id = `section-${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const panel = look === "panel";
    const { title } = heading;
    React.useEffect(() => {
        if (!panel || !outline) return;
        outline.set({ id, title, el: ref.current });
        return () => outline.remove(id);
    }, [panel, outline, id, title]);

    if (!panel) {
        return (
            <section className={cn("space-y-3", className)}>
                <SectionHeading {...heading} />
                {children}
            </section>
        );
    }
    const { icon, description, action, as: Tag = "h2" } = heading;
    // 卡片:標題列(圖示方塊 + 標題 + 動作,說明在下一列、跨到動作底下;手機上說明從最左邊開始)、一條細線、內容。
    // scroll-mt 讓捲過來時不被黏著的頁首蓋住。
    // A card: header strip (icon tile + title + action; the description on the next row, running under the action, and
    // from the left edge on phones), a hairline, the content. scroll-mt keeps it clear of the sticky header.
    return (
        <section
            ref={ref}
            id={id}
            className={cn(
                "scroll-mt-20 rounded-xl border bg-card text-card-foreground shadow-card",
                tone === "danger" ? "border-destructive/40" : "border-border/80",
                className,
            )}
        >
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-b border-border px-4 py-3.5 sm:px-5">
                {icon && (
                    <span
                        className={cn(
                            "col-start-1 row-start-1 grid size-8 shrink-0 place-items-center rounded-md [&>svg]:size-4",
                            tone === "danger" ? "bg-destructive/10 text-destructive" : "bg-muted text-foreground/75",
                        )}
                        aria-hidden
                    >
                        {icon}
                    </span>
                )}
                <Tag className={cn("row-start-1 flex min-h-8 min-w-0 items-center text-base leading-snug text-foreground [overflow-wrap:anywhere]", icon ? "col-start-2" : "col-span-2 col-start-1")}>
                    {title}
                </Tag>
                {action && <div className="col-start-3 row-start-1 flex min-h-8 items-center">{action}</div>}
                {description && (
                    <p className={cn("col-span-3 col-start-1 text-sm leading-relaxed text-muted-foreground", icon && "sm:col-span-2 sm:col-start-2")}>{description}</p>
                )}
            </div>
            <LookContext.Provider value="plain">
                <div className="space-y-3 px-4 py-4 sm:px-5">{children}</div>
            </LookContext.Provider>
        </section>
    );
}

/**
 * 「這一頁有哪幾塊」:SectionPanels 裡的卡片標題,捲到哪一塊就標哪一塊(左邊一條直線,現在那塊是品牌色的一段),點了捲過去。
 * 少於兩塊不畫。/ The cards in SectionPanels by title: the one in view marked (a straight line on the left, the current
 * block a primary segment), a click scrolls to it. Nothing below two cards.
 */
export function SectionOutline({ label, className }: { label: React.ReactNode; className?: string }) {
    const store = React.useContext(OutlineContext);
    const empty = React.useMemo<OutlineEntry[]>(() => [], []);
    const entries = React.useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.get ?? (() => empty), () => empty);
    const [current, setCurrent] = React.useState<string | null>(null);
    const preferred = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (entries.length < 2) return;
        let frame = 0;
        // 頁首 4rem + 一點空間:卡片上緣捲過這條線就算「現在這塊」。/ The sticky header (4rem) plus a little room.
        const line = () => parseFloat(getComputedStyle(document.documentElement).fontSize || "16") * 5;
        const update = () => {
            frame = 0;
            const boxes = entries.filter((e) => e.el?.isConnected).map((e) => ({ id: e.id, ...pick(e.el!.getBoundingClientRect()) }));
            const doc = document.documentElement;
            // 沒捲過就不算「到底」（整頁放得下的時候標第一塊）。/ Not scrolled = not at the bottom (a page that fits marks the first block).
            const atBottom = window.scrollY > 0 && window.innerHeight + window.scrollY >= doc.scrollHeight - 2;
            setCurrent(activeSection(boxes, { line: line(), viewport: window.innerHeight, atBottom, preferred: preferred.current }));
        };
        const schedule = () => {
            if (!frame) frame = requestAnimationFrame(update);
        };
        // 自己捲(滾輪、觸控、按鍵)就不再照「剛點的那塊」。/ Scrolling by hand drops the clicked block.
        const manual = () => {
            preferred.current = null;
        };
        update();
        window.addEventListener("scroll", schedule, { passive: true });
        window.addEventListener("resize", schedule);
        window.addEventListener("wheel", manual, { passive: true });
        window.addEventListener("touchmove", manual, { passive: true });
        window.addEventListener("keydown", manual);
        return () => {
            if (frame) cancelAnimationFrame(frame);
            window.removeEventListener("scroll", schedule);
            window.removeEventListener("resize", schedule);
            window.removeEventListener("wheel", manual);
            window.removeEventListener("touchmove", manual);
            window.removeEventListener("keydown", manual);
        };
    }, [entries]);

    if (entries.length < 2) return null;
    // 還沒量過（剛掛上）就標第一塊，不要先空一下再淡入。/ Before the first measurement mark the first block, no fade-in.
    const marked = current ?? entries[0].id;
    const go = (e: OutlineEntry) => {
        if (!e.el) return;
        preferred.current = e.id;
        setCurrent(e.id);
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        e.el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    };
    return (
        <nav aria-label={typeof label === "string" ? label : undefined} className={cn("space-y-1.5", className)}>
            <p className="px-3 text-xs text-muted-foreground">{label}</p>
            <ol className="ml-[1.2rem] border-l border-border">
                {entries.map((e) => {
                    const on = e.id === marked;
                    return (
                        <li key={e.id}>
                            <button
                                type="button"
                                onClick={() => go(e)}
                                aria-current={on ? "location" : undefined}
                                className={cn(
                                    "-ml-px block w-full border-l-2 py-1 pr-2 pl-3 text-left text-sm leading-snug transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                                    on ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                                )}
                            >
                                {e.title}
                            </button>
                        </li>
                    );
                })}
            </ol>
        </nav>
    );
}

const noopSubscribe = () => () => {};
const pick = (r: DOMRect) => ({ top: r.top, bottom: r.bottom });

/** 屬性清單外框:凹槽底 + 細線分隔。/ Property list frame: well surface, hairline dividers. */
export function PropertyList({ children, className }: { children: React.ReactNode; className?: string }) {
    return <dl className={cn("@container divide-y divide-border rounded-lg border border-border bg-surface px-4", className)}>{children}</dl>;
}

/** 清單夠寬是「標籤 值」兩欄,很窄(手機放大字)時標籤在上、值在下,值才不會被擠出去。
 *  Two columns when the list is wide enough; very narrow (a phone at a large text size) stacks label over value so the value never spills out. */
export function Property({ label, children, mono = false, className }: { label: React.ReactNode; children: React.ReactNode; mono?: boolean; className?: string }) {
    return (
        <div className={cn("grid grid-cols-1 items-baseline gap-0.5 py-2.5 text-sm @[20rem]:grid-cols-[minmax(6rem,9rem)_1fr] @[20rem]:gap-3", className)}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={cn("min-w-0 break-words text-foreground", mono && "font-mono")}>{children}</dd>
        </div>
    );
}

const CHIP_TONE = {
    neutral: "bg-muted text-muted-foreground",
    primary: "bg-primary/10 text-primary",
    success: "bg-success/10 text-success",
    warning: "bg-warning/12 text-warning",
    danger: "bg-destructive/10 text-destructive",
} as const;

export function Chip({
    children,
    tone = "neutral",
    mono = false,
    className,
    ...props
}: React.ComponentProps<"span"> & { tone?: keyof typeof CHIP_TONE; mono?: boolean }) {
    return (
        <span
            className={cn("inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-xs leading-5 whitespace-nowrap [&>svg]:size-3.5", CHIP_TONE[tone], mono && "font-mono tabular-nums", className)}
            {...props}
        >
            {children}
        </span>
    );
}
