"use client";

/**
 * 網站設定 → 帳號與註冊 →「允許註冊的 Email 網域」：網域是可以移除的標籤，貼上一串會自動拆開，
 * 空清單說明代表什麼，還有「測試一個信箱」。每次加入或移除就存（跟其他設定一樣立即生效），存的仍是逗號接起來的字串。
 * Site settings → Account & registration → "Allowed registration email domains": domains as removable chips, a pasted
 * list is split, the empty state says what empty means, and "Test an address". Every add / remove saves at once
 * (like the other settings); what is stored is still the comma-joined string.
 */
import React, { useState } from "react";
import { AtSign, Plus, X } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Chip, SectionHeading } from "@/components/ui/section";
import { useUserManagement } from "@/hooks/useUserManagement";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import {
    addDomains, checkAddress, coverage, newlyRefused, DEFAULT_DOMAINS, DOMAINS_MAX, fitsLimit, joinDomains, parentInList, parseStored, storedLength,
    type AddResult, type DomainProblem,
} from "@/lib/registerDomains";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";

/** 由這個面板編輯，一般的設定清單不列。/ Edited here, so the generic list leaves it out. */
export const REGISTER_DOMAIN_KEYS = ["valid_register_domains"];

const KEY = "valid_register_domains";
const WHY: Record<DomainProblem, TranslationKey> = {
    empty: "regDomains.why.empty",
    wildcard: "regDomains.why.wildcard",
    unicode: "regDomains.why.unicode",
    tooLong: "regDomains.why.tooLong",
    noDot: "regDomains.why.noDot",
    emptyPart: "regDomains.why.emptyPart",
    partTooLong: "regDomains.why.partTooLong",
    badChar: "regDomains.why.badChar",
    hyphen: "regDomains.why.hyphen",
    numericTld: "regDomains.why.numericTld",
};

