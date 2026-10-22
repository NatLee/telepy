/**
 * 分享彈窗內的權限對照表（Admin/Editor/Viewer），收在可展開的區塊裡。
 * Permission matrix (Admin / Editor / Viewer) inside the share modal, in a collapsible section.
 */
import React from "react";
import { Shield, Check, Minus, ChevronDown } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";

const COLUMNS: TranslationKey[] = [
    "share.thViewTunnels",
    "share.thEditConfig",
    "share.thManageTargetUsers",
    "share.thShareTunnels",
    "share.thDeleteTunnels",
];

const ROWS: [TranslationKey, boolean[]][] = [
    ["share.roleAdmin", [true, true, true, true, true]],
    ["share.roleEditor", [true, true, false, false, false]],
    ["share.roleViewer", [true, false, false, false, false]],
];

export function ShareModalPermissionMatrix({ defaultOpen = false }: { defaultOpen?: boolean }) {
    const { t } = useI18n();
    return (
        <details open={defaultOpen} className="group overflow-hidden rounded-xl bg-surface text-sm ring-1 ring-inset ring-border/80">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-foreground transition-colors hover:bg-muted/60 [&::-webkit-details-marker]:hidden">
                <Shield size={16} className="text-primary" aria-hidden />
                <span>{t("share.matrixTitle")}</span>
                <ChevronDown size={16} className="ml-auto text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <div className="overflow-x-auto border-t border-border/70 bg-card">
                <table className="w-full text-xs">
                    <thead>
                        <tr className="text-muted-foreground">
                            <th className="px-4 py-2.5 text-left">{t("share.thRole")}</th>
                            {COLUMNS.map((col) => (
                                <th key={col} className="px-3 py-2.5 text-center">{t(col)}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border/70 border-t border-border/70">
                        {ROWS.map(([role, allowed]) => (
                            <tr key={role}>
                                <td className="px-4 py-2.5 text-left text-sm text-foreground">{t(role)}</td>
                                {allowed.map((ok, i) => (
                                    <td key={COLUMNS[i]} className="px-3 py-2.5 text-center">
                                        {ok ? (
                                            <span className="inline-grid size-5 place-items-center rounded-full bg-primary/12 text-primary">
                                                <Check size={12} strokeWidth={3} />
                                            </span>
                                        ) : (
                                            <Minus size={14} className="mx-auto text-muted-foreground/40" />
                                        )}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <p className="border-t border-border/70 bg-card px-4 py-2.5 text-xs text-muted-foreground">
                {t("share.allowListFootnote")}
            </p>
        </details>
    );
}
