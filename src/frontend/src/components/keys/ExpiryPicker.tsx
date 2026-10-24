/**
 * 金鑰效期選擇：預設選項 + 自選日期。新增與詳細資訊共用。
 * Key lifetime picker: presets plus a custom date; shared by the add and details dialogs.
 */
import React from "react";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useI18n } from "@/lib/i18n";
import { addDays, EXPIRY_PRESETS, type ExpiryPreset } from "@/lib/keyExpiry";
import type { TranslationKey } from "@/locales/en";

const LABEL: Record<ExpiryPreset, TranslationKey> = {
    never: "keys.expiry.never",
    "30": "keys.expiry.d30",
    "90": "keys.expiry.d90",
    "180": "keys.expiry.d180",
    "365": "keys.expiry.d365",
    custom: "keys.expiry.custom",
};

export function ExpiryPicker({
    id,
    preset,
    customDate,
    onPreset,
    onCustomDate,
    neverLabel,
}: {
    id: string;
    preset: ExpiryPreset;
    customDate: string;
    onPreset: (p: ExpiryPreset) => void;
    onCustomDate: (d: string) => void;
    /** 「不到期」在新增時其實是「用站台預設」。/ On create "never" really means "the site default". */
    neverLabel?: string;
}) {
    const { t } = useI18n();
    return (
        <div className="flex flex-wrap items-center gap-2">
            <NativeSelect id={id} value={preset} onChange={(e) => onPreset(e.target.value as ExpiryPreset)} className="w-56">
                {EXPIRY_PRESETS.map((p) => (
                    <option key={p} value={p}>
                        {p === "never" && neverLabel ? neverLabel : t(LABEL[p])}
                    </option>
                ))}
            </NativeSelect>
            {preset === "custom" && (
                <Input type="date" value={customDate} min={addDays(1)} onChange={(e) => onCustomDate(e.target.value)} className="h-9 w-44" aria-label={t("keys.expiry.custom")} />
            )}
        </div>
    );
}