export function RegisterDomainsPanel({ values, onSave }: { values: Record<string, unknown>; onSave: (key: string, value: unknown) => Promise<void> | void }) {
    const { t } = useI18n();
    const list = parseStored(typeof values[KEY] === "string" ? (values[KEY] as string) : "");
    const registrationOpen = values.allow_registration !== false;
    const [draft, setDraft] = useState("");
    const [notice, setNotice] = useState<Pick<AddResult, "rejected" | "duplicates"> | null>(null);
    const [full, setFull] = useState(false);
    const [address, setAddress] = useState("");
    const { user: me } = useAuth();
    const { users } = useUserManagement(true);
    /** 會讓既有帳號被擋的變更，等確認再存。/ A change that would lock accounts out waits for a confirmation. */
    const [pending, setPending] = useState<{ next: string[]; lost: typeof users } | null>(null);

    const length = storedLength(list);
    const write = (next: string[]) => void onSave(KEY, joinDomains(next));
    const save = (next: string[]) => {
        const lost = newlyRefused(users, list, next);
        if (lost.length) setPending({ next, lost });
        else write(next);
    };
    // 自己排第一，其餘照名稱。/ You first, the rest by name.
    const lostSorted = pending ? [...pending.lost].sort((a, b) => Number(b.id === me?.id) - Number(a.id === me?.id) || a.username.localeCompare(b.username)) : [];

    const commit = (raw: string) => {
        if (!raw.trim()) return;
        const r = addDomains(list, raw);
        if (!fitsLimit(r.list)) {
            // 太長就一個都不加，輸入留著讓人修改。/ Too long: add nothing and keep the input.
            setFull(true);
            setNotice({ rejected: r.rejected, duplicates: r.duplicates });
            return;
        }
        setFull(false);
        setNotice(r.rejected.length || r.duplicates.length ? { rejected: r.rejected, duplicates: r.duplicates } : null);
        // 只有一個壞值時留在輸入框讓人改；多個就清掉，原因都列在下面。/ One bad value stays to be fixed; several are cleared (all listed below).
        setDraft(r.rejected.length === 1 && !r.added.length && !r.duplicates.length ? r.rejected[0].value : "");
        if (r.added.length) save(r.list);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" || e.key === "," || e.key === " " || e.key === ";") {
            e.preventDefault();
            commit(draft);
        }
    };
    const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
        const text = e.clipboardData.getData("text");
        if (/[\s,;]/.test(text.trim())) {
            e.preventDefault();
            commit(`${draft} ${text}`);
        }
    };
    const remove = (d: string) => {
        setFull(false);
        save(list.filter((x) => x !== d));
    };

    const check = address.trim() ? checkAddress(address, list) : null;
    const defaults = DEFAULT_DOMAINS.join(", ");

    return (
        <section className="overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card">
            <div className="p-4 sm:px-6 sm:pt-5 sm:pb-4">
                <SectionHeading
                    icon={<AtSign />}
                    title={t("siteSettings.valid_register_domains.label")}
                    description={t("regDomains.description")}
                />
            </div>

            <div className="space-y-5 border-t border-border/70 p-4 sm:px-6 sm:py-5">
                <div><Chip tone={registrationOpen ? "success" : "neutral"}>{t(registrationOpen ? "regDomains.regOpen" : "regDomains.regClosed")}</Chip></div>
                {!registrationOpen && <Callout tone="warning">{t("regDomains.closedNote")}</Callout>}

                <Field
                    label={t("regDomains.addLabel")}
                    addon={<span className={cn("tabular-nums", (full || length > DOMAINS_MAX) && "text-destructive")}>{t("regDomains.count", { count: length, max: DOMAINS_MAX })}</span>}
                    hint={t("regDomains.addHint")}
                    error={full ? t("regDomains.full", { max: DOMAINS_MAX }) : undefined}
                >
                    <div className="flex gap-2">
                        <Input
                            value={draft}
                            onChange={(e) => { setDraft(e.target.value); setNotice(null); setFull(false); }}
                            onKeyDown={onKeyDown}
                            onPaste={onPaste}
                            placeholder="mycorp.com"
                            autoComplete="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            inputMode="email"
                            aria-invalid={full || (notice?.rejected.length ?? 0) > 0 || undefined}
                        />
                        <Button type="button" variant="soft" className="shrink-0" onClick={() => commit(draft)} disabled={!draft.trim()}>
                            <Plus size={15} /> {t("regDomains.add")}
                        </Button>
                    </div>
                </Field>

                {notice && (notice.rejected.length > 0 || notice.duplicates.length > 0) && (
                    <div className="space-y-1.5 text-sm" role="alert">
                        {notice.rejected.map((r) => (
                            <p key={r.value} className="break-words text-destructive">{t(WHY[r.reason], { value: r.value })}</p>
                        ))}
                        {notice.duplicates.length > 0 && (
                            <p className="break-words text-muted-foreground">{t("regDomains.duplicates", { list: notice.duplicates.join(", ") })}</p>
                        )}
                    </div>
                )}

                {list.length > 0 ? (
                    <ul className="flex flex-wrap gap-2" aria-label={t("regDomains.listLabel")}>
                        {list.map((d) => (
                            <li key={d} className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted py-1 pl-2.5 pr-1 text-sm">
                                <span className="min-w-0 break-all font-mono">{d}</span>
                                {users.length > 0 && (
                                    <span className="text-xs tabular-nums text-muted-foreground" title={t("regDomains.coverTitle", { count: coverage(users, d) })}>{coverage(users, d)}</span>
                                )}
                                <button
                                    type="button"
                                    onClick={() => remove(d)}
                                    className="grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/30"
                                    aria-label={t("regDomains.remove", { domain: d })}
                                    title={t("regDomains.remove", { domain: d })}
                                >
                                    <X size={14} />
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <div className="rounded-lg border border-dashed border-border bg-surface p-4">
                        <p className="text-sm text-foreground">{t("regDomains.emptyTitle")}</p>
                        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t("regDomains.emptyBody", { default: defaults })}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                            {DEFAULT_DOMAINS.map((d) => (
                                <span key={d} className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1 font-mono text-sm text-muted-foreground">
                                    {d} <span className="font-sans text-xs">{t("regDomains.defaultTag")}</span>
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                <div className="border-t border-border/70 pt-4">
                    <Field label={t("regDomains.testLabel")} hint={t("regDomains.testHint")}>
                        <Input
                            type="email"
                            value={address}
                            onChange={(e) => setAddress(e.target.value)}
                            placeholder="someone@mycorp.com"
                            autoComplete="off"
                            autoCapitalize="none"
                            spellCheck={false}
                        />
                    </Field>
                    {check && (
                        <div className="mt-2 flex items-start gap-2 text-sm" aria-live="polite">
                            {check.kind === "invalid" ? (
                                <span className="text-muted-foreground">{t("regDomains.testInvalid")}</span>
                            ) : (
                                <>
                                    <Chip tone={check.kind === "allowed" ? "success" : "danger"} className="mt-px shrink-0">
                                        {t(check.kind === "allowed" ? "regDomains.testAllowed" : "regDomains.testBlocked")}
                                    </Chip>
                                    <span className="min-w-0 break-words leading-relaxed text-muted-foreground">
                                        {check.kind === "allowed"
                                            ? t(check.usingDefault ? "regDomains.whyAllowedDefault" : "regDomains.whyAllowed", { domain: check.domain })
                                            : t(check.usingDefault ? "regDomains.whyBlockedDefault" : "regDomains.whyBlocked", { domain: check.domain, default: defaults })}
                                        {check.kind === "blocked" && parentInList(check.domain, list) && ` ${t("regDomains.subdomainNote", { parent: parentInList(check.domain, list) ?? "" })}`}
                                        {check.kind === "allowed" && ` ${t(registrationOpen ? "regDomains.newAccountOpen" : "regDomains.newAccountClosed")}`}
                                    </span>
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>
            <ConfirmDialog
                isOpen={pending !== null}
                onClose={() => setPending(null)}
                onConfirm={() => { if (pending) write(pending.next); }}
                isDestructive
                title={t("regDomains.lockTitle")}
                confirmText={t("regDomains.lockConfirm")}
                message={
                    <>
                        <span className="block">{t("regDomains.lockBody", { count: lostSorted.length })}</span>
                        <span className="mt-2 block space-y-0.5 font-mono text-sm text-foreground">
                            {lostSorted.slice(0, 8).map((u) => (
                                <span key={u.id} className="block break-all">{u.id === me?.id ? t("regDomains.lockYou", { name: u.email }) : u.email}</span>
                            ))}
                            {lostSorted.length > 8 && <span className="block font-sans text-muted-foreground">{t("regDomains.lockMore", { count: lostSorted.length - 8 })}</span>}
                        </span>
                    </>
                }
            />
        </section>
    );
}
