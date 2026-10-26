/**
 * 指令規則頁的資料：範圍（全站或一條隧道，`?tunnel=`）、分頁（`?tab=rules|history`）、規則的增刪改、試跑一個指令，
 * 以及紀錄（被擋下與送核准的指令；有新的申請或決定就重抓）。
 * Data for the command rules page: the scope (site-wide or one tunnel, `?tunnel=`), the tab (`?tab=rules|history`),
 * rule create / change / delete, trying a command, and the history (blocked and held commands; refetched on new
 * requests and decisions).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { useNotificationHandlers } from "@/lib/websocket";
import type { CheckResult, CommandRequest, CommandRule, RuleInput, SiteRules, TunnelRules } from "@/types/commandRules";

export type RulesTab = "rules" | "history";

/** 存規則時欄位的錯誤（`{pattern: [msg]}`）。/ Field errors from saving a rule. */
export type RuleErrors = Partial<Record<keyof RuleInput, string>>;

export function useCommandRulesPage() {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const router = useRouter();
    const params = useSearchParams();
    const tunnelId = Number(params.get("tunnel")) || null;
    const tab: RulesTab = params.get("tab") === "history" ? "history" : "rules";

    const [tunnels, setTunnels] = useState<{ id: number; name: string }[]>([]);
    const [site, setSite] = useState<SiteRules | null>(null);
    const [tunnelRules, setTunnelRules] = useState<TunnelRules | null>(null);
    const [history, setHistory] = useState<CommandRequest[] | null>(null);
    const [failed, setFailed] = useState(false);

    const go = useCallback(
        (next: { tunnel?: number | null; tab?: RulesTab }) => {
            const q = new URLSearchParams();
            const tid = next.tunnel === undefined ? tunnelId : next.tunnel;
            const tb = next.tab ?? tab;
            if (tid) q.set("tunnel", String(tid));
            if (tb !== "rules") q.set("tab", tb);
            const s = q.toString();
            router.replace(s ? `/tunnels/commands?${s}` : "/tunnels/commands");
        },
        [router, tunnelId, tab],
    );

    const loadRules = useCallback(async () => {
        try {
            const [s, tr] = await Promise.all([
                apiFetch("/api/command-rules"),
                tunnelId ? apiFetch(`/api/reverse/server/${tunnelId}/command-rules`) : Promise.resolve(null),
            ]);
            if (s.ok) setSite((await s.json()) as SiteRules);
            if (tr) {
                if (tr.ok) setTunnelRules((await tr.json()) as TunnelRules);
                else setTunnelRules(null);
            } else {
                setTunnelRules(null);
            }
            setFailed(!s.ok || (tr !== null && !tr.ok));
        } catch {
            setFailed(true);
        }
    }, [tunnelId]);

    const loadHistory = useCallback(async () => {
        try {
            const res = await apiFetch(`/api/command-requests?limit=300${tunnelId ? `&tunnel_id=${tunnelId}` : ""}`);
            if (res.ok) setHistory(((await res.json()) as { requests: CommandRequest[] }).requests);
        } catch {
            /* 下次通知再抓。/ Retried on the next notification. */
        }
    }, [tunnelId]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch("/api/reverse/server/dashboard");
                const body = await readJson<{ tunnels?: { id: number; host_friendly_name: string }[] }>(res);
                if (!cancelled && res.ok && Array.isArray(body?.tunnels)) {
                    setTunnels(body!.tunnels.map((x) => ({ id: x.id, name: x.host_friendly_name })).sort((a, b) => a.name.localeCompare(b.name)));
                }
            } catch {
                /* 只影響選單。/ Only the picker is affected. */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const first = setTimeout(() => {
            void loadRules();
            void loadHistory();
        }, 0);
        return () => clearTimeout(first);
    }, [loadRules, loadHistory]);

    // 申請 / 決定一來就重抓紀錄（同一輪的幾則合併成一次）。/ Refetch the history on requests and decisions (coalesced).
    const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const refetchSoon = useCallback(() => {
        if (refetchTimer.current) clearTimeout(refetchTimer.current);
        refetchTimer.current = setTimeout(() => void loadHistory(), 250);
    }, [loadHistory]);
    useEffect(() => () => {
        if (refetchTimer.current) clearTimeout(refetchTimer.current);
    }, []);
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.COMMAND_APPROVAL_REQUESTED]: refetchSoon,
        [NOTIFICATION_ACTIONS.COMMAND_APPROVAL_DECIDED]: refetchSoon,
    });

    /** 新增或修改；欄位錯誤回傳給表單。/ Create or change; field errors go back to the form. */
    const saveRule = async (input: RuleInput, existing: CommandRule | null): Promise<RuleErrors | null> => {
        const url = existing ? `/api/command-rules/${existing.id}` : tunnelId ? `/api/reverse/server/${tunnelId}/command-rules` : "/api/command-rules";
        const res = await apiFetch(url, { method: existing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
        if (res.ok) {
            showSuccess(t(existing ? "commands.ruleSaved" : "commands.ruleAdded"));
            await loadRules();
            return null;
        }
        const body = await readJson<Record<string, unknown>>(res);
        const errors: RuleErrors = {};
        for (const k of ["action", "kind", "pattern", "who", "via", "note", "enabled", "approver_ids"] as const) {
            const v = body?.[k];
            if (Array.isArray(v) && typeof v[0] === "string") errors[k] = v[0];
        }
        if (Object.keys(errors).length > 0) return errors;
        showError(responseError(res, body, t("commands.saveFailed")));
        return {};
    };

    const toggleRule = async (rule: CommandRule) => {
        const res = await apiFetch(`/api/command-rules/${rule.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !rule.enabled }) });
        if (!res.ok) showError(responseError(res, await readJson(res), t("commands.saveFailed")));
        await loadRules();
    };

    const deleteRule = async (rule: CommandRule) => {
        const res = await apiFetch(`/api/command-rules/${rule.id}`, { method: "DELETE" });
        if (res.ok) showSuccess(t("commands.ruleDeleted"));
        else showError(responseError(res, await readJson(res), t("commands.saveFailed")));
        await loadRules();
    };

    /** 試一個指令（`draft` = 還沒存的規則）。/ Try a command (`draft` = an unsaved rule). */
    const check = useCallback(
        async (command: string, draft?: { kind: string; pattern: string }): Promise<CheckResult | null> => {
            try {
                const res = await apiFetch("/api/command-rules/check", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ command, tunnel_id: tunnelId ?? undefined, rule: draft }),
                });
                return res.ok ? ((await res.json()) as CheckResult) : null;
            } catch {
                return null;
            }
        },
        [tunnelId],
    );

    const withdraw = async (id: number) => {
        const res = await apiFetch(`/api/command-requests/${id}/cancel`, { method: "POST" });
        if (!res.ok) showError(responseError(res, await readJson(res), t("commands.decideFailed")));
        await loadHistory();
    };

    const scopeName = tunnelId ? (tunnelRules?.tunnel.name ?? tunnels.find((x) => x.id === tunnelId)?.name ?? `#${tunnelId}`) : null;
    const rules = tunnelId ? (tunnelRules?.rules ?? null) : (site?.rules ?? null);
    const canEdit = tunnelId ? Boolean(tunnelRules?.can_edit) : Boolean(site?.can_edit);
    // 「要核准」規則可以指定的核准人：隧道 = 擁有者 + Admin sharee；全站 = 所有啟用中的帳號（管理員才拿得到）。
    // Who an approve rule may name: tunnel = owner + Admin sharees; site = every active account (admins only).
    const approverCandidates = tunnelId ? (tunnelRules?.approver_candidates ?? []) : (site?.approver_candidates ?? []);

    return {
        tunnelId,
        tab,
        go,
        tunnels,
        scopeName,
        rules,
        siteRules: site?.rules ?? [],
        canEdit,
        approverCandidates,
        failed,
        history,
        reload: async () => {
            await Promise.all([loadRules(), loadHistory()]);
        },
        saveRule,
        toggleRule,
        deleteRule,
        check,
        withdraw,
    };
}
