"use client";

/**
 * 「登入狀態是怎麼維持的」說明圖：登入 ─開始→ 這個瀏覽器的登入（每 N 續期一次）─N 天沒用→ 登出，
 * 下面列出這個瀏覽器還剩多久、其他瀏覽器，以及「登出」會切斷的三件事。數字都來自實際設定與 session（`sessionDiagram`）。
 * 只用直線（寬時橫排、窄時直排，container query）。
 * "How staying signed in works": sign in ─starts→ this browser's sign-in (renews every N) ─N days unused→
 * signed out; below, how long this browser has left, the other browsers, and the three things "Sign out" cuts.
 * Every number comes from the real settings and sessions (`sessionDiagram`). Straight lines only.
 */
import React from "react";
import { Clock, KeyRound, LogIn, LogOut, RefreshCw, Scissors, type LucideIcon } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatLifetime, sessionDiagram, type WebSessionList } from "@/lib/webSessions";

function Node({ icon: Icon, title, sub, children, tone = "neutral" }: { icon: LucideIcon; title: string; sub: string; children?: React.ReactNode; tone?: "neutral" | "primary" }) {
    return (
        <li className={cn("flex min-w-0 flex-col items-center gap-1.5 rounded-xl border bg-card px-3 py-3 text-center @2xl:flex-1 @2xl:basis-0", tone === "primary" ? "border-primary/50" : "border-border")}>
            <span className={cn("grid size-10 place-items-center rounded-lg", tone === "primary" ? "bg-primary/10 text-primary" : "bg-muted text-foreground")} aria-hidden>
                <Icon size={20} />
            </span>
            <span className="text-sm text-foreground">{title}</span>
            <span className="text-xs leading-snug text-muted-foreground">{sub}</span>
            {children}
        </li>
    );
}

/** 兩個節點之間的直線 + 標籤（窄時直的、寬時橫的）。/ A straight connector with a label. */
function Connector({ label, dashed = false }: { label: string; dashed?: boolean }) {
    const line = (vertical: boolean) => (
        <svg className={cn(vertical ? "h-8 w-3 @2xl:hidden" : "hidden h-3 w-full @2xl:block", "text-muted-foreground")} viewBox={vertical ? "0 0 6 100" : "0 0 100 6"} preserveAspectRatio="none" aria-hidden>
            <line x1={vertical ? 3 : 0} y1={vertical ? 0 : 3} x2={vertical ? 3 : 100} y2={vertical ? 100 : 3} stroke="currentColor" strokeWidth={2} strokeDasharray={dashed ? "4 5" : undefined} vectorEffect="non-scaling-stroke" />
        </svg>
    );
    return (
        <li className="flex min-w-0 flex-row items-center gap-3 px-6 @2xl:w-28 @2xl:shrink-0 @2xl:flex-col @2xl:gap-1 @2xl:px-1.5" aria-label={label}>
            {line(true)}
            {line(false)}
            <span className="text-xs leading-tight text-muted-foreground @2xl:text-center">{label}</span>
        </li>
    );
}

export function SessionLifeDiagram({ list, forOther = false }: { list: WebSessionList; forOther?: boolean }) {
    const { t, locale } = useI18n();
    const d = sessionDiagram(list);
    const every = formatLifetime(d.accessSeconds, locale);
    const after = formatLifetime(d.signinSeconds, locale);
    const when = (iso: string) => {
        const x = new Date(iso);
        return Number.isNaN(x.getTime()) ? iso : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(x);
    };
    return (
        <div className="space-y-5">
            <div className="@container">
                <ol className="flex flex-col items-stretch @2xl:flex-row @2xl:items-center">
                    <Node icon={LogIn} title={t("security.devices.flow.signIn")} sub={t("security.devices.flow.signInSub")} />
                    <Connector label={t("security.devices.flow.starts")} />
                    <Node
                        icon={KeyRound}
                        tone="primary"
                        title={t(d.current && !forOther ? "security.devices.flow.session" : "security.devices.flow.sessionAny")}
                        sub={t("security.devices.flow.sessionSub")}
                    >
                        <Chip tone="primary">
                            <RefreshCw aria-hidden /> {t("security.devices.flow.renew", { every })}
                        </Chip>
                        <span className="text-[0.75rem] leading-snug text-muted-foreground">{t("security.devices.flow.renewNote", { count: d.renewalsPerDay })}</span>
                    </Node>
                    <Connector label={t("security.devices.flow.idle", { after })} dashed />
                    <Node icon={Clock} title={t("security.devices.flow.end")} sub={t("security.devices.flow.endSub", { after })} />
                </ol>
            </div>

            <div className="space-y-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-sm">
                {d.current && !forOther && d.currentLeft !== null && <p className="text-foreground">{t("security.devices.flow.now", { when: when(d.current.expires_at) })}</p>}
                {d.others > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-muted-foreground">{t("security.devices.flow.others", { count: d.others })}</span>
                        {d.otherLabels.map((l) => (
                            <Chip key={l}>{l === "?" ? t("security.unknownDevice") : l}</Chip>
                        ))}
                        {d.moreDevices > 0 && <span className="text-xs text-muted-foreground">+{d.moreDevices}</span>}
                    </div>
                ) : (
                    <p className="text-muted-foreground">{t("security.devices.flow.othersNone")}</p>
                )}
            </div>

            <section className="space-y-2">
                <h3 className="text-sm text-foreground">{t("security.devices.flow.signOutTitle")}</h3>
                <div className="flex flex-col gap-0 @container sm:flex-row sm:items-stretch">
                    <div className="flex items-center gap-2 rounded-xl border border-destructive/50 bg-card px-3 py-2.5 sm:w-40 sm:shrink-0 sm:flex-col sm:justify-center sm:text-center">
                        <span className="grid size-9 place-items-center rounded-lg bg-destructive/10 text-destructive" aria-hidden>
                            <LogOut size={18} />
                        </span>
                        <span className="text-sm text-foreground">{t("security.devices.signOut")}</span>
                    </div>
                    {/* 直線 + 剪刀：從「登出」切到右邊三件事。/ A straight cut line from "Sign out" to the three effects. */}
                    <div className="flex items-center justify-center py-1 sm:px-2 sm:py-0" aria-hidden>
                        <span className="h-4 w-px bg-destructive/50 sm:h-px sm:w-6" />
                        <Scissors size={14} className="mx-1 my-0.5 text-destructive sm:my-0" />
                        <span className="h-4 w-px bg-destructive/50 sm:h-px sm:w-6" />
                    </div>
                    <ul className="flex-1 divide-y divide-border rounded-xl border border-border bg-card text-sm">
                        {(["security.devices.flow.cutRenew", "security.devices.flow.cutRequests", "security.devices.flow.cutPages"] as const).map((k) => (
                            <li key={k} className="flex items-start gap-2 px-3 py-2">
                                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden />
                                <span className="text-foreground">{t(k)}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            </section>

            <p className="text-xs text-muted-foreground">{t("security.devices.flow.note")}</p>
        </div>
    );
}

export function SessionInfoDialog({ isOpen, onClose, list, forOther }: { isOpen: boolean; onClose: () => void; list: WebSessionList; forOther?: boolean }) {
    const { t } = useI18n();
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("security.devices.info")}
            description={t("security.devices.flow.description")}
            icon={<KeyRound />}
            size="3xl"
            footer={<Button onClick={onClose}>{t("common.close")}</Button>}
        >
            <SessionLifeDiagram list={list} forOther={forOther} />
        </Modal>
    );
}
