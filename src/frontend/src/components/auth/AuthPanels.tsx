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

function DiagramNode({ Icon, label, accent = false }: { Icon: LucideIcon; label: string; accent?: boolean }) {
    return (
        <div className="flex w-20 shrink-0 flex-col items-center gap-2">
            <span
                className={cn(
                    "grid size-12 place-items-center rounded-xl border",
                    accent ? "border-white/20 bg-brand-gradient text-white shadow-glow" : "border-border bg-card text-muted-foreground"
                )}
            >
                <Icon size={20} strokeWidth={2} />
            </span>
            <span className="text-center text-xs font-medium text-muted-foreground">{label}</span>
        </div>
    );
}

/** 一條連線 + 沿線移動的封包。/ A link with a packet travelling along it. */
function DiagramLink({ label, reverse = false }: { label: string; reverse?: boolean }) {
    return (
        <div className="mb-6 flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">{label}</span>
            <span className="relative h-px w-full bg-gradient-to-r from-border via-white/25 to-border">
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

/** 首次設定：三步驟，第一步（建立管理員）是目前步驟。/ First run: three steps, the first one is current. */
export function SetupSteps() {
    const { t } = useI18n();
    return (
        <div>
            <h2 className="text-3xl font-semibold leading-tight tracking-tight xl:text-4xl">{t("firstLogin.panelTitle")}</h2>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground">{t("firstLogin.panelBody")}</p>

            <ol className="mt-10 space-y-0">
                {SETUP_STEPS.map(({ title, body }, i) => {
                    const current = i === 0;
                    const last = i === SETUP_STEPS.length - 1;
                    return (
                        <li key={title} className="relative flex gap-4 pb-8 last:pb-0" aria-current={current ? "step" : undefined}>
                            {!last && <span className="absolute left-4 top-9 bottom-1 w-px bg-border" aria-hidden />}
                            <span
                                className={cn(
                                    "relative grid size-8 shrink-0 place-items-center rounded-full border text-sm font-semibold",
                                    current
                                        ? "border-transparent bg-brand-gradient text-white shadow-glow"
                                        : "border-border bg-card text-muted-foreground"
                                )}
                            >
                                {i + 1}
                            </span>
                            <span className="min-w-0 pt-1">
                                <span className={cn("block text-sm font-medium", current ? "text-foreground" : "text-muted-foreground")}>
                                    {t(title)}
                                </span>
                                <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{t(body)}</span>
                            </span>
                        </li>
                    );
                })}
            </ol>

            <p className="mt-10 flex items-center gap-2 text-xs text-muted-foreground">
                <Check size={14} className="text-primary" />
                {t("firstLogin.panelNote")}
            </p>
        </div>
    );
}
