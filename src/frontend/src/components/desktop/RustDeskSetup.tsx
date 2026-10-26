"use client";

/**
 * 「讓那台電腦的 RustDesk 準備好」：遠端桌面頁 RustDesk 模式的視覺清單。每一步旁邊畫出 RustDesk / macOS 裡要點的地方
 * （扁平的小視窗示意，標籤用 RustDesk 自己的翻譯），狀態跟著從裝置的探測、上一次的連線失敗與這次有沒有連上過走；
 * 只有現在該看的那一步攤開示意，其他各一行（不擠表單）。都確認好了就收成一行，只剩「裝系統服務」的提醒。
 * The "get that computer's RustDesk ready" checklist for the remote desktop page's RustDesk mode: each step comes with
 * a small flat mock of where to click in RustDesk or macOS (RustDesk's own labels), states follow the device probe,
 * the last connect failure and whether a session connected; only the step to look at now shows its mock. Once all
 * is confirmed it folds to one row with the system-service advice.
 */
import React, { useState } from "react";
import { CheckCircle2, ChevronDown, Info, ListChecks, Loader2, Lock, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { allReady, nextStep, SETUP_STEPS, type SetupStepId, type StepStatus } from "@/lib/rustdeskSetup";
import type { TranslationKey } from "@/locales/en";

const TITLE: Record<SetupStepId, TranslationKey> = {
    directIp: "desktop.rdSetup.directIp.title",
    password: "desktop.rdSetup.password.title",
    permissions: "desktop.rdSetup.permissions.title",
    service: "desktop.rdSetup.service.title",
};
const DETAIL: Record<SetupStepId, TranslationKey> = {
    directIp: "desktop.rdSetup.directIp.detail",
    password: "desktop.rdSetup.password.detail",
    permissions: "desktop.rdSetup.permissions.detail",
    service: "desktop.rdSetup.service.detail",
};
const FAILED: Partial<Record<SetupStepId, TranslationKey>> = {
    directIp: "desktop.rdSetup.directIp.failed",
    password: "desktop.rdSetup.password.failed",
    permissions: "desktop.rdSetup.permissions.failed",
};
const OK: Partial<Record<SetupStepId, TranslationKey>> = {
    directIp: "desktop.rdSetup.directIp.ok",
    password: "desktop.rdSetup.password.ok",
    permissions: "desktop.rdSetup.permissions.ok",
};
const STATUS_LABEL: Record<StepStatus, TranslationKey> = {
    ok: "desktop.rdSetup.status.ok",
    failed: "desktop.rdSetup.status.failed",
    checking: "desktop.rdSetup.status.checking",
    unknown: "desktop.rdSetup.status.unknown",
    advice: "desktop.rdSetup.status.advice",
};

function StatusIcon({ status, n }: { status: StepStatus; n: number }) {
    const { t } = useI18n();
    const label = t(STATUS_LABEL[status]);
    if (status === "ok") return <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success" aria-label={label} />;
    if (status === "failed") return <XCircle size={18} className="mt-0.5 shrink-0 text-destructive" aria-label={label} />;
    if (status === "checking") return <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin text-muted-foreground" aria-label={label} />;
    if (status === "advice") return <Info size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-label={label} />;
    return (
        <span className="mt-0.5 grid size-[1.125rem] shrink-0 place-items-center rounded-full border border-border text-[0.7rem] tabular-nums text-muted-foreground" aria-label={label}>
            {n}
        </span>
    );
}

// ---- 示意小視窗 / mock windows ----------------------------------------------------------------

/** 扁平的小視窗：標題列 + 左側欄 + 內容。/ A flat little window: title bar, sidebar, content. */
function MockWindow({ title, nav, active, children }: { title: string; nav: string[]; active: number; children: React.ReactNode }) {
    return (
        <div className="w-full max-w-[30rem] overflow-hidden rounded-lg border border-border bg-card text-xs shadow-card" aria-hidden>
            <div className="flex items-center gap-1.5 border-b border-border bg-surface px-2.5 py-1.5">
                <span className="size-2 rounded-full bg-muted-foreground/30" />
                <span className="size-2 rounded-full bg-muted-foreground/30" />
                <span className="size-2 rounded-full bg-muted-foreground/30" />
                <span className="ml-1.5 truncate text-muted-foreground">{title}</span>
            </div>
            <div className="flex min-w-0">
                <ul className="hidden w-[7.5rem] shrink-0 space-y-0.5 border-r border-border bg-surface/60 p-1.5 min-[420px]:block">
                    {nav.map((n, i) => (
                        <li key={n} className={cn("truncate rounded-sm px-1.5 py-1", i === active ? "bg-muted text-foreground" : "text-muted-foreground")}>{n}</li>
                    ))}
                </ul>
                <div className="min-w-0 flex-1 space-y-2 p-2.5">{children}</div>
            </div>
        </div>
    );
}

/** 要點的那一個：主色外框 + 箭頭說明。/ The control to use: a primary ring and a short pointer. */
function Target({ children, note }: { children: React.ReactNode; note?: string }) {
    return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex min-w-0 items-center gap-1.5 rounded-sm px-1.5 py-1 ring-2 ring-primary/70">{children}</span>
            {note && <span className="text-[0.7rem] text-primary">← {note}</span>}
        </div>
    );
}

