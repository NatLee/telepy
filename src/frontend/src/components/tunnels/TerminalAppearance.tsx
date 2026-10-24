"use client";

/**
 * 終端機外觀的 UI:預覽、字型 / 字級 / 配色選擇器,以及終端機頁的「外觀」對話框。
 * - 偏好設定 modal 用 TerminalPreview + TerminalAppearanceFields 改「我的預設」。
 * - 終端機頁的 TerminalAppearanceDialog 有兩個範圍:「這台裝置」(覆寫,每一項都可以選「我的預設」)
 *   與「我的預設」(所有終端機)。改了立即套用到開著的 shell。
 * - 字型卡片用介面字型顯示名稱,只有預覽用所選字型,打開對話框不會一次下載六套字型。
 * Terminal appearance UI: preview, font / size / colour-scheme pickers and the terminal page's
 * Appearance dialog. The preferences modal edits "My default" with the same fields; the dialog adds a
 * "This device" scope whose every field can follow the default. Font cards use the UI font so opening the
 * dialog doesn't download every font; only the preview renders the chosen one.
 */
import React, { useState } from "react";
import { ALargeSmall, Check, MonitorSmartphone, Palette, RotateCcw, Type, UserRound } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Segmented } from "@/components/ui/segmented";
import { Section } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
    ANSI_KEYS,
    isKnownFont,
    isKnownScheme,
    resolveTerminalAppearance,
    TERMINAL_FONT_SIZE_RANGE,
    TERMINAL_FONTS,
    TERMINAL_SCHEMES,
    terminalFont,
    terminalFontCss,
    terminalScheme,
    type ResolvedTerminalAppearance,
    type TerminalDefaults,
    type TerminalScheme,
} from "@/lib/terminalAppearance";
import type { TerminalAppearanceState } from "@/hooks/useTerminalAppearance";

// Nerd Font 圖示(預覽用):Linux、資料夾、git 分支、powerline 箭頭。/ Nerd Font glyphs used by the preview.
const ICON_LINUX = "";
const ICON_FOLDER = "";
const ICON_BRANCH = "";
const POWERLINE = "";

/** 假的終端機畫面:powerline 提示字元、ls、git status 與 16 色色票。/ A fake terminal screen with prompt, ls, git status and the 16 colours. */
export function TerminalPreview({ look, className }: { look: ResolvedTerminalAppearance; className?: string }) {
    const { t } = useI18n();
    const p = look.scheme.theme;
    // 預覽的字級跟著設定,但不超過 18px,免得窄的對話框裡一行放不下。/ Follows the size, capped so a line fits a narrow dialog.
    const size = Math.min(look.fontSize, 18);
    const seg = (bg: string, fg: string, text: string, next: string | null) => (
        <>
            <span style={{ background: bg, color: fg }}>{text}</span>
            <span style={{ color: bg, background: next ?? "transparent" }}>{POWERLINE}</span>
        </>
    );
    return (
        <figure className={cn("overflow-hidden rounded-xl border border-border", className)} aria-label={t("terminal.previewLabel")}>
            <div
                className="overflow-x-auto px-3.5 py-3 leading-[1.35] whitespace-pre"
                style={{ background: p.background, color: p.foreground, fontFamily: terminalFontCss(look.font), fontSize: `${size}px` }}
                aria-hidden
            >
                <div>
                    {seg(p.blue, p.background, ` ${ICON_LINUX} natlee@pi `, p.brightBlack)}
                    {seg(p.brightBlack, p.brightWhite, ` ${ICON_FOLDER} ~/telepy `, p.magenta)}
                    {seg(p.magenta, p.background, ` ${ICON_BRANCH} main `, null)}
                </div>
                <div><span style={{ color: p.green }}>❯</span> ls -l</div>
                <div><span style={{ color: p.brightBlack }}>drwxr-xr-x</span>  <span style={{ color: p.blue }}>bin/</span></div>
                <div><span style={{ color: p.brightBlack }}>-rwxr-xr-x</span>  <span style={{ color: p.green }}>deploy.sh</span></div>
                <div><span style={{ color: p.brightBlack }}>-rw-r--r--</span>  README.md</div>
                <div><span style={{ color: p.green }}>❯</span> git status -s</div>
                <div><span style={{ color: p.red }}> M</span> src/app.rs  <span style={{ color: p.green }}>A</span> <span style={{ color: p.yellow }}>notes.md</span></div>
                <div>
                    <span style={{ color: p.green }}>❯</span>{" "}
                    <span style={{ background: p.cursor, color: p.cursorAccent }}> </span>
                </div>
            </div>
            <div className="grid grid-cols-8 gap-px border-t border-border" style={{ background: p.background }} aria-hidden>
                {ANSI_KEYS.map((k) => <span key={k} className="h-3" style={{ background: p[k] }} />)}
            </div>
        </figure>
    );
}

