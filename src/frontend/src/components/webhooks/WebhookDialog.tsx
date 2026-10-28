"use client";

/**
 * 左側是步驟分頁（StepTabs）：送到哪 → 送什麼 → 哪些隧道（有隧道事件時）→ 自訂標頭（選填）；填好的變綠、有錯的變琥珀色，
 * 存檔失敗就跳到第一個有錯的那步。/ Side step tabs: where → what → which tunnels (with tunnel events) → custom headers
 * (optional); filled steps turn green, steps with an error amber, and a failed save jumps to the first one.
 * 新增 / 修改 webhook：送到哪（網址、認出來的服務、格式、訊息語言、名稱）→ 送什麼（依分組勾事件，附「誰會收到」與預設組合）
 * → 狀態事件等多久 → 哪些隧道。全站 webhook 一律涵蓋每條隧道，不顯示隧道選單。
 * Add or change a webhook: where (URL, the recognised service, format, message language, name) → what (events by
 * group, with who receives each one, and presets) → how long status events wait → which tunnels. Site-wide
 * webhooks always cover every tunnel, so they have no tunnel picker.
 */
import React, { useMemo, useState } from "react";
import { Eye, EyeOff, Plus, Search, Trash2, UserRound, Webhook as WebhookIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { NativeSelect } from "@/components/ui/native-select";
import { Chip } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { StepTabs, type StepTab } from "@/components/ui/step-tabs";
import type { StepState } from "@/lib/stepTabs";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
    AUDIENCE_KEY,
    DELAY_CHOICES,
    EVENT_KEYS,
    FORMAT_KEY,
    FORMAT_SHORT,
    FORMATS,
    GROUP_KEY,
    LANGUAGES,
    MAX_HEADERS,
    PRESET_KEY,
    defaultInput,
    detectFormat,
    groupCatalog,
    hasStatusEvent,
    hasTunnelEvent,
    headerProblem,
    headersToSave,
    orderEvents,
    presetEvents,
    presetsFor,
    sameEvents,
    toInput,
    hookMode,
} from "@/lib/webhooks";
import type { WebhookErrors } from "@/hooks/useWebhooksPage";
import type { CatalogEvent, Webhook, WebhookInput, WebhookLanguage, WebhookScope } from "@/types/webhooks";
import { EnforcedChip, useDelayLabel } from "./parts";

type WebhookTab = "where" | "what" | "tunnels" | "headers";

/** 隧道多到要搜尋。/ Show a search box from this many tunnels. */
const SEARCH_FROM = 7;

interface Props {
    isOpen: boolean;
    onClose: () => void;
    /** null = 新增。/ null = a new webhook. */
    hook: Webhook | null;
    scope: WebhookScope;
    catalog: CatalogEvent[];
    tunnels: { id: number; name: string }[];
    language: WebhookLanguage;
    privateTargets: boolean;
    onSave: (input: WebhookInput, existing: Webhook | null) => Promise<{ errors: WebhookErrors } | { saved: Webhook }>;
}

export function WebhookDialog(props: Props) {
    // 每次打開都從頭來。/ A fresh form every time it opens.
    return props.isOpen ? <WebhookForm key={props.hook?.id ?? "new"} {...props} /> : null;
}

