"use client";

/**
 * `telepy login` 完成後瀏覽器停的那一頁（/oauth/done），跟著授權頁的樣子：一般 = CLI 的流程面板（第三步「回到終端機」）+
 * 結果、可以在終端機試的指令、這個 CLI 能做什麼（權限與隧道，從這個瀏覽器的登入讀 grant）與 CLI 說明的連結；
 * 低調 = 只寫 Telepy 的低調外框，一句結果、一句「回到終端機」；Tapi = 終端機場景，Tapi 照結果反應，卡片是結果與可以試的指令。拒絕或沒完成時說原因（只有固定的幾種）。
 * The page the browser lands on after `telepy login` (/oauth/done), in the approval page's look: standard = the CLI
 * flow panel (step three, back to the terminal) plus the result, commands to try, what this CLI may do (scopes and
 * tunnels, read from the grant with this browser's sign-in) and a link to the CLI guide; discreet = the plain
 * "Telepy" frame with the result and "go back to the terminal"; Tapi = the terminal scene with Tapi reacting to the
 * outcome, the card holding the result and commands to try. A denial or failure says why (fixed reasons only).
 */
import React from "react";
import Link from "next/link";
import { BookOpen, CircleCheck, CircleX, Settings2, ShieldAlert } from "lucide-react";
import { AuthShell } from "@/components/auth/AuthShell";
import { DiscreetShell } from "@/components/auth/DiscreetShell";
import { TapiShell } from "@/components/auth/TapiShell";
import { ConnectAppAside, ConnectProgress, SCOPE_META } from "@/components/oauth/ConnectFlow";
import { CopyButton } from "@/components/ui/CopyButton";
import { Chip } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { cliHost } from "@/lib/cliClient";
import type { CliDoneOutcome } from "@/lib/oauthFlow";
import type { SignInStyle } from "@/lib/signinLook";
import type { TranslationKey } from "@/locales/en";
import type { OAuthGrant } from "@/types/oauth";
import { cn } from "@/lib/utils";

const FAILED_TEXT: Record<"state" | "exchange" | "error", TranslationKey> = {
    state: "oauth.cliDone.failedState",
    exchange: "oauth.cliDone.failedExchange",
    error: "oauth.cliDone.failedOther",
};

/** 結果的圖示、標題與說明。/ The outcome's icon, title and sentence. */
function OutcomeHeading({ outcome, host, username, brief }: { outcome: CliDoneOutcome; host: string; username: string | null; brief: boolean }) {
    const { t } = useI18n();
    const ok = outcome.kind === "ok";
    const Icon = ok ? CircleCheck : outcome.kind === "denied" ? CircleX : ShieldAlert;
    const title = ok ? t("oauth.cliDone.okTitle") : outcome.kind === "denied" ? t("oauth.cliDone.deniedTitle") : t("oauth.cliDone.failedTitle");
    const body = ok
        ? brief
            ? t("oauth.cliDone.briefBody")
            : username
              ? t("oauth.cliDone.okBody", { host, user: username })
              : t("oauth.cliDone.okBodyNoUser", { host })
        : outcome.kind === "denied"
          ? t("oauth.cliDone.deniedBody")
          : t(FAILED_TEXT[outcome.reason]);
    return (
        <div className="flex items-start gap-3" role="status">
            <span
                className={cn(
                    "grid size-11 shrink-0 place-items-center rounded-xl border",
                    ok ? "border-success/30 bg-success/10 text-success" : outcome.kind === "denied" ? "border-border bg-surface text-muted-foreground" : "border-warning/30 bg-warning/10 text-warning",
                )}
            >
                <Icon size={22} aria-hidden />
            </span>
            <div className="min-w-0">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </div>
        </div>
    );
}

/**
 * 終端機裡可以試的指令（每行可複製；跟 CLI 頁的 CommandLine 同一個樣子，但不載入整份 CLI 說明）。
 * Commands to try in the terminal, each copyable (styled like the CLI page's CommandLine without loading the guide).
 */
function TryCommands({ tunnel }: { tunnel: string | null }) {
    const { t } = useI18n();
    const lines = ["telepy whoami", "telepy ls", `telepy ssh ${tunnel ?? "<tunnel>"}`];
    return (
        <section>
            <h2 className="text-sm text-foreground">{t("oauth.cliDone.tryTitle")}</h2>
            <ul className="mt-2 space-y-1.5">
                {lines.map((line) => (
                    <li key={line} className="flex min-w-0 items-center gap-1 rounded-lg bg-surface py-1 pr-1 pl-3 ring-1 ring-border/80 ring-inset">
                        <code className="min-w-0 flex-1 py-1 font-mono text-sm break-all text-foreground">
                            <span className="text-muted-foreground select-none" aria-hidden>
                                ${" "}
                            </span>
                            {line}
                        </code>
                        <CopyButton value={line} />
                    </li>
                ))}
            </ul>
        </section>
    );
}

