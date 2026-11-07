"use client";

/**
 * 網站設定 → 登入 →「單一登入（OIDC）」：身分提供者的清單（開關、回呼網址、連了幾個帳號、試登入、修改、刪除），
 * 新增 / 修改的對話框（issuer 的 discovery 檢查、要在身分提供者那邊登記的回呼網址、帳號規則），與「怎麼運作」說明圖。
 * Site settings → Sign-in → "Single sign-on (OIDC)": the providers (switch, callback URL, linked accounts, test
 * sign-in, edit, delete), the add / edit dialog (discovery check, the callback URL to register, account rules) and
 * the "How it works" diagram.
 */
import React, { useState } from "react";
import Link from "next/link";
import { ArrowRight, Building2, CircleHelp, Copy, FlaskConical, Pencil, Plug, Plus, Search, ShieldCheck, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NavTabs } from "@/components/ui/nav-tabs";
import { Modal } from "@/components/ui/Modal";
import { NativeSelect } from "@/components/ui/native-select";
import { Chip, SectionHeading } from "@/components/ui/section";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/Toast";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { OidcFlowDialog } from "@/components/sso/OidcFlow";
import { useOidcProviders, type Discovery, type FieldErrors, type OidcProvider, type ProviderDraft } from "@/hooks/useOidcProviders";
import { useI18n } from "@/lib/i18n";
import { badDomain, postLogoutUrl, fromRuleValue, grantsAdmin, groupLines, parseDomains, ruleValue, slugify, tidyRules, type GroupRule } from "@/lib/sso";

function CopyButton({ text }: { text: string }) {
    const { t } = useI18n();
    const { showSuccess } = useToast();
    return (
        <Button
            type="button"
            size="sm"
            variant="ghost"
            className="shrink-0"
            aria-label={t("common.copy")}
            title={t("common.copy")}
            onClick={async () => {
                try {
                    await navigator.clipboard.writeText(text);
                    showSuccess(t("common.copied"));
                } catch {
                    /* clipboard blocked */
                }
            }}
        >
            <Copy size={14} />
        </Button>
    );
}

