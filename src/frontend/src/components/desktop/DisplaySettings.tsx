"use client";

/**
 * 偏好設定 → 遠端桌面 → 顯示：每個桌面的預設縮放、RDP 解析度（跟著視窗 / 固定）、HiDPI、VNC 要不要也跟著視窗，
 * 以及一張「哪些會即時調整」的對照（RDP 改遠端解析度；VNC / RustDesk 由遠端決定、在瀏覽器裡縮放）。
 * 存在這台瀏覽器（useDesktopDisplay），桌面頁的「顯示」選單讀寫同一份。
 * Preferences → Remote desktop → Display: default scaling, the RDP resolution, HiDPI, VNC resizing and what adjusts
 * live per way. Kept in this browser; the desktop page's Display menu shares the same value.
 */
import React, { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Field } from "@/components/ui/field";
import { useDesktopDisplay } from "@/hooks/useDesktopDisplay";
import { clampPercent, MAX_PERCENT, MIN_PERCENT, RESOLUTION_PRESETS, sizeLabel, validDimension, type ScaleMode } from "@/lib/desktopDisplay";
import type { TranslationKey } from "@/locales/en";

export const SCALE_LABEL: Record<ScaleMode, TranslationKey> = {
    fit: "desktop.display.scale.fit",
    shrink: "desktop.display.scale.shrink",
    actual: "desktop.display.scale.actual",
    custom: "desktop.display.scale.custom",
};
const SCALE_HINT: Record<ScaleMode, TranslationKey> = {
    fit: "desktop.display.scaleHint.fit",
    shrink: "desktop.display.scaleHint.shrink",
    actual: "desktop.display.scaleHint.actual",
    custom: "desktop.display.scaleHint.custom",
};

const CUSTOM = "custom";

