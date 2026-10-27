"use client";

/**
 * 自訂終端機配色的編輯對話框:名稱、「從目前的配色開始」、匯入(Windows Terminal JSON / base16 YAML,即時辨識)、
 * 前景 / 背景 / 游標 / 選取 + 16 格 ANSI 色票(兩欄 / 四欄)(原生 <input type=color>),以及即時預覽。新增與編輯共用。
 * The custom-scheme editor: name, "start from the current scheme", import (Windows Terminal JSON / base16 YAML
 * with live detection), text / background / cursor / selection + the 16 ANSI swatches (2 / 4 columns) (native colour inputs) and a
 * live preview. Shared by create and edit.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Palette } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Section } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { ANSI_KEYS, type ResolvedTerminalAppearance, type TerminalPalette, type TerminalScheme } from "@/lib/terminalAppearance";
import {
    BASE_COLOR_KEYS,
    colorsFromScheme,
    customToScheme,
    OPTIONAL_COLOR_KEYS,
    parseSchemeImport,
    SCHEME_NAME_MAX,
    validateColors,
    type CustomScheme,
    type SchemeColors,
} from "@/lib/terminalSchemes";
import { TerminalPreview } from "./TerminalAppearance";

type ColorKey = keyof SchemeColors;

const COLOR_LABEL: Record<ColorKey, TranslationKey> = {
    foreground: "terminal.color.foreground",
    background: "terminal.color.background",
    cursor: "terminal.color.cursor",
    cursorAccent: "terminal.color.cursorAccent",
    selectionBackground: "terminal.color.selectionBackground",
    selectionForeground: "terminal.color.selectionForeground",
    black: "terminal.color.black",
    red: "terminal.color.red",
    green: "terminal.color.green",
    yellow: "terminal.color.yellow",
    blue: "terminal.color.blue",
    magenta: "terminal.color.magenta",
    cyan: "terminal.color.cyan",
    white: "terminal.color.white",
    brightBlack: "terminal.color.brightBlack",
    brightRed: "terminal.color.brightRed",
    brightGreen: "terminal.color.brightGreen",
    brightYellow: "terminal.color.brightYellow",
    brightBlue: "terminal.color.brightBlue",
    brightMagenta: "terminal.color.brightMagenta",
    brightCyan: "terminal.color.brightCyan",
    brightWhite: "terminal.color.brightWhite",
};

/** 色票 + 名稱 + 十六進位值;原生 color input 負責選色。/ Swatch + label + hex; the native colour input picks. */
function ColorSwatch({ k, value, onChange, compact }: { k: ColorKey; value: string; onChange: (v: string) => void; compact?: boolean }) {
    const { t } = useI18n();
    const id = `scheme-color-${k}`;
    return (
        <label htmlFor={id} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 hover:bg-muted">
            <span className="relative size-7 shrink-0 overflow-hidden rounded-sm ring-1 ring-inset ring-black/15" style={{ background: value || "transparent" }}>
                <input
                    id={id}
                    type="color"
                    value={value || "#000000"}
                    onChange={(e) => onChange(e.target.value)}
                    className="absolute inset-0 size-full cursor-pointer opacity-0"
                    aria-label={t(COLOR_LABEL[k])}
                />
            </span>
            <span className="min-w-0 flex-1">
                {/* 名稱可換行、不截斷;色碼截斷,窄格也不會撐出格子。/ The name wraps, the hex truncates, so a narrow cell never overflows. */}
                <span className={compact ? "block break-words text-xs leading-tight text-foreground" : "block truncate text-sm text-foreground"}>{t(COLOR_LABEL[k])}</span>
                <span className="block truncate font-mono text-xs tabular-nums text-muted-foreground">{value || "—"}</span>
            </span>
        </label>
    );
}

export interface SchemeEditorProps {
    isOpen: boolean;
    onClose: () => void;
    /** 編輯的配色;undefined = 新增。/ The scheme being edited; undefined = create. */
    editing?: CustomScheme;
    /** 「從目前的配色開始」的來源(終端機正在用的)。/ The current scheme, as the starting point. */
    current: TerminalScheme;
    look: ResolvedTerminalAppearance;
    onSave: (name: string, colors: SchemeColors) => Promise<void>;
}

