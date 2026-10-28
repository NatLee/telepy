"use client";

/**
 * 工具列的「顯示」選單（滑鼠也能用，guacd 和 RustDesk 的畫面共用）：− / 百分比 / +、塞進框裡 / 只縮不放 / 1:1、
 * 這個 session 的解析度怎麼來的（跟著視窗 / 固定 / 遠端決定）、HiDPI、「佔滿瀏覽器視窗」，以及前往偏好設定。
 * The toolbar's Display menu, shared by both viewers: zoom − / % / +, fit / shrink only / 1:1, where this session's
 * resolution comes from, HiDPI, "fill the browser window" and a link to the preferences.
 */
import React from "react";
import { ChevronDown, Minus, Plus, Settings2, ZoomIn } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openPreferences } from "@/components/layout/UserPreferencesModal";
import { sizeLabel, type FixedSize, type ResolutionStatus } from "@/lib/desktopDisplay";
import type { ZoomInfo } from "@/hooks/useDesktopZoom";
import type { ZoomCommands } from "@/components/desktop/DesktopViewer";
import type { TranslationKey } from "@/locales/en";

const STATUS_KEY: Record<ResolutionStatus, TranslationKey> = {
    follows: "desktop.display.res.follows",
    asked: "desktop.display.res.asked",
    fixed: "desktop.display.res.fixed",
    remote: "desktop.display.res.remote",
};

interface Props {
    info: ZoomInfo;
    /** 讀最新的 viewer（ref 在 render 之後才有）。/ Reads the current viewer's commands. */
    commands: () => ZoomCommands | null | undefined;
    status: ResolutionStatus;
    remoteSize: FixedSize | null;
    /** null = 這種畫面沒有 HiDPI 選項（RustDesk）。/ null = no HiDPI choice for this viewer (RustDesk). */
    hidpi: boolean | null;
    onHidpi: (on: boolean) => void;
    fill: boolean;
    onFill: (on: boolean) => void;
    disabled?: boolean;
    className?: string;
}

export function DisplayMenu({ info, commands, status, remoteSize, hidpi, onHidpi, fill, onFill, disabled, className }: Props) {
    const { t } = useI18n();
    const mode = info.mode === "scale" ? "" : info.mode;
    const small = "grid size-8 place-items-center rounded-md text-foreground hover:bg-muted disabled:text-muted-foreground/50 disabled:hover:bg-transparent";
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className={className} disabled={disabled} title={t("desktop.display.menu")}>
                    <ZoomIn size={15} aria-hidden />
                    <span className="font-mono text-xs tabular-nums">{info.percent}%</span>
                    <ChevronDown size={13} className="hidden text-muted-foreground sm:block" aria-hidden />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" collisionPadding={8} className="w-72">
                <DropdownMenuLabel>{t("desktop.display.menu")}</DropdownMenuLabel>
                {/* 放大縮小不關選單（一直按 +）。/ The zoom buttons keep the menu open. */}
                <div className="flex items-center justify-between gap-2 px-2 py-1" role="group" aria-label={t("desktop.zoom.label")}>
                    <button type="button" className={small} onClick={() => commands()?.zoomOut()} disabled={!info.canZoomOut} aria-label={t("desktop.zoom.out")} title={t("desktop.zoom.out")}>
                        <Minus size={15} aria-hidden />
                    </button>
                    <span className="min-w-14 text-center font-mono text-sm tabular-nums text-foreground" aria-live="polite">{info.percent}%</span>
                    <button type="button" className={small} onClick={() => commands()?.zoomIn()} disabled={!info.canZoomIn} aria-label={t("desktop.zoom.in")} title={t("desktop.zoom.in")}>
                        <Plus size={15} aria-hidden />
                    </button>
                </div>
                <DropdownMenuRadioGroup value={mode} onValueChange={(v) => commands()?.setMode(v as "fit" | "shrink" | "actual")}>
                    <DropdownMenuRadioItem value="fit" onSelect={(e) => e.preventDefault()}>
                        <span className="flex-1">{t("desktop.display.scale.fit")}</span>
                        <span className="font-mono text-xs text-muted-foreground">{info.fitPercent}%</span>
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="shrink" onSelect={(e) => e.preventDefault()}>
                        {t("desktop.display.scale.shrink")}
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="actual" onSelect={(e) => e.preventDefault()}>
                        <span className="flex-1">{t("desktop.display.scale.actual")}</span>
                        <span className="font-mono text-xs text-muted-foreground">100%</span>
                    </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <p className="px-2 py-1.5 text-xs text-muted-foreground">{t(STATUS_KEY[status], { size: remoteSize ? sizeLabel(remoteSize) : "—" })}</p>
                {hidpi !== null && (
                    <DropdownMenuCheckboxItem checked={hidpi} onCheckedChange={onHidpi} onSelect={(e) => e.preventDefault()}>
                        <span className="block">
                            {t("desktop.display.hidpi")}
                            <span className="block text-xs text-muted-foreground">{t("desktop.display.hidpiMenuHint")}</span>
                        </span>
                    </DropdownMenuCheckboxItem>
                )}
                <DropdownMenuCheckboxItem checked={fill} onCheckedChange={onFill}>
                    <span className="block">
                        {t("desktop.display.fill")}
                        <span className="block text-xs text-muted-foreground">{t("desktop.display.fillHint")}</span>
                    </span>
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => openPreferences("desktop")}>
                    <Settings2 size={14} /> {t("desktop.display.settings")}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
