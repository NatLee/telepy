/**
 * 建立精靈各步驟共用的小元件：步驟標題、底部導覽、可複製的單行指令、分段切換、可展開區塊。
 * Small pieces shared by the wizard steps: step heading, footer navigation, copyable one-line command,
 * segmented toggle and a disclosure block.
 */
"use client";

import React, { useState } from "react";
import { Check, ChevronDown, ChevronLeft, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export function StepHeading({ title, subtitle }: { title: React.ReactNode; subtitle?: React.ReactNode }) {
    return (
        <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
            {subtitle && <p className="text-sm leading-relaxed text-muted-foreground">{subtitle}</p>}
        </div>
    );
}

export function StepFooter({ onBack, children }: { onBack?: () => void; children: React.ReactNode }) {
    const { t } = useI18n();
    return (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
            {onBack ? (
                <Button type="button" variant="ghost" onClick={onBack}>
                    <ChevronLeft /> {t("common.back")}
                </Button>
            ) : <span />}
            <div className="flex flex-wrap items-center gap-2">{children}</div>
        </div>
    );
}

/** 等寬字行內程式碼。/ Inline monospace code. */
export function Code({ children, className }: { children: React.ReactNode; className?: string }) {
    return <code className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground", className)}>{children}</code>;
}

export function useCopy(timeout = 1600) {
    const [copied, setCopied] = useState(false);
    const copy = (value: string) => {
        navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), timeout);
        }).catch(() => undefined);
    };
    return { copied, copy };
}

/** 單行指令 + 複製鈕（短指令用；長腳本用 CodeBlock）。/ One-line command with a copy button (short commands; long scripts use CodeBlock). */
export function CopyLine({ value, className }: { value: string; className?: string }) {
    const { t } = useI18n();
    const { copied, copy } = useCopy();
    return (
        <div className={cn("flex min-w-0 items-center gap-1 rounded-lg border border-border bg-background/70 py-1 pl-3 pr-1", className)}>
            <span className="select-none font-mono text-xs text-muted-foreground" aria-hidden>$</span>
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground [scrollbar-width:none]">{value}</code>
            <button
                type="button"
                onClick={() => copy(value)}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label={t("ui.copyToClipboard")}
            >
                {copied ? <Check size={13} className="text-primary" /> : <Copy size={13} />}
                <span className="hidden sm:inline">{copied ? t("common.copied") : t("common.copy")}</span>
            </button>
        </div>
    );
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
    value: T;
    options: { value: T; label: React.ReactNode }[];
    onChange: (v: T) => void;
    ariaLabel: string;
}) {
    return (
        <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5" role="group" aria-label={ariaLabel}>
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    aria-pressed={value === o.value}
                    onClick={() => onChange(o.value)}
                    className={cn(
                        "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium transition-colors",
                        value === o.value ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground"
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

/** 可展開的次要內容（完整腳本、SSH config…）。/ Collapsible secondary content (full script, SSH config…). */
export function Disclosure({ title, icon, onOpen, children, defaultOpen = false }: {
    title: React.ReactNode;
    icon?: React.ReactNode;
    onOpen?: () => void;
    children: React.ReactNode;
    defaultOpen?: boolean;
}) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className="rounded-xl border border-border bg-background/50">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => {
                    if (!open) onOpen?.();
                    setOpen((v) => !v);
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3.5 py-2.5 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
            >
                {icon && <span className="text-muted-foreground">{icon}</span>}
                <span className="flex-1">{title}</span>
                <ChevronDown size={16} className={cn("text-muted-foreground transition-transform", open && "rotate-180")} />
            </button>
            {open && <div className="border-t border-border p-3.5">{children}</div>}
        </div>
    );
}

/** 欄位下方的錯誤訊息。/ Field error text. */
export function FieldError({ children, id }: { children?: React.ReactNode; id?: string }) {
    if (!children) return null;
    return <p id={id} role="alert" className="text-xs text-destructive">{children}</p>;
}
