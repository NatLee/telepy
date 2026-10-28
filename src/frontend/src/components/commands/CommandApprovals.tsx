"use client";

/**
 * 指令核准：
 * - CommandApprovalsProvider（AppLayout）：等「我」決定的申請（`/api/command-requests?status=pending`，加上
 *   COMMAND-APPROVAL-REQUESTED / DECIDED 通知），給側欄的數字與核准卡共用。
 * - CommandApprovalCenter：任何頁面右下角的核准卡（誰、哪條隧道、哪個帳號、完整指令、哪條規則、倒數），核准 / 拒絕（可附原因）；
 *   「稍後」收成一顆小膠囊，有新的申請再打開。指令規則頁本身已經列出來，那裡不顯示。
 * Command approvals: the provider (pending requests waiting for me, shared by the sidebar count and the cards) and
 * the approval cards in the bottom-right corner of every page, with approve / deny (optional reason); "Later"
 * collapses them into a pill until a new request arrives. Hidden on the command rules page, which lists them itself.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, Check, ChevronDown, ShieldAlert, SquareTerminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/section";
import { useToast } from "@/components/ui/Toast";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { countdown, dropRequest, secondsLeft, showsInCenter, upsertRequest } from "@/lib/commandRules";
import { useI18n } from "@/lib/i18n";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { useNotificationHandlers } from "@/lib/websocket";
import { cn } from "@/lib/utils";
import type { CommandRequest } from "@/types/commandRules";
import { RuleSource } from "./RuleList";

interface Approvals {
    /** 等我決定的申請（新的在前）。/ Requests waiting for my decision, newest first. */
    pending: CommandRequest[];
    reload: () => Promise<void>;
    /** 核准 / 拒絕；成功回 true。/ Approve or deny; true on success. */
    decide: (id: number, approve: boolean, reason?: string) => Promise<boolean>;
}

const ApprovalsContext = createContext<Approvals>({ pending: [], reload: async () => {}, decide: async () => false });

export const useCommandApprovals = () => useContext(ApprovalsContext);

