"use client";

/**
 * 網站設定 → 伺服器 →「代理位址」：輸入框，加上裝置代理實際會用的兩個位址——網頁位址上的 WebSocket（永遠有）與標準的
 * 代理位址。沒設定時連線就走網頁位址，所以第二列顯示同一個位址並標「跟網頁一樣」（跟「SSH 主機」那一列的寫法一樣）；
 * 設了卻沒開代理的 port 時說出來。
 * Site settings → Server → "Proxy address": the input plus the two addresses the device proxy really uses — the
 * WebSocket on the web address (always) and the standard proxy address. Unset, connections use the web address, so the
 * second row shows the same address marked "same as the web" (as the "SSH host" row does); an address set without the
 * proxy port open is called out.
 */
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/section";
import { apiFetch, readJson } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { ProxyInfo } from "@/lib/proxy";
import { proxyRows, proxyUrlProblem, proxyVerdict, tidyUrl, type ProxyRowState } from "@/lib/proxyUrl";

const TONE: Record<ProxyRowState, "success" | "warning" | undefined> = { always: "success", listening: "success", notListening: "warning", sameAsWeb: undefined };

export function ProxyUrlControl({ shown, locked, onSave }: { shown: unknown; locked: boolean; onSave: (value: string) => void }) {
    const { t } = useI18n();
    const saved = String(shown ?? "");
    const [draft, setDraft] = useState(saved);
    // undefined = 讀取中；null = 讀不到。/ undefined = loading; null = unavailable.
    const [endpoints, setEndpoints] = useState<ProxyInfo["endpoints"] | null | undefined>(undefined);
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await apiFetch("/api/proxy/tunnels");
                const body = res.ok ? ((await readJson(res)) as ProxyInfo) : null;
                if (!cancelled) setEndpoints(body?.endpoints ?? null);
            } catch {
                if (!cancelled) setEndpoints(null);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [saved]);

    const value = locked ? saved : draft;
    const problem = locked ? null : proxyUrlProblem(draft);
    const dirty = !locked && tidyUrl(draft) !== tidyUrl(saved);
    const save = () => {
        if (!problem && dirty) onSave(tidyUrl(draft));
    };
    const listening = endpoints?.http_listening === true;
    const verdict = proxyVerdict(saved, listening);

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    className="h-8 w-full max-w-md font-mono"
                    value={value}
                    disabled={locked}
                    placeholder={t("proxyUrl.placeholder")}
                    aria-label={t("siteSettings.server_proxy_url.label")}
                    aria-invalid={!!problem}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") save();
                    }}
                />
                {!locked && (
                    <Button type="button" size="sm" variant="soft" disabled={!!problem || !dirty} onClick={save}>
                        {t("common.save")}
                    </Button>
                )}
                {!locked && saved.trim() !== "" && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => onSave("")}>
                        {t("proxyUrl.clear")}
                    </Button>
                )}
            </div>
            {problem && <p className="text-xs text-destructive">{t("proxyUrl.problem")}</p>}

            <div className="overflow-hidden rounded-lg border border-border bg-surface">
                {endpoints === undefined ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">{t("common.loading")}</p>
                ) : endpoints === null ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">{t("proxyUrl.unavailable")}</p>
                ) : (
                    <ul className="divide-y divide-border/70">
                        {proxyRows(saved, endpoints.websocket, listening).map((row) => (
                            <li key={row.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm">
                                <span className="w-12 shrink-0 text-xs text-muted-foreground">{t(`proxyUrl.row.${row.id}`)}</span>
                                <span className={`min-w-0 font-mono [overflow-wrap:anywhere] ${row.state === "sameAsWeb" ? "text-muted-foreground" : "text-foreground"}`}>{row.value}</span>
                                <Chip tone={TONE[row.state]} className="whitespace-normal">{t(`proxyUrl.state.${row.state}`)}</Chip>
                                <span className="ml-auto text-xs text-muted-foreground">{t(`proxyUrl.who.${row.id}`)}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            {endpoints && (
                <Callout tone={verdict === "portClosed" ? "warning" : "info"}>{t(`proxyUrl.verdict.${verdict}`)}</Callout>
            )}
        </div>
    );
}
