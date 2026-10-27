"use client";

/**
 * 建立個人 API token：名稱、scope（跟 OAuth 同意頁同一張勾選清單，多一項「管理隧道」）、隧道（全部 / 只限勾選）、
 * 到期（7 / 30 / 90 天 / 1 年 / 自選，最多一年）。建立後換成「現在就複製」的畫面：祕密只顯示這一次，
 * 下面是 CLI 登入、curl、MCP 設定三種用法。帳號有第二因素時送出前會先確認是你（hook 處理）。
 * Create a personal API token: name, scopes (the consent page's checklist plus "Manage tunnels"), tunnels (all or
 * picked), expiry (7 / 30 / 90 days / 1 year / a date, at most a year). Afterwards the one-time secret view with copy
 * and three ways to use it (CLI login, curl, MCP config). The hook asks to confirm it's you when the account has a factor.
 */
import React, { useEffect, useMemo, useState } from "react";
import { KeyRound, TriangleAlert } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { CopyButton } from "@/components/ui/CopyButton";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Section } from "@/components/ui/section";
import { ScopeChoices, TunnelChoice } from "@/components/oauth/ConsentSections";
import type { ConsentTunnel } from "@/hooks/useOAuthConsent";
import type { CreateResult, NewTokenBody } from "@/hooks/useApiTokens";
import { apiFetch } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { matchesTunnel } from "@/lib/oauthFlow";
import { addDays } from "@/lib/keyExpiry";
import { DEFAULT_SCOPES, MAX_DAYS, TOKEN_EXPIRY_PRESETS, TOKEN_SCOPES, tokenExamples, tokenExpiryValue, type TokenExpiryPreset } from "@/lib/apiTokens";
import type { TranslationKey } from "@/locales/en";

const PRESET_LABEL: Record<TokenExpiryPreset, TranslationKey> = {
    "7": "tokens.expiry7",
    "30": "tokens.expiry30",
    "90": "tokens.expiry90",
    "365": "tokens.expiry365",
    custom: "tokens.expiryCustom",
};

