"use client";

/**
 * 一個 webhook 最近的送出：成功 / 失敗 / 跳過、HTTP 狀態、試了幾次、花多久、錯誤，點開看送出的內容（可複製）。
 * A webhook's recent deliveries: ok / failed / skipped, HTTP status, attempts, time taken and the error; expand a
 * row to see (and copy) what was sent.
 */
import React, { useCallback, useEffect, useState } from "react";
import { ChevronDown, History, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Modal } from "@/components/ui/Modal";
import { Chip } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import { prettyBody } from "@/lib/webhooks";
import type { TranslationKey } from "@/locales/en";
import type { Webhook, WebhookDelivery } from "@/types/webhooks";
import { useEventLabel } from "./parts";

const DOT: Record<WebhookDelivery["status"], string> = { ok: "bg-success", failed: "bg-destructive", skipped: "bg-warning" };
const STATUS_KEY: Record<WebhookDelivery["status"], TranslationKey> = {
    ok: "webhooks.deliveries.status.ok",
    failed: "webhooks.deliveries.status.failed",
    skipped: "webhooks.deliveries.status.skipped",
};

interface Props {
    hook: Webhook | null;
    onClose: () => void;
    load: (id: number) => Promise<WebhookDelivery[] | null>;
    onTest: (h: Webhook) => Promise<unknown>;
}

export function DeliveriesDialog({ hook, onClose, load, onTest }: Props) {
    return hook ? <Deliveries key={hook.id} hook={hook} onClose={onClose} load={load} onTest={onTest} /> : null;
}

function Deliveries({ hook, onClose, load, onTest }: Props & { hook: Webhook }) {
    const { t, locale } = useI18n();
    const eventLabel = useEventLabel();
    const [rows, setRows] = useState<WebhookDelivery[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [open, setOpen] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async () => {
        const r = await load(hook.id);
        setFailed(r === null);
        if (r) setRows(r);
    }, [hook.id, load]);

    useEffect(() => {
        const first = setTimeout(() => void refresh(), 0);
        return () => clearTimeout(first);
    }, [refresh]);

    const test = async () => {
        setBusy(true);
        await onTest(hook);
        await refresh();
        setBusy(false);
    };

    return (
        <Modal
            isOpen
            onClose={onClose}
            size="3xl"
            icon={<History />}
            title={t("webhooks.card.deliveries")}
            description={t("webhooks.deliveries.description", { name: hook.name })}
            toolbar={
                <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => void test()} disabled={busy}>
                        <Send size={15} /> {busy ? t("webhooks.card.testing") : t("webhooks.card.test")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void refresh()}>
                        <RefreshCw size={15} /> {t("common.refresh")}
                    </Button>
                </div>
            }
            footer={
                <Button variant="outline" onClick={onClose}>
                    {t("common.close")}
                </Button>
            }
        >
            {failed && !rows ? (
                <p className="text-sm text-destructive">{t("webhooks.deliveries.loadFailed")}</p>
            ) : rows === null ? (
                <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
            ) : rows.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{t("webhooks.deliveries.empty")}</p>
            ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                    {rows.map((d) => {
                        const expanded = open === d.id;
                        const facts = [
                            d.http_status ? `HTTP ${d.http_status}` : null,
                            d.attempts > 1 ? t("webhooks.deliveries.attempts", { n: d.attempts }) : null,
                            d.status !== "skipped" ? t("webhooks.deliveries.took", { ms: d.duration_ms }) : null,
                        ].filter(Boolean);
                        return (
                            <li key={d.id}>
                                <button type="button" onClick={() => setOpen(expanded ? null : d.id)} aria-expanded={expanded} className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-muted/40">
                                    <span className={cn("mt-1.5 inline-flex size-2 shrink-0 rounded-full", DOT[d.status])} aria-hidden />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                            <span className="text-sm text-foreground">{eventLabel(d.event)}</span>
                                            <span className="text-xs text-muted-foreground">{t(STATUS_KEY[d.status])}</span>
                                            {d.test && d.event !== "webhook.test" && <Chip>{t("webhooks.deliveries.test")}</Chip>}
                                        </span>
                                        <span className="mt-0.5 block text-xs text-muted-foreground" title={new Date(d.at).toLocaleString(locale)}>
                                            {[formatRelativeTime(d.at, locale), ...facts].join(" · ")}
                                        </span>
                                        {d.error && <span className="mt-0.5 block text-xs text-destructive [overflow-wrap:anywhere]">{d.error}</span>}
                                    </span>
                                    {d.body && <ChevronDown size={16} className={cn("mt-1 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} aria-hidden />}
                                </button>
                                {expanded && d.body && (
                                    <div className="space-y-2 px-3 pb-3">
                                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                                            <span className="font-mono [overflow-wrap:anywhere]">webhook-id: {d.message_id}</span>
                                            <CopyButton value={d.body} />
                                        </div>
                                        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface p-3 font-mono text-xs leading-relaxed text-foreground">{prettyBody(d.body)}</pre>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </Modal>
    );
}
