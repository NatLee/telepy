/**
 * 存取申請的畫面：
 * - RequestAccessDialog：被分享的人要帳號 / 更高權限一段時間（隧道選單、終端機「沒有帳號」頁）
 * - AccessRequestsPanel：owner / ADMIN 在分享視窗最上面核准或拒絕
 * - TemporaryGrantText：已分享列表裡「暫時：root、Edit · 2 小時後結束」
 * Access request UI: the sharee's request dialog, the owner / ADMIN panel at the top of the share dialog, and the
 * "temporary" line on shared rows.
 */
import React, { useState } from "react";
import { Check, Clock, Hourglass, KeyRound, ShieldPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/Modal";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { Chip, SectionHeading } from "@/components/ui/section";
import { Textarea } from "@/components/ui/textarea";
import { useAccessRequests } from "@/hooks/useAccessRequests";
import { durationLabel, higherPermissions, REQUEST_DURATIONS } from "@/lib/accessRequests";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import { shareEndsIn, shareExpiryState } from "@/lib/shareExpiry";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import type { AccessRequest, SharePermission } from "@/types/accessRequest";

const PERM_LABEL: Record<string, TranslationKey> = { view: "share.permView", edit: "share.permEdit", admin: "share.permAdmin" };
const REASON_MAX = 500;

function useDurationText() {
    const { t } = useI18n();
    return (secs: number) => {
        const { key, n } = durationLabel(secs);
        return t(key, n === undefined ? undefined : { n });
    };
}

/** 申請的內容：帳號（等寬）+ 權限的小標籤。/ What a request asks for, as chips. */
function RequestChips({ request }: { request: AccessRequest }) {
    const { t } = useI18n();
    return (
        <span className="inline-flex flex-wrap items-center gap-1">
            {request.accounts.map((a) => (
                <Chip key={a.id} mono>
                    {a.username ?? `#${a.id}`}
                </Chip>
            ))}
            {request.permission && (
                <Chip>
                    <ShieldPlus aria-hidden /> {t(PERM_LABEL[request.permission])}
                </Chip>
            )}
        </span>
    );
}

/** 已決定的申請一行：誰、什麼時候、到什麼時候。/ One decided request: who decided, and until when. */
function DecidedLine({ request }: { request: AccessRequest }) {
    const { t, locale } = useI18n();
    const by = request.decided_by ?? "";
    const text =
        request.status === "approved"
            ? request.ends_at && shareExpiryState(request.ends_at) !== "ending"
                ? t("share.request.status.approvedUntil", { by, when: shareEndsIn(request.ends_at, locale) })
                : t("share.request.status.approved", { by })
            : request.status === "denied"
              ? t("share.request.status.denied", { by })
              : t("share.request.status.cancelled");
    return (
        <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <RequestChips request={request} />
            <span className={cn("text-xs", request.status === "approved" ? "text-success" : "text-muted-foreground")} title={request.decided_at ? new Date(request.decided_at).toLocaleString(locale) : undefined}>
                {text}
            </span>
        </li>
    );
}

/** 被分享的人：要帳號 / 更高權限一段時間。/ A sharee asks for accounts or a higher permission for a while. */
export function RequestAccessDialog({ isOpen, onClose, tunnelId, tunnelName }: { isOpen: boolean; onClose: () => void; tunnelId: number | null; tunnelName?: string }) {
    const { t, locale } = useI18n();
    const durationText = useDurationText();
    const { data, busy, create, cancel } = useAccessRequests(tunnelId, isOpen);
    const [picked, setPicked] = useState<number[]>([]);
    const [permission, setPermission] = useState<SharePermission | "keep">("keep");
    const [duration, setDuration] = useState(8 * 3600);
    const [reason, setReason] = useState("");

    const pending = data?.requests.find((r) => r.status === "pending");
    const history = (data?.requests ?? []).filter((r) => r.status !== "pending").slice(0, 3);
    const accounts = data?.accounts ?? [];
    const higher = higherPermissions(data?.permission ?? "admin");
    const nothingToAsk = !!data && accounts.every((a) => a.allowed) && higher.length === 0;
    const canSend = !pending && !busy && (picked.length > 0 || permission !== "keep") && reason.length <= REASON_MAX;

    const close = () => {
        setPicked([]);
        setPermission("keep");
        setReason("");
        onClose();
    };
    const submit = async () => {
        const ok = await create({ account_ids: picked, permission: permission === "keep" ? null : permission, duration_secs: duration, reason: reason.trim() });
        if (ok) {
            setPicked([]);
            setPermission("keep");
            setReason("");
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={close}
            title={t("share.request.title")}
            description={t("share.request.description", { name: tunnelName ?? "" })}
            icon={<KeyRound />}
            size="lg"
            isLoading={!data && isOpen}
            footer={
                pending || nothingToAsk ? (
                    <Button variant="outline" onClick={close}>
                        {t("common.close")}
                    </Button>
                ) : (
                    <>
                        <Button variant="outline" onClick={close}>
                            {t("common.cancel")}
                        </Button>
                        <Button onClick={submit} disabled={!canSend}>
                            {t("share.request.send")}
                        </Button>
                    </>
                )
            }
        >
            <div className="space-y-5">
                {pending ? (
                    <Callout tone="info" icon={<Hourglass size={17} className="mt-0.5 shrink-0" aria-hidden />} title={t("share.request.pendingTitle")}>
                        <div className="space-y-2">
                            <RequestChips request={pending} />
                            <p>
                                {t("share.request.pendingBody", { duration: durationText(pending.duration_secs), when: formatRelativeTime(pending.created_at, locale) })}
                            </p>
                            {pending.reason && <p className="text-muted-foreground">“{pending.reason}”</p>}
                            <Button variant="outline" size="sm" disabled={busy} onClick={() => cancel(pending.id)}>
                                {t("share.request.withdraw")}
                            </Button>
                        </div>
                    </Callout>
                ) : nothingToAsk ? (
                    <Callout tone="tip">{t("share.request.nothingMore")}</Callout>
                ) : (
                    data && (
                        <>
                            {accounts.length > 0 && (
                                <div className="space-y-2">
                                    <p className="text-sm text-foreground">{t("share.request.accounts")}</p>
                                    <div className="flex flex-wrap gap-2">
                                        {accounts.map((a) => (
                                            <label
                                                key={a.id}
                                                className={cn(
                                                    "flex items-center gap-2 rounded-full bg-card px-3 py-1.5 text-xs ring-1 ring-inset ring-border transition-colors",
                                                    a.allowed ? "cursor-default text-muted-foreground" : "cursor-pointer hover:ring-foreground/20 has-checked:bg-primary/10 has-checked:text-primary has-checked:ring-primary/40",
                                                )}
                                            >
                                                <input
                                                    type="checkbox"
                                                    className="size-3.5 accent-primary"
                                                    disabled={a.allowed}
                                                    checked={a.allowed || picked.includes(a.id)}
                                                    onChange={(e) => setPicked((prev) => (e.target.checked ? [...prev, a.id] : prev.filter((id) => id !== a.id)))}
                                                />
                                                <code className="font-mono">{a.username}</code>
                                                {a.allowed && (
                                                    <span className="text-[0.6875rem]">
                                                        {a.until ? t("share.request.until", { when: shareEndsIn(a.until, locale) }) : t("share.request.youHaveIt")}
                                                    </span>
                                                )}
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {higher.length > 0 && (
                                <div className="space-y-2">
                                    <p className="text-sm text-foreground">{t("share.request.permission")}</p>
                                    <Segmented
                                        size="sm"
                                        value={permission}
                                        onChange={setPermission}
                                        aria-label={t("share.request.permission")}
                                        options={[
                                            { value: "keep" as const, label: t("share.request.keep", { permission: t(PERM_LABEL[data.permission] ?? "share.permView") }) },
                                            ...higher.map((p) => ({ value: p, label: t(PERM_LABEL[p]) })),
                                        ]}
                                    />
                                </div>
                            )}
                            <Field label={t("share.request.duration")}>
                                <NativeSelect value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="w-48">
                                    {REQUEST_DURATIONS.map((d) => (
                                        <option key={d.secs} value={d.secs}>
                                            {t(d.label)}
                                        </option>
                                    ))}
                                </NativeSelect>
                            </Field>
                            <Field label={t("share.request.reason")} hint={`${reason.length} / ${REASON_MAX}`} error={reason.length > REASON_MAX ? t("share.request.err.reason") : undefined}>
                                <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("share.request.reasonPlaceholder")} />
                            </Field>
                            <p className="text-xs text-muted-foreground">{t("share.request.endsOnItsOwn")}</p>
                        </>
                    )
                )}
                {history.length > 0 && (
                    <section>
                        <SectionHeading title={t("share.request.history")} className="mb-1" />
                        <ul className="divide-y divide-border/70">
                            {history.map((r) => (
                                <DecidedLine key={r.id} request={r} />
                            ))}
                        </ul>
                    </section>
                )}
            </div>
        </Modal>
    );
}

/** 一筆等待中的申請：內容、理由、時長（可改）、核准 / 拒絕。/ One pending request with approve / decline. */
function PendingRequest({ request, busy, onApprove, onDeny }: { request: AccessRequest; busy: boolean; onApprove: (secs: number) => void; onDeny: () => void }) {
    const { t, locale } = useI18n();
    const durationText = useDurationText();
    const [secs, setSecs] = useState(request.duration_secs);
    const options: { secs: number; label: TranslationKey | null }[] = REQUEST_DURATIONS.some((d) => d.secs === request.duration_secs)
        ? REQUEST_DURATIONS
        : [{ secs: request.duration_secs, label: null }, ...REQUEST_DURATIONS];
    return (
        <li className="space-y-2.5 px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-foreground text-xs text-background uppercase" aria-hidden>
                    {(request.requester.username ?? "?").slice(0, 1)}
                </span>
                <span className="text-sm text-foreground">{request.requester.username}</span>
                <span className="text-xs text-muted-foreground">{t("share.request.asksFor")}</span>
                <RequestChips request={request} />
                <span className="ml-auto text-xs text-muted-foreground" title={new Date(request.created_at).toLocaleString(locale)}>
                    {formatRelativeTime(request.created_at, locale)}
                </span>
            </div>
            {request.reason && <p className="border-l-2 border-border pl-2.5 text-sm text-muted-foreground">{request.reason}</p>}
            <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock size={13} aria-hidden />
                    {t("share.request.grantFor")}
                    <NativeSelect value={secs} onChange={(e) => setSecs(Number(e.target.value))} className="h-8 w-36 text-xs">
                        {options.map((d) => (
                            <option key={d.secs} value={d.secs}>
                                {d.label ? t(d.label) : durationText(d.secs)}
                            </option>
                        ))}
                    </NativeSelect>
                </label>
                <div className="ml-auto flex gap-2">
                    <Button variant="ghost" size="sm" disabled={busy} onClick={onDeny}>
                        <X /> {t("share.request.deny")}
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => onApprove(secs)}>
                        <Check /> {t("share.request.approve")}
                    </Button>
                </div>
            </div>
        </li>
    );
}

/** 分享視窗最上面：等待中的申請（沒有就不顯示）。/ Top of the share dialog: pending requests (hidden when none). */
export function AccessRequestsPanel({ tunnelId, enabled, onDecided }: { tunnelId: number | null; enabled: boolean; onDecided?: () => void }) {
    const { t } = useI18n();
    const { data, busy, approve, deny } = useAccessRequests(tunnelId, enabled);
    // 自己做的決定不會收到通知：成功後讓分享名單重抓。/ Our own decision sends us no notification: refresh the list.
    const decide = async (run: Promise<boolean>) => {
        if (await run) onDecided?.();
    };
    const pending = data?.can_decide ? data.requests.filter((r) => r.status === "pending") : [];
    if (pending.length === 0) return null;
    return (
        <section>
            <h3 className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                {t("share.request.panelTitle")}
                <span className="rounded-full bg-warning/12 px-1.5 py-px tabular-nums text-warning">{pending.length}</span>
            </h3>
            <ul className="divide-y divide-border/70 overflow-hidden rounded-xl ring-1 ring-inset ring-warning/40">
                {pending.map((r) => (
                    <PendingRequest key={r.id} request={r} busy={busy} onApprove={(secs) => decide(approve(r.id, secs))} onDeny={() => decide(deny(r.id))} />
                ))}
            </ul>
        </section>
    );
}

/** 已分享列表：核准的申請給的暫時帳號 / 權限，與最早結束的時間。/ Temporary accounts / permission on a shared row. */
export function TemporaryGrantText({
    accounts,
    permission,
    permissionUntil,
}: {
    accounts: { username: string; until?: string | null }[];
    permission?: string;
    permissionUntil?: string | null;
}) {
    const { t, locale } = useI18n();
    const temp = accounts.filter((a) => a.until);
    const items = temp.map((a) => a.username);
    if (permissionUntil && permission) items.push(t(PERM_LABEL[permission] ?? "share.permView"));
    if (items.length === 0) return null;
    const ends = [...temp.map((a) => a.until as string), ...(permissionUntil ? [permissionUntil] : [])].sort()[0];
    return (
        <span className="inline-flex items-start gap-1 text-xs text-info" title={new Date(ends).toLocaleString(locale)}>
            <Hourglass size={12} className="mt-0.5 shrink-0" aria-hidden />
            {t("share.request.temporary", { what: items.join(", "), when: shareEndsIn(ends, locale) })}
        </span>
    );
}
