"use client";

/**
 * CLI 頁的資料：這個人自己的東西，拿來把範例填成能直接複製的指令——隧道（`?tunnel=` 選哪一條，預設第一條線上的）、
 * 那條隧道的帳號（預設以外的一個）、另一條隧道、一個標籤、一個自己的通道群組、最常用的工具箱片段；以及 CLI 的登入
 * （API 頁「CLI 登入」裡的 `telepy CLI (<電腦>)`）、個人 SSH 金鑰數（ssh / scp / sftp 要用）、伺服器網址與從瀏覽器猜的平台。
 * Data for the CLI page — the person's own things, so the examples are commands they can copy as is: the tunnel
 * (`?tunnel=`, default the first online one), one of its accounts other than the default, a second tunnel, a label,
 * one of their tunnel groups and their most used snippet; plus the CLI's sign-ins (`telepy CLI (<host>)`, listed
 * on the API page), the number of personal SSH keys (ssh / scp / sftp need one), the server URL and the platform.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { apiFetch, readJson } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { hasFeature } from "@/lib/features";
import { useMcpServerUrl } from "@/hooks/useMcpPage";
import { useTunnelGroups } from "@/hooks/useTunnelGroups";
import { detectPlatform, type CliContext, type CliPlatform } from "@/lib/cliGuide";
import { grantHost } from "@/lib/cliSignIns";
import type { Snippet, SnippetList } from "@/lib/snippets";
import type { OAuthGrant } from "@/types/oauth";
import type { Tunnel } from "@/types/tunnel";

export interface CliSignIn {
    id: number;
    host: string;
    lastUsedAt: string | null;
    createdAt: string;
}

export type DetectedPlatform = CliPlatform & { sure: boolean; picked: boolean };

interface UsernamesReply {
    usernames?: { id: number; username: string }[];
    default_username_id?: number | null;
}

const noSubscribe = () => () => {};
const browserHints = () => `${navigator.userAgent}\n${navigator.platform}`;

/** 最常用、再來最近用的片段。/ The most used snippet, then the most recently used. */
function favouriteSnippet(list: Snippet[]): Snippet | null {
    return [...list].sort((a, b) => b.use_count - a.use_count || (b.last_used_at ?? "").localeCompare(a.last_used_at ?? ""))[0] ?? null;
}

/** 標籤：先挑 `k=v` 形式、又有好幾條隧道共用的（`--label` 才有意思）。/ Prefer a `k=v` label shared by several tunnels. */
function pickLabel(tunnels: Tunnel[], selected: Tunnel | null): string | null {
    const count = new Map<string, number>();
    for (const t of tunnels) for (const l of t.labels ?? []) count.set(l, (count.get(l) ?? 0) + 1);
    const score = (l: string) => (l.includes("=") ? 2 : 0) + ((count.get(l) ?? 0) > 1 ? 1 : 0) + ((selected?.labels ?? []).includes(l) ? 0.5 : 0);
    return [...count.keys()].sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0] ?? null;
}