/** 單選卡片(role=radio)。/ A radio card. */
function ChoiceCard({ checked, onSelect, className, children, label }: {
    checked: boolean;
    onSelect: () => void;
    className?: string;
    children: React.ReactNode;
    label: string;
}) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={label}
            onClick={onSelect}
            className={cn(
                "relative min-w-0 rounded-md border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                checked ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border bg-card hover:bg-muted",
                className,
            )}
        >
            {children}
            {checked && <Check className="absolute top-2 right-2 size-4 text-primary" aria-hidden />}
        </button>
    );
}

function FontPicker({ value, inherit, onChange }: { value: string | null; inherit?: string; onChange: (id: string | null) => void }) {
    const { t } = useI18n();
    const followsDefault = inherit !== undefined && value === null;
    return (
        <div role="radiogroup" aria-label={t("terminal.font")} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {inherit !== undefined && (
                <ChoiceCard checked={followsDefault} onSelect={() => onChange(null)} className="px-3 py-2.5 pr-8" label={t("terminal.myDefaultValue", { value: terminalFont(inherit).name })}>
                    <span className="block text-sm text-foreground">{t("terminal.useMyDefault")}</span>
                    <span className="block truncate text-xs text-muted-foreground">{terminalFont(inherit).name}</span>
                </ChoiceCard>
            )}
            {TERMINAL_FONTS.map((f) => (
                <ChoiceCard key={f.id} checked={!followsDefault && value === f.id} onSelect={() => onChange(f.id)} className="px-3 py-2.5 pr-8" label={f.name}>
                    <span className="block text-sm text-foreground">{f.name}</span>
                    {/* 說明可以換行:窄一點的對話框(偏好設定)裡截斷會切掉重點。/ Notes wrap; truncating cut them in the narrower preferences dialog. */}
                    <span className="block text-xs leading-snug text-muted-foreground">{t(f.note)}</span>
                </ChoiceCard>
            ))}
        </div>
    );
}

/** 配色縮圖:背景 + 一行提示字元 + 6 個主色點。/ Scheme thumbnail: background, a prompt line and six colour dots. */
function SchemeSwatch({ scheme }: { scheme: TerminalScheme }) {
    const p = scheme.theme;
    return (
        <span className="block rounded-sm px-2 py-1.5 font-mono text-xs leading-5" style={{ background: p.background, color: p.foreground }} aria-hidden>
            <span style={{ color: p.green }}>❯</span> ls <span style={{ color: p.blue }}>bin/</span>
            <span className="mt-1 flex gap-1">
                {(["red", "green", "yellow", "blue", "magenta", "cyan"] as const).map((k) => (
                    <span key={k} className="size-2.5 rounded-full" style={{ background: p[k] }} />
                ))}
            </span>
        </span>
    );
}

function SchemePicker({ value, inherit, onChange }: { value: string | null; inherit?: string; onChange: (id: string | null) => void }) {
    const { t } = useI18n();
    const followsDefault = inherit !== undefined && value === null;
    const card = (scheme: TerminalScheme, checked: boolean, onSelect: () => void, title: string, subtitle: string, key: string) => (
        <ChoiceCard key={key} checked={checked} onSelect={onSelect} className="p-1.5" label={title}>
            <SchemeSwatch scheme={scheme} />
            <span className="block truncate px-1 pt-1.5 pr-6 text-sm text-foreground">{title}</span>
            <span className="block truncate px-1 pb-0.5 text-xs text-muted-foreground">{subtitle}</span>
        </ChoiceCard>
    );
    return (
        <div role="radiogroup" aria-label={t("terminal.colorScheme")} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {inherit !== undefined && card(
                terminalScheme(inherit), followsDefault, () => onChange(null),
                t("terminal.useMyDefault"), terminalScheme(inherit).name, "__default",
            )}
            {TERMINAL_SCHEMES.map((s) => card(
                s, !followsDefault && value === s.id, () => onChange(s.id),
                s.name, t(s.kind === "dark" ? "terminal.schemeDark" : "terminal.schemeLight"), s.id,
            ))}
        </div>
    );
}

function FontSizeField({ value, inherit, onChange }: { value: number | null; inherit?: number; onChange: (size: number | null) => void }) {
    const { t } = useI18n();
    const followsDefault = inherit !== undefined && value === null;
    const shown = value ?? inherit ?? 14;
    return (
        <div className="space-y-2.5">
            {inherit !== undefined && (
                <Segmented
                    size="sm"
                    options={[
                        { value: "default", label: t("terminal.myDefaultValue", { value: `${inherit}px` }) },
                        { value: "custom", label: t("terminal.customSize") },
                    ]}
                    value={followsDefault ? "default" : "custom"}
                    onChange={(v) => onChange(v === "default" ? null : shown)}
                    aria-label={t("terminal.fontSize")}
                />
            )}
            {!followsDefault && (
                <div className="flex items-center gap-3 rounded-xl bg-surface px-3.5 py-3 ring-1 ring-inset ring-border/80">
                    <input
                        type="range"
                        min={TERMINAL_FONT_SIZE_RANGE.min}
                        max={TERMINAL_FONT_SIZE_RANGE.max}
                        value={shown}
                        onChange={(e) => onChange(parseInt(e.target.value, 10))}
                        className="min-w-0 flex-1 accent-primary"
                        aria-label={t("terminal.fontSize")}
                        aria-valuetext={`${shown}px`}
                    />
                    <span className="w-14 shrink-0 rounded-lg bg-muted py-1 text-center font-mono text-sm tabular-nums">{shown}px</span>
                </div>
            )}
        </div>
    );
}

