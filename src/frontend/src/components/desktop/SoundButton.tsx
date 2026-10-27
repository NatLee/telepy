"use client";

/**
 * 工具列的聲音按鈕：圖示與字跟著 lib/desktopSound 的判斷走（在播 / 安靜 / 等遠端 / 瀏覽器擋著 / 遠端沒送 / 靜音 / 關），
 * 提示是為什麼。瀏覽器擋著時旁邊多一顆「點一下啟用聲音」——那一下點擊就是自動播放限制要的使用者手勢。
 * RDP 的按鈕是這一頁的靜音；RustDesk 的是開 / 關（請裝置送不送）。
 * The toolbar sound button: icon and label follow lib/desktopSound's verdict, the tooltip says why. While the browser
 * holds the sound back, a "Click to enable sound" button appears next to it: that click is the gesture autoplay
 * needs. For RDP the button mutes this tab; for RustDesk it switches the device's sound on or off.
 */
import React from "react";
import { Volume1, Volume2, VolumeOff, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { soundNeedsAttention, type SoundReport, type SoundState } from "@/lib/desktopSound";
import type { TranslationKey } from "@/locales/en";

const LABEL: Record<SoundState, TranslationKey> = {
    off: "desktop.sound.off",
    unsupported: "desktop.sound.off",
    muted: "desktop.sound.muted",
    waiting: "desktop.sound.state.waiting",
    blocked: "desktop.sound.state.blocked",
    playing: "desktop.sound.playing",
    quiet: "desktop.sound.state.quiet",
    none: "desktop.sound.state.none",
};

function SoundIcon({ state }: { state: SoundState }) {
    if (state === "playing") return <Volume2 size={15} className="text-success" />;
    if (state === "quiet" || state === "waiting") return <Volume1 size={15} />;
    if (state === "none") return <VolumeOff size={15} className="text-warning" />;
    if (state === "blocked") return <VolumeX size={15} className="text-warning" />;
    return <VolumeX size={15} />;
}

export interface SoundButtonProps {
    report: SoundReport;
    /** 按鈕在做什麼（給 aria-label）。/ What the button does, for its accessible name. */
    action: TranslationKey;
    pressed: boolean;
    disabled?: boolean;
    className?: string;
    onToggle: () => void;
    onResume: () => void;
}

export function SoundButton({ report, action, pressed, disabled, className, onToggle, onResume }: SoundButtonProps) {
    const { t } = useI18n();
    const warn = soundNeedsAttention(report.state);
    return (
        <>
            {report.state === "blocked" && (
                <Button size="sm" variant="outline" className={cn("h-8 shrink-0 gap-1.5 border-warning/60 px-2 text-warning hover:text-warning", className)} onClick={onResume} title={t(report.reason)} data-sound-unlock>
                    <Volume2 size={15} /> {t("desktop.sound.enable")}
                </Button>
            )}
            <Button
                size="sm"
                variant="ghost"
                className={cn(className, warn && "text-warning hover:text-warning")}
                onClick={onToggle}
                disabled={disabled}
                aria-pressed={pressed}
                aria-label={t(action)}
                title={`${t(LABEL[report.state])} — ${t(report.reason)}`}
                data-sound={report.state}
            >
                <SoundIcon state={report.state} />
                <span className="hidden md:inline">{t(LABEL[report.state])}</span>
            </Button>
        </>
    );
}