/** 這個 CLI 能做什麼：權限與隧道。/ What this CLI may do: scopes and tunnels. */
function GrantSummary({ grant }: { grant: OAuthGrant }) {
    const { t } = useI18n();
    return (
        <section>
            <h2 className="text-sm text-foreground">{t("oauth.cliDone.canTitle")}</h2>
            <ul className="mt-2 flex flex-wrap gap-1.5">
                {grant.scopes.map((s) => {
                    const meta = SCOPE_META[s];
                    const Icon = meta?.Icon;
                    return (
                        <li key={s}>
                            <Chip tone={meta?.changes ? "warning" : "neutral"}>
                                {Icon && <Icon aria-hidden />}
                                {meta ? t(meta.label) : s}
                            </Chip>
                        </li>
                    );
                })}
            </ul>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {grant.tunnels === null ? t("oauth.cliDone.allTunnels") : t("oauth.cliDone.someTunnels", { names: grant.tunnels.map((x) => x.name).join(", ") })}
            </p>
        </section>
    );
}

export interface CliDoneProps {
    style: SignInStyle;
    message: string;
    outcome: CliDoneOutcome;
    /** 這次登入的 grant（這個瀏覽器有登入、找得到時）。/ This sign-in's grant, when this browser is signed in and it was found. */
    grant: OAuthGrant | null;
    username: string | null;
    /** 還在讀 grant。/ Still reading the grant. */
    loading: boolean;
}

export function CliDoneScreen({ style, message, outcome, grant, username, loading }: CliDoneProps) {
    const { t } = useI18n();
    const name = grant?.client_name ?? "telepy CLI";
    const host = cliHost(grant?.client_name) || t("oauth.cli.thisComputer");

    if (style === "discreet") {
        return (
            <DiscreetShell message={message}>
                <OutcomeHeading outcome={outcome} host={host} username={username} brief />
            </DiscreetShell>
        );
    }

    const ok = outcome.kind === "ok";
    const firstTunnel = grant?.tunnels?.[0]?.name ?? null;
    // Tapi 版：終端機場景，Tapi 照結果開心 / 揮手 / 驚訝；卡片是結果與可以試的指令。
    // The Tapi look: the terminal scene, Tapi happy / waving / surprised by the outcome; the card holds the result and commands to try.
    if (style === "tapi") {
        return (
            <TapiShell scene="terminal" message={message} fixedMood={ok ? "done" : outcome.kind === "denied" ? "bye" : "oops"}>
                <div className="space-y-6">
                    <OutcomeHeading outcome={outcome} host={host} username={username} brief />
                    {ok && <TryCommands tunnel={firstTunnel} />}
                </div>
            </TapiShell>
        );
    }
    // 成功 = 三步都完成；拒絕 / 沒完成 = 停在「回到終端機」。/ Success = all three done; otherwise it stops at "back to the terminal".
    const step = ok ? 3 : 2;
    return (
        <AuthShell wide aside={<ConnectAppAside step={step} appName={name} />}>
            <ConnectProgress step={step} appName={name} />
            <div className="space-y-8">
                <OutcomeHeading outcome={outcome} host={host} username={username} brief={false} />
                {ok && <TryCommands tunnel={firstTunnel} />}
                {ok && loading && <span className="block h-16 animate-pulse rounded-lg bg-muted" aria-hidden />}
                {ok && grant && <GrantSummary grant={grant} />}
                <p className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                    <Link href="/tunnels/cli" className="inline-flex items-center gap-1.5 text-primary underline-offset-4 hover:underline">
                        <BookOpen size={15} aria-hidden />
                        {t("oauth.cliDone.guide")}
                    </Link>
                    {/* CLI 登入列在 API 頁（不在 MCP app 裡）。/ CLI sign-ins live on the API page, not among MCP apps. */}
                    {ok && (
                        <Link href="/tunnels/api?tab=cli" className="inline-flex items-center gap-1.5 text-primary underline-offset-4 hover:underline">
                            <Settings2 size={15} aria-hidden />
                            {t("oauth.cli.manage")}
                        </Link>
                    )}
                </p>
            </div>
        </AuthShell>
    );
}
