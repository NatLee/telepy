/**
 * 金鑰頁頂端的「裝置金鑰清單怎麼運作」說明：三欄示意圖（你的金鑰 → 裝置的清單 → 裝置上各帳號的
 * authorized_keys）＋四條規則。擁有者與被分享者的金鑰用不同顏色，被撤銷的那把劃掉，一眼看出「誰的金鑰會
 * 進哪個帳號、什麼時候會被拿掉」。可收合（記在 localStorage）。
 * The "how device key lists work" panel: a three-column diagram (your keys → the device's list → each
 * account's authorized_keys) plus four rules. Owner and sharee keys are coloured differently and a revoked
 * key is struck through. Collapsible (remembered in localStorage).
 */
import React from "react";
import { ArrowDown, ArrowRight, Check, Clock3, KeyRound, Laptop, Scissors, ShieldCheck, UserCheck, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

type Who = "owner" | "sharee" | "revoked";

const CHIP: Record<Who, string> = {
    owner: "bg-primary/8 text-foreground ring-primary/25 [&>svg]:text-primary",
    sharee: "bg-info/10 text-foreground ring-info/30 [&>svg]:text-info",
    revoked: "bg-muted text-muted-foreground ring-border line-through decoration-destructive/70 [&>svg]:text-muted-foreground",
};

function KeyChip({ who, label, ticked }: { who: Who; label: string; ticked?: boolean }) {
    return (
        <span className={cn("inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs ring-1 ring-inset", CHIP[who])}>
            {ticked !== undefined && (
                <span
                    className={cn(
                        "grid size-3.5 place-items-center rounded-[4px] ring-1 ring-inset",
                        ticked ? "bg-primary text-primary-foreground ring-primary" : "bg-card ring-border"
                    )}
                    aria-hidden
                >
                    {ticked && <Check size={10} strokeWidth={3} />}
                </span>
            )}
            <KeyRound size={13} aria-hidden />
            <span className="font-mono">{label}</span>
        </span>
    );
}

function Column({ step, title, children, className }: { step: number; title: string; children: React.ReactNode; className?: string }) {
    return (
        <div className={cn("flex min-w-0 flex-col gap-2 rounded-xl bg-card p-3 ring-1 ring-border shadow-card", className)}>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="grid size-5 place-items-center rounded-full bg-muted font-mono text-[0.75rem] text-foreground">{step}</span>
                {title}
            </div>
            {children}
        </div>
    );
}

function Flow() {
    return (
        <>
            <ArrowRight size={18} className="hidden shrink-0 self-center text-muted-foreground/70 lg:block" aria-hidden />
            <ArrowDown size={18} className="shrink-0 self-center text-muted-foreground/70 lg:hidden" aria-hidden />
        </>
    );
}

export function KeyListExplainer({ onHide }: { onHide: () => void }) {
    const { t, tn } = useI18n();
    const rules = [
        { icon: UserCheck, title: t("keys.how.rule1Title"), body: t("keys.how.rule1Body") },
        { icon: Users, title: t("keys.how.rule2Title"), body: t("keys.how.rule2Body") },
        { icon: Scissors, title: t("keys.how.rule3Title"), body: t("keys.how.rule3Body") },
        { icon: Clock3, title: t("keys.how.rule4Title"), body: t("keys.how.rule4Body") },
    ];
    return (
        <section aria-labelledby="keys-how-title" className="rounded-xl bg-surface p-4 ring-1 ring-border sm:p-5">
            <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2 id="keys-how-title" className="text-base text-foreground">{t("keys.how.title")}</h2>
                    <p className="mt-0.5 text-sm text-muted-foreground">{t("keys.how.subtitle")}</p>
                </div>
                <button
                    type="button"
                    onClick={onHide}
                    aria-label={t("keys.how.hide")}
                    title={t("keys.how.hide")}
                    className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                    <X size={16} />
                </button>
            </div>

            {/* 示意圖 / Diagram */}
            <div className="flex flex-col gap-2 lg:flex-row lg:items-stretch" role="img" aria-label={t("keys.how.diagramAria")}>
                <Column step={1} title={t("keys.how.colKeys")} className="lg:w-[13rem]">
                    <div className="flex items-center gap-1.5 text-[0.75rem] text-muted-foreground">
                        <Laptop size={13} aria-hidden /> alice
                    </div>
                    <div className="flex flex-col items-start gap-1.5">
                        <KeyChip who="owner" label="macbook" ticked />
                        <KeyChip who="owner" label="desktop" ticked={false} />
                    </div>
                    <p className="text-[0.75rem] leading-snug text-muted-foreground">{t("keys.how.colKeysNote")}</p>
                </Column>
                <Flow />
                <Column step={2} title={t("keys.how.colList")} className="lg:w-[15rem]">
                    <div className="font-mono text-[0.75rem] text-muted-foreground">pi-lab</div>
                    <div className="flex flex-col items-start gap-1.5">
                        <KeyChip who="owner" label="alice/macbook" />
                        <KeyChip who="sharee" label="bob/laptop" />
                        <span className="inline-flex items-center gap-1.5">
                            <KeyChip who="revoked" label="carol/phone" />
                            <Scissors size={13} className="text-destructive" aria-hidden />
                        </span>
                    </div>
                    <p className="text-[0.75rem] leading-snug text-muted-foreground">{t("keys.how.colListNote")}</p>
                </Column>
                <Flow />
                <Column step={3} title={t("keys.how.colDevice")} className="flex-1">
                    <div className="grid gap-2 sm:grid-cols-2">
                        <div className="rounded-lg bg-surface p-2 ring-1 ring-border">
                            <div className="mb-1.5 font-mono text-[0.75rem] text-foreground">ubuntu <span className="text-muted-foreground">~/.ssh/authorized_keys</span></div>
                            <div className="flex flex-col items-start gap-1">
                                <KeyChip who="owner" label="alice/macbook" />
                                <KeyChip who="sharee" label="bob/laptop" />
                            </div>
                        </div>
                        <div className="rounded-lg bg-surface p-2 ring-1 ring-border">
                            <div className="mb-1.5 font-mono text-[0.75rem] text-foreground">root <span className="text-muted-foreground">~/.ssh/authorized_keys</span></div>
                            <div className="flex flex-col items-start gap-1">
                                <KeyChip who="owner" label="alice/macbook" />
                            </div>
                        </div>
                    </div>
                    <p className="text-[0.75rem] leading-snug text-muted-foreground">
                        {tn("keys.how.colDeviceNote", { bob: <span className="text-info">bob</span>, ubuntu: <code className="font-mono">ubuntu</code> })}
                    </p>
                </Column>
            </div>

            {/* 圖例 / Legend */}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.75rem] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-primary/60" aria-hidden />{t("keys.how.legendOwner")}</span>
                <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-info/70" aria-hidden />{t("keys.how.legendSharee")}</span>
                <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-muted-foreground/40" aria-hidden />{t("keys.how.legendRevoked")}</span>
            </div>

            {/* 規則 / Rules */}
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {rules.map(({ icon: Icon, title, body }) => (
                    <li key={title} className="flex gap-3">
                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-card text-primary ring-1 ring-border" aria-hidden>
                            <Icon size={16} />
                        </span>
                        <span className="min-w-0">
                            <span className="block text-sm text-foreground">{title}</span>
                            <span className="block text-xs leading-relaxed text-muted-foreground">{body}</span>
                        </span>
                    </li>
                ))}
            </ul>
            <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                <ShieldCheck size={15} className="mt-px shrink-0 text-success" aria-hidden />
                {t("keys.how.safety")}
            </p>
        </section>
    );
}
