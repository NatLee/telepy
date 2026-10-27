"use client";

/**
 * 「這台電腦上有好幾台 Telepy？」：替這台 Telepy 的裝置別名加一個前綴（個人設定 `ssh_alias_prefix`，例如 `work-` →
 * `ssh work-pi`），兩台 Telepy 的同名裝置就能並存。安裝指令偵測到同名時會叫使用者來這裡設。設了前綴時預設展開。
 * "Several Telepy servers on this computer?": a prefix for this server's device aliases (personal setting
 * `ssh_alias_prefix`, e.g. `work-` → `ssh work-pi`) so two servers' devices of the same name can coexist. The install
 * command points here when it finds a clash. Opens by itself while a prefix is set.
 */
import React, { useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface AliasPrefixControl {
    value: string;
    /** 拿來示範的裝置名稱（不含前綴）。/ A device name for the preview (without the prefix). */
    example: string;
    /** 存起來；回錯誤訊息或 null。/ Save it; returns an error message or null. */
    onSave: (prefix: string) => Promise<string | null>;
}

/** 前端先擋一次（後端 `scripts::alias_prefix_problem` 同一條規則）。/ The same rule as the backend's check. */
export function prefixProblem(p: string): "chars" | "dash" | "long" | null {
    if (p.length > 24) return "long";
    if (!/^[A-Za-z0-9._-]*$/.test(p)) return "chars";
    if (p.startsWith("-")) return "dash";
    return null;
}

export function AliasPrefix({ control }: { control: AliasPrefixControl }) {
    const { t, tn } = useI18n();
    const [open, setOpen] = useState(control.value !== "");
    const [draft, setDraft] = useState(control.value);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const value = draft.trim();
    const problem = prefixProblem(value);
    const changed = value !== control.value;
    const code = (s: string) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground [overflow-wrap:anywhere]">{s}</code>;

    const save = async (next: string) => {
        setSaving(true);
        setError(await control.onSave(next));
        setSaving(false);
    };

    return (
        <div className="rounded-lg border border-border">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-foreground outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/60"
            >
                <ChevronDown size={15} className={cn("shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} aria-hidden />
                <span className="min-w-0 flex-1">{control.value ? tn("config.prefix.titleSet", { prefix: code(control.value) }) : t("config.prefix.title")}</span>
            </button>
            {open && (
                <div className="space-y-3 border-t border-border px-3 py-3 text-sm">
                    <p className="text-muted-foreground">{t("config.prefix.body")}</p>
                    <form
                        className="flex flex-wrap items-center gap-2"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (!problem && changed) save(value);
                        }}
                    >
                        <Input
                            value={draft}
                            onChange={(e) => {
                                setDraft(e.target.value);
                                setError(null);
                            }}
                            placeholder="work-"
                            aria-label={t("config.prefix.label")}
                            aria-invalid={!!problem || !!error}
                            maxLength={32}
                            className="h-8 w-40 font-mono"
                        />
                        <Button type="submit" size="sm" disabled={saving || !!problem || !changed}>
                            {saving && <Loader2 className="animate-spin" />}
                            {t("common.save")}
                        </Button>
                        {control.value && (
                            <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => { setDraft(""); save(""); }}>
                                {t("config.prefix.clear")}
                            </Button>
                        )}
                    </form>
                    {problem || error ? (
                        <p className="text-xs text-destructive">{error ?? (problem ? t(`config.prefix.err.${problem}`) : "")}</p>
                    ) : (
                        <p className="text-xs text-muted-foreground">{tn("config.prefix.preview", { cmd: code(`ssh ${value}${control.example}`) })}</p>
                    )}
                    <p className="text-xs text-muted-foreground">{t("config.prefix.note")}</p>
                </div>
            )}
        </div>
    );
}
