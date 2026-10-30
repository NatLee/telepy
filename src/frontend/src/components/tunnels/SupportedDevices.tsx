"use client";

/**
 * 建立頁的「可以加入的機器」：一排小標籤（像素圖示 + 名稱），跟現在選的方式（一行指令 / 逐步）不合的會標出該用哪一種；
 * 點一下看細節（一行指令怎麼裝、逐步有哪些腳本、能不能走網頁 port、需要什麼），並可直接切過去。
 * 一列就好，不擠到下面的表單。資料在 `lib/devicePlatforms.ts`（跟 `join_install.sh` 一致）。
 * The create page's "works on" row: small chips (pixel icon + name); those that don't fit the chosen mode say which
 * mode to use. A click shows the details (how the one command installs, which scripts fit, whether the web port
 * works, what is needed) and can switch the mode. One row, so it never crowds the form below.
 */
import React from "react";
import { Check, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { PLATFORMS, type JoinSupport, type Platform, type PlatformId, type ScriptKind } from "@/lib/devicePlatforms";
import type { TranslationKey } from "@/locales/en";
import { PLATFORM_NAME, PlatformIcon } from "./DevicePlatform";

export type CreateMode = "command" | "steps";

const JOIN_TEXT: Record<JoinSupport, TranslationKey> = {
    service: "platforms.join.service",
    loop: "platforms.join.loop",
    untested: "platforms.join.untested",
    no: "platforms.join.no",
};

const SCRIPT_NAME: Record<ScriptKind, TranslationKey> = {
    service: "wizard.connect.service",
    autossh: "wizard.connect.autossh",
    ssh: "wizard.connect.ssh",
    docker: "wizard.connect.docker",
    compose: "wizard.connect.compose",
    windows: "wizard.connect.windows",
};

const NEEDS: Record<PlatformId, TranslationKey> = {
    linux: "platforms.needs.linux",
    macos: "platforms.needs.macos",
    raspberrypi: "platforms.needs.raspberrypi",
    openwrt: "platforms.needs.openwrt",
    windows: "platforms.needs.windows",
    docker: "platforms.needs.docker",
    unix: "platforms.needs.unix",
};

/** 這個平台能不能用目前的方式加入。/ Whether the platform fits the chosen mode. */
function fits(p: Platform, mode: CreateMode): boolean {
    return mode === "command" ? p.join !== "no" : p.scripts.length > 0;
}

function Yes({ ok, children }: { ok: boolean; children: React.ReactNode }) {
    return (
        <span className={cn("inline-flex items-start gap-1.5", ok ? "text-foreground/85" : "text-muted-foreground")}>
            {ok ? <Check size={13} className="mt-0.5 shrink-0 text-success" aria-hidden /> : <Minus size={13} className="mt-0.5 shrink-0" aria-hidden />}
            <span>{children}</span>
        </span>
    );
}

/** 標籤在上、內容在下（彈出框很窄，兩欄會把字擠斷）。/ Label above value; two columns squeeze the narrow popover. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="space-y-1 py-2">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{children}</dd>
        </div>
    );
}

function PlatformChip({ p, mode, onMode }: { p: Platform; mode: CreateMode; onMode: (m: CreateMode) => void }) {
    const { t } = useI18n();
    const ok = fits(p, mode);
    const other: CreateMode = mode === "command" ? "steps" : "command";
    const hint = !ok ? t(other === "steps" ? "platforms.useSteps" : "platforms.useCommand") : mode === "command" && p.join === "untested" ? t("platforms.untested") : null;
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-sm transition-colors hover:border-foreground/30",
                        ok ? "border-border bg-card text-foreground" : "border-dashed border-border text-muted-foreground"
                    )}
                >
                    <PlatformIcon id={p.id} size={18} />
                    <span>{t(PLATFORM_NAME[p.id])}</span>
                    {hint && <span className="text-xs text-muted-foreground">· {hint}</span>}
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[min(22rem,calc(100vw-1.5rem))] space-y-3 p-4 text-sm">
                <div className="flex items-center gap-2.5">
                    <PlatformIcon id={p.id} size={32} />
                    <span className="text-base text-foreground">{t(PLATFORM_NAME[p.id])}</span>
                </div>
                <dl className="divide-y divide-border rounded-lg border border-border bg-surface px-3 text-sm">
                    <Row label={t("platforms.oneCommand")}>
                        <Yes ok={p.join !== "no"}>{t(JOIN_TEXT[p.join])}</Yes>
                    </Row>
                    <Row label={t("platforms.stepByStep")}>
                        <Yes ok={p.scripts.length > 0}>{p.scripts.length > 0 ? p.scripts.map((s) => t(SCRIPT_NAME[s])).join(" · ") : t("platforms.noScripts")}</Yes>
                    </Row>
                    <Row label={t("platforms.waysIn")}>
                        <span className="flex flex-col gap-0.5">
                            <Yes ok>{t("platforms.via.sshLong")}</Yes>
                            <Yes ok={p.web}>{t(p.web ? "platforms.via.httpLong" : "platforms.via.httpNo")}</Yes>
                        </span>
                    </Row>
                </dl>
                <p className="text-xs leading-relaxed text-muted-foreground">{t(NEEDS[p.id])}</p>
                {!ok && (
                    <Button size="sm" variant="outline" className="w-full" onClick={() => onMode(other)}>
                        {t(other === "steps" ? "platforms.switchSteps" : "platforms.switchCommand")}
                    </Button>
                )}
            </PopoverContent>
        </Popover>
    );
}

export function SupportedDevices({ mode, onMode }: { mode: CreateMode; onMode: (m: CreateMode) => void }) {
    const { t } = useI18n();
    return (
        // 手機上一列橫向捲動，不把表單往下推；sm 以上自動換行。/ One sideways-scrolling row on phones; wraps from sm.
        <div className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0" role="group" aria-label={t("platforms.title")}>
            <span className="mr-1 shrink-0 text-xs text-muted-foreground">{t("platforms.title")}</span>
            {PLATFORMS.map((p) => (
                <PlatformChip key={p.id} p={p} mode={mode} onMode={onMode} />
            ))}
        </div>
    );
}
