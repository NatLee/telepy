"use client";

/**
 * 外觀對話框 info 按鈕打開的圖:「我的預設(所有裝置)→ 這台裝置的覆寫(只有我、只有這條隧道)→ 這個終端機」三個
 * 方塊、直線相連,每格列出字型 / 字級 / 配色 / 粗體 / 連字與它來自哪一層(純函式 effectiveAppearance)。平面、
 * 直線與直角、手機直排。
 * The diagram behind the Appearance dialog's info button: "My default (all devices) → This device override (only
 * me, only this tunnel) → This terminal" as three boxes joined by straight lines, each listing font / size / scheme /
 * bold / ligatures and which layer supplied it (pure effectiveAppearance). Flat, straight lines, stacked on phones.
 */
import React from "react";
import { Info, MonitorSmartphone, SquareTerminal, UserRound, type LucideIcon } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import {
    effectiveAppearance,
    hasProfileOverride,
    isBoldStyle,
    isKnownFont,
    isKnownScheme,
    TERMINAL_FONT_SIZE_RANGE,
    terminalFont,
    terminalScheme,
    type AppearanceSource,
    type TerminalBold,
    type TerminalDefaults,
    type TerminalProfile,
    type TerminalScheme,
} from "@/lib/terminalAppearance";

const BOLD_LABEL: Record<TerminalBold, TranslationKey> = { face: "terminal.boldFace", bright: "terminal.boldBright", both: "terminal.boldBoth" };
const FIELD_LABEL = {
    font: "terminal.font",
    fontSize: "terminal.fontSize",
    scheme: "terminal.colorScheme",
    bold: "terminal.bold",
    ligatures: "terminal.ligatures",
} as const satisfies Record<string, TranslationKey>;
type FieldKey = keyof typeof FIELD_LABEL;
const FIELDS: FieldKey[] = ["font", "fontSize", "scheme", "bold", "ligatures"];

/** 一格一行:標籤、值、來源。/ One row per field: label, value, source. */
function Row({ label, value, tag, tone, muted }: { label: string; value: React.ReactNode; tag?: string; tone?: "neutral" | "primary"; muted?: boolean }) {
    return (
        <li className="flex items-baseline justify-between gap-2 text-xs">
            <span className="shrink-0 text-muted-foreground">{label}</span>
            <span className="flex min-w-0 items-baseline justify-end gap-1.5">
                <span className={cn("truncate", muted ? "text-muted-foreground" : "text-foreground")}>{value}</span>
                {tag && <Chip tone={tone ?? "neutral"} className="shrink-0">{tag}</Chip>}
            </span>
        </li>
    );
}