export function ApiTokenCreateDialog({ isOpen, onClose, onCreate }: { isOpen: boolean; onClose: () => void; onCreate: (body: NewTokenBody) => Promise<CreateResult> }) {
    const { t } = useI18n();
    const [name, setName] = useState("");
    const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
    const [mode, setMode] = useState<"all" | "some">("all");
    const [picked, setPicked] = useState<number[]>([]);
    const [query, setQuery] = useState("");
    const [preset, setPreset] = useState<TokenExpiryPreset>("30");
    const [customDate, setCustomDate] = useState("");
    const [tunnels, setTunnels] = useState<ConsentTunnel[]>([]);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [message, setMessage] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);

    // 每次打開都是新的元件（呼叫端換 `key`），所以這裡只載入隧道清單。/ Each open is a fresh instance (the caller changes `key`).
    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch("/api/reverse/server/keys");
                const data = res.ok ? ((await res.json()) as { id: number; host_friendly_name: string }[]) : [];
                if (!cancelled) setTunnels(data.map((x) => ({ id: x.id, name: x.host_friendly_name, permission: null })));
            } catch {
                if (!cancelled) setTunnels([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [isOpen]);

    const shown = useMemo(() => tunnels.filter((x) => matchesTunnel(x.name, query)), [tunnels, query]);
    const expiresAt = tokenExpiryValue(preset, customDate);
    const valid = name.trim() !== "" && scopes.length > 0 && expiresAt !== undefined && (mode === "all" || picked.length > 0);

    const submit = async () => {
        if (!valid || !expiresAt) return;
        setBusy(true);
        setMessage(null);
        const r = await onCreate({ name: name.trim(), scopes, tunnel_ids: mode === "all" ? null : picked, expires_at: expiresAt });
        setBusy(false);
        if (r.ok) {
            setCreated({ name: r.token.name, secret: r.secret });
        } else if (!("cancelled" in r)) {
            setErrors(r.errors);
            setMessage(Object.keys(r.errors).length === 0 ? r.message ?? t("tokens.createFailed") : null);
        }
    };

    if (created) {
        const ex = tokenExamples(typeof window === "undefined" ? "" : window.location.origin, created.secret);
        return (
            <Modal
                isOpen={isOpen}
                onClose={onClose}
                title={t("tokens.secretTitle")}
                description={created.name}
                icon={<KeyRound />}
                size="2xl"
                footer={<Button onClick={onClose}>{t("tokens.done")}</Button>}
            >
                <div className="min-w-0 space-y-5">
                    <Callout tone="warning" icon={<TriangleAlert />}>
                        {t("tokens.secretWarning")}
                    </Callout>
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
                        <code className="min-w-0 flex-1 break-all font-mono text-sm text-foreground" data-testid="token-secret">
                            {created.secret}
                        </code>
                        <CopyButton value={created.secret} />
                    </div>
                    <Section as="h3" title={t("tokens.useCli")}>
                        <CodeBlock language="bash" value={ex.cli} />
                    </Section>
                    <Section as="h3" title={t("tokens.useCurl")}>
                        <CodeBlock language="bash" value={ex.curl} />
                    </Section>
                    <Section as="h3" title={t("tokens.useMcp")}>
                        <CodeBlock language="json" value={ex.mcp} />
                    </Section>
                </div>
            </Modal>
        );
    }

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("tokens.createTitle")}
            description={t("tokens.createDescription")}
            icon={<KeyRound />}
            size="2xl"
            footer={
                <>
                    <Button variant="outline" onClick={onClose}>
                        {t("common.cancel")}
                    </Button>
                    <Button onClick={submit} disabled={!valid || busy}>
                        {busy ? t("tokens.creating") : t("tokens.create")}
                    </Button>
                </>
            }
        >
            <div className="min-w-0 space-y-6">
                {message && <Callout tone="danger">{message}</Callout>}
                <Field label={t("tokens.name")} hint={t("tokens.nameHint")} error={errors.name} required>
                    <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder={t("tokens.namePlaceholder")} autoFocus />
                </Field>
                <ScopeChoices
                    scopes={TOKEN_SCOPES.map((s) => ({ name: s, description: "" }))}
                    selected={scopes}
                    onToggle={(s) => setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : TOKEN_SCOPES.filter((x) => x === s || prev.includes(x))))}
                    hint={t("tokens.scopesHint")}
                    needOne={t("tokens.needOneScope")}
                />
                {errors.scopes && <p className="text-xs text-destructive">{errors.scopes}</p>}
                <TunnelChoice
                    all={tunnels}
                    shown={shown}
                    mode={mode}
                    selected={picked}
                    query={query}
                    onMode={setMode}
                    onToggle={(id) => setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))}
                    onQuery={setQuery}
                    onShown={(on) => setPicked((prev) => (on ? Array.from(new Set([...prev, ...shown.map((x) => x.id)])) : prev.filter((id) => !shown.some((x) => x.id === id))))}
                    hint={t("tokens.tunnelsHint")}
                    emptyText={t("tokens.noTunnels")}
                />
                {errors.tunnel_ids && <p className="text-xs text-destructive">{errors.tunnel_ids}</p>}
                <Section as="h2" title={t("tokens.expiry")} description={t("tokens.expiryHint")}>
                    <Segmented fullWidth size="sm" aria-label={t("tokens.expiry")} value={preset} onChange={setPreset} options={TOKEN_EXPIRY_PRESETS.map((p) => ({ value: p, label: t(PRESET_LABEL[p]) }))} />
                    {preset === "custom" && (
                        <Field label={t("tokens.expiryDate")} error={customDate && expiresAt === undefined ? t("tokens.expiryInvalid") : errors.expires_at}>
                            <Input type="date" value={customDate} min={addDays(1)} max={addDays(MAX_DAYS)} onChange={(e) => setCustomDate(e.target.value)} className="w-auto" />
                        </Field>
                    )}
                    {preset !== "custom" && errors.expires_at && <p className="text-xs text-destructive">{errors.expires_at}</p>}
                </Section>
            </div>
        </Modal>
    );
}
