"use client";

/**
 * 偏好設定的「已存的登入」：憑證庫裡自己存的遠端桌面登入（只列名稱、目標與帳號，密碼不會回到瀏覽器），可以刪除。
 * The preferences' "Saved logins": your vault entries for remote desktops (never the password), with delete.
 */
import React, { useState } from "react";
import Link from "next/link";
import { KeyRound, Monitor, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Chip, Section } from "@/components/ui/section";
import { useToast } from "@/components/ui/Toast";
import { useSavedLogins, type SavedLogin } from "@/hooks/useSavedLogins";
import { useI18n } from "@/lib/i18n";

export function SavedLogins({ onNavigate }: { onNavigate?: () => void }) {
    const { t, locale } = useI18n();
    const { showSuccess, showError } = useToast();
    const { list, loaded, remove } = useSavedLogins(null);
    const [confirm, setConfirm] = useState<SavedLogin | null>(null);
    const date = (iso: string) => new Date(iso).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });

    return (
        <Section icon={<KeyRound />} title={t("vault.title")} description={t("vault.description")}>
            {!loaded ? null : list.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    {t("vault.empty")}{" "}
                    <Link href="/tunnels/desktop" prefetch={false} onClick={onNavigate} className="text-primary underline-offset-2 hover:underline">{t("vault.openDesktop")}</Link>
                </p>
            ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                    {list.map((c) => (
                        <li key={c.id} className="flex items-start gap-3 px-3 py-2.5">
                            <Monitor size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="truncate text-sm text-foreground">{c.label}</span>
                                    <Chip mono>{c.protocol === "rustdesk" ? "RustDesk" : c.protocol.toUpperCase()}</Chip>
                                </div>
                                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                    {(c.tunnel_name ?? `#${c.tunnel_id}`) + (c.lan_host ? ` › ${c.lan_host}` : "")}
                                    {c.port ? `:${c.port}` : ""} · <span className="font-mono">{c.login || "—"}{c.domain ? ` @ ${c.domain}` : ""}</span>
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {c.last_used_at ? t("vault.lastUsed", { date: date(c.last_used_at) }) : t("vault.neverUsed")}
                                </p>
                            </div>
                            <Button type="button" size="icon" variant="ghost" className="size-8 shrink-0" onClick={() => setConfirm(c)} aria-label={t("vault.delete")} title={t("vault.delete")}>
                                <Trash2 size={15} />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            <ConfirmDialog
                isOpen={!!confirm}
                onClose={() => setConfirm(null)}
                onConfirm={async () => {
                    const c = confirm;
                    setConfirm(null);
                    if (!c) return;
                    if (await remove(c.id)) showSuccess(t("vault.deleted", { label: c.label }));
                    else showError(t("vault.deleteFailed"));
                }}
                title={t("vault.deleteTitle")}
                message={t("vault.deleteMessage", { label: confirm?.label ?? "" })}
                confirmText={t("vault.delete")}
                isDestructive
            />
        </Section>
    );
}
