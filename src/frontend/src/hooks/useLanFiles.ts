"use client";

/**
 * 區網主機的檔案 session：打開（經裝置登入那台主機、開 SFTP）、關掉（沒傳完的暫存檔一起刪）。
 * 狀態：要打密碼 → 打開中 → 開著 / 失敗（錯誤碼 → `lanFiles.err.*`，Telepy 的金鑰不收時提議改打密碼）。
 * A LAN host's file session: open (log in through the device, start SFTP) and close (unfinished part files go too).
 */
import { useCallback, useRef, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { LanAuth } from "@/lib/lanAuth";
import { lanFilesErrorKey, needsPassword, openBody, showDetail, type LanFilesSession } from "@/lib/lanFiles";

export type LanFilesPhase =
    | { kind: "password"; error?: string }
    | { kind: "opening" }
    | { kind: "open"; session: LanFilesSession }
    | { kind: "failed"; code: string | null; message: string };

export function useLanFiles(tunnelId: number, hostId: number) {
    const { t } = useI18n();
    const [phase, setPhase] = useState<LanFilesPhase>({ kind: "opening" });
    const current = useRef<string | null>(null);
    // 每次打開 / 關掉加一：回來得太晚的打開（已經關了、或又開了一次）把自己那個 session 關掉，不留在伺服器上。
    // Bumped by every open and close: an open answered too late closes its own session instead of leaving it behind.
    const generation = useRef(0);

    const drop = useCallback((sid: string) => {
        void apiFetch(`/api/reverse/server/${tunnelId}/lan/files/${encodeURIComponent(sid)}`, { method: "DELETE" }).catch(() => undefined);
    }, [tunnelId]);

    const close = useCallback(() => {
        generation.current += 1;
        const sid = current.current;
        current.current = null;
        if (sid) drop(sid);
    }, [drop]);

    const open = useCallback(
        async (auth: LanAuth, login: string, account: string | null, password?: string) => {
            if (needsPassword(auth) && !password) {
                setPhase({ kind: "password" });
                return;
            }
            close();
            const mine = generation.current;
            setPhase({ kind: "opening" });
            try {
                const res = await apiFetch(`/api/reverse/server/${tunnelId}/lan/hosts/${hostId}/files`, { method: "POST", body: JSON.stringify(openBody(auth, login, account, password)) });
                const data = await readJson<LanFilesSession & { error?: string; code?: string }>(res);
                if (mine !== generation.current) {
                    if (res.ok && data?.session) drop(data.session);
                    return;
                }
                if (res.ok && data?.session) {
                    current.current = data.session;
                    setPhase({ kind: "open", session: data });
                    return;
                }
                const code = data?.code ?? null;
                const key = lanFilesErrorKey(code);
                const said = data?.error ?? (res.status ? `HTTP ${res.status}` : t("api.unexpectedError"));
                const message = key ? (showDetail(code) ? `${t(key)} (${said})` : t(key)) : said;
                // 打錯密碼：留在密碼那一步。/ A wrong password stays on the password step.
                if (code === "lan_files_login" && needsPassword(auth)) setPhase({ kind: "password", error: message });
                else setPhase({ kind: "failed", code, message });
            } catch (e) {
                setPhase({ kind: "failed", code: null, message: e instanceof Error ? e.message : t("api.unexpectedError") });
            }
        },
        [tunnelId, hostId, close, drop, t],
    );

    const askPassword = useCallback(() => setPhase({ kind: "password" }), []);

    return { phase, open, close, askPassword };
}
