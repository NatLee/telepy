"use client";

/**
 * 用 SSH 主機的名稱開網頁時（例如 telepy-ssh.example.com，而網頁在 PUBLIC_URL）換成一頁說明：那個名稱只是給 SSH 用的，
 * 網頁在這裡。後端那邊同時擋住該名稱的登入（421 `ssh_host`），所以這頁不是裝飾：留在這裡也登不進去。
 * 規則跟後端一樣（`lib/signinLook.onSshHost`）：PUBLIC_URL 與 SSH 主機都有、兩者不同、而且這裡的主機就是 SSH 主機時才
 * 顯示；還不知道設定之前照常畫（靜態 HTML 保持中性），所以不會閃。
 * When the web was opened through the SSH host's name, replace the page with one note: that name is for SSH, the web
 * is at PUBLIC_URL. The backend refuses sign-ins through that name too (421 `ssh_host`), so this is not decoration.
 * Same rule as the backend (`onSshHost`); until the look is known the page renders as usual, so nothing flashes.
 */
import React, { useSyncExternalStore } from "react";
import { ArrowRight, Route } from "lucide-react";
import { useSignInLook } from "@/hooks/useSignInLook";
import { useI18n } from "@/lib/i18n";
import { onSshHost, publicPageUrl } from "@/lib/signinLook";

const subscribe = () => () => {};
const hostname = () => window.location.hostname;
const pathAndQuery = () => `${window.location.pathname}${window.location.search}`;

export function SshHostGate({ children }: { children: React.ReactNode }) {
    const look = useSignInLook();
    const here = useSyncExternalStore(subscribe, hostname, () => "");
    const page = useSyncExternalStore(subscribe, pathAndQuery, () => "/");
    if (!look || !here || !onSshHost(look, here)) return <>{children}</>;
    return <SshHostNotice sshHost={look.sshHost ?? here} target={publicPageUrl(look, page)} webHost={look.webHost ?? ""} />;
}

function SshHostNotice({ sshHost, webHost, target }: { sshHost: string; webHost: string; target: string | null }) {
    const { t, tn } = useI18n();
    const code = (s: string) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] text-foreground [overflow-wrap:anywhere]">{s}</code>;
    return (
        <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-foreground">
            <div className="w-full max-w-lg space-y-5 rounded-xl border border-border bg-card p-6 shadow-card">
                <div className="flex items-start gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted" aria-hidden>
                        <Route size={20} />
                    </span>
                    <div className="min-w-0 space-y-1">
                        <h1 className="text-lg">{t("sshHostGate.title")}</h1>
                        <p className="text-sm leading-relaxed text-muted-foreground">{tn("sshHostGate.body", { ssh: code(sshHost), web: code(webHost) })}</p>
                    </div>
                </div>
                {target ? (
                    <a href={target} className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm text-primary-foreground">
                        {t("sshHostGate.go", { host: webHost })} <ArrowRight size={16} aria-hidden />
                    </a>
                ) : null}
                <p className="text-xs leading-relaxed text-muted-foreground">{t("sshHostGate.why")}</p>
            </div>
        </main>
    );
}
