/**
 * 最近 24 小時、每小時一根的長條圖：總數（info 藍）上面疊著其中的問題 / 失敗（destructive 紅），中間 2px 底色縫。
 * 滑鼠移上去或用方向鍵逐小時看提示；另有給螢幕閱讀器的隱藏表格。
 * One bar per hour for the last 24 hours: the total (info blue) with its problems / failures (destructive red)
 * stacked on top, a 2px surface gap between. Hover or arrow keys show a tooltip per hour; a visually hidden table
 * carries the same numbers for screen readers.
 */
import React, { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { HOURS, barsSummary, labelIndexes, niceMax, type HourBar } from "@/lib/serverStats";

const OK = "bg-info dark:bg-info/90";
const SUB = "bg-destructive dark:bg-destructive/85";

function hourStarts(hours: string[] | null): Date[] {
    if (hours) return hours.map((h) => new Date(h));
    const now = new Date();
    now.setMinutes(0, 0, 0);
    return Array.from({ length: HOURS }, (_, i) => new Date(now.getTime() - (HOURS - 1 - i) * 3_600_000));
}

export function StatsHourlyChart({
    title,
    okLabel,
    subLabel,
    bars,
    hours,
}: {
    title: string;
    okLabel: string;
    subLabel: string;
    bars: HourBar[];
    hours: string[] | null;
}) {
    const { t, locale } = useI18n();
    const [active, setActive] = useState<number | null>(null);
    const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
    const starts = useMemo(() => hourStarts(hours), [hours]);
    const sum = barsSummary(bars);
    const top = niceMax(sum.max);

    const time = (d: Date) => d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    const range = (i: number) => `${time(starts[i])}–${time(new Date(starts[i].getTime() + 3_600_000))}`;
    const tick = (i: number) => starts[i].toLocaleTimeString(locale, { hour: "numeric" });

    const onKey = (e: React.KeyboardEvent) => {
        const cur = active ?? sum.maxAt;
        let next: number | null = null;
        if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
        else if (e.key === "ArrowRight") next = Math.min(HOURS - 1, cur + 1);
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = HOURS - 1;
        else if (e.key === "Escape") return setActive(null);
        if (next !== null) {
            e.preventDefault();
            setActive(next);
        }
    };

    const aria = t("health.stats.chartAria", {
        title,
        total: nf.format(sum.total),
        sub: nf.format(sum.sub),
        subLabel: subLabel.toLocaleLowerCase(locale),
        range: range(sum.maxAt),
        max: nf.format(sum.max),
    });

    return (
        <figure className="min-w-0 rounded-xl border border-border bg-card p-4">
            <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="text-sm text-foreground">{title}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{t("health.stats.chartTotal", { n: nf.format(sum.total) })}</span>
            </figcaption>
            <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground" aria-hidden>
                <li className="inline-flex items-center gap-1.5">
                    <span className={cn("size-2 rounded-[2px]", OK)} />
                    {okLabel}
                </li>
                <li className="inline-flex items-center gap-1.5">
                    <span className={cn("size-2 rounded-[2px]", SUB)} />
                    {subLabel} <span className="tabular-nums">{nf.format(sum.sub)}</span>
                </li>
            </ul>

            <div
                role="group"
                aria-label={aria}
                tabIndex={0}
                onKeyDown={onKey}
                onFocus={() => setActive((a) => a ?? sum.maxAt)}
                onBlur={() => setActive(null)}
                onPointerLeave={() => setActive(null)}
                className="relative mt-3 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
                {/* 刻度上限與基線：細線、退到背景。/ The axis top and baseline: hairlines, recessive. */}
                <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-border" aria-hidden />
                <span className="pointer-events-none absolute -top-2 right-0 bg-card pl-1 text-[0.6875rem] leading-4 tabular-nums text-muted-foreground" aria-hidden>
                    {nf.format(top)}
                </span>
                <div className="flex h-24 items-end gap-[2px] border-b border-border" aria-hidden>
                    {bars.map((b, i) => {
                        const ok = b.total - b.sub;
                        const pct = (v: number) => (v <= 0 ? 0 : Math.max((v / top) * 100, 2.5));
                        return (
                            <div
                                key={i}
                                onPointerEnter={() => setActive(i)}
                                className={cn("flex h-full min-w-0 flex-1 flex-col items-center justify-end rounded-t-[3px]", active === i && "bg-muted/70")}
                            >
                                {b.sub > 0 && <span className={cn("w-full max-w-6 rounded-t-[4px]", SUB)} style={{ height: `${pct(b.sub)}%` }} />}
                                {b.sub > 0 && ok > 0 && <span className="h-[2px] w-full shrink-0" />}
                                {ok > 0 && <span className={cn("w-full max-w-6", OK, b.sub === 0 && "rounded-t-[4px]")} style={{ height: `${pct(ok)}%` }} />}
                            </div>
                        );
                    })}
                </div>

                {active !== null && (
                    <div
                        className={cn(
                            "pointer-events-none absolute bottom-full z-10 mb-2 w-max max-w-[14rem] rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-pop",
                            active < 6 ? "" : active > HOURS - 7 ? "-translate-x-full" : "-translate-x-1/2"
                        )}
                        style={{ left: `${(active < 6 ? active : active > HOURS - 7 ? active + 1 : active + 0.5) * (100 / HOURS)}%` }}
                    >
                        <p className="tabular-nums text-muted-foreground">{range(active)}</p>
                        <p className="mt-0.5 flex items-center gap-1.5">
                            <span className={cn("size-2 rounded-[2px]", OK)} />
                            <span>{title}</span>
                            <span className="ml-auto pl-3 tabular-nums">{nf.format(bars[active].total)}</span>
                        </p>
                        <p className="flex items-center gap-1.5">
                            <span className={cn("size-2 rounded-[2px]", SUB)} />
                            <span>{subLabel}</span>
                            <span className="ml-auto pl-3 tabular-nums">{nf.format(bars[active].sub)}</span>
                        </p>
                    </div>
                )}
            </div>

            <div className="relative mt-1 h-4 text-[0.6875rem] leading-4 tabular-nums text-muted-foreground" aria-hidden>
                {labelIndexes().map((i) => (
                    <span key={i} className="absolute whitespace-nowrap" style={{ left: `${(i * 100) / HOURS}%` }}>
                        {tick(i)}
                    </span>
                ))}
                <span className="absolute right-0">{t("health.stats.now")}</span>
            </div>

            {/* 表格的 sr-only 要包一層 div：表格不會縮成 1px，手機上會撐寬頁面。/ Wrapped: a table ignores sr-only's 1px width and widened the phone page. */}
            <div className="sr-only">
                <table>
                    <caption>{title}</caption>
                    <thead>
                        <tr>
                            <th scope="col">{t("health.stats.hour")}</th>
                            <th scope="col">{title}</th>
                            <th scope="col">{subLabel}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {bars.map((b, i) => (
                            <tr key={i}>
                                <th scope="row">{range(i)}</th>
                                <td>{nf.format(b.total)}</td>
                                <td>{nf.format(b.sub)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </figure>
    );
}
