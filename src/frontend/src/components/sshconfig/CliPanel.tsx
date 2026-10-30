"use client";

/**
 * 「命令列」分頁：`telepy config tidy` 在你自己的電腦上讀 ~/.ssh/config、用同一套規則簡化（網頁與 CLI 的結果由共用的測試
 * 案例綁在一起），先列出差異再問，寫回前備份成 config.bak。檔案不離開那台電腦，網頁也碰不到它。
 * The "command line" tab: `telepy config tidy` reads ~/.ssh/config on your own computer and simplifies it with the
 * same rules (shared test cases keep the web and the CLI identical), shows the difference and asks, and backs up to
 * config.bak before writing. The file never leaves that computer; the web can't reach it anyway.
 */
import React from "react";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { MiniCommand } from "@/components/cheatsheet/CommandView";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";

const COMMANDS: { cmd: string; key: TranslationKey }[] = [
    { cmd: "telepy config tidy", key: "tidy.cli.run" },
    { cmd: "telepy config tidy --check", key: "tidy.cli.check" },
    { cmd: "telepy config tidy --wildcards", key: "tidy.cli.wildcards" },
    { cmd: "telepy config tidy --yes", key: "tidy.cli.yes" },
    { cmd: "telepy config tidy --file ~/dotfiles/ssh/config", key: "tidy.cli.file" },
];

const POINTS: TranslationKey[] = ["tidy.cli.pointLocal", "tidy.cli.pointSame", "tidy.cli.pointBackup", "tidy.cli.pointNoLogin"];

export function CliPanel() {
    const { t } = useI18n();
    return (
        <div className="space-y-5">
            <p className="text-sm leading-relaxed text-muted-foreground">{t("tidy.cli.intro")}</p>
            <ul className="space-y-1.5 text-sm text-foreground">
                {POINTS.map((k) => (
                    <li key={k} className="flex items-start gap-2">
                        <Check size={15} className="mt-0.5 shrink-0 text-success" aria-hidden />
                        <span>{t(k)}</span>
                    </li>
                ))}
            </ul>
            <ul className="space-y-3">
                {COMMANDS.map((c) => (
                    <li key={c.cmd} className="space-y-1">
                        <MiniCommand command={c.cmd} />
                        <p className="text-xs text-muted-foreground">{t(c.key)}</p>
                    </li>
                ))}
            </ul>
            <Link href="/tunnels/cli" prefetch={false} className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline">
                {t("tidy.cli.guide")}
                <ArrowRight size={14} aria-hidden />
            </Link>
        </div>
    );
}