export function OidcProvidersPanel() {
    const { t } = useI18n();
    const { list, failed, save, toggle, remove, discover, test } = useOidcProviders();
    const [editing, setEditing] = useState<OidcProvider | "new" | null>(null);
    const [deleting, setDeleting] = useState<OidcProvider | null>(null);
    const [info, setInfo] = useState(false);

    return (
        <section id="sso" className="scroll-mt-24 overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card">
            <div className="p-4 sm:px-6 sm:pt-5 sm:pb-4">
                <SectionHeading
                    icon={<Building2 />}
                    title={t("sso.admin.title")}
                    description={t("sso.admin.description")}
                    action={
                        <div className="flex flex-wrap gap-2">
                            <Button type="button" size="sm" variant="outline" onClick={() => setInfo(true)}>
                                <CircleHelp size={14} /> {t("sso.flow.button")}
                            </Button>
                            <Button type="button" size="sm" onClick={() => setEditing("new")} disabled={!list}>
                                <Plus size={14} /> {t("sso.admin.add")}
                            </Button>
                        </div>
                    }
                />
            </div>

            <div className="space-y-4 border-t border-border/70 p-4 sm:px-6 sm:py-5">
                {list && !list.public_url_set && <Callout tone="warning">{t("sso.admin.noPublicUrl")}</Callout>}
                {failed && <p className="text-sm text-destructive">{t("sso.admin.loadFailed")}</p>}
                {!list && !failed && <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}
                {list && list.providers.length === 0 && (
                    <div className="rounded-lg bg-surface px-4 py-4 text-sm text-muted-foreground">
                        <p>{t("sso.admin.empty")}</p>
                        <p className="mt-1">{t("sso.admin.worksWith")}</p>
                    </div>
                )}
                {list && list.providers.length > 0 && (
                    <ul className="divide-y divide-border/70 rounded-lg ring-1 ring-inset ring-border/80" data-refresh-list>
                        {list.providers.map((p) => (
                            <li key={p.id} className="space-y-2 px-4 py-3">
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                                    <Switch size="sm" checked={p.enabled} onCheckedChange={(on) => void toggle(p, on)} aria-label={t("sso.admin.enabledFor", { name: p.name })} />
                                    <div className="min-w-0 flex-1">
                                        <p className="flex flex-wrap items-center gap-2">
                                            <span className="truncate">{p.name}</span>
                                            <Chip mono>{p.slug}</Chip>
                                            {!p.enabled && <Chip>{t("sso.links.off")}</Chip>}
                                        </p>
                                        <p className="truncate font-mono text-xs text-muted-foreground">{p.issuer}</p>
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        <Button type="button" size="sm" variant="outline" onClick={() => void test(p)}>
                                            <FlaskConical size={14} /> {t("sso.admin.test")}
                                        </Button>
                                        <Button type="button" size="sm" variant="ghost" aria-label={t("common.edit")} title={t("common.edit")} onClick={() => setEditing(p)}>
                                            <Pencil size={14} />
                                        </Button>
                                        <Button type="button" size="sm" variant="ghost" aria-label={t("common.delete")} title={t("common.delete")} onClick={() => setDeleting(p)}>
                                            <Trash2 size={14} />
                                        </Button>
                                    </div>
                                </div>
                                <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                    <span>{t("sso.admin.linksCount", { count: p.links })}</span>
                                    <span>{p.create_users ? t("sso.admin.createsAccounts") : t("sso.admin.linkedOnly")}</span>
                                    {p.allowed_domains.length > 0 && <span>{t("sso.admin.onlyDomains", { domains: p.allowed_domains.join(", ") })}</span>}
                                    {!p.has_secret && <span>{t("sso.admin.publicClient")}</span>}
                                    {(p.group_rules?.length ?? 0) > 0 && <span>{t("sso.roles.count", { count: p.group_rules.length })}</span>}
                                    {p.end_session && <span>{t("sso.logout.listNote")}</span>}
                                    {(p.required_groups?.length ?? 0) > 0 && <span>{t("sso.roles.onlyGroups", { groups: p.required_groups.join(", ") })}</span>}
                                </p>
                                <div className="flex items-center gap-1 rounded-md bg-surface py-1 pl-2.5 pr-1">
                                    <span className="shrink-0 text-xs text-muted-foreground">{t("sso.admin.callback")}</span>
                                    <code className="min-w-0 flex-1 truncate font-mono text-xs">{p.callback_url}</code>
                                    <CopyButton text={p.callback_url} />
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {editing && list && (
                <ProviderDialog
                    provider={editing === "new" ? null : editing}
                    callbackBase={list.callback_base}
                    userGroups={list.user_groups ?? []}
                    onClose={() => setEditing(null)}
                    onSave={async (draft) => {
                        const errors = await save(editing === "new" ? null : editing.id, draft);
                        if (!errors) setEditing(null);
                        return errors;
                    }}
                    discover={discover}
                />
            )}
            {deleting && (
                <ConfirmDialog
                    isOpen
                    isDestructive
                    title={t("sso.admin.deleteTitle", { name: deleting.name })}
                    message={deleting.links > 0 ? t("sso.admin.deleteLinked", { count: deleting.links }) : t("sso.admin.deleteMessage")}
                    confirmText={t("common.delete")}
                    onConfirm={() => {
                        const p = deleting;
                        setDeleting(null);
                        void remove(p);
                    }}
                    onClose={() => setDeleting(null)}
                />
            )}
            <OidcFlowDialog isOpen={info} onClose={() => setInfo(false)} />
        </section>
    );
}

function emptyDraft(): ProviderDraft {
    return {
        name: "",
        slug: "",
        issuer: "",
        client_id: "",
        client_secret: "",
        scopes: "openid email profile",
        username_from: "email",
        allowed_domains: [],
        create_users: true,
        link_by_email: false,
        enabled: true,
        groups_claim: "groups",
        required_groups: [],
        group_rules: [],
        end_session: false,
    };
}

function draftOf(p: OidcProvider): ProviderDraft {
    return {
        name: p.name,
        slug: p.slug,
        issuer: p.issuer,
        client_id: p.client_id,
        scopes: p.scopes,
        username_from: p.username_from,
        allowed_domains: p.allowed_domains,
        create_users: p.create_users,
        link_by_email: p.link_by_email,
        enabled: p.enabled,
        groups_claim: p.groups_claim ?? "groups",
        required_groups: p.required_groups ?? [],
        // 群組已刪掉的規則留著讓人看到（存檔時要改掉）。/ Rules whose group is gone stay visible until fixed.
        group_rules: (p.group_rules ?? []).map((r) => ({ idp_group: r.idp_group, target: r.target, group_id: r.group_id })),
        end_session: p.end_session ?? false,
    };
}

type DialogTab = "connection" | "accounts" | "groups";

/** 欄位在哪一頁（錯誤時跳過去）。/ Which tab a field lives on (errors jump there). */
const FIELD_TAB: Record<keyof ProviderDraft, DialogTab> = {
    name: "connection",
    slug: "connection",
    issuer: "connection",
    client_id: "connection",
    client_secret: "connection",
    scopes: "connection",
    enabled: "connection",
    create_users: "accounts",
    link_by_email: "accounts",
    username_from: "accounts",
    allowed_domains: "accounts",
    groups_claim: "groups",
    required_groups: "groups",
    group_rules: "groups",
    end_session: "connection",
};

function ProviderDialog({
    provider,
    callbackBase,
    userGroups,
    onClose,
    onSave,
    discover,
}: {
    provider: OidcProvider | null;
    callbackBase: string;
    userGroups: { id: number; name: string }[];
    onClose: () => void;
    onSave: (draft: ProviderDraft) => Promise<FieldErrors | null>;
    discover: (issuer: string) => Promise<Discovery | { fieldError: string }>;
}) {
    const { t } = useI18n();
    const [draft, setDraft] = useState<ProviderDraft>(() => (provider ? draftOf(provider) : emptyDraft()));
    const [tab, setTab] = useState<DialogTab>("connection");
    /** 代號自己改過就不再跟著名字。/ Once the slug is edited it stops following the name. */
    const [slugTouched, setSlugTouched] = useState(!!provider);
    const [domains, setDomains] = useState(() => draft.allowed_domains.join(", "));
    const [required, setRequired] = useState(() => draft.required_groups.join("\n"));
    const [secret, setSecret] = useState("");
    const [dropSecret, setDropSecret] = useState(false);
    const [errors, setErrors] = useState<FieldErrors>({});
    const [saving, setSaving] = useState(false);
    const [checking, setChecking] = useState(false);
    const [check, setCheck] = useState<Discovery | null>(null);

    const set = <K extends keyof ProviderDraft>(k: K, v: ProviderDraft[K]) => {
        setDraft((d) => ({ ...d, [k]: v }));
        setErrors((e) => ({ ...e, [k]: undefined }));
    };
    const slug = slugTouched ? draft.slug : draft.name.trim() ? slugify(draft.name) : "";
    const callback = `${callbackBase}${slug || "…"}/callback`;
    const parsedDomains = parseDomains(domains);
    const domainProblem = badDomain(parsedDomains);
    const groupNames = new Map(userGroups.map((g) => [g.id, g.name] as const));
    const rules = draft.group_rules;
    const setRule = (i: number, patch: Partial<GroupRule>) => set("group_rules", rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));

    /** 有錯誤的頁。/ Tabs with an error. */
    const errorTabs = new Set(
        (Object.keys(errors) as (keyof ProviderDraft)[]).filter((k) => errors[k]).map((k) => FIELD_TAB[k]),
    );
    const flag = (t2: DialogTab, hint: string) => (errorTabs.has(t2) ? <span className="text-destructive">{t("sso.admin.tabError")}</span> : hint);

    const runCheck = async () => {
        if (!draft.issuer.trim()) return;
        setChecking(true);
        setCheck(null);
        try {
            const r = await discover(draft.issuer.trim());
            if ("fieldError" in r) setErrors((e) => ({ ...e, issuer: r.fieldError }));
            else setCheck(r);
        } finally {
            setChecking(false);
        }
    };

    /** 錯誤：記下來並跳到第一個有錯的頁。/ Errors: keep them and jump to the first tab with one. */
    const fail = (errs: FieldErrors) => {
        setErrors(errs);
        const first = (["connection", "accounts", "groups"] as const).find((d) => (Object.keys(errs) as (keyof ProviderDraft)[]).some((k) => errs[k] && FIELD_TAB[k] === d));
        if (first) setTab(first);
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const local: FieldErrors = {};
        if (!draft.name.trim()) local.name = t("sso.admin.required");
        if (!draft.issuer.trim()) local.issuer = t("sso.admin.required");
        if (!draft.client_id.trim()) local.client_id = t("sso.admin.required");
        if (domainProblem) local.allowed_domains = t("sso.admin.badDomain", { domain: domainProblem });
        const tidy = tidyRules(rules);
        if (tidy.problem) local.group_rules = t(tidy.problem === "group_name" ? "sso.roles.needGroupName" : "sso.roles.needTarget");
        if (Object.keys(local).length) {
            fail(local);
            return;
        }
        const body: ProviderDraft = { ...draft, slug, allowed_domains: parsedDomains, required_groups: groupLines(required), group_rules: tidy.rules };
        delete body.client_secret;
        if (dropSecret) body.client_secret = "";
        else if (secret.trim()) body.client_secret = secret.trim();
        setSaving(true);
        try {
            const errs = await onSave(body);
            if (errs) fail(errs);
        } finally {
            setSaving(false);
        }
    };

    const ruleCount = tidyRules(rules).rules.length;
    const tabs = [
        { value: "connection" as const, label: t("sso.admin.tabConnection"), icon: <Plug />, hint: flag("connection", t("sso.admin.tabConnectionHint")) },
        { value: "accounts" as const, label: t("sso.admin.accounts"), icon: <Users />, hint: flag("accounts", t(draft.create_users ? "sso.admin.createsAccounts" : "sso.admin.linkedOnly")) },
        { value: "groups" as const, label: t("sso.roles.tab"), icon: <ShieldCheck />, hint: flag("groups", ruleCount ? t("sso.roles.count", { count: ruleCount }) : t("sso.roles.none")) },
    ];

    return (
        <Modal
            isOpen
            onClose={onClose}
            size="4xl"
            fixedHeight
            icon={<Building2 />}
            title={provider ? t("sso.admin.editTitle", { name: provider.name }) : t("sso.admin.addTitle")}
            description={t("sso.admin.dialogDescription")}
            nav={<NavTabs aria-label={t("sso.admin.tabsAria")} tabs={tabs} value={tab} onChange={setTab} />}
            footer={
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <Switch size="sm" checked={draft.enabled} onCheckedChange={(v) => set("enabled", v)}>
                        <span className="text-sm">{t("sso.admin.enabled")}</span>
                    </Switch>
                    <div className="flex gap-2">
                        <Button type="button" variant="outline" onClick={onClose}>
                            {t("common.cancel")}
                        </Button>
                        <Button type="submit" form="oidc-provider-form" disabled={saving}>
                            {t("common.save")}
                        </Button>
                    </div>
                </div>
            }
        >
            <form id="oidc-provider-form" onSubmit={submit} className="space-y-5" noValidate>
                {tab === "connection" && (
                    <>
                        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
                            <Field label={t("sso.admin.name")} hint={t("sso.admin.nameHint")} error={errors.name}>
                                <Input value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Okta" maxLength={64} autoFocus />
                            </Field>
                            <Field label={t("sso.admin.slug")} error={errors.slug}>
                                <Input
                                    value={slug}
                                    onChange={(e) => {
                                        setSlugTouched(true);
                                        set("slug", e.target.value.toLowerCase());
                                    }}
                                    className="font-mono"
                                    placeholder="okta"
                                    maxLength={32}
                                    spellCheck={false}
                                    autoCapitalize="none"
                                />
                            </Field>
                        </div>

                        <Field label={t("sso.admin.issuer")} hint={t("sso.admin.issuerHint")} error={errors.issuer}>
                            <div className="flex gap-2">
                                <Input
                                    value={draft.issuer}
                                    onChange={(e) => {
                                        set("issuer", e.target.value);
                                        setCheck(null);
                                    }}
                                    placeholder="https://example.okta.com"
                                    className="font-mono"
                                    spellCheck={false}
                                    autoCapitalize="none"
                                    inputMode="url"
                                />
                                <Button type="button" variant="soft" className="shrink-0" onClick={() => void runCheck()} disabled={checking || !draft.issuer.trim()}>
                                    <Search size={14} /> {t("sso.admin.check")}
                                </Button>
                            </div>
                        </Field>
                        {check &&
                            (check.ok ? (
                                <Callout tone="success" title={t("sso.admin.checkOk", { keys: check.keys ?? 0 })}>
                                    <dl className="grid gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr]">
                                        <dt className="text-muted-foreground">{t("sso.admin.authEndpoint")}</dt>
                                        <dd className="min-w-0 truncate font-mono">{check.authorization_endpoint}</dd>
                                        <dt className="text-muted-foreground">{t("sso.admin.tokenEndpoint")}</dt>
                                        <dd className="min-w-0 truncate font-mono">{check.token_endpoint}</dd>
                                        <dt className="text-muted-foreground">PKCE</dt>
                                        <dd>{check.pkce === "S256" ? "S256" : t("sso.admin.pkceUnlisted")}</dd>
                                        <dt className="text-muted-foreground">{t("sso.logout.endpoint")}</dt>
                                        <dd className="min-w-0 truncate font-mono">{check.end_session_endpoint || <span className="font-sans">{t("sso.logout.noEndpoint")}</span>}</dd>
                                    </dl>
                                </Callout>
                            ) : (
                                <Callout tone="danger" title={t("sso.admin.checkBad")}>
                                    <span className="break-words">{check.error}</span>
                                </Callout>
                            ))}

                        <Field label={t("sso.admin.callback")} hint={t("sso.admin.callbackHint")}>
                            <div className="flex items-center gap-1 rounded-md bg-surface py-1.5 pl-3 pr-1">
                                <code className="min-w-0 flex-1 break-all font-mono text-xs">{callback}</code>
                                <CopyButton text={callback} />
                            </div>
                        </Field>

                        <div className="grid gap-4 sm:grid-cols-2">
                            <Field label={t("sso.admin.clientId")} error={errors.client_id}>
                                <Input value={draft.client_id} onChange={(e) => set("client_id", e.target.value)} className="font-mono" spellCheck={false} autoCapitalize="none" autoComplete="off" />
                            </Field>
                            <Field label={t("sso.admin.clientSecret")} hint={provider?.has_secret ? t("sso.admin.secretKept") : t("sso.admin.secretHint")} error={errors.client_secret}>
                                <PasswordInput value={secret} onChange={(e) => setSecret(e.target.value)} disabled={dropSecret} autoComplete="new-password" placeholder={provider?.has_secret ? "••••••••" : ""} />
                            </Field>
                        </div>
                        {provider?.has_secret && (
                            <Switch size="sm" checked={dropSecret} onCheckedChange={setDropSecret}>
                                <span className="text-sm">{t("sso.admin.dropSecret")}</span>
                            </Switch>
                        )}

                        <div className="space-y-2">
                            <Switch size="sm" checked={draft.end_session} onCheckedChange={(v) => set("end_session", v)}>
                                <span className="text-sm">{t("sso.logout.switch")}</span>
                            </Switch>
                            <p className="pl-11 text-xs text-muted-foreground">{t(draft.end_session ? "sso.logout.on" : "sso.logout.off")}</p>
                            {draft.end_session && (
                                <Field label={t("sso.logout.redirect")} hint={t("sso.logout.redirectHint")}>
                                    <div className="flex items-center gap-1 rounded-md bg-surface py-1.5 pl-3 pr-1">
                                        <code className="min-w-0 flex-1 break-all font-mono text-xs">{postLogoutUrl(callbackBase)}</code>
                                        <CopyButton text={postLogoutUrl(callbackBase)} />
                                    </div>
                                </Field>
                            )}
                            {draft.end_session && check && check.ok && !check.end_session_endpoint && <Callout tone="warning">{t("sso.logout.missing")}</Callout>}
                        </div>

                        <Field label={t("sso.admin.scopes")} hint={t("sso.admin.scopesHint")} error={errors.scopes}>
                            <Input value={draft.scopes} onChange={(e) => set("scopes", e.target.value)} className="font-mono" spellCheck={false} autoCapitalize="none" />
                        </Field>
                        {draft.enabled && !provider && <p className="text-xs text-muted-foreground">{t("sso.admin.enabledHint")}</p>}
                    </>
                )}

                {tab === "accounts" && (
                    <div className="space-y-4">
                        <Switch size="sm" checked={draft.create_users} onCheckedChange={(v) => set("create_users", v)}>
                            <span className="text-sm">{t("sso.admin.createUsers")}</span>
                        </Switch>
                        <p className="pl-11 text-xs text-muted-foreground">{t(draft.create_users ? "sso.admin.createUsersOn" : "sso.admin.createUsersOff")}</p>
                        <Switch size="sm" checked={draft.link_by_email} onCheckedChange={(v) => set("link_by_email", v)}>
                            <span className="text-sm">{t("sso.admin.linkByEmail")}</span>
                        </Switch>
                        {draft.link_by_email ? <Callout tone="warning">{t("sso.admin.linkByEmailWarn")}</Callout> : <p className="pl-11 text-xs text-muted-foreground">{t("sso.admin.linkByEmailOff")}</p>}
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Field label={t("sso.admin.usernameFrom")} hint={t("sso.admin.usernameFromHint")} error={errors.username_from}>
                                <NativeSelect value={draft.username_from} onChange={(e) => set("username_from", e.target.value as ProviderDraft["username_from"])}>
                                    <option value="email">{t("sso.admin.fromEmail")}</option>
                                    <option value="preferred_username">{t("sso.admin.fromPreferred")}</option>
                                </NativeSelect>
                            </Field>
                            <Field label={t("sso.admin.domains")} hint={t("sso.admin.domainsHint")} error={errors.allowed_domains}>
                                <Input
                                    value={domains}
                                    onChange={(e) => {
                                        setDomains(e.target.value);
                                        setErrors((x) => ({ ...x, allowed_domains: undefined }));
                                    }}
                                    placeholder="corp.example"
                                    className="font-mono"
                                    spellCheck={false}
                                    autoCapitalize="none"
                                />
                            </Field>
                        </div>
                    </div>
                )}

                {tab === "groups" && (
                    <div className="space-y-5">
                        <p className="text-sm text-muted-foreground">{t("sso.roles.intro")}</p>
                        <Field label={t("sso.roles.claim")} hint={t("sso.roles.claimHint")} error={errors.groups_claim}>
                            <Input value={draft.groups_claim} onChange={(e) => set("groups_claim", e.target.value)} placeholder="groups" className="font-mono sm:w-72" spellCheck={false} autoCapitalize="none" />
                        </Field>
                        <Field label={t("sso.roles.required")} hint={t("sso.roles.requiredHint")} error={errors.required_groups}>
                            <Textarea
                                value={required}
                                onChange={(e) => {
                                    setRequired(e.target.value);
                                    setErrors((x) => ({ ...x, required_groups: undefined }));
                                }}
                                rows={3}
                                placeholder={"staff\ntelepy-users"}
                                className="font-mono"
                                spellCheck={false}
                                autoCapitalize="none"
                            />
                        </Field>

                        <div className="space-y-2">
                            <SectionHeading title={t("sso.roles.rules")} description={t("sso.roles.rulesHint")} />
                            {errors.group_rules && <p className="text-sm text-destructive">{errors.group_rules}</p>}
                            {rules.length === 0 && <p className="rounded-lg bg-surface px-3 py-2.5 text-sm text-muted-foreground">{t("sso.roles.noRules")}</p>}
                            <ul className="space-y-2">
                                {rules.map((r, i) => (
                                    <li key={i} className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto]">
                                        <Input
                                            value={r.idp_group}
                                            onChange={(e) => setRule(i, { idp_group: e.target.value })}
                                            placeholder={t("sso.roles.groupPlaceholder")}
                                            aria-label={t("sso.roles.idpGroup")}
                                            className="font-mono"
                                            spellCheck={false}
                                            autoCapitalize="none"
                                        />
                                        <ArrowRight size={14} className="hidden text-muted-foreground sm:block" aria-hidden />
                                        <NativeSelect value={ruleValue(r)} onChange={(e) => setRule(i, fromRuleValue(e.target.value))} aria-label={t("sso.roles.telepyRole")}>
                                            <option value="" disabled>
                                                {t("sso.roles.pick")}
                                            </option>
                                            <option value="admin">{t("sso.roles.admin")}</option>
                                            {userGroups.map((g) => (
                                                <option key={g.id} value={`group:${g.id}`}>
                                                    {t("sso.roles.userGroup", { name: g.name })}
                                                </option>
                                            ))}
                                            {r.target === "group" && r.group_id != null && !groupNames.has(r.group_id) && (
                                                <option value={`group:${r.group_id}`} disabled>
                                                    {t("sso.roles.goneGroup")}
                                                </option>
                                            )}
                                        </NativeSelect>
                                        <Button type="button" variant="ghost" size="sm" aria-label={t("common.delete")} title={t("common.delete")} onClick={() => set("group_rules", rules.filter((_, j) => j !== i))}>
                                            <Trash2 size={14} />
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                            <Button type="button" variant="outline" size="sm" onClick={() => set("group_rules", [...rules, { idp_group: "", target: userGroups.length ? "group" : "admin", group_id: userGroups[0]?.id ?? null }])}>
                                <Plus size={14} /> {t("sso.roles.add")}
                            </Button>
                            {userGroups.length === 0 && (
                                <p className="text-xs text-muted-foreground">
                                    {t("sso.roles.noUserGroups")}{" "}
                                    <Link href="/tunnels/admin/access" className="text-foreground underline underline-offset-2">
                                        {t("sso.roles.manageGroups")}
                                    </Link>
                                </p>
                            )}
                        </div>
                        {grantsAdmin(rules) && <Callout tone="warning">{t("sso.roles.adminWarn")}</Callout>}
                        <Callout tone="info">{t("sso.roles.how")}</Callout>
                    </div>
                )}
            </form>
        </Modal>
    );
}
