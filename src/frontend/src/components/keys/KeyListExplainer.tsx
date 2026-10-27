/**
 * 金鑰區標題列「運作方式」按鈕打開的「裝置金鑰清單怎麼運作」視窗（跟其他頁面的 info 一樣是對話框）。
 * 上面是總覽：每個人勾自己的金鑰 → 裝置 pi-lab 的清單 → 裝置上各帳號的 authorized_keys；擁有者與被分享者的
 * 金鑰用不同顏色，分享已結束的那把劃掉。下面是放大其中一把（bob 的 laptop）：允許 ∩ 選定 → 哪些帳號的檔案，
 * 由 `lib/keyPlacement` 的純函式算出，裝置面板用同一張圖顯示真實狀態。兩張圖用同一個例子
 * （帳號 ubuntu / deploy / root；bob 能用 ubuntu 與 deploy，這把金鑰只選 ubuntu）。
 * 版面：容器夠寬（@3xl）橫排，否則直排；文字一律換行，不截斷、不溢出。
 * The "how device key lists work" dialog behind the keys area's "How it works" button. Overview on top:
 * everyone ticks their own keys → pi-lab's list → each account's authorized_keys (owner / sharee colours, the
 * ended share struck through). Below, one key (bob's laptop) zoomed in: allowed ∩ chosen → which files; the
 * device panel draws the same flow with real state. Both use one example. A row from @3xl, a column below;
 * text always wraps.
 */
import React from "react";
import { Check, Clock3, Info, KeyRound, Scissors, Server, ShieldCheck, UserCheck, Users } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Callout } from "@/components/ui/callout";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { EXAMPLE_ACCOUNTS, EXAMPLE_ALLOWED, EXAMPLE_CHOSEN, placeKey } from "@/lib/keyPlacement";
import type { TranslationKey } from "@/locales/en";
import { FlowLink, FlowRow, KeyPlacementFlow } from "./KeyPlacementFlow";

type Who = "owner" | "sharee" | "revoked";

const CHIP: Record<Who, string> = {
    owner: "bg-primary/8 text-foreground ring-primary/25 [&>svg]:text-primary",
    sharee: "bg-info/10 text-foreground ring-info/30 [&>svg]:text-info",
    revoked: "bg-muted text-muted-foreground ring-border [&>svg]:text-muted-foreground",
};

const SWATCH: Record<Who, string> = { owner: "bg-primary/60", sharee: "bg-info/70", revoked: "bg-muted-foreground/40" };

const ROLE: Record<Who, TranslationKey> = { owner: "keys.how.roleOwner", sharee: "keys.how.roleSharee", revoked: "keys.how.roleEnded" };

function KeyChip({ who, label, ticked }: { who: Who; label: string; ticked?: boolean }) {
    return (
        <span className={cn("inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-xs ring-1 ring-inset", CHIP[who])}>
            {ticked !== undefined && (
                <span
                    className={cn("grid size-3.5 shrink-0 place-items-center rounded-[4px] ring-1 ring-inset", ticked ? "bg-primary text-primary-foreground ring-primary" : "bg-card ring-border")}
                    aria-hidden
                >
                    {ticked && <Check size={10} strokeWidth={3} />}
                </span>
            )}
            <KeyRound size={13} className="shrink-0" aria-hidden />
            <span className={cn("min-w-0 font-mono [overflow-wrap:anywhere]", who === "revoked" && "line-through decoration-destructive/70")}>{label}</span>
        </span>
    );
}

/** 總覽的一欄：編號 + 標題與一句說明，再來是例子。/ One stage of the overview: number + title and a note, then the example. */
function Stage({ step, title, note, children, className }: { step: number; title: string; note: React.ReactNode; children: React.ReactNode; className?: string }) {
    return (
        <div className={cn("flex min-w-0 flex-col gap-2.5 rounded-xl bg-card p-3 ring-1 ring-border", className)}>
            <div className="flex min-w-0 items-start gap-2">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted font-mono text-[0.75rem] text-foreground">{step}</span>
                <span className="min-w-0">
                    <span className="block pt-px text-xs text-foreground [overflow-wrap:anywhere]">{title}</span>
                    <span className="mt-0.5 block text-[0.75rem] leading-snug text-muted-foreground">{note}</span>
                </span>
            </div>
            {children}
        </div>
    );
}

/** 一個人與他勾的金鑰。/ One person and the keys they tick. */
function Person({ name, who, children }: { name: string; who: Who; children: React.ReactNode }) {
    const { t } = useI18n();
    return (
        <li className="flex min-w-0 flex-col items-start gap-1">
            <span className="flex flex-wrap items-center gap-x-1.5 text-[0.75rem]">
                <span className={cn("size-2 shrink-0 rounded-sm", SWATCH[who])} aria-hidden />
                <span className="text-foreground">{name}</span>
                <span className="text-muted-foreground">{t(ROLE[who])}</span>
            </span>
            <span className="flex max-w-full flex-wrap gap-1">{children}</span>
        </li>
    );
}

/** 裝置上一個帳號的 authorized_keys。/ One account's authorized_keys on the device. */
function Account({ name, children }: { name: string; children: React.ReactNode }) {
    return (
        <li className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-surface p-2 ring-1 ring-inset ring-border">
            <span className="font-mono text-xs text-foreground">{name}</span>
            <span className="flex max-w-full flex-wrap gap-1">{children}</span>
        </li>
    );
}

