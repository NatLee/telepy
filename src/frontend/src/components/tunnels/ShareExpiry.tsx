/**
 * 限時分享：期限文字、分享表單裡的選擇、已分享列表裡改期限的浮層。
 * Timed sharing: the "ends in…" text, the choice in the share form, and the popover that changes it on a shared row.
 */
import React, { useState } from "react";
import { Clock, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { minShareDate, SHARE_EXPIRY_PRESETS, shareEndsIn, shareExpiryState, shareExpiryValue, type ShareExpiryPreset } from "@/lib/shareExpiry";
import type { TranslationKey } from "@/locales/en";

const LABEL: Record<ShareExpiryPreset, TranslationKey> = {
    never: "share.expiry.never",
    "1h": "share.expiry.h1",
    "8h": "share.expiry.h8",
    "1d": "share.expiry.d1",
    "7d": "share.expiry.d7",
    "30d": "share.expiry.d30",
    date: "share.expiry.date",
};

const SPANS = SHARE_EXPIRY_PRESETS.filter((p): p is Exclude<ShareExpiryPreset, "never" | "date"> => p !== "never" && p !== "date");

/** 「5 小時後結束」；一天內琥珀色。沒期限時 `showNone` 才顯示「沒有期限」。/ "Ends in 5 hours"; amber within a day. */
export function ShareExpiryText({ expiresAt, showNone = false, className }: { expiresAt?: string | null; showNone?: boolean; className?: string }) {
    const { t, locale } = useI18n();
    const state = shareExpiryState(expiresAt);
    if (state === "none" || !expiresAt) {
        return showNone ? <span className={cn("text-muted-foreground", className)}>{t("share.expiry.noEnd")}</span> : null;
    }
    return (
        <span title={new Date(expiresAt).toLocaleString(locale)} className={cn(state === "ok" ? "text-muted-foreground" : "text-warning", className)}>
            {state === "ending" ? t("share.expiry.ending") : t("share.expiry.endsIn", { when: shareEndsIn(expiresAt, locale) })}
        </span>
    );
}

/** 分享表單：存取多久。/ Share form: how long access lasts. */
export function ShareExpiryChoice({
    preset,
    date,
    onPreset,
    onDate,
}: {
    preset: ShareExpiryPreset;
    date: string;
    onPreset: (p: ShareExpiryPreset) => void;
    onDate: (d: string) => void;
}) {
    const { t } = useI18n();
    return (
        <div className="space-y-1.5">
            <label htmlFor="share-expiry" className="block text-xs text-muted-foreground">
                {t("share.expiry.label")}
            </label>
            <div className="flex flex-wrap items-center gap-2">
                <NativeSelect id="share-expiry" value={preset} onChange={(e) => onPreset(e.target.value as ShareExpiryPreset)} className="w-48">
                    {SHARE_EXPIRY_PRESETS.map((p) => (
                        <option key={p} value={p}>
                            {t(LABEL[p])}
                        </option>
                    ))}
                </NativeSelect>
                {preset === "date" && (
                    <Input type="date" value={date} min={minShareDate()} onChange={(e) => onDate(e.target.value)} className="h-9 w-44" aria-label={t("share.expiry.onDate")} />
                )}
            </div>
            {preset !== "never" && <p className="text-xs text-muted-foreground">{t("share.expiry.hint")}</p>}
        </div>
    );
}

/** 已分享列表：顯示期限，可改的話點開浮層（點一下就套用）。/ Shared row: the end, with a popover to change it (one click applies). */
export function ShareExpiryControl({
    expiresAt,
    editable,
    onChange,
}: {
    expiresAt?: string | null;
    editable: boolean;
    onChange: (value: string | null) => Promise<boolean>;
}) {
    const { t } = useI18n();
    const [open, setOpen] = useState(false);
    const [date, setDate] = useState("");
    const [busy, setBusy] = useState(false);

    const text = (
        <span className="inline-flex items-center gap-1 text-xs">
            <Clock size={12} className="shrink-0 text-muted-foreground" aria-hidden />
            <ShareExpiryText expiresAt={expiresAt} showNone />
        </span>
    );
    if (!editable) return text;

    const apply = async (value: string | null | undefined) => {
        if (value === undefined) return;
        setBusy(true);
        const ok = await onChange(value);
        setBusy(false);
        if (ok) {
            setOpen(false);
            setDate("");
        }
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="group/exp -mx-1 inline-flex items-center gap-1 rounded-sm px-1 hover:bg-muted"
                    title={t("share.expiry.change")}
                    aria-label={t("share.expiry.change")}
                >
                    {text}
                    <Pencil size={11} className="text-muted-foreground opacity-0 transition-opacity group-hover/exp:opacity-100 group-focus-visible/exp:opacity-100" aria-hidden />
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 space-y-3 p-3">
                <div className="space-y-0.5">
                    <p className="text-sm text-foreground">{t("share.expiry.title")}</p>
                    <p className="text-xs">
                        <ShareExpiryText expiresAt={expiresAt} showNone />
                    </p>
                </div>
                <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">{t("share.expiry.fromNow")}</p>
                    <div className="grid grid-cols-3 gap-1.5">
                        {SPANS.map((p) => (
                            <Button key={p} type="button" variant="outline" size="sm" disabled={busy} onClick={() => apply(shareExpiryValue(p, ""))}>
                                {t(LABEL[p])}
                            </Button>
                        ))}
                    </div>
                </div>
                <div className="space-y-1.5">
                    <label htmlFor="share-expiry-date" className="block text-xs text-muted-foreground">
                        {t("share.expiry.onDate")}
                    </label>
                    <div className="flex gap-1.5">
                        <Input id="share-expiry-date" type="date" value={date} min={minShareDate()} onChange={(e) => setDate(e.target.value)} className="h-8 flex-1" />
                        <Button type="button" size="sm" disabled={busy || !date} onClick={() => apply(shareExpiryValue("date", date))}>
                            {t("share.expiry.apply")}
                        </Button>
                    </div>
                </div>
                {expiresAt && (
                    <Button type="button" variant="ghost" size="sm" className="w-full" disabled={busy} onClick={() => apply(null)}>
                        {t("share.expiry.removeEnd")}
                    </Button>
                )}
            </PopoverContent>
        </Popover>
    );
}