export function CommandApprovalsProvider({ children }: { children: React.ReactNode }) {
    const { t } = useI18n();
    const { user } = useAuth();
    const { showError, showToast } = useToast();
    const me = user?.id;
    const [pending, setPending] = useState<CommandRequest[]>([]);

    const reload = useCallback(async () => {
        try {
            const res = await apiFetch("/api/command-requests?status=pending");
            if (!res.ok) return;
            const body = (await res.json()) as { requests: CommandRequest[] };
            setPending(body.requests.filter((r) => r.can_decide));
        } catch {
            /* 下一則通知或回到分頁時再試。/ Retried on the next notification or tab focus. */
        }
    }, []);

    useEffect(() => {
        const first = setTimeout(() => void reload(), 0);
        // 分頁回到前景時補抓（睡眠中漏掉的通知）。/ Catch up when the tab comes back (notifications missed while asleep).
        const onVisible = () => document.visibilityState === "visible" && void reload();
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            clearTimeout(first);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [reload]);

    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.COMMAND_APPROVAL_REQUESTED]: (msg) => {
            const req = msg.request as CommandRequest | undefined;
            const approvers = Array.isArray(msg.approver_ids) ? (msg.approver_ids as number[]) : [];
            if (req && me !== undefined && approvers.includes(me)) setPending((p) => upsertRequest(p, { ...req, can_decide: true }));
        },
        [NOTIFICATION_ACTIONS.COMMAND_APPROVAL_DECIDED]: (msg) => {
            const req = msg.request as CommandRequest | undefined;
            if (req) setPending((p) => dropRequest(p, req.id));
        },
    });

    const decide = useCallback(
        async (id: number, approve: boolean, reason?: string) => {
            const res = await apiFetch(`/api/command-requests/${id}/${approve ? "approve" : "deny"}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(approve ? {} : { reason: reason ?? "" }),
            });
            if (res.ok) {
                setPending((p) => dropRequest(p, id));
                return true;
            }
            const body = await readJson<{ code?: string }>(res);
            if (res.status === 409 || res.status === 404) {
                // 別人先決定了、或申請已經結束。/ Someone decided first, or the request is over.
                setPending((p) => dropRequest(p, id));
                showToast(t("commands.alreadyDecided"), "info");
                return false;
            }
            showError(responseError(res, body, t("commands.decideFailed")));
            return false;
        },
        [showError, showToast, t],
    );

    const value = useMemo(() => ({ pending, reload, decide }), [pending, reload, decide]);
    return <ApprovalsContext.Provider value={value}>{children}</ApprovalsContext.Provider>;
}

/** 每秒更新的倒數。/ A countdown that ticks every second. */
export function useCountdown(expires: string | null | undefined): number | null {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!expires) return;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [expires]);
    return secondsLeft(expires, now);
}

/** 指令本身：等寬、保留換行，太長先折起來。/ The command itself: monospace, line breaks kept, long ones folded. */
export function CommandText({ command, className }: { command: string; className?: string }) {
    const { t } = useI18n();
    const long = command.length > 240 || command.split("\n").length > 4;
    const [open, setOpen] = useState(false);
    return (
        <div className={cn("rounded-md border border-border bg-surface px-2.5 py-1.5", className)}>
            <pre className={cn("whitespace-pre-wrap break-all font-mono text-sm text-foreground", long && !open && "line-clamp-4")}>{command || "—"}</pre>
            {long && (
                <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1 text-xs text-primary hover:underline">
                    {open ? t("commands.showLess") : t("commands.showAll")}
                </button>
            )}
        </div>
    );
}

/** 從哪裡來：網頁終端機（區網主機）或 MCP app。/ Where it came from: the web terminal (a LAN host) or an MCP app. */
export function RequestOrigin({ req }: { req: Pick<CommandRequest, "source" | "client" | "account" | "lan_host" | "tunnel_name" | "tunnel_id"> }) {
    const { t } = useI18n();
    return (
        <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <span className="text-foreground">{req.tunnel_name ?? `#${req.tunnel_id}`}</span>
            <span aria-hidden>·</span>
            <Chip mono>{req.lan_host ?? req.account}</Chip>
            <span aria-hidden>·</span>
            {req.source === "agent" ? (
                <span className="inline-flex items-center gap-1">
                    <Bot size={13} aria-hidden /> {req.client ? t("commands.viaApp", { app: req.client }) : t("commands.viaAgent")}
                </span>
            ) : (
                <span className="inline-flex items-center gap-1">
                    <SquareTerminal size={13} aria-hidden /> {t("commands.viaTerminal")}
                </span>
            )}
        </span>
    );
}

/** 一張核准卡（也用在指令規則頁的「等你核准」）。/ One approval card (also used on the command rules page). */
export function ApprovalCard({ req, onDecide, className }: { req: CommandRequest; onDecide: (id: number, approve: boolean, reason?: string) => Promise<boolean>; className?: string }) {
    const { t } = useI18n();
    const { user } = useAuth();
    const left = useCountdown(req.expires_at);
    const [denying, setDenying] = useState(false);
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    const own = req.user.id === user?.id;
    const run = async (approve: boolean) => {
        setBusy(true);
        await onDecide(req.id, approve, reason.trim());
        setBusy(false);
    };
    return (
        <article className={cn("rounded-xl border border-border bg-card p-3 shadow-pop", className)} aria-label={t("commands.cardLabel", { user: req.user.username })}>
            <header className="flex items-start gap-2">
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-warning/12 text-warning">
                    <ShieldAlert size={16} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">{own ? t("commands.cardTitleOwn") : t("commands.cardTitle", { user: req.user.username })}</p>
                    <RequestOrigin req={req} />
                </div>
                {left !== null && (
                    <span className={cn("shrink-0 font-mono text-xs tabular-nums", left < 60 ? "text-destructive" : "text-muted-foreground")} title={t("commands.timeLeftHint")}>
                        {countdown(left)}
                    </span>
                )}
            </header>
            <CommandText command={req.command} className="mt-2" />
            <p className="mt-1.5 text-xs text-muted-foreground">
                <RuleSource rule={req.rule} /> <code className="font-mono text-foreground">{req.rule.pattern}</code>
                {req.rule.note && <span className="block text-foreground/80">“{req.rule.note}”</span>}
            </p>
            {denying ? (
                <form
                    className="mt-2.5 flex flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void run(false);
                    }}
                >
                    <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("commands.reasonPlaceholder")} maxLength={500} className="h-8 min-w-0 flex-1" autoFocus aria-label={t("commands.reason")} />
                    <Button type="button" size="sm" variant="ghost" onClick={() => setDenying(false)} disabled={busy}>
                        {t("common.back")}
                    </Button>
                    <Button type="submit" size="sm" variant="destructive" disabled={busy}>
                        <X /> {t("commands.deny")}
                    </Button>
                </form>
            ) : (
                <div className="mt-2.5 flex items-center justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setDenying(true)} disabled={busy}>
                        <X /> {t("commands.deny")}
                    </Button>
                    <Button size="sm" onClick={() => void run(true)} disabled={busy}>
                        <Check /> {t("commands.approve")}
                    </Button>
                </div>
            )}
        </article>
    );
}

/** 右下角的核准卡。/ The approval cards in the bottom-right corner. */
export function CommandApprovalCenter() {
    const { t } = useI18n();
    const { user } = useAuth();
    const pathname = usePathname();
    const { pending, decide } = useCommandApprovals();
    const shown = pending.filter((r) => showsInCenter(r, user?.id, undefined));
    const [collapsed, setCollapsed] = useState(false);
    // 有新的申請就再打開。/ A new request opens it again.
    const newest = shown[0]?.id ?? 0;
    const seen = useRef(newest);
    if (newest > seen.current) {
        seen.current = newest;
        if (collapsed) setCollapsed(false);
    }
    if (shown.length === 0 || pathname?.startsWith("/tunnels/commands")) return null;

    if (collapsed) {
        return (
            <button
                type="button"
                onClick={() => setCollapsed(false)}
                className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-foreground shadow-pop hover:bg-muted"
            >
                <ShieldAlert size={15} className="text-warning" aria-hidden />
                {t("commands.waitingPill", { count: shown.length })}
            </button>
        );
    }
    const visible = shown.slice(0, 2);
    return (
        <section aria-label={t("commands.centerLabel")} className="fixed bottom-4 right-4 z-40 flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2">
            <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground shadow-pop">
                <span>{t("commands.waitingPill", { count: shown.length })}</span>
                <span className="flex items-center gap-1">
                    <Link href="/tunnels/commands" className="rounded-sm px-1.5 py-0.5 text-primary hover:underline">
                        {t("commands.openList")}
                    </Link>
                    <Button size="icon-xs" variant="ghost" onClick={() => setCollapsed(true)} aria-label={t("commands.later")} title={t("commands.later")}>
                        <ChevronDown />
                    </Button>
                </span>
            </div>
            {visible.map((r) => (
                <ApprovalCard key={r.id} req={r} onDecide={decide} />
            ))}
        </section>
    );
}