export interface AppearanceValue {
    font: string | null;
    fontSize: number | null;
    scheme: string | null;
}

/**
 * 字型 / 字級 / 配色三個欄位。給了 inherit(個人預設)就多一個「我的預設」選項,值 null = 跟隨預設。
 * The three fields. With `inherit` (the personal default) each gets a "My default" choice; null follows it.
 */
export function TerminalAppearanceFields({ value, inherit, onChange }: {
    value: AppearanceValue;
    inherit?: TerminalDefaults;
    onChange: (patch: Partial<AppearanceValue>) => void;
}) {
    const { t } = useI18n();
    return (
        <div className="space-y-6">
            <Section icon={<Type />} title={t("terminal.font")} description={t("terminal.fontHint")} as="h4">
                <FontPicker value={value.font} inherit={inherit?.font} onChange={(font) => onChange({ font })} />
            </Section>
            <Section icon={<ALargeSmall />} title={t("terminal.fontSize")} as="h4">
                <FontSizeField value={value.fontSize} inherit={inherit?.fontSize} onChange={(fontSize) => onChange({ fontSize })} />
            </Section>
            <Section icon={<Palette />} title={t("terminal.colorScheme")} as="h4">
                <SchemePicker value={value.scheme} inherit={inherit?.scheme} onChange={(scheme) => onChange({ scheme })} />
            </Section>
        </div>
    );
}

type Scope = "device" | "default";

/** 終端機頁的「外觀」對話框。/ The terminal page's Appearance dialog. */
export function TerminalAppearanceDialog({ isOpen, onClose, appearance }: {
    isOpen: boolean;
    onClose: () => void;
    appearance: TerminalAppearanceState;
}) {
    const { t } = useI18n();
    const [scope, setScope] = useState<Scope>("device");
    const { defaults, setDefaults, profile, setProfile, resetProfile, customized, saveError } = appearance;

    // 覆寫裡不認得的 id(例如拿掉的字型)在選擇器上視同「我的預設」。/ Unknown override ids show as "My default".
    const deviceValue: AppearanceValue = {
        font: isKnownFont(profile?.font) ? profile!.font : null,
        fontSize: profile?.font_size ?? null,
        scheme: isKnownScheme(profile?.scheme) ? profile!.scheme : null,
    };
    const look = scope === "device" ? appearance.resolved : resolveTerminalAppearance(defaults, null);

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("terminal.appearanceTitle")}
            description={t("terminal.appearanceDescription")}
            icon={<Palette />}
            size="2xl"
            toolbar={
                <Segmented<Scope>
                    kind="tabs"
                    fullWidth
                    options={[
                        { value: "device", label: t("terminal.scopeDevice"), icon: <MonitorSmartphone size={15} /> },
                        { value: "default", label: t("terminal.scopeDefault"), icon: <UserRound size={15} /> },
                    ]}
                    value={scope}
                    onChange={setScope}
                    aria-label={t("terminal.appearanceTitle")}
                />
            }
            footer={
                <>
                    {scope === "device" && customized && (
                        <Button type="button" variant="ghost" className="mr-auto" onClick={resetProfile}>
                            <RotateCcw /> {t("terminal.resetDevice")}
                        </Button>
                    )}
                    <Button type="button" variant="outline" onClick={onClose}>{t("common.close")}</Button>
                </>
            }
        >
            <div className="space-y-6">
                <p className="text-sm leading-relaxed text-muted-foreground">
                    {t(scope === "device" ? "terminal.scopeDeviceHint" : "terminal.scopeDefaultHint")}
                </p>
                {saveError && scope === "device" && <Callout tone="danger">{t("terminal.appearanceSaveFailed")}</Callout>}
                <TerminalPreview look={look} />
                {scope === "device" ? (
                    <TerminalAppearanceFields
                        value={deviceValue}
                        inherit={defaults}
                        onChange={(patch) => setProfile({
                            ...(patch.font !== undefined ? { font: patch.font } : {}),
                            ...(patch.fontSize !== undefined ? { font_size: patch.fontSize } : {}),
                            ...(patch.scheme !== undefined ? { scheme: patch.scheme } : {}),
                        })}
                    />
                ) : (
                    <TerminalAppearanceFields
                        value={defaults}
                        onChange={(patch) => setDefaults({
                            ...(patch.font ? { font: patch.font } : {}),
                            ...(patch.fontSize ? { fontSize: patch.fontSize } : {}),
                            ...(patch.scheme ? { scheme: patch.scheme } : {}),
                        })}
                    />
                )}
            </div>
        </Modal>
    );
}
