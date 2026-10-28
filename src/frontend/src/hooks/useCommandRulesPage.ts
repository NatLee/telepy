/**
 * 指令規則頁的資料。`mine` = 指令規則頁（`/tunnels/commands`）：我的規則與全站規則、選一條隧道看那裡生效的規則
 * （`?tunnel=`）、紀錄分頁（`?tab=history`：被擋下與送核准的指令；有新的申請或決定就重抓）；`site` = 管理區的全站
 * 指令規則頁（`/tunnels/admin/commands`）：全站規則（`?tunnel=` 只留套用到它的）。兩邊都有增刪改與「試一個指令」。
 * Data for the command rules pages. `mine` = the Command rules page: my rules and the site-wide ones, the rules in
 * force on one tunnel (`?tunnel=`), and the History tab (`?tab=history`: blocked and held commands, refetched on new
 * requests and decisions); `site` = the admin section's Site command rules page: the site-wide rules (`?tunnel=`
 * keeps the ones covering it). Both create / change / delete rules and try a command.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { coversTunnel } from "@/lib/commandRules";
import { useI18n } from "@/lib/i18n";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { useNotificationHandlers } from "@/lib/websocket";
import type { CheckResult, CommandRequest, CommandRule, RuleInput, RulesList, TunnelChoice, TunnelRules } from "@/types/commandRules";

export type RulesTab = "rules" | "history";
/** `mine` = 指令規則頁；`site` = 管理區的全站指令規則頁。/ `mine` = Command rules; `site` = Site command rules (admin). */
export type RulesView = "mine" | "site";

/** 存規則時欄位的錯誤（`{pattern: [msg]}`）。/ Field errors from saving a rule. */
export type RuleErrors = Partial<Record<keyof RuleInput, string>>;

const FIELDS = ["action", "kind", "pattern", "who", "via", "note", "enabled", "approver_ids", "all_tunnels", "tunnel_ids"] as const;

export function useCommandRulesPage(view: RulesView = "mine") {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const router = useRouter();
    const params = useSearchParams();
    const tunnelId = Number(params.get("tunnel")) || null;
    const tab: RulesTab = view === "mine" && params.get("tab") === "history" ? "history" : "rules";
    const base = view === "site" ? "/tunnels/admin/commands" : "/tunnels/commands";

    const [data, setData] = useState<RulesList | null>(null);
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
            router.replace(s ? `${base}?${s}` : base);
        },
        [router, tunnelId, tab, base],
    );

    const loadRules = useCallback(async () => {
        try {
            // 我的頁面選了隧道：另外問那條隧道上生效的規則（別人的也在裡面）。/ Mine + a tunnel: also the rules in force there.
            const perTunnel = view === "mine" && tunnelId;
            const [list, tr] = await Promise.all([apiFetch("/api/command-rules"), perTunnel ? apiFetch(`/api/reverse/server/${tunnelId}/command-rules`) : Promise.resolve(null)]);
            if (list.ok) setData((await list.json()) as RulesList);
            if (tr?.ok) setTunnelRules((await tr.json()) as TunnelRules);
            else setTunnelRules(null);
            setFailed(!list.ok || (tr !== null && !tr.ok));
        } catch {
            setFailed(true);
        }
    }, [tunnelId, view]);

    const loadHistory = useCallback(async () => {
        if (view !== "mine") return;
        try {
            const res = await apiFetch(`/api/command-requests?limit=300${tunnelId ? `&tunnel_id=${tunnelId}` : ""}`);
            if (res.ok) setHistory(((await res.json()) as { requests: CommandRequest[] }).requests);
        } catch {
            /* 下次通知再抓。/ Retried on the next notification. */
        }
    }, [tunnelId, view]);

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
        const body = existing ? { ...input, scope: undefined } : { ...input, scope: view === "site" ? "site" : "personal" };
        const res = await apiFetch(existing ? `/api/command-rules/${existing.id}` : "/api/command-rules", {
            method: existing ? "PATCH" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (res.ok) {
            showSuccess(t(existing ? "commands.ruleSaved" : "commands.ruleAdded"));
            await loadRules();
            return null;
        }
        const parsed = await readJson<Record<string, unknown>>(res);
        const errors: RuleErrors = {};
        for (const k of FIELDS) {
            const v = parsed?.[k];
            if (Array.isArray(v) && typeof v[0] === "string") errors[k] = v[0];
        }
        if (Object.keys(errors).length > 0) return errors;
        showError(responseError(res, parsed, t("commands.saveFailed")));
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

    /** 試一個指令（`draft` = 還沒存的規則）；全站頁只看全站規則。/ Try a command (`draft` = an unsaved rule); the site page checks site rules only. */
    const check = useCallback(
        async (command: string, draft?: { kind: string; pattern: string }): Promise<CheckResult | null> => {
            try {
                const res = await apiFetch("/api/command-rules/check", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ command, tunnel_id: tunnelId ?? undefined, rule: draft, scope: view === "site" ? "site" : undefined }),
                });
                return res.ok ? ((await res.json()) as CheckResult) : null;
            } catch {
                return null;
            }
        },
        [tunnelId, view],
    );

    const withdraw = async (id: number) => {
        const res = await apiFetch(`/api/command-requests/${id}/cancel`, { method: "POST" });
        if (!res.ok) showError(responseError(res, await readJson(res), t("commands.decideFailed")));
        await loadHistory();
    };

    // 篩選用的隧道：我的頁面 = 我看得到的；全站頁 = 所有隧道。/ The filter's tunnels: mine = visible ones; site = all.
    const tunnels: TunnelChoice[] = (view === "site" ? data?.site_tunnels : data?.tunnels) ?? [];
    const scopeName = tunnelId ? (tunnelRules?.tunnel.name ?? tunnels.find((x) => x.id === tunnelId)?.name ?? `#${tunnelId}`) : null;
    const siteAll = data?.site ?? null;
    const siteRules = view === "mine" && tunnelId ? (tunnelRules?.site_rules ?? null) : siteAll && tunnelId ? siteAll.filter((r) => coversTunnel(r, tunnelId)) : siteAll;
    // 我的頁面選了隧道：那裡生效的個人規則（我的可以改，別人的唯讀）；否則我自己的全部。
    // Mine + a tunnel: personal rules in force there (mine editable, others' read-only); otherwise all of mine.
    const personalRules = tunnelId ? (tunnelRules?.rules ?? null) : (data?.mine ?? null);

    return {
        view,
        tunnelId,
        tab,
        go,
        tunnels,
        scopeName,
        personalRules,
        siteRules,
        /** 我已經有幾條個人規則。/ How many personal rules I have. */
        used: data?.mine.length ?? 0,
        limit: data?.limit ?? 100,
        canEditSite: Boolean(data?.can_edit_site),
        /** 規則表單能勾的隧道。/ The tunnels the rule form offers. */
        formTunnels: (view === "site" ? data?.site_tunnels : data?.tunnels) ?? [],
        /** 規則表單能指定的核准人。/ Who the rule form may name. */
        approverCandidates: (view === "site" ? data?.site_approver_candidates : data?.approver_candidates) ?? [],
        loaded: data !== null,
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