function Box({ icon: Icon, title, sub, active, children }: { icon: LucideIcon; title: string; sub: string; active?: boolean; children: React.ReactNode }) {
    return (
        <li className={cn("flex min-w-0 flex-1 basis-0 flex-col gap-2 rounded-xl border bg-card p-3", active ? "border-primary" : "border-border")}>
            <div className="flex items-center gap-2">
                <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", active ? "bg-primary text-primary-foreground" : "bg-muted text-foreground")} aria-hidden>
                    <Icon size={16} />
                </span>
                <span className="min-w-0">
                    <span className="block truncate text-sm text-foreground">{title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{sub}</span>
                </span>
            </div>
            <ul className="space-y-1 border-t border-border pt-2">{children}</ul>
        </li>
    );
}

/** 兩個方塊之間的直線(桌面橫、手機直),上面一個小標籤。/ The straight connector (horizontal from sm, vertical on phones). */
function Arrow({ label }: { label: string }) {
    return (
        <li className="flex items-center justify-center sm:w-14 sm:shrink-0 sm:flex-col" aria-label={label}>
            <svg className="h-8 w-3 text-muted-foreground sm:hidden" viewBox="0 0 6 100" preserveAspectRatio="none" aria-hidden>
                <line x1={3} y1={0} x2={3} y2={100} stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            </svg>
            <svg className="hidden h-3 w-full text-muted-foreground sm:block" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden>
                <line x1={0} y1={3} x2={100} y2={3} stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                <polygon points="94,0 100,3 94,6" fill="currentColor" />
            </svg>
            <span className="ml-2 text-xs text-muted-foreground sm:ml-0 sm:mt-1 sm:text-center">{label}</span>
        </li>
    );
}

export function AppearanceLayers({ defaults, profile, customSchemes }: { defaults: TerminalDefaults; profile: TerminalProfile | null; customSchemes: TerminalScheme[] }) {
    const { t } = useI18n();
    const e = effectiveAppearance(defaults, profile, customSchemes);
    const p = profile;
    const sourceName = (from: AppearanceSource) => t(from === "device" ? "terminal.scopeDevice" : "terminal.scopeDefault");
    const boldText = (b: TerminalBold) => t(BOLD_LABEL[b]);
    const onOff = (v: boolean) => t(v ? "terminal.ligaturesOn" : "terminal.ligaturesOff");

    // 這台裝置這一格:覆寫裡認得的值才顯示,其餘「跟隨預設」。/ The device box shows recognised override values; the rest "follows default".
    const deviceValue: Record<FieldKey, React.ReactNode | null> = {
        font: isKnownFont(p?.font) ? terminalFont(p!.font).name : null,
        fontSize: typeof p?.font_size === "number" && p.font_size >= TERMINAL_FONT_SIZE_RANGE.min && p.font_size <= TERMINAL_FONT_SIZE_RANGE.max ? `${p.font_size}px` : null,
        scheme: isKnownScheme(p?.scheme, customSchemes) ? terminalScheme(p!.scheme, customSchemes).name : null,
        bold: isBoldStyle(p?.bold) ? boldText(p!.bold as TerminalBold) : null,
        ligatures: typeof p?.ligatures === "boolean" ? onOff(p.ligatures) : null,
    };
    const defaultValue: Record<FieldKey, React.ReactNode> = {
        font: terminalFont(defaults.font).name,
        fontSize: `${defaults.fontSize}px`,
        scheme: terminalScheme(defaults.scheme, customSchemes).name,
        bold: boldText(defaults.bold),
        ligatures: onOff(defaults.ligatures),
    };
    const resultValue: Record<FieldKey, React.ReactNode> = {
        font: e.font.value.name,
        fontSize: `${e.fontSize.value}px`,
        scheme: e.scheme.value.name,
        bold: boldText(e.bold.value),
        ligatures: onOff(e.ligatures.value),
    };
    const overridden = hasProfileOverride(profile);
    const ligaturesWanted = typeof p?.ligatures === "boolean" ? p.ligatures : defaults.ligatures;

    return (
        <div className="space-y-4">
            <ol className="flex flex-col sm:flex-row sm:items-stretch">
                <Box icon={UserRound} title={t("terminal.layerDefault")} sub={t("terminal.layerDefaultSub")}>
                    {FIELDS.map((k) => <Row key={k} label={t(FIELD_LABEL[k])} value={defaultValue[k]} />)}
                </Box>
                <Arrow label={t("terminal.layerArrowOverride")} />
                <Box icon={MonitorSmartphone} title={t("terminal.layerDevice")} sub={t("terminal.layerDeviceSub")} active={overridden}>
                    {FIELDS.map((k) => (
                        deviceValue[k] !== null
                            ? <Row key={k} label={t(FIELD_LABEL[k])} value={deviceValue[k]} tag={t("terminal.layerOverrides")} tone="primary" />
                            : <Row key={k} label={t(FIELD_LABEL[k])} value={t("terminal.layerFollows")} muted />
                    ))}
                </Box>
                <Arrow label={t("terminal.layerArrowResult")} />
                <Box icon={SquareTerminal} title={t("terminal.layerResult")} sub={t("terminal.layerResultSub")}>
                    {FIELDS.map((k) => <Row key={k} label={t(FIELD_LABEL[k])} value={resultValue[k]} tag={sourceName(e[k].from)} tone={e[k].from === "device" ? "primary" : "neutral"} />)}
                </Box>
            </ol>
            {!overridden && <p className="text-xs text-muted-foreground">{t("terminal.layerNoOverride")}</p>}
            {ligaturesWanted && !e.font.value.ligatures && (
                <Callout tone="info">{t("terminal.layerFontNoLigatures", { font: e.font.value.name })}</Callout>
            )}
        </div>
    );
}

export function AppearanceLayersDialog({ isOpen, onClose, defaults, profile, customSchemes }: {
    isOpen: boolean;
    onClose: () => void;
    defaults: TerminalDefaults;
    profile: TerminalProfile | null;
    customSchemes: TerminalScheme[];
}) {
    const { t } = useI18n();
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("terminal.layersTitle")}
            description={t("terminal.layersDescription")}
            icon={<Info />}
            size="3xl"
            footer={<Button type="button" onClick={onClose}>{t("common.close")}</Button>}
        >
            <AppearanceLayers defaults={defaults} profile={profile} customSchemes={customSchemes} />
        </Modal>
    );
}
