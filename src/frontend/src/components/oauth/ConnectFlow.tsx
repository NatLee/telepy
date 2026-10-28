"use client";

/**
 * MCP 應用程式連接（OAuth）流程共用的畫面元件：左側面板（連接一個 app：示意圖 + 三個步驟）、手機上的步驟條、
 * 要求連接的 app 卡片、權限的圖示與標籤、無法完成時的說明。OAuth 登入頁（/oauth/login）與同意頁共用，
 * 兩頁看起來是同一個流程，而且跟一般登入頁明顯不同。
 * Shared pieces of the app-connection (OAuth) flow: the side panel (diagram + three steps), the phone step
 * strip, the requesting-app card, scope icons / labels and the problem view. Used by the OAuth sign-in page
 * and the consent page, so both read as one flow that looks nothing like the normal sign-in.
 * 要求的是 `telepy` CLI（`telepy login`）時，面板與步驟改講終端機：終端機 ─HTTPS─ Telepy ─SSH─ 裝置、最後一步回到終端機。
 * When the `telepy` CLI is asking (`telepy login`), the panel and steps speak of the terminal instead: terminal
 * ─HTTPS─ Telepy ─SSH─ devices, and the last step goes back to the terminal.
 */
import React from "react";
import { Bot, CornerDownLeft, Eye, FolderTree, Globe, Radar, Server, Settings2, ShieldAlert, ShieldCheck, SquareTerminal, type LucideIcon } from "lucide-react";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { DiagramLink, DiagramNode, FlowSteps } from "@/components/auth/AuthPanels";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { cliHost } from "@/lib/cliClient";
import type { TranslationKey } from "@/locales/en";
import { cn } from "@/lib/utils";

/** 0 = 登入、1 = 檢視並決定、2 = 回到 app。/ 0 = sign in, 1 = review, 2 = back to the app. */
export type ConnectStep = 0 | 1 | 2;

const STEPS: { title: TranslationKey; body: TranslationKey }[] = [
    { title: "oauth.step.signIn", body: "oauth.step.signInBody" },
    { title: "oauth.step.review", body: "oauth.step.reviewBody" },
    { title: "oauth.step.return", body: "oauth.step.returnBody" },
];

/** CLI（`telepy login`）的三步：一樣的流程，最後回到終端機。/ The CLI's three steps: the same flow, ending in the terminal. */
const CLI_STEPS: { title: TranslationKey; body: TranslationKey }[] = [
    { title: "oauth.step.signIn", body: "oauth.cli.signInBody" },
    { title: "oauth.step.review", body: "oauth.cli.reviewBody" },
    { title: "oauth.cli.return", body: "oauth.cli.returnBody" },
];

/** scope 的圖示、標籤與性質（唯讀 / 會改東西）；名稱固定（後端 SCOPES）。/ Scope icon, labels and impact. */
export const SCOPE_META: Record<string, { Icon: LucideIcon; label: TranslationKey; description: TranslationKey; changes: boolean }> = {
    "tunnels:read": { Icon: Eye, label: "oauth.scope.tunnelsRead", description: "oauth.scope.tunnelsReadDescription", changes: false },
    "ssh:exec": { Icon: SquareTerminal, label: "oauth.scope.sshExec", description: "oauth.scope.sshExecDescription", changes: true },
    "ssh:files": { Icon: FolderTree, label: "oauth.scope.sshFiles", description: "oauth.scope.sshFilesDescription", changes: true },
    "network:scan": { Icon: Radar, label: "oauth.scope.networkScan", description: "oauth.scope.networkScanDescription", changes: false },
    "browser:use": { Icon: Globe, label: "oauth.scope.browserUse", description: "oauth.scope.browserUseDescription", changes: true },
    // 只有個人 API token 有（REST 的寫入）。/ Personal API tokens only (REST writes).
    "tunnels:manage": { Icon: Settings2, label: "oauth.scope.tunnelsManage", description: "oauth.scope.tunnelsManageDescription", changes: true },
};

export function ScopeImpact({ scope }: { scope: string }) {
    const { t } = useI18n();
    const meta = SCOPE_META[scope];
    if (!meta) return null;
    return meta.changes ? <Chip tone="warning">{t("oauth.scope.canChange")}</Chip> : <Chip>{t("oauth.scope.readOnly")}</Chip>;
}

/** 左側面板（lg 以上）：連接一個 app 的示意圖與三個步驟。/ Side panel (lg+): the diagram and the three steps. */
export function ConnectAppAside({ step, appName }: { step: ConnectStep; appName?: string | null }) {
    const { t } = useI18n();
    const host = cliHost(appName);
    const cli = host !== null;
    const steps = cli ? CLI_STEPS : STEPS;
    return (
        <div>
            <h2 className="text-3xl font-semibold leading-tight tracking-tight xl:text-4xl">{t(cli ? "oauth.cli.panelTitle" : "oauth.panelTitle")}</h2>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground">
                {cli ? t("oauth.cli.panelBody", { host: host || t("oauth.cli.thisComputer") }) : t("oauth.panelBody")}
            </p>

            {/* app ─MCP→ Telepy ─SSH→ 裝置（CLI：終端機 ─HTTPS→ …）：永遠只透過 Telepy 碰到裝置。/ Devices are reached only through Telepy. */}
            <div className="mt-10 flex items-center gap-2" aria-hidden>
                {cli ? <DiagramNode Icon={SquareTerminal} label={host || "telepy CLI"} /> : <DiagramNode Icon={Bot} label={appName || t("oauth.diagramApp")} />}
                <DiagramLink label={cli ? "HTTPS" : "MCP"} />
                <DiagramNode Icon={TelepyGlyph} label="Telepy" accent />
                <DiagramLink label="SSH" />
                <DiagramNode Icon={Server} label={t("oauth.diagramDevices")} />
            </div>

            <div className="mt-10">
                <FlowSteps steps={steps.map(({ title, body }) => ({ title: t(title), body: t(body) }))} current={step} />
            </div>

            <p className="mt-10 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                <ShieldCheck size={14} className="mt-px shrink-0 text-primary" aria-hidden />
                {t(cli ? "oauth.cli.panelNote" : "oauth.panelNote")}
            </p>
        </div>
    );
}

