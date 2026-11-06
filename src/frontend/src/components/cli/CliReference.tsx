"use client";

/**
 * CLI 頁的參考：全部指令（可以搜尋；指令與說明一起比對）、`telepy doctor`（全部通過時旁邊是開心的 Tapi，跟真的 CLI 一樣）
 * 與環境變數。指令表是 `lib/cliGuide.CLI_COMMANDS`（測試會比對 `src/cli/src/lib.rs` 的子指令）。
 * 彩蛋：隱藏的 `telepy dig` 不在表裡，只有在搜尋框打 `dig` 才出現。
 * The CLI page's reference: every command (searchable over the command and its text), `telepy doctor` (a happy Tapi
 * beside a clean run, like the real CLI), Tab completion (the line for each shell, as `telepy completions` prints it)
 * and the environment variables. The egg: the hidden `telepy dig` is not in
 * the list; it only shows up when you search for `dig`.
 */
import React, { useState } from "react";
import { ChevronRight, Keyboard, Search, Stethoscope } from "lucide-react";
import { Tapi } from "@/components/brand/Tapi";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { CliTerminal, CommandLine, CommandText, NeedChips } from "@/components/cli/CliBlocks";
import { FlagText } from "@/components/ui/flag-text";
import { useI18n } from "@/lib/i18n";
import { CLI_COMMANDS, CLI_ENV, COMPLETION_SETUP, HIDDEN_COMMAND, defaultShell, doctorSample, examplesForCommand, filterCommands, revealsHidden, type CliCommand, type CliContext, type CliOs, type CompletionShell } from "@/lib/cliGuide";
import type { TranslationKey } from "@/locales/en";

export function CliCommands({ context }: { context: CliContext }) {
    const { t, tn } = useI18n();
    const [query, setQuery] = useState("");
    // 展開的指令（看它的範例）。/ Commands opened to show their examples.
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
    const toggle = (key: string) => setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
    });
    // 搜尋也看範例（「SOCKS」找得到 ssh）；只因為範例才符合的指令直接展開。
    // The search reads the examples too ("SOCKS" finds ssh); a command that matches only through them opens.
    const exampleText = (c: CliCommand) => examplesForCommand(c.key, context).map((e) => `${t(e.title)} ${t(e.note)} ${e.command.value}`).join(" ");
    const describe = (c: CliCommand) => `${t(`cli.cmd.${c.key}` as TranslationKey)} ${exampleText(c)}`;
    const shown = filterCommands(CLI_COMMANDS, query, describe);
    const byExampleOnly = new Set(query.trim() ? shown.filter((c) => filterCommands([c], query, (x) => t(`cli.cmd.${x.key}` as TranslationKey)).length === 0).map((c) => c.key) : []);
    const egg = revealsHidden(query);
    return (
        <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm leading-relaxed text-muted-foreground">
                    {tn("cli.cmds.help", {
                        help: <code className="font-mono text-foreground [overflow-wrap:anywhere]">telepy &lt;command&gt; --help</code>,
                        examples: <code className="font-mono text-foreground [overflow-wrap:anywhere]">telepy examples</code>,
                    })}
                </p>
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
                        {shown.map((c) => {
                            const examples = examplesForCommand(c.key, context);
                            const isOpen = open.has(c.key) !== byExampleOnly.has(c.key);
                            const panel = `cli-cmd-ex-${c.key}`;
                            return (
                                <li key={c.key} className="min-w-0 px-4 py-2.5">
                                    <div className="grid min-w-0 gap-x-4 gap-y-1 md:grid-cols-[minmax(0,25rem)_minmax(0,1fr)_auto] md:items-center">
                                        {/* 只在空白處換行，不把 `[--follow]` 切成兩半。/ Wrap at spaces only, never inside a flag. */}
                                        <code className="min-w-0 font-mono text-sm text-foreground">
                                            <CommandText value={`telepy ${c.usage}`} synopsis />
                                        </code>
                                        <span className="min-w-0 text-sm leading-relaxed text-muted-foreground">{t(`cli.cmd.${c.key}` as TranslationKey)}</span>
                                        <span className="flex flex-wrap items-center gap-2 md:justify-end">
                                            <NeedChips needs={c.needs} />
                                            {examples.length > 0 && (
                                                <button
                                                    type="button"
                                                    onClick={() => toggle(c.key)}
                                                    aria-expanded={isOpen}
                                                    aria-controls={panel}
                                                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-sm text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/20"
                                                >
                                                    <ChevronRight size={14} className={isOpen ? "rotate-90 transition-transform" : "transition-transform"} aria-hidden />
                                                    {isOpen ? t("cli.cmds.hideExamples") : t("cli.cmds.showExamples", { count: examples.length })}
                                                </button>
                                            )}
                                        </span>
                                    </div>
                                    {isOpen && (
                                        <ul id={panel} className="mt-2.5 space-y-3 border-l-2 border-border pl-3 md:ml-1">
                                            {examples.map((ex) => (
                                                <li key={ex.id} className="min-w-0 space-y-1.5">
                                                    <p className="text-sm text-foreground">
                                                        {t(ex.title)}
                                                        <span className="text-muted-foreground"> · <FlagText text={t(ex.note)} /></span>
                                                    </p>
                                                    <CommandLine value={ex.command.value} />
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </div>
    );
}

const SHELL_LABEL: Record<CompletionShell, string> = { bash: "bash", zsh: "zsh", fish: "fish", powershell: "PowerShell", elvish: "elvish" };

/**
 * Tab 補完：選 shell（預設照猜到的系統）→ 要加的那一行與加在哪個檔；補得出什麼、哪些 shell 沒有補完。
 * Tab completion: pick the shell (the guessed system's by default) → the line and the file it goes into; what it
 * completes, and which shells have no completion at all.
 */
function CompletionCard({ os }: { os: CliOs }) {
    const { t, tn } = useI18n();
    const [picked, setPicked] = useState<CompletionShell | null>(null);
    const shell = picked ?? defaultShell(os);
    const setup = COMPLETION_SETUP.find((s) => s.shell === shell) ?? COMPLETION_SETUP[0];
    return (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-card">
            <p className="flex items-start gap-2 text-sm leading-relaxed text-foreground">
                <Keyboard size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                <span>{t("cli.complete.what")}</span>
            </p>
            {/* 五個 shell 在手機上擠不下（PowerShell 撞到 elvish）：手機用下拉選單。/ Five shells don't fit a phone row: a select there. */}
            <NativeSelect value={shell} onChange={(e) => setPicked(e.target.value as CompletionShell)} aria-label={t("cli.complete.shell")} className="w-full sm:hidden">
                {COMPLETION_SETUP.map((s) => (
                    <option key={s.shell} value={s.shell}>
                        {SHELL_LABEL[s.shell]}
                    </option>
                ))}
            </NativeSelect>
            <Segmented size="sm" className="hidden sm:inline-flex" aria-label={t("cli.complete.shell")} value={shell} onChange={setPicked} options={COMPLETION_SETUP.map((s) => ({ value: s.shell, label: SHELL_LABEL[s.shell] }))} />
            <p className="text-sm leading-relaxed text-muted-foreground">{tn("cli.complete.addTo", { file: <code className="font-mono text-foreground [overflow-wrap:anywhere]">{setup.file}</code> })}</p>
            <CommandLine value={setup.line} />
            <p className="text-sm leading-relaxed text-muted-foreground">{tn("cli.complete.old", { cmd: <code className="font-mono text-foreground">telepy completions</code> })}</p>
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
            <CompletionCard os={os} />
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
