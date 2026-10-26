"use client";

/**
 * 終端機外觀的 UI:預覽、字型 / 字級 / 配色 / 粗體 / 連字選擇器,以及終端機頁的「外觀」對話框。
 * - 偏好設定 modal 用 TerminalPreview + TerminalAppearanceFields 改「我的預設」。
 * - 終端機頁的 TerminalAppearanceDialog 有兩個範圍:「這台裝置」(覆寫,每一項都可以選「我的預設」)
 *   與「我的預設」(所有終端機)。改了立即套用到開著的 shell。info 按鈕打開 AppearanceLayers(兩層怎麼合成)。
 * - 配色選擇器多一組「自訂」:使用者自己的配色(hooks/useTerminalSchemes),新增 / 編輯用 SchemeEditorDialog。
 * - 字型卡片用介面字型顯示名稱,只有預覽用所選字型,打開對話框不會一次下載六套字型。
 * Terminal appearance UI: preview, font / size / scheme / bold / ligature pickers and the terminal page's
 * Appearance dialog. The preferences modal edits "My default" with the same fields; the dialog adds a
 * "This device" scope whose every field can follow the default, and an info button opening AppearanceLayers.
 * The scheme picker has a "Custom" group (the user's own schemes, hooks/useTerminalSchemes) edited with
 * SchemeEditorDialog. Font cards use the UI font so opening the dialog doesn't download every font.
 */
import React, { useState } from "react";
import { ALargeSmall, Bold, Check, Info, Ligature, MonitorSmartphone, Palette, Pencil, Plus, RotateCcw, Trash2, Type, UserRound } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Section } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import {
    ANSI_KEYS,
    BOLD_STYLES,
    isBoldStyle,
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
    type TerminalBold,
    type TerminalDefaults,
    type TerminalScheme,
} from "@/lib/terminalAppearance";
import { ligatureFeatureSettings } from "@/lib/ligatures";
import { MAX_CUSTOM_SCHEMES, type CustomScheme, type SchemeColors } from "@/lib/terminalSchemes";
import type { TerminalAppearanceState } from "@/hooks/useTerminalAppearance";
import { useTerminalSchemes } from "@/hooks/useTerminalSchemes";
import { SchemeEditorDialog } from "./SchemeEditorDialog";
import { AppearanceLayersDialog } from "./AppearanceLayers";

const BOLD_LABEL: Record<TerminalBold, TranslationKey> = { face: "terminal.boldFace", bright: "terminal.boldBright", both: "terminal.boldBoth" };
const BOLD_NOTE: Record<TerminalBold, TranslationKey> = { face: "terminal.boldFaceNote", bright: "terminal.boldBrightNote", both: "terminal.boldBothNote" };

// Nerd Font 圖示(預覽用):Linux、資料夾、git 分支、powerline 箭頭。/ Nerd Font glyphs used by the preview.
const ICON_LINUX = "";
const ICON_FOLDER = "";
const ICON_BRANCH = "";
const POWERLINE = "";

/**
 * 假的終端機畫面:powerline 提示字元、ls、git status、一行粗體 / 斜體 / 連字樣本與 16 色色票。
 * 粗體照設定畫(真實字體 → font-weight 700;亮色 → 亮色;both → 兩者),連字由 font-feature-settings 開關。
 * A fake terminal screen with prompt, ls, git status, a bold / italic / ligature sample line and the 16 colours.
 * Bold follows the setting (face → weight 700; bright → the bright colour; both), ligatures via font-feature-settings.
 */
