"use client";

/**
 * CLI 頁的範例：選一條隧道（`?tunnel=`）與主題（日常 / 多台 / 檔案 / session 與錄影 / 工具箱 / 網路與瀏覽器 /
 * 腳本與 CI）——寬螢幕是左邊一欄（主題直排，不管哪種語言都放得下），窄螢幕是兩個下拉；每個範例 = 標題、一句說明、
 * 能直接複製的指令（用你的隧道、帳號、標籤、群組、片段），與它需要什麼。範例清單是 `lib/cliGuide.cliRecipes`（純函式、有測試）。
 * The CLI page's examples: pick a tunnel (`?tunnel=`) and a topic — a left column on wide screens (topics stacked,
 * so every language fits), two selects on narrow ones; per example a title, one line, a command you can copy as is
 * (your tunnel, account, label, group, snippet) and what it needs. Built by `cliRecipes` (tested).
 */
import React, { useState } from "react";
import Link from "next/link";
import { Info, SquareTerminal } from "lucide-react";
import { ForwardKinds } from "@/components/flow/ForwardKinds";
import { FlagText } from "@/components/ui/flag-text";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { NavTabs } from "@/components/ui/nav-tabs";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { CommandLine, NeedChips } from "@/components/cli/CliBlocks";
import { useI18n } from "@/lib/i18n";
import { CLI_TOPICS, cliRecipes, topicIntro, type CliContext, type CliTopicId } from "@/lib/cliGuide";
import type { TranslationKey } from "@/locales/en";
import type { Tunnel } from "@/types/tunnel";

const topicLabel = (id: CliTopicId) => `cli.topic.${id}` as TranslationKey;

interface Props {
    context: CliContext;
    tunnels: Tunnel[];
    selected: Tunnel | null;
    setTunnel: (id: number) => void;
    online: (t: Tunnel) => boolean;
}

export function CliExamples({ context, tunnels, selected, setTunnel, online }: Props) {
    const { t, tn } = useI18n();
    const [topic, setTopic] = useState<CliTopicId>("everyday");
    // 窄螢幕沒有左欄：主題換成下拉。/ No left column on narrow screens: the topics become a select.
    const narrow = useMediaQuery("(max-width: 1023.98px)") === true;
    const recipes = cliRecipes(topic, context);
    const anyPlaceholder = recipes.some((r) => r.placeholder);
    const intro = topicIntro(topic);

    return (
        <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-start lg:gap-6">
            <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:sticky lg:top-20 lg:grid-cols-1">
                {tunnels.length > 0 && (
                    <Field label={t("cli.ex.for")} className="min-w-0">
                        <NativeSelect value={selected ? String(selected.id) : ""} onChange={(e) => setTunnel(Number(e.target.value))}>
                            {tunnels.map((tn) => (
                                <option key={tn.id} value={tn.id}>
                                    {online(tn) ? tn.host_friendly_name : t("cli.ex.offlineOption", { name: tn.host_friendly_name })}
                                </option>
                            ))}
                        </NativeSelect>
                    </Field>
                )}
                {narrow ? (
                    <Field label={t("cli.ex.topic")} className="min-w-0">
                        <NativeSelect value={topic} onChange={(e) => setTopic(e.target.value as CliTopicId)}>
                            {CLI_TOPICS.map((id) => (
                                <option key={id} value={id}>
                                    {t(topicLabel(id))}
                                </option>
                            ))}
                        </NativeSelect>
                    </Field>
                ) : (
                    <div className="min-w-0 space-y-1.5">
                        <span className="block text-sm text-foreground">{t("cli.ex.topic")}</span>
                        <NavTabs aria-label={t("cli.ex.topic")} value={topic} onChange={setTopic} tabs={CLI_TOPICS.map((id) => ({ value: id, label: t(topicLabel(id)) }))} />
                    </div>
                )}
            </div>
            <div className="min-w-0 space-y-4">
                {intro && <p className="text-sm leading-relaxed text-foreground"><FlagText text={t(intro)} /></p>}
                {/* 埠轉發：先看方向，再看指令；自己的埠到指令速查填。/ Forwarding: the directions first, then the commands; own ports on the command sheet. */}
                {topic === "forward" && (
                    <>
                        <ForwardKinds />
                        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-muted-foreground">
                            {t("cli.ex.sheet")}
                            <Link href={selected ? `/tunnels/cheatsheet?tunnel=${selected.id}&way=telepy` : "/tunnels/cheatsheet?way=telepy"} className="text-primary hover:underline">
                                {t("cli.ex.sheetLink")} →
                            </Link>
                        </p>
                    </>
                )}
                {anyPlaceholder && (
                    <p className="flex items-start gap-2 text-sm text-muted-foreground">
                        <Info size={15} className="mt-0.5 shrink-0" aria-hidden />
                        {t("cli.ex.placeholder")}
                    </p>
                )}
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                    <SquareTerminal size={15} className="mt-0.5 shrink-0" aria-hidden />
                    <span>{tn("cli.ex.inTerminal", { cmd: <code className="font-mono text-foreground">telepy examples {topic}</code> })}</span>
                </p>
                <ul className="divide-y divide-border rounded-xl border border-border bg-card text-card-foreground shadow-card">
                    {recipes.map((r) => (
                        <li key={r.id} className="min-w-0 space-y-2 px-4 py-3.5">
                            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
                                <div className="min-w-0 flex-1 basis-64">
                                    <h4 className="text-sm text-foreground">{t(r.title)}</h4>
                                    <p className="text-sm leading-relaxed text-muted-foreground"><FlagText text={t(r.note)} /></p>
                                </div>
                                <NeedChips needs={r.needs} />
                            </div>
                            {r.command.language === "bash" ? <CommandLine value={r.command.value} /> : <CodeBlock language={r.command.language} value={r.command.value} />}
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}
