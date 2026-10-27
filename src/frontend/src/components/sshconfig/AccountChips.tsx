"use client";

/**
 * 挑帳號的小方塊（可複選）：單台的 SSH config 工具列與多台對話框的每一列都用它。至少留一個——最後一個不能取消。
 * 只勾一個 = Host 別名就是裝置名稱；勾幾個 = 每個帳號一個 `<名稱>-<帳號>`（後端 `device_aliases`）。
 * Multi-select account chips for the single SSH config toolbar and each row of the bulk dialog. At least one stays
 * ticked. One ticked = the device name as the alias; several = `<name>-<account>` each (backend `device_aliases`).
 */
import React from "react";
import { Check } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface AccountChoice {
    id: number;
    username: string;
}

export function AccountChips({ accounts, selected, onToggle, onAll, defaultId, className }: {
    accounts: AccountChoice[];
    selected: ReadonlySet<number>;
    onToggle: (id: number) => void;
    /** 有就在沒全選時放「全部」。/ When given, an "All" button while not everything is ticked. */
    onAll?: () => void;
    /** 隧道的預設帳號（標一個小字）。/ The tunnel's default account (gets a small tag). */
    defaultId?: number | null;
    className?: string;
}) {
    const { t } = useI18n();
    const allOn = accounts.every((a) => selected.has(a.id));
    return (
        <div className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)} role="group" aria-label={t("config.accounts.aria")}>
            {accounts.map((a) => {
                const on = selected.has(a.id);
                const last = on && selected.size === 1;
                return (
                    <button
                        key={a.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => !last && onToggle(a.id)}
                        title={last ? t("config.accounts.keepOne") : undefined}
                        className={cn(
                            "inline-flex h-7 max-w-full items-center gap-1 rounded-sm px-2 font-mono text-xs ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                            on ? "bg-primary/10 text-foreground ring-primary/40" : "text-muted-foreground ring-border hover:bg-muted/60 hover:text-foreground",
                            last && "cursor-default"
                        )}
                    >
                        {on && <Check size={12} className="shrink-0 text-primary" aria-hidden />}
                        <span className="truncate">{a.username}</span>
                        {a.id === defaultId && <span className="font-sans text-[0.7rem] text-muted-foreground">{t("config.accounts.default")}</span>}
                    </button>
                );
            })}
            {onAll && !allOn && accounts.length > 1 && (
                <button type="button" onClick={onAll} className="h-7 rounded-sm px-2 text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
                    {t("config.accounts.all", { count: accounts.length })}
                </button>
            )}
        </div>
    );
}