export function TerminalPreview({ look, className }: { look: ResolvedTerminalAppearance; className?: string }) {
    const { t } = useI18n();
    const p = look.scheme.theme;
    const boldWeight = look.bold === "bright" ? 400 : 700;
    const boldColor = (normal: string, bright: string) => (look.bold === "face" ? normal : bright);
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
                style={{ background: p.background, color: p.foreground, fontFamily: terminalFontCss(look.font), fontSize: `${size}px`, fontFeatureSettings: ligatureFeatureSettings(look.ligatures) }}
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
                <div><span style={{ color: p.green }}>❯</span> make test</div>
                <div>
                    <span style={{ fontWeight: boldWeight, color: boldColor(p.foreground, p.brightWhite) }}>{t("terminal.previewBoldWord")}</span>
                    {" "}<span style={{ fontWeight: boldWeight, color: boldColor(p.green, p.brightGreen) }}>{t("terminal.previewBoldOk")}</span>
                    {"  "}<span style={{ fontStyle: "italic", color: p.brightBlack }}>{t("terminal.previewItalic")}</span>
                    {"  "}<span style={{ color: p.cyan }}>{"a -> b != c :: d => e"}</span>
                </div>
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

/**
 * 配色選擇器:內建一組 + 「自訂」一組(使用者自己的,加「新增配色…」;每張自訂卡片有編輯 / 刪除)。
 * The scheme picker: built-ins plus a "Custom" group (the user's own, with "New scheme…"; custom cards get edit / delete).
 */
function SchemePicker({ value, inherit, custom, onChange, onNew, onEdit, onDelete }: {
    value: string | null;
    inherit?: string;
    custom: TerminalScheme[];
    onChange: (id: string | null) => void;
    onNew: () => void;
    onEdit: (id: string) => void;
    onDelete: (id: string) => void;
}) {
    const { t } = useI18n();
    const followsDefault = inherit !== undefined && value === null;
    const card = (scheme: TerminalScheme, checked: boolean, onSelect: () => void, title: string, subtitle: string, key: string) => (
        <ChoiceCard key={key} checked={checked} onSelect={onSelect} className="p-1.5" label={title}>
            <SchemeSwatch scheme={scheme} />
            <span className="block truncate px-1 pt-1.5 pr-6 text-sm text-foreground">{title}</span>
            <span className="block truncate px-1 pb-0.5 text-xs text-muted-foreground">{subtitle}</span>
        </ChoiceCard>
    );
    const kindText = (s: TerminalScheme) => t(s.kind === "dark" ? "terminal.schemeDark" : "terminal.schemeLight");
    const atLimit = custom.length >= MAX_CUSTOM_SCHEMES;
    return (
        <div className="space-y-3">
            <div role="radiogroup" aria-label={t("terminal.colorScheme")} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {inherit !== undefined && card(
                    terminalScheme(inherit, custom), followsDefault, () => onChange(null),
                    t("terminal.useMyDefault"), terminalScheme(inherit, custom).name, "__default",
                )}
                {TERMINAL_SCHEMES.map((s) => card(s, !followsDefault && value === s.id, () => onChange(s.id), s.name, kindText(s), s.id))}
            </div>
            <div>
                <p className="mb-2 text-xs text-muted-foreground">{t("terminal.schemeCustom")} · {custom.length}/{MAX_CUSTOM_SCHEMES}</p>
                <div role="radiogroup" aria-label={t("terminal.schemeCustom")} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {custom.map((s) => (
                        // 編輯 / 刪除不能放在 radio 按鈕裡(按鈕不能巢狀),所以疊在卡片右下角。/ Edit / delete sit over the card's corner (no nested buttons).
                        <div key={s.id} className="relative">
                            {card(s, !followsDefault && value === s.id, () => onChange(s.id), s.name, kindText(s), s.id)}
                            <span className="absolute right-1 bottom-1 flex gap-0.5">
                                <button type="button" onClick={() => onEdit(s.id)} className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`${t("common.edit")} ${s.name}`} title={t("common.edit")}>
                                    <Pencil size={13} />
                                </button>
                                <button type="button" onClick={() => onDelete(s.id)} className="rounded-sm p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={`${t("common.delete")} ${s.name}`} title={t("common.delete")}>
                                    <Trash2 size={13} />
                                </button>
                            </span>
                        </div>
                    ))}
                    <button
                        type="button"
                        onClick={onNew}
                        disabled={atLimit}
                        title={atLimit ? t("terminal.schemeLimit", { max: MAX_CUSTOM_SCHEMES }) : undefined}
                        className="flex min-h-[4.5rem] flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border bg-card px-2 py-3 text-sm text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                        <Plus size={16} aria-hidden />
                        {t("terminal.newScheme")}
                    </button>
                </div>
                {custom.length === 0 && <p className="mt-2 text-xs text-muted-foreground">{t("terminal.schemeCustomEmpty")}</p>}
            </div>
        </div>
    );
}

function BoldField({ value, inherit, onChange }: { value: TerminalBold | null; inherit?: TerminalBold; onChange: (bold: TerminalBold | null) => void }) {
    const { t } = useI18n();
    const followsDefault = inherit !== undefined && value === null;
    const shown = value ?? inherit ?? "face";
    return (
        <div className="space-y-2.5">
            {inherit !== undefined && (
                <Segmented
                    size="sm"
                    options={[
                        { value: "default", label: t("terminal.myDefaultValue", { value: t(BOLD_LABEL[inherit]) }) },
                        { value: "custom", label: t("terminal.customSize") },
                    ]}
                    value={followsDefault ? "default" : "custom"}
                    onChange={(v) => onChange(v === "default" ? null : shown)}
                    aria-label={t("terminal.bold")}
                />
            )}
            {!followsDefault && (
                <>
                    <Segmented<TerminalBold>
                        fullWidth
                        options={BOLD_STYLES.map((b) => ({ value: b, label: t(BOLD_LABEL[b]) }))}
                        value={shown}
                        onChange={(b) => onChange(b)}
                        aria-label={t("terminal.bold")}
                    />
                    <p className="text-xs text-muted-foreground">{t(BOLD_NOTE[shown])}</p>
                </>
            )}
        </div>
    );
}

