"use client";

/**
 * 裝置身分出了問題：出示了和釘選不同的 SSH host key，或這台機器屬於別的帳號的隧道（連線被拒）。
 * 列表上的紅色標記，點了開詳細資訊（在那裡核對、確認或看說明）。
 * Red marker on the tunnel list when the device presented a host key other than the pinned one, or the machine
 * belongs to another account's tunnel; opens the details.
 */
import React from "react";
import { ShieldAlert, ShieldOff } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function HostKeyAlert({ changed, claimed, onOpen }: { changed?: boolean; claimed?: boolean; onOpen: () => void }) {
    const { t } = useI18n();
    if (!changed && !claimed) return null;
    const Icon = claimed ? ShieldOff : ShieldAlert;
    return (
        <button
            type="button"
            onClick={onOpen}
            className="inline-flex items-center gap-1 rounded-sm bg-destructive/10 px-1.5 py-px text-xs text-destructive hover:bg-destructive/15"
            title={t(claimed ? "hostKey.claimedHint" : "hostKey.listHint")}
        >
            <Icon size={13} aria-hidden /> {t(claimed ? "hostKey.claimedChip" : "hostKey.listChip")}
        </button>
    );
}
