"use client";

/**
 * 網站設定 →「伺服器」分頁：訪客位址（client_ip_*）與原本只能寫在 .env 的伺服器設定（server_*），分四組。
 * 規則：.env 有設就以它為準（這裡鎖住、顯示它的值），沒設用這頁存的值，再沒有就是內建預設。分頁上方的 info 按鈕
 * 與每個鎖住的標籤打開 SettingSourceDialog，把這三層畫出來。
 * Site settings → "Server": visitor addresses (client_ip_*) and the server settings that used to live in .env only
 * (server_*), in four groups. The rule: .env wins when set (the row is locked and shows its value), else the value
 * saved here, else the built-in default. The tab's info button and every locked chip open SettingSourceDialog.
 */
import React, { useState } from "react";
import { FileCog, Info, Network, ScrollText, Server, LogIn, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { SectionHeading } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import type { useSettingsPage } from "@/hooks/useSettingsPage";
import { useI18n } from "@/lib/i18n";
import { groupServerKeys, isLocked, type ServerGroupId } from "@/lib/settingSource";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import { SettingRow } from "./SettingRow";
import { SettingSourceDialog } from "./SettingSourceDialog";

const GROUP_META: Record<ServerGroupId, { icon: LucideIcon; title: TranslationKey; hint: TranslationKey; anchor: string }> = {
    visitor: { icon: Network, title: "settingsEnv.group.visitor", hint: "settingsEnv.group.visitorHint", anchor: "visitor-addresses" },
    devices: { icon: Server, title: "settingsEnv.group.devices", hint: "settingsEnv.group.devicesHint", anchor: "devices-gateway" },
    logs: { icon: ScrollText, title: "settingsEnv.group.logs", hint: "settingsEnv.group.logsHint", anchor: "logs-api-docs" },
    signin: { icon: LogIn, title: "settingsEnv.group.signin", hint: "settingsEnv.group.signinHint", anchor: "signin-address" },
};

/** 自訂編輯器的 key（整列寬）。/ Keys with a custom, full-width editor. */
const WIDE_KEYS = ["client_ip_hops", "client_ip_cloudflare"];

/** 代理層數：自動，或固定 0–10 層。/ Trusted proxies: automatic, or a fixed 0–10. */
function HopsControl({ shown, locked, onSave }: { shown: unknown; locked: boolean; onSave: (value: string) => void }) {
    const { t } = useI18n();
    const raw = String(shown ?? "").trim().toLowerCase();
    const isAuto = raw === "" || raw === "auto";
    const [mode, setMode] = useState<"auto" | "fixed">(isAuto ? "auto" : "fixed");
    const [count, setCount] = useState(isAuto ? "1" : raw);
    const n = Number(count);
    const valid = count.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 10;
    const pick = (next: "auto" | "fixed") => {
        setMode(next);
        // 改回自動就直接存；固定層數要按儲存。/ Back to auto saves at once; a fixed count waits for Save.
        if (next === "auto" && !isAuto) onSave("auto");
    };
    return (
        <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
                <Segmented
                    size="sm"
                    aria-label={t("siteSettings.client_ip_hops.label")}
                    options={[
                        { value: "auto", label: t("settingsEnv.hopsAuto"), disabled: locked },
                        { value: "fixed", label: t("settingsEnv.hopsFixed"), disabled: locked },
                    ]}
                    value={mode}
                    onChange={pick}
                />
                {mode === "fixed" && (
                    <span className="flex items-center gap-2">
                        <Input
                            type="number"
                            className="h-8 w-20"
                            min={0}
                            max={10}
                            step={1}
                            value={count}
                            disabled={locked}
                            aria-label={t("settingsEnv.hopsCount")}
                            aria-invalid={!valid}
                            onChange={(e) => setCount(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter" && valid) onSave(String(n)); }}
                        />
                        {!locked && (
                            <Button type="button" size="sm" variant="soft" disabled={!valid} onClick={() => onSave(String(n))}>
                                {t("common.save")}
                            </Button>
                        )}
                    </span>
                )}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{t(mode === "auto" ? "settingsEnv.hopsAutoHint" : "settingsEnv.hopsFixedHint")}</p>
        </div>
    );
}

const CLOUDFLARE_MODES = ["auto", "always", "off"] as const;
type CloudflareMode = (typeof CLOUDFLARE_MODES)[number];
const CLOUDFLARE_LABEL: Record<CloudflareMode, TranslationKey> = {
    auto: "settingsEnv.cf.auto",
    always: "settingsEnv.cf.always",
    off: "settingsEnv.cf.off",
};
const CLOUDFLARE_HINT: Record<CloudflareMode, TranslationKey> = {
    auto: "settingsEnv.cf.autoHint",
    always: "settingsEnv.cf.alwaysHint",
    off: "settingsEnv.cf.offHint",
};

/** Cloudflare 的 CF-Connecting-IP：自動 / 一律採用 / 不採用，各附一行說明。/ The three Cloudflare modes, one line each. */
function CloudflareControl({ shown, locked, onSave }: { shown: unknown; locked: boolean; onSave: (value: string) => void }) {
    const { t } = useI18n();
    const value: CloudflareMode = (CLOUDFLARE_MODES as readonly string[]).includes(String(shown)) ? (shown as CloudflareMode) : "auto";
    return (
        <div className="space-y-2">
            <Segmented
                size="sm"
                aria-label={t("siteSettings.client_ip_cloudflare.label")}
                options={CLOUDFLARE_MODES.map((m) => ({ value: m, label: t(CLOUDFLARE_LABEL[m]), disabled: locked }))}
                value={value}
                onChange={(next) => next !== value && onSave(next)}
            />
            <ul className="space-y-1 text-xs leading-relaxed">
                {CLOUDFLARE_MODES.map((m) => (
                    <li key={m} className={cn("flex gap-2", m === value ? "text-foreground" : "text-muted-foreground")}>
                        <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", m === value ? "bg-primary" : "bg-border")} aria-hidden />
                        <span>
                            <span className="text-foreground">{t(CLOUDFLARE_LABEL[m])}</span> — {t(CLOUDFLARE_HINT[m])}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function ServerSettingsTab({ settings }: { settings: ReturnType<typeof useSettingsPage> }) {
    const { t } = useI18n();
    const { state, actions } = settings;
    const { settingsObj, meta, env, loading } = state;
    const { handleToggle, handleUpdate } = actions;
    // 打開說明：undefined = 關著；null = 從分頁的按鈕打開（選第一個鎖住的）；key = 從某列的標籤打開。
    // The explainer: undefined = closed; null = opened from the tab button; a key = opened from that row's chip.
    const [explain, setExplain] = useState<string | null | undefined>(undefined);
    const groups = groupServerKeys(Object.keys(settingsObj));
    const lockedCount = Object.keys(env).filter((k) => isLocked(env, k)).length;

    const custom = (key: string) =>
        key === "client_ip_hops"
            ? (shown: unknown, locked: boolean) => <HopsControl key={`${String(shown)}-${locked}`} shown={shown} locked={locked} onSave={(v) => handleUpdate(key, v)} />
            : key === "client_ip_cloudflare"
              ? (shown: unknown, locked: boolean) => <CloudflareControl shown={shown} locked={locked} onSave={(v) => handleUpdate(key, v)} />
              : undefined;

    return (
        <div className="space-y-6">
            <section className="rounded-xl border border-border/80 bg-card p-4 text-card-foreground shadow-card sm:px-6 sm:py-5">
                <SectionHeading
                    icon={<FileCog />}
                    wrapTitle
                    title={t("settingsEnv.headTitle")}
                    description={t("settings.serverBanner")}
                    action={
                        <Button type="button" size="sm" variant="outline" onClick={() => setExplain(null)} aria-label={t("settingsEnv.howButton")}>
                            <Info size={15} /> <span className="hidden sm:inline">{t("settingsEnv.howButton")}</span>
                        </Button>
                    }
                />
                {/* 三層的順序，一行讀完（圖在說明裡）。/ The order of the three layers in one line (the diagram is in the explainer). */}
                <ol className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <li className="rounded-sm bg-muted px-1.5 py-px font-mono text-xs text-foreground">.env</li>
                    <li className="text-muted-foreground" aria-hidden>›</li>
                    <li className="rounded-sm bg-muted px-1.5 py-px text-xs text-foreground">{t("settingsEnv.layer.page")}</li>
                    <li className="text-muted-foreground" aria-hidden>›</li>
                    <li className="rounded-sm bg-muted px-1.5 py-px text-xs text-foreground">{t("settingsEnv.layer.default")}</li>
                    {!loading && (
                        <li className="ml-1 text-xs text-muted-foreground">
                            {Object.keys(env).length === 0 ? t("settingsEnv.noEnvInfo") : t("settingsEnv.lockedCount", { n: String(lockedCount) })}
                        </li>
                    )}
                </ol>
            </section>

            {loading ? (
                <div className="rounded-xl border border-border/80 bg-card p-8 text-center text-muted-foreground shadow-card">{t("settings.loading")}</div>
            ) : groups.length === 0 ? (
                <Callout tone="info">{t("settingsEnv.olderBackend")}</Callout>
            ) : (
                groups.map((g) => {
                    const gm = GROUP_META[g.id];
                    const Icon = gm.icon;
                    return (
                        <section key={g.id} id={gm.anchor} className="scroll-mt-20 space-y-3">
                            <SectionHeading icon={<Icon />} wrapTitle title={t(gm.title)} description={t(gm.hint)} as="h2" />
                            <div className="overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card">
                                <ul className="divide-y divide-border/70">
                                    {g.keys.map((key) => (
                                        <SettingRow
                                            key={key}
                                            settingKey={key}
                                            value={settingsObj[key]}
                                            meta={meta[key]}
                                            env={env[key]}
                                            onToggle={handleToggle}
                                            onUpdate={handleUpdate}
                                            onExplain={(k) => setExplain(k)}
                                            control={custom(key)}
                                            wide={WIDE_KEYS.includes(key)}
                                        />
                                    ))}
                                </ul>
                            </div>
                        </section>
                    );
                })
            )}

            {explain !== undefined && (
                <SettingSourceDialog
                    isOpen
                    onClose={() => setExplain(undefined)}
                    initial={explain}
                    env={env}
                    values={settingsObj}
                    meta={meta}
                />
            )}
        </div>
    );
}