export function useCliPage() {
    const { user } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const tunnelParam = params.get("tunnel");
    const browserSignIn = hasFeature(user, "mcp.connect");
    const tokensOn = hasFeature(user, "api.tokens");

    // 伺服器網址 = RFC 9728 的 resource（反映 PUBLIC_URL）去掉 /mcp。/ The server URL = the RFC 9728 resource minus /mcp.
    const mcpUrl = useMcpServerUrl();
    const base = mcpUrl ? mcpUrl.replace(/\/mcp\/?$/, "") : "";

    const [tunnels, setTunnels] = useState<Tunnel[]>([]);
    const [ports, setPorts] = useState<Record<string, boolean>>({});
    const [loading, setLoading] = useState(true);
    const [keyCount, setKeyCount] = useState<number | null>(null);
    const [signIns, setSignIns] = useState<CliSignIn[] | null>(null);
    const { groups } = useTunnelGroups();

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const [dash, keys, grants] = await Promise.all([
                apiFetch("/api/reverse/server/dashboard").catch(() => null),
                apiFetch("/api/reverse/user/keys").catch(() => null),
                browserSignIn ? apiFetch("/api/oauth/grants").catch(() => null) : Promise.resolve(null),
            ]);
            if (cancelled) return;
            if (dash?.ok) {
                const data = await readJson<{ tunnels?: Tunnel[]; ports?: Record<string, boolean> }>(dash);
                setTunnels(Array.isArray(data?.tunnels) ? data!.tunnels : []);
                setPorts(data?.ports && typeof data.ports === "object" ? data.ports : {});
            }
            if (keys?.ok) {
                const list = await readJson<unknown[]>(keys);
                setKeyCount(Array.isArray(list) ? list.length : 0);
            }
            if (grants?.ok) {
                const list = await readJson<OAuthGrant[]>(grants);
                const mine = (Array.isArray(list) ? list : [])
                    .map((g) => ({ g, host: grantHost(g) }))
                    .filter((x): x is { g: OAuthGrant; host: string } => x.host !== null)
                    .map(({ g, host }) => ({ id: g.id, host, lastUsedAt: g.last_used_at, createdAt: g.created_at }))
                    .sort((a, b) => (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt));
                setSignIns(mine);
            } else {
                setSignIns([]);
            }
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [browserSignIn]);

    const online = useCallback((t: Tunnel) => ports[String(t.reverse_port)] === true, [ports]);

    // 線上的排前面，再照名字。/ Online first, then by name.
    const sorted = useMemo(() => [...tunnels].sort((a, b) => Number(online(b)) - Number(online(a)) || a.host_friendly_name.localeCompare(b.host_friendly_name)), [tunnels, online]);
    const selected = useMemo(() => sorted.find((t) => String(t.id) === tunnelParam) ?? sorted[0] ?? null, [sorted, tunnelParam]);

    const setTunnel = useCallback(
        (id: number) => {
            const qs = new URLSearchParams(params.toString());
            qs.set("tunnel", String(id));
            router.replace(`${pathname}?${qs.toString()}`, { scroll: false });
        },
        [params, pathname, router],
    );

    // 選中那條隧道的帳號與片段。/ The selected tunnel's accounts and snippets.
    const [account, setAccount] = useState<string | null>(null);
    const [snippet, setSnippet] = useState<Snippet | null>(null);
    const selectedId = selected?.id ?? null;
    useEffect(() => {
        if (selectedId === null) return;
        let cancelled = false;
        (async () => {
            const [names, snips] = await Promise.all([
                apiFetch(`/api/reverse/server/${selectedId}/usernames`).catch(() => null),
                apiFetch(`/api/snippets?tunnel_id=${selectedId}`).catch(() => null),
            ]);
            if (cancelled) return;
            const data = names?.ok ? await readJson<UsernamesReply>(names) : null;
            const list = data?.usernames ?? [];
            const other = list.length > 1 ? (list.find((u) => u.id !== data?.default_username_id) ?? null) : null;
            setAccount(other?.username ?? null);
            const sn = snips?.ok ? await readJson<SnippetList>(snips) : null;
            setSnippet(favouriteSnippet(sn?.snippets ?? []));
        })();
        return () => {
            cancelled = true;
        };
    }, [selectedId]);

    const context: CliContext = useMemo(() => {
        const group = groups.find((g) => selected && g.tunnel_ids.includes(selected.id)) ?? groups.find((g) => g.tunnel_ids.length > 0) ?? null;
        const other = sorted.find((t) => t.id !== selected?.id) ?? null;
        return {
            base,
            tunnel: selected?.host_friendly_name ?? null,
            account,
            other: other?.host_friendly_name ?? null,
            label: pickLabel(tunnels, selected),
            group: group?.name ?? null,
            snippet: snippet ? { name: snippet.name, vars: snippet.variables.filter((v) => !v.default).map((v) => v.name) } : null,
        };
    }, [base, selected, account, sorted, tunnels, groups, snippet]);

    // 平台：UA 先猜（render 時讀，伺服器端 = 還不知道），Chromium 再回報架構；自己選過的優先。
    // The platform: the UA guess (read while rendering; unknown on the server), then Chromium's architecture; a pick wins.
    const hints = useSyncExternalStore(noSubscribe, browserHints, () => "");
    const [architecture, setArchitecture] = useState<string | undefined>(undefined);
    const [picked, setPicked] = useState<CliPlatform | null>(null);
    useEffect(() => {
        const nav = navigator as Navigator & { userAgentData?: { getHighEntropyValues?: (h: string[]) => Promise<{ architecture?: string }> } };
        nav.userAgentData
            ?.getHighEntropyValues?.(["architecture"])
            .then((v) => setArchitecture(v.architecture))
            .catch(() => {});
    }, []);
    const platform: DetectedPlatform | null = useMemo(() => {
        if (picked) return { ...picked, sure: true, picked: true };
        if (!hints) return null;
        const [userAgent, plat] = hints.split("\n");
        return { ...detectPlatform({ userAgent, platform: plat, architecture }), picked: false };
    }, [picked, hints, architecture]);
    const setPlatform = useCallback((p: CliPlatform) => setPicked(p), []);

    return {
        loading,
        base,
        username: user?.username ?? "",
        tunnels: sorted,
        selected,
        setTunnel,
        online,
        context,
        keyCount,
        signIns,
        browserSignIn,
        tokensOn,
        platform,
        setPlatform,
    };
}
