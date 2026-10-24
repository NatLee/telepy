"use client";

/**
 * 裝置出示了和釘選不同的 SSH host key：列表上的紅色標記，點了開詳細資訊（在那裡核對、確認）。
 * Red marker on the tunnel list when the device presented a host key other than the pinned one; opens the details.
 */
import React from "react";
import { ShieldAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function HostKeyAlert({ changed, onOpen }: { changed?: boolean; onOpen: () => void }) {
    const { t } = useI18n();
    if (!changed) return null;
    return (
        <button
            type="button"
            onClick={onOpen}
            className="inline-flex items-center gap-1 rounded-sm bg-destructive/10 px-1.5 py-px text-xs text-destructive hover:bg-destructive/15"
            title={t("hostKey.listHint")}
        >
            <ShieldAlert size={13} aria-hidden /> {t("hostKey.listChip")}
        </button>
    );
}
