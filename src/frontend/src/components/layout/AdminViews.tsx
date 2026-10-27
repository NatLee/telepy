"use client";

/**
 * 「我的」與「全站」分開的頁面共用的小塊：管理區頁面的門（非管理員看到提示與自己那頁的連結）、標題旁的
 * 「只有管理員」標籤，以及個人頁上給管理員的「全站的在管理區」連結。
 * Shared pieces of the pages that come as "mine" + "everyone's": the admin section's gate (non-admins get a note
 * and a link to their own page), the "Admins only" chip next to the title, and the "everyone's is in the admin
 * section" link on a personal page for admins.
 */
import React from "react";
import Link from "next/link";
import { ArrowRight, Shield } from "lucide-react";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/section";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";

/** `mine` = 每個人自己的（管理員也一樣）；`all` = 全站（管理區）。/ `mine` = your own (admins too); `all` = everyone's (admin section). */
export type ViewScope = "mine" | "all";

export function AdminChip() {
    const { t } = useI18n();
    return (
        <Chip tone="primary">
            <Shield /> {t("common.adminOnly")}
        </Chip>
    );
}

/** 管理區的頁面：只有管理員看得到內容。/ An admin-section page: only admins get its content. */
export function AdminGate({ children, mineHref, mineLabel }: { children: React.ReactNode; mineHref?: string; mineLabel?: string }) {
    const { user } = useAuth();
    const { t } = useI18n();
    if (!user) return null;
    if (!user.is_superuser) {
        return (
            <div className="animate-fade-in-up">
                <Callout tone="warning" title={t("admin.onlyTitle")}>
                    <p>{t("admin.only")}</p>
                    {mineHref && mineLabel && (
                        <Link href={mineHref} prefetch={false} className="mt-2 inline-flex items-center gap-1 text-foreground underline underline-offset-2">
                            {mineLabel} <ArrowRight size={12} className="opacity-60" />
                        </Link>
                    )}
                </Callout>
            </div>
        );
    }
    return <>{children}</>;
}

/**
 * 個人頁上給管理員的一行：這裡只有你自己的，全站的在管理區。非管理員不顯示。
 * One line on a personal page for admins: this is only yours, everyone's is in the admin section. Hidden for others.
 */
export function AdminViewLink({ href, label, note, className }: { href: string; label: string; /** 預設「這裡只有你自己的紀錄…」。/ Defaults to "only your own records…". */ note?: string; className?: string }) {
    const { user } = useAuth();
    const { t } = useI18n();
    if (!user?.is_superuser) return null;
    return (
        <Callout tone="info" icon={<Shield size={17} className="mt-0.5 shrink-0" aria-hidden />} className={className}>
            {note ?? t("admin.mineNote")}{" "}
            <Link href={href} prefetch={false} className="inline-flex items-center gap-1 text-foreground underline underline-offset-2">
                {label} <ArrowRight size={12} className="opacity-60" />
            </Link>
        </Callout>
    );
}
