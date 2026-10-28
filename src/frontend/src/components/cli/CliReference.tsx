"use client";

/**
 * CLI 頁的參考：全部指令（可以搜尋；指令與說明一起比對）、`telepy doctor`（全部通過時旁邊是開心的 Tapi，跟真的 CLI 一樣）
 * 與環境變數。指令表是 `lib/cliGuide.CLI_COMMANDS`（測試會比對 `src/cli/src/lib.rs` 的子指令）。
 * 彩蛋：隱藏的 `telepy dig` 不在表裡，只有在搜尋框打 `dig` 才出現。
 * The CLI page's reference: every command (searchable over the command and its text), `telepy doctor` (a happy Tapi
 * beside a clean run, like the real CLI) and the environment variables. The egg: the hidden `telepy dig` is not in
 * the list; it only shows up when you search for `dig`.
 */
import React, { useState } from "react";
import { Search, Stethoscope } from "lucide-react";
import { Tapi } from "@/components/brand/Tapi";
import { Input } from "@/components/ui/input";
import { CliTerminal, CommandLine, CommandText, NeedChips } from "@/components/cli/CliBlocks";
import { useI18n } from "@/lib/i18n";
import { CLI_COMMANDS, CLI_ENV, HIDDEN_COMMAND, doctorSample, filterCommands, revealsHidden, type CliCommand, type CliOs } from "@/lib/cliGuide";
import type { TranslationKey } from "@/locales/en";

export function CliCommands() {
    const { t, tn } = useI18n();
    const [query, setQuery] = useState("");
    const describe = (c: CliCommand) => t(`cli.cmd.${c.key}` as TranslationKey);
    const shown = filterCommands(CLI_COMMANDS, query, describe);
    const egg = revealsHidden(query);
    return (
        <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm leading-relaxed text-muted-foreground">{tn("cli.cmds.help", { help: <code className="font-mono text-foreground [overflow-wrap:anywhere]">telepy &lt;command&gt; --help</code> })}</p>
                <div className="relative sm:w-64 sm:shrink-0">
                    <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("cli.cmds.search")} aria-label={t("cli.cmds.search")} className="pl-8" />
                </div>
            </div>
            <div className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-card">
                {egg ? (
                    <div className="flex flex-col items-start gap-3 px-4 py-4 sm:flex-row sm:items-center">
                        <Tapi pose="surprised" size={56} label={t("eggs.tapiLabel")} />
                        <div className="min-w-0 space-y-1">
                            <code className="font-mono text-sm text-foreground">telepy {HIDDEN_COMMAND.usage}</code>
                            <p className="text-sm leading-relaxed text-muted-foreground">{t("cli.cmd.dig")}</p>
                        </div>
                    </div>
                ) : shown.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t("cli.cmds.none")}</p>
                ) : (
                    <ul className="divide-y divide-border">
                        {shown.map((c) => (
                            <li key={c.key} className="grid min-w-0 gap-x-4 gap-y-1 px-4 py-2.5 md:grid-cols-[minmax(0,25rem)_minmax(0,1fr)_auto] md:items-center">
                                {/* 只在空白處換行，不把 `[--follow]` 切成兩半。/ Wrap at spaces only, never inside a flag. */}
                                <code className="min-w-0 font-mono text-sm text-foreground">
                                    <CommandText value={`telepy ${c.usage}`} />
                                </code>
                                <span className="min-w-0 text-sm leading-relaxed text-muted-foreground">{t(`cli.cmd.${c.key}` as TranslationKey)}</span>
                                <NeedChips needs={c.needs} />
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

export function CliEnvironment({ base, username, os }: { base: string; username: string; os: CliOs }) {
    const { t, tn } = useI18n();
    return (
        <div className="space-y-4">
            <div className="space-y-3 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-card">
                <p className="flex items-start gap-2 text-sm leading-relaxed text-foreground">
                    <Stethoscope size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span>{tn("cli.env.doctor", { cmd: <code className="font-mono [overflow-wrap:anywhere]">telepy doctor</code> })}</span>
                </p>
                <CommandLine value="telepy doctor" />
                <CliTerminal label={t("cli.env.doctorSample")} lines={doctorSample(base || "https://telepy.example.com", username, os)} art={<Tapi pose="happy" size={52} label={t("eggs.tapiLabel")} />} />
            </div>
            {/* 變數名很長（TELEPY_CONFIG_DIR）：手機上名字在上、說明在下。/ Long names: stacked on phones. */}
            <dl className="divide-y divide-border rounded-xl border border-border bg-card text-card-foreground shadow-card">
                {CLI_ENV.map((v) => (
                    <div key={v.name} className="grid gap-x-4 gap-y-0.5 px-4 py-2.5 text-sm sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-baseline">
                        <dt className="min-w-0 break-all font-mono text-foreground">{v.name}</dt>
                        <dd className="min-w-0 leading-relaxed text-muted-foreground">{t(`cli.env.${v.key}` as TranslationKey)}</dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}
