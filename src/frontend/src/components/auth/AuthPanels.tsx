"use client";

/**
 * AuthShell 左側面板的內容：登入頁是產品重點 + 連線示意圖，首次設定頁是三步驟導覽。
 * Left-panel content for AuthShell: product highlights with a connection diagram (sign-in) and the
 * three-step setup guide (first run).
 */
import React from "react";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { Check, FolderTree, Globe, Laptop, Server, SquareTerminal, Users, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { cn } from "@/lib/utils";

const FEATURES: { Icon: LucideIcon; title: TranslationKey; body: TranslationKey }[] = [
    { Icon: SquareTerminal, title: "auth.featureTerminal", body: "auth.featureTerminalBody" },
    { Icon: FolderTree, title: "auth.featureFiles", body: "auth.featureFilesBody" },
    { Icon: Globe, title: "auth.featureBrowser", body: "auth.featureBrowserBody" },
    { Icon: Users, title: "auth.featureSharing", body: "auth.featureSharingBody" },
];

export function DiagramNode({ Icon, label, accent = false }: { Icon: LucideIcon; label: string; accent?: boolean }) {
    return (
        <div className="flex w-20 shrink-0 flex-col items-center gap-2">
            <span
                className={cn(
                    "grid size-12 place-items-center rounded-xl border",
                    accent ? "border-transparent bg-brand-gradient text-white" : "border-input bg-card text-muted-foreground"
                )}
            >
                <Icon size={20} strokeWidth={2} />
            </span>
            <span className="line-clamp-2 w-full text-center text-xs font-medium break-words text-muted-foreground">{label}</span>
        </div>
    );
}

/** 一條連線 + 沿線移動的封包。/ A link with a packet travelling along it. */
export function DiagramLink({ label, reverse = false }: { label: string; reverse?: boolean }) {
    return (
        <div className="mb-6 flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <span className="font-mono text-[0.6875rem] text-muted-foreground/80">{label}</span>
            <span className="relative h-px w-full bg-foreground/25">
                <span
                    className={cn(
                        "absolute top-1/2 size-2 -translate-y-1/2 rounded-full",
                        reverse ? "bg-brand-2 animate-flow-x-rev" : "bg-primary animate-flow-x"
                    )}
                />
            </span>
        </div>
    );
}

/** 登入頁：標語、連線示意圖（裝置 → Telepy ← 瀏覽器）、四個功能。/ Sign-in: tagline, diagram, four features. */
export function AuthHighlights() {
    const { t } = useI18n();
    return (
        <div>
            <h2 className="text-3xl font-semibold leading-tight tracking-tight xl:text-4xl">{t("auth.headline")}</h2>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground">{t("auth.tagline")}</p>

            <div className="mt-10 flex items-center gap-2" aria-hidden>
                <DiagramNode Icon={Server} label={t("auth.diagramDevice")} />
                <DiagramLink label={t("auth.diagramReverseSsh")} />
                <DiagramNode Icon={TelepyGlyph} label="Telepy" accent />
                <DiagramLink label="HTTPS" reverse />
                <DiagramNode Icon={Laptop} label={t("auth.diagramBrowser")} />
            </div>

            <ul className="mt-10 grid grid-cols-2 gap-x-6 gap-y-6">
                {FEATURES.map(({ Icon, title, body }) => (
                    <li key={title} className="flex gap-3">
                        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
                            <Icon size={16} />
                        </span>
                        <span className="min-w-0">
                            <span className="block text-sm font-medium text-foreground">{t(title)}</span>
                            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{t(body)}</span>
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

const SETUP_STEPS: { title: TranslationKey; body: TranslationKey }[] = [
    { title: "firstLogin.step1Title", body: "firstLogin.step1Body" },
    { title: "firstLogin.step2Title", body: "firstLogin.step2Body" },
    { title: "firstLogin.step3Title", body: "firstLogin.step3Body" },
];

/**
 * 步驟清單：完成的打勾、目前的實心、之後的空心，中間一條直線。首次設定與 MCP 應用程式連接流程共用。
 * Step list: done steps ticked, the current one filled, later ones hollow, joined by a straight line.
 * Shared by the first-run guide and the app-connection flow.
 */
export function FlowSteps({ steps, current }: { steps: { title: string; body: string }[]; current: number }) {
    return (
        <ol className="space-y-0">
            {steps.map(({ title, body }, i) => {
                const done = i < current;
                const now = i === current;
                const last = i === steps.length - 1;
                return (
                    <li key={title} className="relative flex gap-4 pb-8 last:pb-0" aria-current={now ? "step" : undefined}>
                        {!last && <span className="absolute left-4 top-9 bottom-1 w-px bg-border" aria-hidden />}
                        <span
                            className={cn(
                                "relative grid size-8 shrink-0 place-items-center rounded-full border text-sm font-semibold",
                                now
                                    ? "border-transparent bg-primary text-primary-foreground"
                                    : done
                                      ? "border-success/40 bg-success/15 text-success"
                                      : "border-input bg-card text-muted-foreground"
                            )}
                        >
                            {done ? <Check size={15} aria-hidden /> : i + 1}
                        </span>
                        <span className="min-w-0 pt-1">
                            <span className={cn("block text-sm font-medium", now || done ? "text-foreground" : "text-muted-foreground")}>{title}</span>
                            <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{body}</span>
                        </span>
                    </li>
                );
            })}
        </ol>
    );
}

/** 首次設定：三步驟，第一步（建立管理員）是目前步驟。/ First run: three steps, the first one is current. */
export function SetupSteps() {
    const { t } = useI18n();
    return (
        <div>
            <h2 className="text-3xl font-semibold leading-tight tracking-tight xl:text-4xl">{t("firstLogin.panelTitle")}</h2>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground">{t("firstLogin.panelBody")}</p>

            <div className="mt-10">
                <FlowSteps steps={SETUP_STEPS.map(({ title, body }) => ({ title: t(title), body: t(body) }))} current={0} />
            </div>

            <p className="mt-10 flex items-center gap-2 text-xs text-muted-foreground">
                <Check size={14} className="text-primary" />
                {t("firstLogin.panelNote")}
            </p>
        </div>
    );
}