export function DisplaySettings() {
    const { t } = useI18n();
    const [display, setDisplay] = useDesktopDisplay();
    const presetValue = RESOLUTION_PRESETS.some((p) => p.width === display.fixed.width && p.height === display.fixed.height) ? sizeLabel(display.fixed) : CUSTOM;
    // 自訂大小與百分比：打字時先放在這裡，合法才存。/ Typed values live here until they are valid.
    const [percentText, setPercentText] = useState<string | null>(null);
    const [sizeText, setSizeText] = useState<{ w: string; h: string } | null>(null);
    const [customOpen, setCustomOpen] = useState(false);
    const showCustomSize = presetValue === CUSTOM || customOpen;

    const commitSize = (w: string, h: string) => {
        const width = validDimension(w);
        const height = validDimension(h);
        if (width && height) setDisplay({ fixed: { width, height } });
    };

    return (
        <div className="space-y-4">
            <Field label={t("desktop.display.scale")} hint={t(SCALE_HINT[display.scale])}>
                <div>
                <Segmented
                    fullWidth
                    size="sm"
                    options={(["fit", "shrink", "actual", "custom"] as const).map((v) => ({ value: v, label: t(SCALE_LABEL[v]) }))}
                    value={display.scale}
                    onChange={(v) => setDisplay({ scale: v })}
                    aria-label={t("desktop.display.scale")}
                />
                {display.scale === "custom" && (
                    <div className="mt-2 flex items-center gap-2">
                        <Input
                            type="number"
                            className="h-8 w-24"
                            min={MIN_PERCENT}
                            max={MAX_PERCENT}
                            step={5}
                            value={percentText ?? String(display.percent)}
                            aria-label={t("desktop.display.percent")}
                            onChange={(e) => setPercentText(e.target.value)}
                            onBlur={() => {
                                if (percentText !== null) setDisplay({ percent: clampPercent(percentText) });
                                setPercentText(null);
                            }}
                        />
                        <span className="text-sm text-muted-foreground">%</span>
                    </div>
                )}
                </div>
            </Field>

            <Field label={t("desktop.display.resolution")} hint={t(display.resolution === "window" ? "desktop.display.resolutionHint.window" : "desktop.display.resolutionHint.fixed")}>
                <div>
                <Segmented
                    fullWidth
                    size="sm"
                    options={[
                        { value: "window" as const, label: t("desktop.display.resolution.window") },
                        { value: "fixed" as const, label: t("desktop.display.resolution.fixed") },
                    ]}
                    value={display.resolution}
                    onChange={(v) => setDisplay({ resolution: v })}
                    aria-label={t("desktop.display.resolution")}
                />
                {display.resolution === "fixed" && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <NativeSelect
                            className="h-8 w-40"
                            value={customOpen ? CUSTOM : presetValue}
                            aria-label={t("desktop.display.resolution.fixed")}
                            onChange={(e) => {
                                if (e.target.value === CUSTOM) {
                                    setCustomOpen(true);
                                    return;
                                }
                                setCustomOpen(false);
                                setSizeText(null);
                                const p = RESOLUTION_PRESETS.find((x) => sizeLabel(x) === e.target.value);
                                if (p) setDisplay({ fixed: p });
                            }}
                        >
                            {RESOLUTION_PRESETS.map((p) => <option key={sizeLabel(p)} value={sizeLabel(p)}>{sizeLabel(p)}</option>)}
                            <option value={CUSTOM}>{t("desktop.display.resolution.custom")}</option>
                        </NativeSelect>
                        {showCustomSize && (
                            <span className="flex items-center gap-1.5">
                                <Input
                                    type="number"
                                    className="h-8 w-24"
                                    min={200}
                                    max={16384}
                                    value={sizeText?.w ?? String(display.fixed.width)}
                                    aria-label={t("desktop.display.width")}
                                    onChange={(e) => setSizeText({ w: e.target.value, h: sizeText?.h ?? String(display.fixed.height) })}
                                    onBlur={() => sizeText && commitSize(sizeText.w, sizeText.h)}
                                />
                                <span className="text-sm text-muted-foreground">×</span>
                                <Input
                                    type="number"
                                    className="h-8 w-24"
                                    min={200}
                                    max={16384}
                                    value={sizeText?.h ?? String(display.fixed.height)}
                                    aria-label={t("desktop.display.height")}
                                    onChange={(e) => setSizeText({ w: sizeText?.w ?? String(display.fixed.width), h: e.target.value })}
                                    onBlur={() => sizeText && commitSize(sizeText.w, sizeText.h)}
                                />
                            </span>
                        )}
                    </div>
                )}
                </div>
            </Field>

            <Field label={t("desktop.display.hidpi")} hint={t("desktop.display.hidpiHint")}>
                <Switch size="sm" checked={display.hidpi} onCheckedChange={(on) => setDisplay({ hidpi: on })}>
                    {display.hidpi ? t("desktop.display.on") : t("desktop.display.off")}
                </Switch>
            </Field>

            <Field label={t("desktop.display.vncResize")} hint={t("desktop.display.vncResizeHint")}>
                <Switch size="sm" checked={display.vncResize} onCheckedChange={(on) => setDisplay({ vncResize: on })}>
                    {display.vncResize ? t("desktop.display.on") : t("desktop.display.off")}
                </Switch>
            </Field>

            <DynamicTable />
        </div>
    );
}

/** 每種方式「什麼會跟著視窗」。/ What follows the window, per way. */
export function DynamicTable() {
    const { t } = useI18n();
    const rows: { way: string; key: TranslationKey }[] = [
        { way: "RDP", key: "desktop.display.dynamic.rdp" },
        { way: "VNC", key: "desktop.display.dynamic.vnc" },
        { way: "RustDesk", key: "desktop.display.dynamic.rustdesk" },
    ];
    return (
        <div className="rounded-md border border-border bg-surface p-3">
            <p className="mb-2 text-sm text-foreground">{t("desktop.display.dynamic.title")}</p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
                {rows.map((r) => (
                    <React.Fragment key={r.way}>
                        <dt className="font-mono text-foreground">{r.way}</dt>
                        <dd className="text-muted-foreground">{t(r.key)}</dd>
                    </React.Fragment>
                ))}
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">{t("desktop.display.dynamic.ceiling")}</p>
        </div>
    );
}
