"use client";

/**
 * 「你的裝置」：目前登入中的瀏覽器，依「瀏覽器 · 系統」分組，每個一列（IP + 位置、這個瀏覽器、登入 / 最後使用 / 到期、
 * 登入方式），可以逐一登出或「登出其他所有裝置」。登出這個瀏覽器 = 一般登出。管理員在「管理使用者」看別人的
 * （`userId`；撤銷原因 = admin）。標題旁的 i 打開說明圖（SessionInfoDialog）。
 * "Your devices": the browsers signed in right now, grouped by browser + OS, one row each (IP + place, this
 * browser, signed in / last active / ends, method), with per-row sign-out and "sign out everywhere else". Signing
 * out this browser is a normal logout. Admins see anyone's in Manage user (`userId`; reason admin). The i button
 * beside the title opens the explainer diagram.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Globe, Info, Laptop, LogOut, MonitorSmartphone, Smartphone } from "lucide-react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { formatRelativeTime } from "@/lib/relativeTime";
import { groupSessions, type DeviceKind, type WebSessionList, type WebSessionRow } from "@/lib/webSessions";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { IpPlace } from "@/components/ui/IpPlace";
import { Chip, SectionHeading } from "@/components/ui/section";
import { useToast } from "@/components/ui/Toast";
import { FACTOR_KEYS, METHOD_KEYS } from "./SignInHistory";
import { SessionInfoDialog } from "./SessionLifeDiagram";

const KIND_ICON: Record<DeviceKind, typeof Laptop> = { computer: Laptop, phone: Smartphone, unknown: Globe };

type Pending = { kind: "one"; row: WebSessionRow; label: string } | { kind: "others"; count: number } | { kind: "all" };

export function SignInDevices({ userId, userName }: { userId?: number; userName?: string }) {
    const { t, locale } = useI18n();
    const { logout } = useAuth();
    const { showToast } = useToast();
    const admin = userId !== undefined;
    const base = admin ? `/api/user/users/${userId}/sessions` : "/api/auth/sessions";
    const [list, setList] = useState<WebSessionList | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<Pending | null>(null);
    const [infoOpen, setInfoOpen] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await apiFetch(base);
            const data = res.ok ? await readJson<WebSessionList>(res) : null;
            if (data && Array.isArray(data.sessions)) {
                setList(data);
                setFailed(false);
            } else setFailed(true);
        } catch {
            setFailed(true);
        }
    }, [base]);

    useEffect(() => {
        void load();
    }, [load]);

    // 自己的清單：有新的登入就重抓。/ Your own list: reload on a new sign-in.
    useNotificationHandlers(admin ? {} : { [NOTIFICATION_ACTIONS.SIGN_IN_NEW_DEVICE]: () => void load() });

    const deviceName = (row: WebSessionRow) => row.device ?? t("security.unknownDevice");
    const when = (iso: string) => {
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
    };
    const how = (row: WebSessionRow) => {
        if (!row.sign_in_method) return t("security.devices.legacy");
        const method = METHOD_KEYS[row.sign_in_method] ? t(METHOD_KEYS[row.sign_in_method]) : row.sign_in_method;
        if (!row.mfa_method) return method;
        const factor = FACTOR_KEYS[row.mfa_method] ? t(FACTOR_KEYS[row.mfa_method]) : row.mfa_method;
        return t("security.signInWith", { method, factor });
    };

    const run = async () => {
        if (!pending) return;
        const p = pending;
        setPending(null);
        // 登出這個瀏覽器 = 一般登出（清本機 + 撤銷 + 回登入頁）。/ This browser = a normal logout.
        if (p.kind === "one" && p.row.current) {
            logout();
            return;
        }
        setBusy(true);
        try {
            const url = p.kind === "one" ? `${base}/${p.row.id}` : p.kind === "others" ? `${base}?others=1` : base;
            const res = await apiFetch(url, { method: "DELETE" });
            if (!res.ok) {
                showToast(responseError(res, await readJson(res), t("security.devices.failed")), "error");
            } else if (p.kind === "one") {
                showToast(t("security.devices.signedOutOne", { device: p.label }), "success");
            } else {
                const n = (await readJson<{ revoked?: number }>(res))?.revoked ?? 0;
                showToast(t("security.devices.signedOutMany", { count: n }), "success");
            }
        } catch {
            showToast(t("security.devices.failed"), "error");
        } finally {
            setBusy(false);
            void load();
        }
    };

    const sessions = list?.sessions ?? [];
    const others = sessions.filter((s) => !s.current).length;
    const groups = groupSessions(sessions);

    const action = (
        <div className="flex items-center gap-1">
            {list && (
                <Button variant="ghost" size="icon-sm" onClick={() => setInfoOpen(true)} aria-label={t("security.devices.info")} title={t("security.devices.info")}>
                    <Info size={16} />
                </Button>
            )}
        </div>
    );
    // 「登出其他所有裝置」放在清單下面，不跟標題搶寬度（手機上標題會被擠成一條）。
    // "Sign out everywhere else" sits under the list so it never squeezes the heading on phones.
    const bulk =
        others > 0 ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setPending(admin ? { kind: "all" } : { kind: "others", count: others })}>
                <LogOut size={14} /> {t(admin ? "security.devices.signOutAll" : "security.devices.signOutOthers")}
            </Button>
        ) : null;

    return (
        <section className="space-y-3">
            <SectionHeading
                icon={<MonitorSmartphone />}
                title={t(admin ? "security.devices.adminTitle" : "security.devices.title")}
                description={t(admin ? "security.devices.adminDescription" : "security.devices.description")}
                action={action}
            />
            {failed && !list ? (
                <p className="text-xs text-destructive">{t("security.devices.loadFailed")}</p>
            ) : !list ? (
                <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
            ) : sessions.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("security.devices.empty")}</p>
            ) : (
                <div className="space-y-2">
                    {groups.map((g) => {
                        const Icon = KIND_ICON[g.kind];
                        return (
                            <div key={g.label ?? "unknown"} className="rounded-xl border border-border bg-card">
                                <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-foreground" aria-hidden>
                                        <Icon size={15} />
                                    </span>
                                    <span className="min-w-0 truncate text-sm text-foreground">{g.label ?? t("security.unknownDevice")}</span>
                                    {g.sessions.length > 1 && <Chip>{t("security.devices.sessions", { count: g.sessions.length })}</Chip>}
                                </div>
                                <ul className="divide-y divide-border">
                                    {g.sessions.map((row) => (
                                        <li key={row.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start">
                                            <div className="min-w-0 flex-1 space-y-0.5">
                                                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                                                    {row.current && <Chip tone="primary">{t("security.devices.thisBrowser")}</Chip>}
                                                    <span className="font-mono text-xs text-foreground/80" title={row.user_agent ?? undefined}>
                                                        {row.ip ?? t("security.unknownIp")}
                                                    </span>
                                                    <IpPlace geo={row.geo} className="text-xs" />
                                                </p>
                                                <p className="text-xs text-muted-foreground">
                                                    {t("security.devices.signedIn", { when: when(row.created_at) })} · {how(row)}
                                                </p>
                                                <p className="text-xs text-muted-foreground">
                                                    {t("security.devices.lastActive", { when: formatRelativeTime(row.last_seen_at, locale) })} ·{" "}
                                                    <span title={when(row.expires_at)}>{t("security.devices.expires", { when: formatRelativeTime(row.expires_at, locale) })}</span>
                                                </p>
                                            </div>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="self-start"
                                                disabled={busy}
                                                onClick={() => setPending({ kind: "one", row, label: deviceName(row) })}
                                            >
                                                <LogOut size={14} /> {t("security.devices.signOut")}
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        );
                    })}
                    {!admin && others === 0 && <p className="text-xs text-muted-foreground">{t("security.devices.onlyThis")}</p>}
                    {bulk}
                </div>
            )}

            {list && <SessionInfoDialog isOpen={infoOpen} onClose={() => setInfoOpen(false)} list={list} forOther={admin} />}
            <ConfirmDialog
                isOpen={pending !== null}
                onClose={() => setPending(null)}
                onConfirm={() => void run()}
                isDestructive
                title={
                    pending?.kind === "one"
                        ? t("security.devices.confirmOneTitle", { device: pending.label })
                        : pending?.kind === "others"
                          ? t("security.devices.confirmOthersTitle", { count: pending.count })
                          : t("security.devices.confirmAllTitle", { user: userName ?? "" })
                }
                message={
                    pending?.kind === "one"
                        ? t("security.devices.confirmOneMessage")
                        : pending?.kind === "others"
                          ? t("security.devices.confirmOthersMessage")
                          : t("security.devices.confirmAllMessage")
                }
                confirmText={pending?.kind === "all" ? t("security.devices.signOutAll") : pending?.kind === "others" ? t("security.devices.signOutOthers") : t("security.devices.signOut")}
            />
        </section>
    );
}