/** 手機 / 平板（沒有左側面板時）的步驟條。/ Step strip for narrow screens, where the side panel is hidden. */
export function ConnectProgress({ step, appName }: { step: ConnectStep; appName?: string | null }) {
    const { t } = useI18n();
    const STEPS_NOW = cliHost(appName) !== null ? CLI_STEPS : STEPS;
    return (
        <div className="mb-6 lg:hidden">
            <div className="flex gap-1.5" aria-hidden>
                {STEPS_NOW.map((s, i) => (
                    <span key={s.title} className={cn("h-1 flex-1 rounded-full", i < step ? "bg-success/60" : i === step ? "bg-primary" : "bg-border")} />
                ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
                {t("oauth.stepOf", { n: step + 1, total: STEPS_NOW.length })}
                <span aria-hidden> · </span>
                <span className="text-foreground">{t(STEPS_NOW[step].title)}</span>
            </p>
        </div>
    );
}

/** app 的方塊圖示（中性色：名稱是對方自己取的，不給品牌感）。/ Neutral app tile: the name is self-declared. */
export function AppTile({ className, appName }: { className?: string; appName?: string | null }) {
    // CLI 用終端機圖示，其他 app 用機器人。/ A terminal for the CLI, a robot for other apps.
    const Icon = cliHost(appName) !== null ? SquareTerminal : Bot;
    return (
        <span className={cn("grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-surface text-muted-foreground", className)}>
            <Icon size={22} aria-hidden />
        </span>
    );
}

/** 「導回 host」：等寬字的小標籤。/ The "returns to <host>" line. */
export function ReturnsTo({ host }: { host: string }) {
    const { tn } = useI18n();
    return (
        <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <CornerDownLeft size={13} aria-hidden />
            {tn("oauth.returnsTo", { host: <code className="rounded-sm bg-muted px-1.5 py-px font-mono text-foreground break-all">{host}</code> })}
        </span>
    );
}

/**
 * 登入頁上方：是哪個 app、會導回哪裡、要哪些權限。還在載入時是骨架；拿不到（網路問題）時只說「有個 app」。
 * Top of the OAuth sign-in page: the app, where it returns and what it asks for. A skeleton while loading.
 */
export function AppRequestCard({ name, host, scopes, loading }: { name?: string; host?: string; scopes?: string[]; loading?: boolean }) {
    const { t } = useI18n();
    return (
        <div className="mb-8 rounded-xl border border-border bg-card p-4 shadow-card">
            <div className="flex items-start gap-3">
                <AppTile appName={name} />
                <div className="min-w-0 flex-1">
                    {loading ? (
                        <>
                            <span className="block h-5 w-32 animate-pulse rounded-sm bg-muted" />
                            <span className="mt-2 block h-4 w-48 animate-pulse rounded-sm bg-muted" />
                        </>
                    ) : (
                        <>
                            <p className="text-base text-foreground break-words">{name || t("oauth.unknownApp")}</p>
                            <p className="text-sm text-muted-foreground">{t("oauth.wantsAccess")}</p>
                            {host && (
                                <div className="mt-2">
                                    <ReturnsTo host={host} />
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
            {!loading && scopes && scopes.length > 0 && (
                <div className="mt-3 border-t border-border pt-3">
                    <p className="text-xs text-muted-foreground">{t("oauth.requestAsks")}</p>
                    <ul className="mt-1.5 flex flex-wrap gap-1.5">
                        {scopes.map((s) => {
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
                </div>
            )}
        </div>
    );
}

/**
 * 請求無法完成：原因 + 回到 app（後端給了可導回的網址時）或「關掉分頁重來」。
 * The request cannot be completed: the reason plus a way back to the app when the backend allows one.
 */
export function OAuthProblem({ description, code, redirectTo, footer }: { description: string; code?: string; redirectTo?: string; footer?: React.ReactNode }) {
    const { t } = useI18n();
    return (
        <div className="space-y-5">
            <div className="flex items-start gap-3">
                <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-destructive/30 bg-destructive/10 text-destructive">
                    <ShieldAlert size={22} aria-hidden />
                </span>
                <div className="min-w-0">
                    <h1 className="text-2xl font-semibold tracking-tight text-foreground">{t("oauth.errorTitle")}</h1>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground break-words">{description}</p>
                    {code && <p className="mt-1 font-mono text-xs text-muted-foreground">{code}</p>}
                </div>
            </div>
            {redirectTo ? (
                <Button className="h-11 w-full" onClick={() => window.location.assign(redirectTo)}>
                    <CornerDownLeft size={16} /> {t("oauth.returnToApp")}
                </Button>
            ) : (
                <Callout tone="info">{t("oauth.noReturn")}</Callout>
            )}
            {footer}
        </div>
    );
}
