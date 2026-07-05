/**
 * 手機鍵盤容器：統一管理定位、可見性、模式切換與高度回報（--kb-offset）。
 * 依模式渲染 AccessoryBar（模式 A：原生鍵盤+特殊鍵列）或 VirtualKeyboard（模式 B：完整鍵盤）。
 *
 * 定位：浮在原生鍵盤上方（bottom = 量測到的原生鍵盤高度）；並把
 * 「原生鍵盤高度 + 本容器高度」寫入 CSS 變數 --kb-offset，供終端機容器保留底部空間。
 */
import React, { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Keyboard, Type } from "lucide-react";
import { cn } from "@/lib/utils";
import { AccessoryBar } from "@/components/tunnels/AccessoryBar";
import { VirtualKeyboard } from "@/components/tunnels/VirtualKeyboard";
import { useKeyboardViewport } from "@/hooks/useKeyboardViewport";
import type { KeyboardController, KeyboardMode } from "@/hooks/useKeyboardController";
import { useI18n } from "@/lib/i18n";

function triggerHaptic() {
    navigator.vibrate?.(10);
}

interface MobileKeyboardProps {
    controller: KeyboardController;
    mode: KeyboardMode;
    setMode: (m: KeyboardMode) => void;
    isVisible: boolean;      // 僅在 Terminal 分頁顯示
    expanded: boolean;       // 模式 B 的 QWERTY 展開狀態
    setExpanded: (v: boolean) => void;
}

export function MobileKeyboard({ controller, mode, setMode, isVisible, expanded, setExpanded }: MobileKeyboardProps) {
    const { t } = useI18n();
    const nativeKbHeight = useKeyboardViewport();
    const contentRef = useRef<HTMLDivElement>(null);
    const lastOpenMode = useRef<KeyboardMode>(mode === "hidden" ? "accessory" : mode);

    // 記住最後一次非 hidden 的模式，供收起後還原（在 effect 內更新 ref，避免 render 期間寫入）。
    useEffect(() => {
        if (mode !== "hidden") lastOpenMode.current = mode;
    }, [mode]);

    // 回報鍵盤總佔用高度到 --kb-offset：原生鍵盤高度 + 本容器高度（僅手機、僅可見時）。
    useEffect(() => {
        const root = document.documentElement;
        const apply = () => {
            if (!isVisible || window.innerWidth >= 768) {
                root.style.setProperty("--kb-offset", "0px");
                return;
            }
            const self = contentRef.current?.offsetHeight ?? 0;
            root.style.setProperty("--kb-offset", `${nativeKbHeight + self}px`);
        };
        apply();
        const ro = new ResizeObserver(apply);
        if (contentRef.current) ro.observe(contentRef.current);
        window.addEventListener("resize", apply);
        return () => {
            ro.disconnect();
            window.removeEventListener("resize", apply);
            root.style.setProperty("--kb-offset", "0px");
        };
    }, [isVisible, nativeKbHeight, mode, expanded]);

    const collapse = () => { triggerHaptic(); setMode("hidden"); };
    const restore = () => { triggerHaptic(); setMode(lastOpenMode.current); };

    return (
        <div
            className={cn(
                "md:hidden absolute left-0 w-full z-[100] transition-transform duration-300 ease-in-out",
                isVisible ? "translate-y-0" : "translate-y-full pointer-events-none"
            )}
            style={{ bottom: nativeKbHeight, paddingBottom: "env(safe-area-inset-bottom)" }}
        >
            <div ref={contentRef} className="w-full bg-background border-t border-border shadow-[0_-4px_20px_rgba(0,0,0,0.6)]">
                {mode === "hidden" ? (
                    <button
                        aria-label={t("kbd.showKeyboard")}
                        onPointerDown={(e) => { e.preventDefault(); restore(); }}
                        className="flex items-center justify-center gap-1.5 w-full h-9 text-xs font-medium text-muted-foreground active:bg-muted/60"
                    >
                        <ChevronUp size={16} /> {t("kbd.keyboard")}
                    </button>
                ) : (
                    <>
                        {/* 控制列：收起 + 模式切換（Native / Full） */}
                        <div className="flex items-center justify-between px-2 h-8">
                            <button
                                aria-label={t("kbd.hideKeyboard")}
                                onPointerDown={(e) => { e.preventDefault(); collapse(); }}
                                className="h-7 w-9 flex items-center justify-center rounded text-muted-foreground active:bg-muted/60"
                            >
                                <ChevronDown size={18} />
                            </button>

                            <div className="flex items-center gap-0.5 bg-muted/60 rounded-md p-0.5">
                                <button
                                    aria-label={t("kbd.nativeAria")}
                                    aria-pressed={mode === "accessory"}
                                    onPointerDown={(e) => { e.preventDefault(); triggerHaptic(); setMode("accessory"); }}
                                    className={cn(
                                        "h-6 px-2.5 rounded flex items-center gap-1 text-[11px] font-medium transition-colors",
                                        mode === "accessory" ? "bg-background shadow text-foreground" : "text-muted-foreground"
                                    )}
                                >
                                    <Type size={13} /> {t("kbd.native")}
                                </button>
                                <button
                                    aria-label={t("kbd.fullAria")}
                                    aria-pressed={mode === "full"}
                                    onPointerDown={(e) => { e.preventDefault(); triggerHaptic(); setMode("full"); }}
                                    className={cn(
                                        "h-6 px-2.5 rounded flex items-center gap-1 text-[11px] font-medium transition-colors",
                                        mode === "full" ? "bg-background shadow text-foreground" : "text-muted-foreground"
                                    )}
                                >
                                    <Keyboard size={13} /> {t("kbd.full")}
                                </button>
                            </div>
                        </div>

                        {mode === "accessory" ? (
                            <AccessoryBar controller={controller} />
                        ) : (
                            <VirtualKeyboard controller={controller} isExpanded={expanded} onToggleExpand={() => setExpanded(!expanded)} />
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