function LigaturesField({ value, inherit, font, onChange }: { value: boolean | null; inherit?: boolean; font: string; onChange: (on: boolean | null) => void }) {
    const { t } = useI18n();
    const followsDefault = inherit !== undefined && value === null;
    const shown = value ?? inherit ?? false;
    const f = terminalFont(font);
    return (
        <div className="space-y-2.5">
            {inherit !== undefined && (
                <Segmented
                    size="sm"
                    options={[
                        { value: "default", label: t("terminal.myDefaultValue", { value: t(inherit ? "terminal.ligaturesOn" : "terminal.ligaturesOff") }) },
                        { value: "custom", label: t("terminal.customSize") },
                    ]}
                    value={followsDefault ? "default" : "custom"}
                    onChange={(v) => onChange(v === "default" ? null : shown)}
                    aria-label={t("terminal.ligatures")}
                />
            )}
            {!followsDefault && (
                <Switch checked={shown} onCheckedChange={(on) => onChange(on)} size="sm" aria-label={t("terminal.ligatures")}>
                    {t(shown ? "terminal.ligaturesOn" : "terminal.ligaturesOff")}
                </Switch>
            )}
            {!f.ligatures && <p className="text-xs text-muted-foreground">{t("terminal.ligaturesUnavailable", { font: f.name })}</p>}
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
    bold: TerminalBold | null;
    ligatures: boolean | null;
}

/**
 * 字型 / 字級 / 配色 / 粗體 / 連字五個欄位。給了 inherit(個人預設)就多一個「我的預設」選項,值 null = 跟隨預設。
 * 自訂配色的新增 / 編輯 / 刪除在這裡處理(useTerminalSchemes);存好的新配色直接選上。
 * The five fields. With `inherit` (the personal default) each gets a "My default" choice; null follows it.
 * Custom-scheme create / edit / delete live here (useTerminalSchemes); a freshly saved scheme is selected at once.
 */
export function TerminalAppearanceFields({ value, inherit, look, onChange }: {
    value: AppearanceValue;
    inherit?: TerminalDefaults;
    /** 預覽 / 編輯器的起點(目前實際的外觀)。/ The current look, for the editor's starting point. */
    look: ResolvedTerminalAppearance;
    onChange: (patch: Partial<AppearanceValue>) => void;
}) {
    const { t } = useI18n();
    const schemes = useTerminalSchemes();
    const [editor, setEditor] = useState<{ open: boolean; editing?: CustomScheme }>({ open: false });
    const [deleting, setDeleting] = useState<CustomScheme | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const effectiveFont = value.font ?? inherit?.font ?? look.font.id;

    const save = async (name: string, colors: SchemeColors) => {
        if (editor.editing) {
            await schemes.update(editor.editing.id, { name, colors });
        } else {
            const made = await schemes.create(name, colors);
            onChange({ scheme: made.id });
        }
    };
    const confirmDelete = async () => {
        if (!deleting) return;
        try {
            await schemes.remove(deleting.id);
            if (value.scheme === deleting.id) onChange({ scheme: inherit ? null : TERMINAL_SCHEMES[0].id });
            setDeleteError(null);
        } catch (e) {
            setDeleteError(e instanceof Error ? e.message : String(e));
        } finally {
            setDeleting(null);
        }
    };

    return (
        <div className="space-y-6">
            <Section icon={<Type />} title={t("terminal.font")} description={t("terminal.fontHint")} as="h4">
                <FontPicker value={value.font} inherit={inherit?.font} onChange={(font) => onChange({ font })} />
            </Section>
            <Section icon={<ALargeSmall />} title={t("terminal.fontSize")} as="h4">
                <FontSizeField value={value.fontSize} inherit={inherit?.fontSize} onChange={(fontSize) => onChange({ fontSize })} />
            </Section>
            <Section icon={<Palette />} title={t("terminal.colorScheme")} as="h4">
                {deleteError && <Callout tone="danger">{deleteError}</Callout>}
                <SchemePicker
                    value={value.scheme}
                    inherit={inherit?.scheme}
                    custom={schemes.schemes}
                    onChange={(scheme) => onChange({ scheme })}
                    onNew={() => setEditor({ open: true })}
                    onEdit={(id) => setEditor({ open: true, editing: schemes.customs.find((c) => c.id === id) })}
                    onDelete={(id) => setDeleting(schemes.customs.find((c) => c.id === id) ?? null)}
                />
            </Section>
            <Section icon={<Bold />} title={t("terminal.bold")} description={t("terminal.boldHint")} as="h4">
                <BoldField value={value.bold} inherit={inherit?.bold} onChange={(bold) => onChange({ bold })} />
            </Section>
            <Section icon={<Ligature />} title={t("terminal.ligatures")} description={t("terminal.ligaturesHint")} as="h4">
                <LigaturesField value={value.ligatures} inherit={inherit?.ligatures} font={effectiveFont} onChange={(ligatures) => onChange({ ligatures })} />
            </Section>
            <SchemeEditorDialog
                isOpen={editor.open}
                onClose={() => setEditor({ open: false })}
                editing={editor.editing}
                current={look.scheme}
                look={look}
                onSave={save}
            />
            <ConfirmDialog
                isOpen={deleting !== null}
                onClose={() => setDeleting(null)}
                onConfirm={() => void confirmDelete()}
                title={t("terminal.deleteSchemeTitle")}
                message={t("terminal.deleteSchemeMessage", { name: deleting?.name ?? "" })}
                confirmText={t("common.delete")}
                isDestructive
            />
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
    const [layersOpen, setLayersOpen] = useState(false);
    const { defaults, setDefaults, profile, setProfile, resetProfile, customized, saveError, customSchemes } = appearance;

    // 覆寫裡不認得的 id(例如拿掉的字型、刪掉的自訂配色)在選擇器上視同「我的預設」。/ Unknown override ids show as "My default".
    const deviceValue: AppearanceValue = {
        font: isKnownFont(profile?.font) ? profile!.font : null,
        fontSize: profile?.font_size ?? null,
        scheme: isKnownScheme(profile?.scheme, customSchemes) ? profile!.scheme : null,
        bold: isBoldStyle(profile?.bold) ? profile!.bold : null,
        ligatures: profile?.ligatures ?? null,
    };
    const look = scope === "device" ? appearance.resolved : resolveTerminalAppearance(defaults, null, customSchemes);

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("terminal.appearanceTitle")}
            description={t("terminal.appearanceDescription")}
            icon={<Palette />}
            size="2xl"
            toolbar={
                <div className="flex items-center gap-2">
                    <Segmented<Scope>
                        kind="tabs"
                        fullWidth
                        className="min-w-0 flex-1"
                        options={[
                            { value: "device", label: t("terminal.scopeDevice"), icon: <MonitorSmartphone size={15} /> },
                            { value: "default", label: t("terminal.scopeDefault"), icon: <UserRound size={15} /> },
                        ]}
                        value={scope}
                        onChange={setScope}
                        aria-label={t("terminal.appearanceTitle")}
                    />
                    {/* info:兩層怎麼合成成這個終端機的外觀。/ Info: how the two layers make this terminal's look. */}
                    <Button type="button" variant="ghost" size="icon" onClick={() => setLayersOpen(true)} aria-label={t("terminal.layersButton")} title={t("terminal.layersButton")}>
                        <Info size={18} />
                    </Button>
                </div>
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
                        look={look}
                        onChange={(patch) => setProfile({
                            ...(patch.font !== undefined ? { font: patch.font } : {}),
                            ...(patch.fontSize !== undefined ? { font_size: patch.fontSize } : {}),
                            ...(patch.scheme !== undefined ? { scheme: patch.scheme } : {}),
                            ...(patch.bold !== undefined ? { bold: patch.bold } : {}),
                            ...(patch.ligatures !== undefined ? { ligatures: patch.ligatures } : {}),
                        })}
                    />
                ) : (
                    <TerminalAppearanceFields
                        value={defaults}
                        look={look}
                        onChange={(patch) => setDefaults(defaultsPatch(patch))}
                    />
                )}
            </div>
            <AppearanceLayersDialog isOpen={layersOpen} onClose={() => setLayersOpen(false)} defaults={defaults} profile={profile} customSchemes={customSchemes} />
        </Modal>
    );
}

/** 「我的預設」的 patch:null 不算(預設永遠有值)。/ A patch for "My default": nulls are ignored (defaults are always set). */
export function defaultsPatch(patch: Partial<AppearanceValue>): Partial<TerminalDefaults> {
    return {
        ...(patch.font ? { font: patch.font } : {}),
        ...(patch.fontSize ? { fontSize: patch.fontSize } : {}),
        ...(patch.scheme ? { scheme: patch.scheme } : {}),
        ...(patch.bold ? { bold: patch.bold } : {}),
        ...(typeof patch.ligatures === "boolean" ? { ligatures: patch.ligatures } : {}),
    };
}
