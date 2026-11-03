/**
 * 每頁頂端的標題區:標題(可附 tooltip / 狀態)+ 說明 + 右側動作按鈕。各頁共用,間距與字級一致。
 * 跟 Cloudflare / Tailscale 的主控台一樣,標題只有文字——不放圖示方塊;`icon` 仍可傳(舊呼叫端),但只在手機寬度
 * 當成標題前的小灰色圖示,桌面不顯示。
 * Page title block shared by every page: title (with optional addon such as an info tooltip or a status badge),
 * description and right-aligned actions. Like the Cloudflare / Tailscale consoles the title is text only — no icon
 * tile; `icon` is still accepted and shows as a small muted glyph before the title on phones only.
 * 管理區有好幾頁的區會經 `PageHeaderNav` 在標題區下面加一排分頁（`AdminAreaNav`）。
 * Admin areas with several pages add a row of tabs under the title block through `PageHeaderNav` (`AdminAreaNav`).
 * `back` = 回上一層的連結，放在標題左上方（側欄在左，往回走也在左；右邊的動作是對這一頁做的事）。
 * `back` = the link one level up, above the title on the left (the sidebar is on the left, so going back is too; the
 * actions on the right are things you do to this page).
 */
import React, { useContext } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeaderNav } from "./AdminAreaNav";

interface PageHeaderProps {
    icon?: React.ReactNode;
    title: React.ReactNode;
    /** 標題右側的小元件(說明 tooltip、連線狀態…)。/ Small element after the title (info tooltip, status…). */
    titleAddon?: React.ReactNode;
    description?: React.ReactNode;
    actions?: React.ReactNode;
    /** 回上一層（標題左上方的小連結）。/ One level up (a small link above the title, on the left). */
    back?: { href: string; label: React.ReactNode };
    className?: string;
}

export function PageHeader({ icon, title, titleAddon, description, actions, back, className }: PageHeaderProps) {
    const nav = useContext(PageHeaderNav);
    const head = (
        <div className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", !nav && className)}>
            <div className="min-w-0">
                {back && (
                    <Link
                        href={back.href}
                        prefetch={false}
                        className="mb-2 inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                        <ArrowLeft size={15} aria-hidden /> {back.label}
                    </Link>
                )}
                <h1 className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xl leading-tight tracking-tight text-foreground">
                    {icon && <span className="text-muted-foreground sm:hidden [&_svg]:size-5" aria-hidden>{icon}</span>}
                    {title}
                    {titleAddon}
                </h1>
                {description && <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
            </div>
            {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
    );
    if (!nav) return head;
    // 呼叫端給的 className（多半是 mb-6）放在外層，分頁跟標題區一起。/ The caller's className (usually mb-6) goes on the wrapper.
    return (
        <div className={cn("space-y-4", className)}>
            {head}
            {nav}
        </div>
    );
}