function WebhookForm({ isOpen, onClose, hook, scope, catalog, tunnels, language, privateTargets, onSave }: Props) {
    const { t } = useI18n();
    const delayLabel = useDelayLabel();
    const [input, setInput] = useState<WebhookInput>(() => (hook ? toInput(hook) : defaultInput(scope, language)));
    const [errors, setErrors] = useState<WebhookErrors>({});
    const [saving, setSaving] = useState(false);
    const [query, setQuery] = useState("");
    const set = <K extends keyof WebhookInput>(k: K, v: WebhookInput[K]) => {
        setInput((p) => ({ ...p, [k]: v }));
        setErrors((e) => ({ ...e, [k]: undefined, form: undefined }));
    };

    const detected = detectFormat(input.url);
    const groups = useMemo(() => groupCatalog(catalog), [catalog]);
    const presets = presetsFor(catalog);
    const selected = orderEvents(input.events, catalog);
    const showDelay = hasStatusEvent(selected, catalog);
    const showTunnels = hasTunnelEvent(selected, catalog);
    const [showValues, setShowValues] = useState(false);
    const headerProblems = input.headers.map((h) => headerProblem(h, input.headers));
    const setHeader = (i: number, patch: Partial<WebhookInput["headers"][number]>) => set("headers", input.headers.map((h, j) => (j === i ? { ...h, ...patch } : h)));
    const delays = DELAY_CHOICES.includes(input.delay) ? DELAY_CHOICES : [...DELAY_CHOICES, input.delay].sort((a, b) => a - b);
    const shownTunnels = tunnels.filter((x) => !query.trim() || x.name.toLowerCase().includes(query.trim().toLowerCase()));
    // 選了但現在看不到的隧道（取消分享了）也列出來，才拿得掉。/ Picked tunnels that are no longer visible stay listed so they can be removed.
    const gone = (hook?.tunnels ?? []).filter((x) => input.tunnel_ids.includes(x.id) && !tunnels.some((v) => v.id === x.id));

    const toggleEvent = (e: string) => set("events", input.events.includes(e) ? input.events.filter((x) => x !== e) : [...input.events, e]);
    const toggleTunnel = (id: number) => set("tunnel_ids", input.tunnel_ids.includes(id) ? input.tunnel_ids.filter((x) => x !== id) : [...input.tunnel_ids, id]);

    const save = async () => {
        setSaving(true);
        const r = await onSave({ ...input, events: selected, headers: headersToSave(input.headers) }, hook);
        setSaving(false);
        if ("saved" in r) onClose();
        else {
            setErrors(r.errors);
            // 跳到第一個有錯的那步。/ Jump to the first step with an error.
            const e = r.errors;
            const first: WebhookTab | null = e.url || e.format || e.language || e.name || e.mode ? "where" : e.events || e.delay ? "what" : e.tunnel_ids ? "tunnels" : e.headers ? "headers" : null;
            if (first) setTab(first);
        }
    };

    const canSave = !saving && Boolean(detected) && selected.length > 0 && (!showTunnels || input.all_tunnels || input.tunnel_ids.length > 0) && headerProblems.every((p) => p === null);

    // 左側的步驟：送到哪 → 送什麼 → 哪些隧道（有隧道事件時）→ 自訂標頭（選填）。填好的變綠、有錯的變琥珀色。
    // The steps on the left: where → what → which tunnels (with tunnel events) → custom headers (optional).
    const errorOn: Record<WebhookTab, boolean> = {
        where: Boolean(errors.url || errors.format || errors.language || errors.name || errors.mode),
        what: Boolean(errors.events || errors.delay),
        tunnels: Boolean(errors.tunnel_ids),
        headers: Boolean(errors.headers) || headerProblems.some((p) => p !== null),
    };
    const savedHeaders = headersToSave(input.headers).length;
    const tabs: StepTab<WebhookTab>[] = [
        { value: "where", label: t("webhooks.form.where"), state: errorOn.where ? "attention" : detected ? "done" : "todo", status: detected ? FORMAT_SHORT[detected] : t("webhooks.tab.whereTodo") },
        { value: "what", label: t("webhooks.form.what"), state: errorOn.what ? "attention" : selected.length > 0 ? "done" : "todo", status: selected.length > 0 ? t("webhooks.tab.events", { count: selected.length }) : t("webhooks.tab.whatTodo") },
        ...(showTunnels
            ? [{
                value: "tunnels" as const,
                label: t("webhooks.form.tunnels"),
                state: (errorOn.tunnels ? "attention" : input.all_tunnels || input.tunnel_ids.length > 0 ? "done" : "todo") as StepState,
                status: input.all_tunnels ? t("webhooks.tab.allTunnels") : t("webhooks.tab.someTunnels", { count: input.tunnel_ids.length }),
            }]
            : []),
        { value: "headers", label: t("webhooks.headers.title"), state: errorOn.headers ? "attention" : savedHeaders > 0 ? "done" : "todo", status: savedHeaders > 0 ? t("webhooks.tab.headers", { count: savedHeaders }) : t("webhooks.form.optional") },
    ];
    const [picked, setTab] = useState<WebhookTab>("where");
    // 隧道那步消失了（沒有隧道事件）就回到「送什麼」。/ Back to "what" when the tunnel step goes away.
    const tab: WebhookTab = tabs.some((x) => x.value === picked) ? picked : "what";

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            size="4xl"
            fixedHeight
            nav={<StepTabs aria-label={t("webhooks.tab.aria")} tabs={tabs} value={tab} onChange={setTab} />}
            icon={<WebhookIcon />}
            title={hook ? t("webhooks.form.editTitle") : scope === "site" ? t("webhooks.form.addSiteTitle") : t("webhooks.form.addTitle")}
            description={scope === "site" ? t("webhooks.form.siteDescription") : t("webhooks.form.description")}
            footer={
                <>
                    <Button variant="outline" onClick={onClose} disabled={saving}>
                        {t("common.cancel")}
                    </Button>
                    <Button onClick={() => void save()} disabled={!canSave}>
                        {hook ? t("common.save") : t("webhooks.form.add")}
                    </Button>
                </>
            }
        >
            <div className="space-y-7">
                {errors.form && <Callout tone="danger">{errors.form}</Callout>}

                <section role="tabpanel" hidden={tab !== "where"} className="space-y-4">
                    <h3 className="text-base text-foreground">{t("webhooks.form.where")}</h3>
                    <Field
                        label={t("webhooks.form.url")}
                        required
                        error={errors.url}
                        hint={
                            input.url.trim() && !detected
                                ? t("webhooks.form.urlInvalid")
                                : detected && detected !== "json" && input.format === "auto"
                                    ? t("webhooks.form.detected", { service: FORMAT_SHORT[detected] })
                                    : scope === "user" && !privateTargets
                                        ? t("webhooks.form.urlHintPublic")
                                        : t("webhooks.form.urlHint")
                        }
                    >
                        <Input
                            value={input.url}
                            onChange={(e) => set("url", e.target.value)}
                            placeholder="https://hooks.slack.com/services/…"
                            className="font-mono"
                            inputMode="url"
                            autoFocus={!hook}
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                        />
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field label={t("webhooks.form.format")} error={errors.format}>
                            <NativeSelect value={input.format} onChange={(e) => set("format", e.target.value as WebhookInput["format"])}>
                                {FORMATS.map((f) => (
                                    <option key={f} value={f}>
                                        {f === "auto" && detected ? t("webhooks.format.autoDetected", { service: FORMAT_SHORT[detected] }) : t(FORMAT_KEY[f])}
                                    </option>
                                ))}
                            </NativeSelect>
                        </Field>
                        <Field label={t("webhooks.form.language")} error={errors.language} hint={t("webhooks.form.languageHint")}>
                            <NativeSelect value={input.language} onChange={(e) => set("language", e.target.value as WebhookLanguage)}>
                                {LANGUAGES.map((l) => (
                                    <option key={l.value} value={l.value}>
                                        {l.label}
                                    </option>
                                ))}
                            </NativeSelect>
                        </Field>
                    </div>
                    <Field label={t("webhooks.form.name")} addon={t("webhooks.form.optional")} error={errors.name}>
                        <Input value={input.name} onChange={(e) => set("name", e.target.value)} placeholder={detected ? (safeHost(input.url) ?? t("webhooks.form.namePlaceholder")) : t("webhooks.form.namePlaceholder")} maxLength={80} />
                    </Field>
                <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
                    <Switch checked={input.enabled} onCheckedChange={(v) => set("enabled", v)}>
                        <span className="text-sm text-foreground">{t("webhooks.form.enabled")}</span>
                    </Switch>
                </div>
                {scope === "site" && (
                    // 開 = 預設（隧道的 owner / Admin 可以退出）；關 = 強制。/ On = default (owners / Admins may opt out); off = enforced.
                    <div className="space-y-1 rounded-lg border border-border bg-surface px-3 py-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <Switch checked={hookMode(input) === "default"} onCheckedChange={(v) => set("mode", v ? "default" : "enforced")}>
                                <span className="text-sm text-foreground">{t("webhooks.mode.switch")}</span>
                            </Switch>
                            {hookMode(input) === "enforced" && <EnforcedChip />}
                        </div>
                        <p className="text-xs text-muted-foreground">{hookMode(input) === "default" ? t("webhooks.mode.onHint") : t("webhooks.mode.offHint")}</p>
                    </div>
                )}
                </section>

                <section role="tabpanel" hidden={tab !== "what"} className="space-y-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="text-base text-foreground">{t("webhooks.form.what")}</h3>
                        <span className="text-xs tabular-nums text-muted-foreground">{t("webhooks.form.selectedCount", { n: selected.length, total: catalog.length })}</span>
                    </div>
                    <p className="-mt-1 text-sm text-muted-foreground">{scope === "site" ? t("webhooks.form.whatSiteHint") : t("webhooks.form.whatHint")}</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                        {presets.map((p) => {
                            const events = presetEvents(p, catalog);
                            const active = sameEvents(selected, events);
                            return (
                                <button
                                    key={p}
                                    type="button"
                                    aria-pressed={active}
                                    onClick={() => set("events", events)}
                                    className={cn(
                                        "rounded-sm border px-2 py-0.5 text-xs transition-colors",
                                        active ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-surface text-foreground hover:border-foreground/30 hover:bg-muted",
                                    )}
                                >
                                    {t(PRESET_KEY[p])}
                                </button>
                            );
                        })}
                        {selected.length > 0 && (
                            <button type="button" onClick={() => set("events", [])} className="px-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                                {t("webhooks.form.clear")}
                            </button>
                        )}
                    </div>
                    {errors.events && <p className="text-xs text-destructive" role="alert">{errors.events}</p>}
                    <div className="space-y-4">
                        {groups.map((g) => (
                            <fieldset key={g.group} className="rounded-lg border border-border">
                                <legend className="ml-3 px-1 text-sm text-muted-foreground">{t(GROUP_KEY[g.group])}</legend>
                                <ul className="divide-y divide-border">
                                    {g.events.map((e) => {
                                        const keys = EVENT_KEYS[e.event];
                                        const checked = input.events.includes(e.event);
                                        return (
                                            <li key={e.event}>
                                                <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-muted/40">
                                                    <input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" checked={checked} onChange={() => toggleEvent(e.event)} />
                                                    <span className="min-w-0 flex-1">
                                                        <span className="block text-sm text-foreground">{keys ? t(keys.label) : e.event}</span>
                                                        {keys && <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{t(keys.hint)}</span>}
                                                        {scope === "user" && (
                                                            <span className="mt-1 flex items-start gap-1 text-xs text-muted-foreground/90">
                                                                <UserRound size={12} className="mt-0.5 shrink-0" aria-hidden />
                                                                {t(AUDIENCE_KEY[e.audience])}
                                                            </span>
                                                        )}
                                                    </span>
                                                </label>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </fieldset>
                        ))}
                    </div>
                {showDelay && (
                    <Field label={t("webhooks.form.delay")} error={errors.delay} hint={t("webhooks.form.delayHint")}>
                        <NativeSelect value={String(input.delay)} onChange={(e) => set("delay", Number(e.target.value))} className="sm:w-60">
                            {delays.map((d) => (
                                <option key={d} value={d}>
                                    {delayLabel(d)}
                                </option>
                            ))}
                        </NativeSelect>
                    </Field>
                )}
                </section>


                {showTunnels && (
                    <section role="tabpanel" hidden={tab !== "tunnels"} className="space-y-3">
                        <h3 className="text-base text-foreground">{t("webhooks.form.tunnels")}</h3>
                        <Segmented
                            size="sm"
                            value={input.all_tunnels ? "all" : "some"}
                            onChange={(v) => set("all_tunnels", v === "all")}
                            options={[
                                { value: "all", label: scope === "site" ? t("webhooks.form.everyTunnel") : t("webhooks.form.allTunnels") },
                                { value: "some", label: t("webhooks.form.someTunnels") },
                            ]}
                            aria-label={t("webhooks.form.tunnels")}
                        />
                        <p className="text-xs text-muted-foreground">
                            {input.all_tunnels ? t(scope === "site" ? "webhooks.form.everyTunnelHint" : "webhooks.form.allTunnelsHint") : t("webhooks.form.someTunnelsHint")}
                        </p>
                        {!input.all_tunnels && (
                            <div className="space-y-2">
                                {tunnels.length >= SEARCH_FROM && (
                                    <div className="relative">
                                        <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                                        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("webhooks.form.searchTunnels")} className="pl-8" aria-label={t("webhooks.form.searchTunnels")} />
                                    </div>
                                )}
                                {tunnels.length === 0 && gone.length === 0 ? (
                                    <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">{t("webhooks.form.noTunnels")}</p>
                                ) : (
                                    <ul className="divide-y divide-border rounded-lg border border-border">
                                        {[...shownTunnels.map((x) => ({ ...x, gone: false })), ...gone.map((x) => ({ id: x.id, name: x.name ?? `#${x.id}`, gone: true }))].map((x) => (
                                            <li key={x.id}>
                                                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/40">
                                                    <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={input.tunnel_ids.includes(x.id)} onChange={() => toggleTunnel(x.id)} />
                                                    <span className="min-w-0 flex-1 text-sm text-foreground [overflow-wrap:anywhere]">{x.name}</span>
                                                    {x.gone && <Chip tone="warning">{t("webhooks.form.tunnelGone")}</Chip>}
                                                </label>
                                            </li>
                                        ))}
                                        {shownTunnels.length === 0 && gone.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">{t("webhooks.form.noMatch")}</li>}
                                    </ul>
                                )}
                                {errors.tunnel_ids && <p className="text-xs text-destructive" role="alert">{errors.tunnel_ids}</p>}
                            </div>
                        )}
                    </section>
                )}

                <section role="tabpanel" hidden={tab !== "headers"} className="space-y-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="text-base text-foreground">{t("webhooks.headers.title")}</h3>
                        {input.headers.length > 0 && (
                            <button type="button" onClick={() => setShowValues((v) => !v)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                                {showValues ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
                                {showValues ? t("webhooks.headers.hideValues") : t("webhooks.headers.showValues")}
                            </button>
                        )}
                    </div>
                    <p className="-mt-1 text-sm text-muted-foreground">{t("webhooks.headers.hint")}</p>
                    {hook?.headers_unreadable && <Callout tone="warning">{t("webhooks.headers.unreadable")}</Callout>}
                    {input.headers.length > 0 && (
                        <ul className="space-y-2">
                            {input.headers.map((h, i) => (
                                // 手機上名稱與值分兩行，框起來才看得出是一組。/ On phones name and value stack, so each pair gets a frame.
                                <li key={i} className="rounded-lg border border-border p-2 sm:border-0 sm:p-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Input
                                            value={h.name}
                                            onChange={(e) => setHeader(i, { name: e.target.value })}
                                            placeholder="Authorization"
                                            aria-label={t("webhooks.headers.name")}
                                            aria-invalid={headerProblems[i] !== null}
                                            className="w-full font-mono sm:w-48"
                                            maxLength={64}
                                            spellCheck={false}
                                            autoCapitalize="off"
                                            autoCorrect="off"
                                        />
                                        <Input
                                            value={h.value}
                                            onChange={(e) => setHeader(i, { value: e.target.value })}
                                            type={showValues ? "text" : "password"}
                                            placeholder="Bearer …"
                                            aria-label={t("webhooks.headers.value")}
                                            aria-invalid={headerProblems[i] !== null}
                                            className="min-w-0 flex-1 font-mono"
                                            maxLength={2048}
                                            autoComplete="off"
                                            spellCheck={false}
                                        />
                                        <Button
                                            type="button"
                                            size="icon-sm"
                                            variant="ghost"
                                            onClick={() => set("headers", input.headers.filter((_, j) => j !== i))}
                                            aria-label={t("webhooks.headers.remove", { name: h.name || "" })}
                                            title={t("webhooks.headers.remove", { name: h.name || "" })}
                                            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                        >
                                            <Trash2 />
                                        </Button>
                                    </div>
                                    {headerProblems[i] && (
                                        <p className="mt-1 text-xs text-destructive" role="alert">
                                            {t(headerProblems[i]!)}
                                        </p>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    {errors.headers && <p className="text-xs text-destructive" role="alert">{errors.headers}</p>}
                    {input.headers.length < MAX_HEADERS && (
                        <Button type="button" size="sm" variant="outline" onClick={() => set("headers", [...input.headers, { name: "", value: "" }])}>
                            <Plus size={15} /> {t("webhooks.headers.add")}
                        </Button>
                    )}
                </section>

            </div>
        </Modal>
    );
}

function safeHost(url: string): string | null {
    try {
        return new URL(url.trim()).hostname || null;
    } catch {
        return null;
    }
}