export function KeyListExplainerDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const { t, tn } = useI18n();
    const rules = [
        { icon: UserCheck, title: t("keys.how.rule1Title"), body: t("keys.how.rule1Body") },
        { icon: Users, title: t("keys.how.rule2Title"), body: t("keys.how.rule2Body") },
        { icon: Scissors, title: t("keys.how.rule3Title"), body: t("keys.how.rule3Body") },
        { icon: Clock3, title: t("keys.how.rule4Title"), body: t("keys.how.rule4Body") },
    ];
    const code = (s: string) => <code className="font-mono">{s}</code>;
    // 總覽的連線對齊編號圓圈的中心（p-3 + size-5 的一半 − 箭頭高度的一半）。/ Level with the step circles.
    const link = "@3xl:mt-[1.125rem]";
    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("keys.how.title")} description={t("keys.how.subtitle")} icon={<Info />} size="4xl">
            {/* 總覽 / Overview */}
            <FlowRow label={t("keys.how.diagramAria")} stretch>
                <Stage step={1} title={t("keys.how.colKeys")} note={t("keys.how.colKeysNote")} className="@3xl:w-[13rem] @3xl:shrink-0">
                    <ul className="flex flex-col gap-2">
                        <Person name="alice" who="owner">
                            <KeyChip who="owner" label="macbook" ticked />
                            <KeyChip who="owner" label="desktop" ticked={false} />
                        </Person>
                        <Person name="bob" who="sharee">
                            <KeyChip who="sharee" label="laptop" ticked />
                        </Person>
                        <Person name="carol" who="revoked">
                            <KeyChip who="revoked" label="phone" />
                        </Person>
                    </ul>
                </Stage>
                <FlowLink className={link} />
                <Stage step={2} title={t("keys.how.colList")} note={t("keys.how.colListNote")} className="@3xl:w-[13rem] @3xl:shrink-0">
                    <span className="flex items-center gap-1.5 font-mono text-xs text-foreground">
                        <Server size={13} className="shrink-0 text-muted-foreground" aria-hidden />
                        pi-lab
                    </span>
                    <span className="flex flex-col items-start gap-1">
                        <KeyChip who="owner" label="alice/macbook" />
                        <KeyChip who="sharee" label="bob/laptop" />
                        <span className="inline-flex max-w-full items-center gap-1.5">
                            <KeyChip who="revoked" label="carol/phone" />
                            <Scissors size={13} className="shrink-0 text-destructive" aria-hidden />
                        </span>
                    </span>
                </Stage>
                <FlowLink className={link} />
                <Stage
                    step={3}
                    title={t("keys.how.colDevice")}
                    note={tn("keys.how.colDeviceNote", { bob: <span className="text-info">bob</span>, ubuntu: code("ubuntu"), deploy: code("deploy"), root: code("root") })}
                    className="@3xl:flex-1"
                >
                    <ul className="flex flex-col gap-1.5">
                        <Account name="ubuntu">
                            <KeyChip who="owner" label="alice/macbook" />
                            <KeyChip who="sharee" label="bob/laptop" />
                        </Account>
                        <Account name="deploy">
                            <KeyChip who="owner" label="alice/macbook" />
                        </Account>
                        <Account name="root">
                            <KeyChip who="owner" label="alice/macbook" />
                        </Account>
                    </ul>
                </Stage>
            </FlowRow>

            {/* 放大一把金鑰（允許 ∩ 選定 → 檔案）/ One key zoomed in (allowed ∩ chosen → files) */}
            <section className="mt-5 rounded-xl bg-surface p-3 ring-1 ring-border sm:p-4">
                <h3 className="text-sm text-foreground">{t("keys.place.title")}</h3>
                <p className="mb-3 mt-0.5 text-xs text-muted-foreground">{t("keys.place.subtitle")}</p>
                <KeyPlacementFlow keyLabel="bob/laptop" listLabel="pi-lab" placements={placeKey(EXAMPLE_ACCOUNTS, EXAMPLE_ALLOWED, EXAMPLE_CHOSEN)} note={t("keys.place.exampleNote")} />
                <Callout tone="info" title={t("keys.place.adminFile")} className="mt-3 text-xs leading-relaxed">
                    <span className="[overflow-wrap:anywhere]">{t("keys.place.adminFileTip")}</span>
                </Callout>
            </section>

            {/* 規則 / Rules */}
            <ul className="mt-5 grid gap-x-6 gap-y-4 sm:grid-cols-2">
                {rules.map(({ icon: Icon, title, body }) => (
                    <li key={title} className="flex min-w-0 gap-3">
                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-card text-primary ring-1 ring-border" aria-hidden>
                            <Icon size={16} />
                        </span>
                        <span className="min-w-0">
                            <span className="block text-sm text-foreground">{title}</span>
                            <span className="block text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{body}</span>
                        </span>
                    </li>
                ))}
            </ul>
            <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                <ShieldCheck size={15} className="mt-0.5 shrink-0 text-success" aria-hidden />
                <span className="min-w-0">{t("keys.how.safety")}</span>
            </p>
        </Modal>
    );
}