const box = (checked: boolean) => (
    <span className={cn("grid size-3.5 shrink-0 place-items-center rounded-[3px] border", checked ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background")}>
        {checked && <svg viewBox="0 0 12 12" className="size-2.5"><path d="M2.5 6.2 5 8.5 9.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>}
    </span>
);
const radio = (on: boolean) => (
    <span className={cn("grid size-3.5 shrink-0 place-items-center rounded-full border", on ? "border-primary" : "border-border")}>{on && <span className="size-1.5 rounded-full bg-primary" />}</span>
);
const toggle = (on: boolean) => (
    <span className={cn("inline-flex h-3.5 w-6 shrink-0 items-center rounded-full px-0.5", on ? "justify-end bg-success" : "justify-start bg-muted")}>
        <span className="size-2.5 rounded-full bg-background" />
    </span>
);

function SecurityMock({ port }: { port: string }) {
    const { t } = useI18n();
    const nav = [t("desktop.rdSetup.mock.general"), t("desktop.rdSetup.mock.security"), t("desktop.rdSetup.mock.network"), t("desktop.rdSetup.mock.display")];
    return (
        <MockWindow title={`RustDesk — ${t("desktop.rdSetup.mock.settings")}`} nav={nav} active={1}>
            <span className="inline-flex items-center gap-1.5 rounded-sm border border-border px-1.5 py-1 text-foreground"><Lock size={11} /> {t("desktop.rdSetup.mock.unlock")}</span>
            <Target note={t("desktop.rdSetup.mock.turnOn")}>
                {box(true)}
                <span className="text-foreground">{t("desktop.rdSetup.mock.directIp")}</span>
            </Target>
            <div className="flex items-center gap-2 pl-6 text-muted-foreground">
                {t("desktop.rdSetup.mock.port")}
                <span className="rounded-sm border border-border bg-background px-1.5 py-0.5 font-mono text-foreground">{port}</span>
            </div>
        </MockWindow>
    );
}

function PasswordMock() {
    const { t } = useI18n();
    const nav = [t("desktop.rdSetup.mock.general"), t("desktop.rdSetup.mock.security"), t("desktop.rdSetup.mock.network"), t("desktop.rdSetup.mock.display")];
    return (
        <MockWindow title={`RustDesk — ${t("desktop.rdSetup.mock.settings")}`} nav={nav} active={1}>
            <p className="text-muted-foreground">{t("desktop.rdSetup.mock.password")}</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1.5 text-muted-foreground">
                {radio(false)}
                <span className="line-through decoration-destructive/60">{t("desktop.rdSetup.mock.oneTime")}</span>
                <span className="text-[0.7rem] text-destructive">✗ {t("desktop.rdSetup.mock.notThis")}</span>
            </div>
            <div className="flex items-center gap-2 px-1.5 text-muted-foreground">{radio(false)}<span>{t("desktop.rdSetup.mock.permanent")}</span></div>
            <Target note={t("desktop.rdSetup.mock.pickThis")}>
                {radio(true)}
                <span className="text-foreground">{t("desktop.rdSetup.mock.both")}</span>
            </Target>
            <Target>
                <span className="rounded-sm border border-border bg-background px-1.5 py-0.5 text-foreground">{t("desktop.rdSetup.mock.setPermanent")}</span>
            </Target>
        </MockWindow>
    );
}

function PermissionsMock() {
    const { t } = useI18n();
    const nav = [t("desktop.rdSetup.mock.privacy")];
    return (
        <MockWindow title={t("desktop.rdSetup.mock.systemSettings")} nav={nav} active={0}>
            {(["desktop.rdSetup.mock.screenRecording", "desktop.rdSetup.mock.accessibility"] as const).map((k) => (
                <div key={k} className="space-y-1">
                    <p className="text-muted-foreground">{t(k)}</p>
                    <Target>
                        <span className="text-foreground">RustDesk</span>
                        {toggle(true)}
                    </Target>
                </div>
            ))}
        </MockWindow>
    );
}

function ServiceMock() {
    const { t } = useI18n();
    return (
        <MockWindow title="RustDesk" nav={[]} active={0}>
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5">
                <span className="min-w-0 flex-1 text-foreground">{t("desktop.rdSetup.mock.installTip")}</span>
                <Target>
                    <span className="text-foreground">{t("desktop.rdSetup.mock.install")}</span>
                </Target>
            </div>
        </MockWindow>
    );
}

function Mock({ id, port }: { id: SetupStepId; port: string }) {
    if (id === "directIp") return <SecurityMock port={port} />;
    if (id === "password") return <PasswordMock />;
    if (id === "permissions") return <PermissionsMock />;
    return <ServiceMock />;
}

// ---- 清單 / the checklist ---------------------------------------------------------------------

export interface RustDeskSetupProps {
    status: Record<SetupStepId, StepStatus>;
    port: string;
    /** 探測狀態列：檢查中、有回應、或隧道那段的問題（翻好的字）。/ The probe line: checking, answering, or a tunnel problem. */
    probeLine: { tone: "muted" | "success" | "danger"; text: string } | null;
    canCheck: boolean;
    checking: boolean;
    onCheck: () => void;
}

export function RustDeskSetup({ status, port, probeLine, canCheck, checking, onCheck }: RustDeskSetupProps) {
    const { t } = useI18n();
    const next = nextStep(status);
    const ready = allReady(status);
    // 使用者自己點開的步驟；現在該看的那一步一定是開的。/ Steps the user opened; the spotlighted one is always open.
    const [opened, setOpened] = useState<Partial<Record<SetupStepId, boolean>>>({});
    const [expanded, setExpanded] = useState(false);

    const header = (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <ListChecks size={17} className="shrink-0 text-muted-foreground" aria-hidden />
            <h3 className="min-w-[11rem] flex-1 text-sm text-foreground">{t("desktop.rdSetup.title")}</h3>
            <Button type="button" size="sm" variant="outline" disabled={!canCheck} onClick={onCheck}>
                {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} {checking ? t("desktop.rustdesk.checking") : t("desktop.rustdesk.check")}
            </Button>
        </div>
    );

    if (ready && !expanded) {
        return (
            <section className="space-y-2 rounded-lg border border-border bg-surface px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <CheckCircle2 size={17} className="shrink-0 text-success" aria-hidden />
                    <span className="min-w-0 flex-1 text-foreground">{t("desktop.rdSetup.ready")}</span>
                    <button type="button" onClick={() => setExpanded(true)} className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline">
                        {t("desktop.rdSetup.showChecklist")} <ChevronDown size={13} aria-hidden />
                    </button>
                </div>
                <p className="flex items-start gap-2 pl-[1.6rem] text-xs leading-relaxed text-muted-foreground">{t("desktop.rdSetup.readyService")}</p>
            </section>
        );
    }

    return (
        <section className="space-y-3 rounded-lg border border-border bg-surface p-3">
            {header}
            {probeLine && (
                <p className={cn("text-xs leading-relaxed", probeLine.tone === "success" ? "text-success" : probeLine.tone === "danger" ? "text-destructive" : "text-muted-foreground")}>{probeLine.text}</p>
            )}
            <ol className="space-y-2">
                {SETUP_STEPS.map((id, i) => {
                    const s = status[id];
                    const current = id === next;
                    const show = current || !!opened[id];
                    const line = s === "failed" ? FAILED[id] : s === "ok" ? OK[id] : undefined;
                    return (
                        <li
                            key={id}
                            aria-current={current ? "step" : undefined}
                            className={cn(
                                "rounded-md border px-3 py-2.5",
                                current && s === "failed" ? "border-destructive/50 bg-destructive/5" : current ? "border-primary/50 bg-primary/5" : "border-border bg-card",
                            )}
                        >
                            <div className="flex items-start gap-2.5">
                                <StatusIcon status={s} n={i + 1} />
                                <div className="min-w-0 flex-1 space-y-1">
                                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground">
                                        <span>{t(TITLE[id])}</span>
                                        {current && s !== "ok" && <Chip tone={s === "failed" ? "danger" : "primary"}>{s === "failed" ? t("desktop.rdSetup.status.failed") : t("desktop.rdSetup.nextChip")}</Chip>}
                                        {id === "permissions" && <Chip>macOS</Chip>}
                                        {s === "advice" && <Chip>{t("desktop.rdSetup.status.advice")}</Chip>}
                                    </p>
                                    {line && <p className={cn("text-xs", s === "failed" ? "text-destructive" : "text-success")}>{t(line, { port })}</p>}
                                    {show && <p className="text-xs leading-relaxed text-muted-foreground">{t(DETAIL[id], { port })}</p>}
                                    {!current && (
                                        <button type="button" onClick={() => setOpened((o) => ({ ...o, [id]: !o[id] }))} aria-expanded={show} className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline">
                                            {show ? t("desktop.rdSetup.hideWhere") : t("desktop.rdSetup.showWhere")}
                                            <ChevronDown size={13} className={cn("transition-transform", show && "rotate-180")} aria-hidden />
                                        </button>
                                    )}
                                    {show && (
                                        <div className="pt-1.5">
                                            <Mock id={id} port={port} />
                                        </div>
                                    )}
                                </div>
                            </div>
                        </li>
                    );
                })}
            </ol>
            {ready && (
                <button type="button" onClick={() => setExpanded(false)} className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline">
                    {t("desktop.rdSetup.foldChecklist")}
                </button>
            )}
        </section>
    );
}
