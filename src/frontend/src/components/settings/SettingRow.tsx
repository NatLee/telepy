"use client";

/**
 * 網站設定清單的一列：標題、說明、key、編輯器（開關 / 下拉 / 秒數 / 文字 + 儲存）。可用環境變數設定的 key 多一行：
 * .env 有設時整列鎖住、顯示 .env 的值與「由 .env 設定 · 變數」標籤（按了打開來源說明），沒設時提醒「也能寫在 .env，
 * 寫了就以那裡為準」。
 * One row of the site settings list: title, description, key and the editor (switch / select / duration / text +
 * save). Env-backed keys get one more line: set in .env = the row is locked, shows the .env value and a "Set by
 * .env · VAR" chip (opens the source explainer); not set = a hint that .env would take over.
 */
import React, { useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Chip } from "@/components/ui/section";
import { Switch } from "@/components/ui/switch";
import type { SettingMeta } from "@/hooks/useSettingsPage";
import { useI18n } from "@/lib/i18n";
import { BUILTIN_DEFAULTS, settingSource, type EnvEntry } from "@/lib/settingSource";
import { cn } from "@/lib/utils";
import { en } from "@/locales/en";
import type { TranslationKey } from "@/locales/en";

export function titleize(key: string) {
    return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** 只能選固定值的字串設定：用下拉選單。/ String settings with a fixed set of values get a select. */
export const SETTING_CHOICES: Record<string, { value: string; label: TranslationKey }[]> = {
    desktop_clipboard: [
        { value: "both", label: "siteSettings.desktop_clipboard.both" },
        { value: "to_remote", label: "siteSettings.desktop_clipboard.to_remote" },
        { value: "off", label: "siteSettings.desktop_clipboard.off" },
    ],
};

/** 以秒為單位的站台設定(逾時 / 存活時間)。/ Site settings measured in seconds. */
export const SECONDS_KEY = /_(timeout|lifetime|delay|secs)$/;

/** 秒數設定的單位(由小到大)。/ Units for seconds-based settings, smallest first. */
type DurationUnit = "seconds" | "minutes" | "hours" | "days";
const DURATION_UNITS: { id: DurationUnit; secs: number; label: TranslationKey }[] = [
    { id: "seconds", secs: 1, label: "settings.unitSeconds" },
    { id: "minutes", secs: 60, label: "settings.unitMinutes" },
    { id: "hours", secs: 3600, label: "settings.unitHours" },
    { id: "days", secs: 86400, label: "settings.unitDays" },
];
const unitSecs = (id: DurationUnit) => DURATION_UNITS.find((u) => u.id === id)?.secs ?? 1;
/** 能整除的最大單位(2592000 → 天、3600 → 小時、90 → 秒)。/ The largest unit that divides the value exactly. */
function unitFor(seconds: number): DurationUnit {
    for (const u of [...DURATION_UNITS].reverse()) {
        if (seconds > 0 && seconds % u.secs === 0) return u.id;
    }
    return "seconds";
}
/** 單位換算後的顯示值(最多兩位小數)。/ The amount in a unit, at most two decimals. */
const amountIn = (seconds: number, unit: DurationUnit) => String(Math.round((seconds / unitSecs(unit)) * 100) / 100);

/**
 * 以秒儲存的設定:數字 + 單位 + 儲存。換單位時數值跟著換算(30 天 → 720 小時),存回去的永遠是秒。
 * 存好的值變了(存檔、還原、重新載入)時由呼叫端以 key 重新掛載,所以這裡只在初始化時推導一次。
 * A seconds-based setting: number + unit + save. Switching the unit converts the amount (30 days → 720 hours);
 * what is saved is always seconds. The caller remounts it (key) when the saved value changes, so the local
 * state is derived once.
 */
export function DurationField({ seconds, label, onSave, disabled = false }: { seconds: number; label: string; onSave: (seconds: number) => void; disabled?: boolean }) {
    const { t } = useI18n();
    const [unit, setUnit] = useState<DurationUnit>(() => unitFor(seconds));
    const [amount, setAmount] = useState(() => amountIn(seconds, unitFor(seconds)));
    const commit = () => {
        const n = Number(amount);
        if (!Number.isFinite(n) || n < 0) return;
        onSave(Math.round(n * unitSecs(unit)));
    };
    const changeUnit = (next: DurationUnit) => {
        const n = Number(amount);
        if (Number.isFinite(n)) setAmount(amountIn(n * unitSecs(unit), next));
        setUnit(next);
    };
    return (
        <div className="flex items-center gap-2">
            <Input
                type="number"
                className="w-24 h-8"
                value={amount}
                min={0}
                step="any"
                aria-label={label}
                disabled={disabled}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
            />
            <NativeSelect className="h-8 w-28" value={unit} disabled={disabled} onChange={(e) => changeUnit(e.target.value as DurationUnit)} aria-label={t("settings.unitLabel")}>
                {DURATION_UNITS.map((u) => <option key={u.id} value={u.id}>{t(u.label)}</option>)}
            </NativeSelect>
            {!disabled && (
                <Button type="button" size="sm" variant="soft" onClick={commit}>
                    {t("common.save")}
                </Button>
            )}
        </div>
    );
}

/**
 * 設定的標題與說明：前端字典優先（隨介面語言），沒有對應 key 再退回後端 meta。
 * A setting's label and description: the frontend dictionary first (localized), backend meta as the fallback.
 */
export function useSettingText() {
    const { t } = useI18n();
    const tOpt = (key: string): string | null => (key in en ? t(key as TranslationKey) : null);
    return {
        labelOf: (key: string, m?: SettingMeta) => tOpt(`siteSettings.${key}.label`) ?? m?.label ?? titleize(key),
        descriptionOf: (key: string, m?: SettingMeta) => tOpt(`siteSettings.${key}.description`) ?? m?.description ?? "",
    };
}

/** 內建預設：後端 meta 有給就用，否則前端的表。/ The built-in default: backend meta first, then the frontend table. */
export const defaultOf = (key: string, m?: SettingMeta): unknown => (m && "default" in m ? m.default : BUILTIN_DEFAULTS[key]);

/** 依 meta.type(找不到就用值的型別)決定編輯器。/ Pick the editor from meta.type, else the value's type. */
export function kindOf(key: string, value: unknown, m?: SettingMeta): SettingMeta["type"] {
    return m?.type ?? (typeof value === "boolean" ? "boolean" : typeof value === "number" ? "integer" : typeof BUILTIN_DEFAULTS[key] === "boolean" ? "boolean" : "string");
}

/** 「由 .env 設定 · 變數」標籤；可以按（打開來源說明）。/ The "Set by .env · VAR" chip, clickable. */
export function EnvChip({ variable, onClick }: { variable: string; onClick?: () => void }) {
    const { t } = useI18n();
    const chip = (
        <Chip className="whitespace-normal [overflow-wrap:anywhere]">
            <Lock aria-hidden /> {t("settingsEnv.setByEnv")} · <span className="font-mono">{variable}</span>
        </Chip>
    );
    if (!onClick) return chip;
    return (
        <button type="button" onClick={onClick} className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60" title={t("settingsEnv.chipTitle")}>
            {chip}
        </button>
    );
}

/** 列底下那一行 .env 說明。/ The .env line under a row. */
export function EnvLine({ env, onExplain }: { env: EnvEntry; onExplain?: () => void }) {
    const { tn } = useI18n();
    const code = (s: string) => <code className="rounded bg-muted px-1 font-mono text-[0.85em]">{s}</code>;
    if (env.set) {
        return (
            <div className="mt-2 space-y-1">
                <EnvChip variable={env.var} onClick={onExplain} />
                <p className="text-xs leading-relaxed text-muted-foreground">
                    {tn("settingsEnv.unlockHint", { var: code(env.var), command: code("docker compose up -d backend") })}
                </p>
            </div>
        );
    }
    return <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{tn("settingsEnv.alsoEnv", { var: code(env.var) })}</p>;
}

export interface SettingRowProps {
    settingKey: string;
    value: unknown;
    meta?: SettingMeta;
    env?: EnvEntry;
    onToggle: (key: string, value: unknown) => void;
    onUpdate: (key: string, value: unknown) => void;
    /** 打開來源說明（鎖住的標籤）。/ Opens the source explainer (the locked chip). */
    onExplain?: (key: string) => void;
    /** 自訂編輯器（取代通用的）；拿到要顯示的值與是否鎖住。/ A custom editor; receives the shown value and the lock. */
    control?: (shown: unknown, locked: boolean) => React.ReactNode;
    /** 編輯器放在說明下面整列寬（寬的自訂編輯器）。/ Put the editor under the text, full width. */
    wide?: boolean;
}

export function SettingRow({ settingKey: key, value, meta: m, env, onToggle, onUpdate, onExplain, control, wide = false }: SettingRowProps) {
    const { t } = useI18n();
    const { labelOf, descriptionOf } = useSettingText();
    const [edit, setEdit] = useState<string | null>(null);
    const kind = kindOf(key, value, m);
    const label = labelOf(key, m);
    const description = descriptionOf(key, m);
    const src = settingSource(env, value, defaultOf(key, m));
    const locked = src.locked;
    // 鎖住時顯示 .env 的值（真正生效的那個）。/ Locked rows show the .env value (the one in effect).
    const shown = locked ? src.value : value;
    const current = locked ? String(shown ?? "") : edit ?? String(value ?? "");

    const commit = () => {
        if (locked) return;
        const raw = edit ?? String(value ?? "");
        if (kind === "integer") {
            const num = parseInt(raw, 10);
            if (isNaN(num) || num < 0) return; // 允許 0(例如 max_sessions=0 代表不限制)
            onUpdate(key, num);
        } else {
            const s = raw.trim();
            // 網址欄位、可用 .env 設定的欄位可以清空（= 關閉 / 用預設）。/ URL and env-backed fields may be cleared.
            if (!s && kind !== "url" && !env) return;
            onUpdate(key, s);
        }
    };

    const editor = control ? (
        control(shown, locked)
    ) : kind === "boolean" ? (
        <Switch checked={!!shown} disabled={locked} onCheckedChange={() => onToggle(key, value)} aria-label={label} />
    ) : SETTING_CHOICES[key] ? (
        <NativeSelect className="h-8 w-56" value={String(shown ?? "")} disabled={locked} onChange={(e) => onUpdate(key, e.target.value)} aria-label={label}>
            {SETTING_CHOICES[key].map((c) => <option key={c.value} value={c.value}>{t(c.label)}</option>)}
        </NativeSelect>
    ) : kind === "choice" && Array.isArray(m?.choices) ? (
        // 後端給的選項（沒有翻譯時直接顯示值）。/ Choices from the backend meta, shown as-is.
        <NativeSelect className="h-8 w-56" value={String(shown ?? "")} disabled={locked} onChange={(e) => onUpdate(key, e.target.value)} aria-label={label}>
            {m.choices.map((c) => <option key={c} value={c}>{c}</option>)}
        </NativeSelect>
    ) : kind === "integer" && SECONDS_KEY.test(key) ? (
        <DurationField key={`${String(shown)}-${locked}`} seconds={Number(shown) || 0} label={label} disabled={locked} onSave={(secs) => onUpdate(key, secs)} />
    ) : (
        <div className="flex items-center gap-2">
            <Input
                type={kind === "integer" ? "number" : kind === "url" ? "url" : "text"}
                className={cn(kind === "integer" ? "w-24" : kind === "url" ? "w-56 sm:w-80" : "w-56", "h-8 max-w-full")}
                value={current}
                disabled={locked}
                aria-label={label}
                onChange={(e) => setEdit(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
                min={kind === "integer" ? 0 : undefined}
            />
            {!locked && (
                <Button type="button" size="sm" variant="soft" onClick={commit}>
                    {t("common.save")}
                </Button>
            )}
        </div>
    );

    return (
        <li className="p-4 sm:px-6 sm:py-5 transition-colors hover:bg-surface">
            <div className={cn("flex gap-4", wide ? "flex-col" : "items-start justify-between")}>
                <div className="min-w-0 flex-1">
                    <h4 className="text-[1rem] text-foreground">{label}</h4>
                    {description && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p>}
                    <p className="mt-2 inline-block rounded-md bg-muted px-1.5 py-px font-mono text-xs text-muted-foreground/80">{key}</p>
                    {env && <EnvLine env={env} onExplain={onExplain ? () => onExplain(key) : undefined} />}
                </div>
                <div className={cn("min-w-0", wide ? "" : "shrink-0 pt-0.5")}>{editor}</div>
            </div>
        </li>
    );
}