export function SchemeEditorDialog({ isOpen, onClose, editing, current, look, onSave }: SchemeEditorProps) {
    const { t } = useI18n();
    const [name, setName] = useState("");
    const [colors, setColors] = useState<SchemeColors>(() => colorsFromScheme(current));
    const [importText, setImportText] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [nameError, setNameError] = useState(false);

    // 每次打開重設:編輯 = 那個配色,新增 = 目前的配色。/ Reset on open: the edited scheme, or the current one.
    useEffect(() => {
        if (!isOpen) return;
        setName(editing?.name ?? "");
        setColors(editing ? { ...editing.colors } : colorsFromScheme(current));
        setImportText("");
        setError(null);
        setNameError(false);
        setSaving(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, editing?.id]);

    const detected = useMemo(() => (importText.trim() ? parseSchemeImport(importText) : null), [importText]);
    const formatName = (f: "windows-terminal" | "base16" | null) => (f === "base16" ? t("terminal.schemeFormatBase16") : f === "windows-terminal" ? t("terminal.schemeFormatWt") : "");

    const previewLook = useMemo<ResolvedTerminalAppearance>(() => {
        const check = validateColors(colors);
        const theme: TerminalPalette = check.ok ? customToScheme({ id: "preview", name: name || "preview", colors: check.colors }).theme : look.scheme.theme;
        return { ...look, scheme: { id: "preview", name: name || "", kind: look.scheme.kind, theme } };
    }, [colors, look, name]);

    const set = (k: ColorKey) => (v: string) => setColors((c) => ({ ...c, [k]: v }));
    const applyImport = () => {
        if (!detected?.ok) return;
        setColors(detected.colors);
        if (!name && detected.name) setName(detected.name);
        setImportText("");
    };

    const save = async () => {
        const trimmed = name.trim();
        if (!trimmed) { setNameError(true); return; }
        const check = validateColors(colors);
        if (!check.ok) { setError(t("terminal.schemeIncompleteColors")); return; }
        setSaving(true);
        setError(null);
        try {
            await onSave(trimmed.slice(0, SCHEME_NAME_MAX), check.colors);
            onClose();
        } catch (e) {
            setError(t("terminal.schemeSaveFailed", { error: e instanceof Error ? e.message : String(e) }));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t(editing ? "terminal.schemeEditorEdit" : "terminal.schemeEditorTitle")}
            description={t("terminal.schemeEditorDescription")}
            icon={<Palette />}
            size="2xl"
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
                    <Button type="button" onClick={() => void save()} disabled={saving}>{t(saving ? "terminal.schemeSaving" : "terminal.schemeSave")}</Button>
                </>
            }
        >
            <div className="space-y-6">
                {error && <Callout tone="danger">{error}</Callout>}
                <TerminalPreview look={previewLook} />
                <Field label={t("terminal.schemeName")} required error={nameError ? t("terminal.schemeNameRequired") : undefined}>
                    <Input
                        value={name}
                        maxLength={SCHEME_NAME_MAX}
                        placeholder={t("terminal.schemeNamePlaceholder")}
                        onChange={(e) => { setName(e.target.value); setNameError(false); }}
                    />
                </Field>

                <Section title={t("terminal.schemeImport")} description={t("terminal.schemeImportHint")} as="h4">
                    <Field
                        label={t("terminal.schemeImportLabel")}
                        hint={detected?.ok
                            ? (detected.name ? t("terminal.schemeImportDetected", { format: formatName(detected.format), name: detected.name }) : t("terminal.schemeImportDetectedNoName", { format: formatName(detected.format) }))
                            : undefined}
                        error={detected && !detected.ok && detected.reason !== "empty"
                            ? (detected.reason === "incomplete"
                                ? t("terminal.schemeImportIncomplete", { format: formatName(detected.format), missing: (detected.missing ?? []).join(", ") })
                                : t("terminal.schemeImportUnrecognised"))
                            : undefined}
                    >
                        <Textarea
                            value={importText}
                            onChange={(e) => setImportText(e.target.value)}
                            rows={4}
                            spellCheck={false}
                            className="font-mono text-xs"
                            placeholder={'{ "name": "Campbell", "background": "#0C0C0C", … }\nbase00: "#181818"\nbase01: "#282828"\n…'}
                        />
                    </Field>
                    {detected?.ok && (
                        <Button type="button" variant="outline" size="sm" onClick={applyImport}>{t("terminal.schemeImportApply")}</Button>
                    )}
                </Section>

                <Section title={t("terminal.schemeColorsBase")} as="h4">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {BASE_COLOR_KEYS.map((k) => <ColorSwatch key={k} k={k} value={colors[k]} onChange={set(k)} />)}
                        {OPTIONAL_COLOR_KEYS.map((k) => <ColorSwatch key={k} k={k} value={colors[k] ?? ""} onChange={set(k)} />)}
                    </div>
                </Section>

                <Section title={t("terminal.schemeColorsAnsi")} description={t("terminal.schemeColorsAnsiHint")} as="h4">
                    {/* 最多四欄:八欄在 2xl 對話框裡每格只剩約 70px,色碼與「明るいマゼンタ」都塞不下。
                        At most four columns: eight left ~70px per cell in the 2xl dialog, too narrow for the hex and the longer names. */}
                    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                        {ANSI_KEYS.map((k) => <ColorSwatch key={k} k={k} value={colors[k]} onChange={set(k)} compact />)}
                    </div>
                </Section>
            </div>
        </Modal>
    );
}
