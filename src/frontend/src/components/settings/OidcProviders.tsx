"use client";

/**
 * 網站設定 → 登入 →「單一登入（OIDC）」：身分提供者的清單（開關、回呼網址、連了幾個帳號、試登入、修改、刪除），
 * 新增 / 修改的對話框（issuer 的 discovery 檢查、要在身分提供者那邊登記的回呼網址、帳號規則），與「怎麼運作」說明圖。
 * Site settings → Sign-in → "Single sign-on (OIDC)": the providers (switch, callback URL, linked accounts, test
 * sign-in, edit, delete), the add / edit dialog (discovery check, the callback URL to register, account rules) and
 * the "How it works" diagram.
 */
import React, { useState } from "react";
import { Building2, CircleHelp, Copy, FlaskConical, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { NativeSelect } from "@/components/ui/native-select";
import { Chip, SectionHeading } from "@/components/ui/section";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/Toast";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { OidcFlowDialog } from "@/components/sso/OidcFlow";
import { useOidcProviders, type Discovery, type FieldErrors, type OidcProvider, type ProviderDraft } from "@/hooks/useOidcProviders";
import { useI18n } from "@/lib/i18n";
import { badDomain, parseDomains, slugify } from "@/lib/sso";

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
    return { name: "", slug: "", issuer: "", client_id: "", client_secret: "", scopes: "openid email profile", username_from: "email", allowed_domains: [], create_users: true, link_by_email: false, enabled: true };
}

function draftOf(p: OidcProvider): ProviderDraft {
    return { name: p.name, slug: p.slug, issuer: p.issuer, client_id: p.client_id, scopes: p.scopes, username_from: p.username_from, allowed_domains: p.allowed_domains, create_users: p.create_users, link_by_email: p.link_by_email, enabled: p.enabled };
}

function ProviderDialog({
    provider,
    callbackBase,
    onClose,
    onSave,
    discover,
}: {
    provider: OidcProvider | null;
    callbackBase: string;
    onClose: () => void;
    onSave: (draft: ProviderDraft) => Promise<FieldErrors | null>;
    discover: (issuer: string) => Promise<Discovery | { fieldError: string }>;
}) {
    const { t } = useI18n();
    const [draft, setDraft] = useState<ProviderDraft>(() => (provider ? draftOf(provider) : emptyDraft()));
    /** 代號自己改過就不再跟著名字。/ Once the slug is edited it stops following the name. */
    const [slugTouched, setSlugTouched] = useState(!!provider);
    const [domains, setDomains] = useState(() => draft.allowed_domains.join(", "));
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

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (domainProblem) {
            setErrors((x) => ({ ...x, allowed_domains: t("sso.admin.badDomain", { domain: domainProblem }) }));
            return;
        }
        const body: ProviderDraft = { ...draft, slug, allowed_domains: parsedDomains };
        delete body.client_secret;
        if (dropSecret) body.client_secret = "";
        else if (secret.trim()) body.client_secret = secret.trim();
        setSaving(true);
        try {
            const errs = await onSave(body);
            if (errs) setErrors(errs);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            isOpen
            onClose={onClose}
            size="2xl"
            icon={<Building2 />}
            title={provider ? t("sso.admin.editTitle", { name: provider.name }) : t("sso.admin.addTitle")}
            description={t("sso.admin.dialogDescription")}
            footer={
                <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" onClick={onClose}>
                        {t("common.cancel")}
                    </Button>
                    <Button type="submit" form="oidc-provider-form" disabled={saving}>
                        {t("common.save")}
                    </Button>
                </div>
            }
        >
            <form id="oidc-provider-form" onSubmit={submit} className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
                    <Field label={t("sso.admin.name")} hint={t("sso.admin.nameHint")} error={errors.name}>
                        <Input value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Okta" maxLength={64} required autoFocus />
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
                            required
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
                        <Input value={draft.client_id} onChange={(e) => set("client_id", e.target.value)} className="font-mono" spellCheck={false} autoCapitalize="none" autoComplete="off" required />
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

                <fieldset className="min-w-0 space-y-3 rounded-lg p-4 ring-1 ring-inset ring-border/80">
                    <legend className="px-1 text-sm">{t("sso.admin.accounts")}</legend>
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
                </fieldset>

                <Field label={t("sso.admin.scopes")} hint={t("sso.admin.scopesHint")} error={errors.scopes}>
                    <Input value={draft.scopes} onChange={(e) => set("scopes", e.target.value)} className="font-mono" spellCheck={false} autoCapitalize="none" />
                </Field>

                <Switch size="sm" checked={draft.enabled} onCheckedChange={(v) => set("enabled", v)}>
                    <span className="text-sm">{t("sso.admin.enabled")}</span>
                </Switch>
                {draft.enabled && !provider && <p className="text-xs text-muted-foreground">{t("sso.admin.enabledHint")}</p>}
            </form>
        </Modal>
    );
}
