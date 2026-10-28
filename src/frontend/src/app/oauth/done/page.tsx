"use client";

/**
 * `telepy login` 完成後的頁面：CLI 換到 token（或失敗）之後，把瀏覽器從 loopback 導來這裡
 * （`?client_id=&result=ok|denied|failed[&reason=]`，後端 metadata 的 `telepy_cli_done_page`）。樣子跟著授權頁的設定；
 * 這個瀏覽器有登入時，從 grant 列出這個 CLI 能做什麼。查詢參數只認固定的字（`parseCliDone`）。
 * The page after `telepy login`: once the CLI has its token (or failed), it sends the browser here from the loopback
 * (`?client_id=&result=ok|denied|failed[&reason=]`, the metadata's `telepy_cli_done_page`). It follows the approval
 * page's look; with a sign-in in this browser it lists what the CLI may do from the grant. Only fixed words are read
 * from the query (`parseCliDone`).
 */
import React, { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SignInPending } from "@/components/auth/DiscreetShell";
import { CliDoneScreen } from "@/components/oauth/CliDone";
import { useSignInLook } from "@/hooks/useSignInLook";
import { apiFetch, readJson } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { parseCliDone } from "@/lib/oauthFlow";
import type { OAuthGrant } from "@/types/oauth";

function CliDone() {
    const look = useSignInLook();
    const params = useSearchParams();
    const { clientId, outcome } = useMemo(() => parseCliDone(params), [params]);
    const { isAuthenticated, isLoading, user } = useAuth();
    const wantsGrant = outcome.kind === "ok" && !!clientId && isAuthenticated;
    /** 讀回來的 grant，記著是哪個 client 的（還沒回來 = 讀取中）。/ The fetched grant and whose it is (absent = loading). */
    const [fetched, setFetched] = useState<{ clientId: string; grant: OAuthGrant | null } | null>(null);

    useEffect(() => {
        if (!wantsGrant || !clientId) return;
        let cancelled = false;
        apiFetch("/api/oauth/grants")
            .then((res) => (res.ok ? readJson<OAuthGrant[]>(res) : null))
            .catch(() => null)
            .then((rows) => {
                if (!cancelled) setFetched({ clientId, grant: rows?.find((g) => g.client_id === clientId) ?? null });
            });
        return () => {
            cancelled = true;
        };
    }, [wantsGrant, clientId]);
    const done = fetched !== null && fetched.clientId === clientId;
    const grant = done ? fetched.grant : null;
    const loading = wantsGrant && !done;

    if (!look || isLoading) return <SignInPending />;
    return <CliDoneScreen style={look.consentStyle} message={look.message} outcome={outcome} grant={grant} username={isAuthenticated ? (user?.username ?? null) : null} loading={loading} />;
}

export default function CliDonePage() {
    // useSearchParams 需要 Suspense 邊界；外面先畫空外框（兩種樣子共用）。/ useSearchParams needs Suspense; the fallback is the shared empty frame.
    return (
        <Suspense fallback={<SignInPending />}>
            <CliDone />
        </Suspense>
    );
}
