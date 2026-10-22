"use client";

/**
 * 第一次使用的設定指南（對話框）：三個編號步驟，各自帶狀態——登記金鑰、把別名加進 ~/.ssh/config（或改用獨立指令）、
 * 裝置要在線。主頁面只留一顆按鈕，需要時才展開。
 * First-time setup guide (dialog): three numbered steps with live status — register your key, add the alias to
 * ~/.ssh/config (or switch to standalone commands), have the device online. The page itself only shows a button.
 */
import React from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Circle } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { ConnectMode } from "@/lib/forwardRecipes";

type StepState = "done" | "todo" | "info";

function Step({ n, state, title, children, last = false }: { n: number; state: StepState; title: React.ReactNode; children: React.ReactNode; last?: boolean }) {
    const Icon = state === "done" ? CheckCircle2 : state === "todo" ? AlertTriangle : Circle;
    return (
        <li className="relative flex gap-4 pb-6 last:pb-0">
            {!last && <span className="absolute left-4 top-9 bottom-1 w-px bg-border" aria-hidden />}
            <span
                className={cn(
                    "relative grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold ring-1 ring-inset",
                    state === "done" && "bg-emerald-500/12 text-emerald-600 ring-emerald-500/30 dark:text-emerald-400",
                    state === "todo" && "bg-amber-500/12 text-amber-600 ring-amber-500/35 dark:text-amber-400",
                    state === "info" && "bg-primary/10 text-primary ring-primary/25"
                )}
            >
                {n}
            </span>
            <div className="min-w-0 flex-1 space-y-2 pt-1">
                <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    {title}
                    <Icon
                        size={15}
                        className={cn(state === "done" ? "text-emerald-500" : state === "todo" ? "text-amber-500" : "text-muted-foreground/50")}
                        aria-hidden
                    />
                </p>
                <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">{children}</div>
            </div>
        </li>
    );
}

interface SetupGuideProps {
    isOpen: boolean;
    onClose: () => void;
    alias: string;
    keyCount: number | null;
    online: boolean;
    mode: ConnectMode;
    setMode: (m: ConnectMode) => void;
    configText: string | null;
}

export function SetupGuide({ isOpen, onClose, alias, keyCount, online, mode, setMode, configText }: SetupGuideProps) {
    const { t, tn } = useI18n();
    const code = (s: string) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{s}</code>;
    const hasKey = keyCount !== null && keyCount > 0;

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("sheet.setup.title")} size="2xl">
            <ol className="list-none">
                <Step n={1} state={keyCount === null ? "info" : hasKey ? "done" : "todo"} title={t("sheet.setup.keyTitle")}>
                    <p>{hasKey ? t("sheet.setup.keyOk", { count: keyCount ?? 0 }) : t("sheet.setup.keyMissing")}</p>
                    <p className="text-xs">{tn("sheet.setup.keyDevice", { path: code("~/.ssh/authorized_keys") })}</p>
                    {!hasKey && (
                        <Button asChild size="sm" variant="outline">
                            <Link href="/tunnels/keys" prefetch={false}>{t("sheet.setup.keyAction")}</Link>
                        </Button>
                    )}
                </Step>

                <Step n={2} state={mode === "direct" ? "done" : "info"} title={tn("sheet.setup.configTitle", { alias: code(alias) })}>
                    {mode === "direct" ? (
                        <>
                            <p>{t("sheet.setup.directOn")}</p>
                            <Button size="sm" variant="outline" onClick={() => setMode("alias")}>{t("sheet.setup.useShort")}</Button>
                        </>
                    ) : (
                        <>
                            <p>{tn("sheet.setup.configBody", { path: code("~/.ssh/config"), cmd: code(`ssh ${alias}`) })}</p>
                            {configText && (
                                <div className="max-h-60 overflow-auto rounded-md">
                                    <CodeBlock language="txt" value={configText} />
                                </div>
                            )}
                            <p className="flex flex-wrap items-center gap-2 text-xs">
                                {t("sheet.setup.skipConfig")}
                                <Button size="xs" variant="outline" onClick={() => setMode("direct")}>{t("sheet.setup.useDirect")}</Button>
                            </p>
                        </>
                    )}
                </Step>

                <Step n={3} state={online ? "done" : "todo"} title={t("sheet.setup.deviceTitle")} last>
                    <p>{online ? t("sheet.setup.deviceOnline", { alias }) : t("sheet.setup.deviceOffline", { alias })}</p>
                </Step>
            </ol>
        </Modal>
    );
}
