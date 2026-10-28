"use client";

/**
 * CLI 頁（`/tunnels/cli`，側欄「開發者」區的 CLI，在 API 上面）：`telepy` 命令列的說明，放在網頁裡而不是文件裡，
 * 因為這裡知道你是誰——安裝指令依你的電腦、登入用這台伺服器的網址、範例用你自己的隧道 / 帳號 / 標籤 / 群組 / 片段，
 * 看得到 CLI 從哪幾台電腦登入過、你有沒有個人 SSH 金鑰。四個分頁（`?tab=`）：開始使用（三步，一次一步）、範例、
 * 所有指令、疑難排解。資訊按鈕 = 兩條路的即時圖。`?tunnel=` 選範例用哪條隧道。
 * The CLI page: the `telepy` guide inside the web rather than the docs, because here it knows who you are — the
 * install command for your computer, this server's URL, examples with your own tunnels / accounts / labels /
 * groups / snippets, which computers the CLI signed in from, and whether you have a personal SSH key. Four tabs
 * (`?tab=`): get started (three steps, one at a time), examples, all commands, troubleshooting. The info button is
 * the live two-lane diagram; `?tunnel=` picks the tunnel the examples use.
 */
import React, { Suspense, useCallback, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ExternalLink, Info, Terminal } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Segmented } from "@/components/ui/segmented";
import { CliStart } from "@/components/cli/CliStart";
import { CliExamples } from "@/components/cli/CliExamples";
import { CliCommands, CliEnvironment } from "@/components/cli/CliReference";
import { CliFlowDialog } from "@/components/cli/CliFlowDialog";
import { useCliPage } from "@/hooks/useCliPage";
import { useI18n } from "@/lib/i18n";
import { CLI_RELEASES_URL } from "@/lib/cliGuide";

const TABS = ["start", "examples", "commands", "help"] as const;
type Tab = (typeof TABS)[number];

function CliPageInner() {
    const { t } = useI18n();
    const page = useCliPage();
    const [howOpen, setHowOpen] = useState(false);
    const signedIn = (page.signIns?.length ?? 0) > 0;
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const raw = params.get("tab");
    const tab: Tab = (TABS as readonly string[]).includes(raw ?? "") ? (raw as Tab) : "start";
    // 換分頁只動 `?tab=`，範例用的 `?tunnel=` 留著。/ Switching tabs keeps `?tunnel=`.
    const go = useCallback(
        (next: Tab) => {
            const qs = new URLSearchParams(params.toString());
            if (next === "start") qs.delete("tab");
            else qs.set("tab", next);
            const s = qs.toString();
            router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
        },
        [params, pathname, router],
    );
    const labels: Record<Tab, string> = { start: t("cli.start.title"), examples: t("cli.ex.title"), commands: t("cli.cmds.title"), help: t("cli.tab.help") };

    return (
        <div className="animate-fade-in-up space-y-6">
            <PageHeader
                icon={<Terminal />}
                title={t("cli.title")}
                description={t("cli.subtitle")}
                actions={
                    <>
                        <Button variant="outline" onClick={() => setHowOpen(true)}>
                            <Info size={16} /> {t("cli.how")}
                        </Button>
                        <Button variant="outline" asChild>
                            <a href={CLI_RELEASES_URL} target="_blank" rel="noopener noreferrer">
                                {t("cli.downloads")}
                                <ExternalLink size={12} className="opacity-60" aria-hidden />
                            </a>
                        </Button>
                    </>
                }
            />
            <CliFlowDialog isOpen={howOpen} onClose={() => setHowOpen(false)} signedIn={signedIn} keyCount={page.keyCount} />

            {!page.browserSignIn && !page.tokensOn && <Callout tone="warning">{t("cli.bothOff")}</Callout>}

            {/* 手機上兩欄兩列，分頁名稱不會在字中間斷開。/ Two by two on phones, so no label breaks mid-word. */}
            <Segmented kind="tabs" fullWidth className="max-sm:grid-flow-row max-sm:grid-cols-2 sm:inline-grid sm:w-auto" aria-label={t("cli.title")} value={tab} onChange={go} options={TABS.map((x) => ({ value: x, label: labels[x] }))} />

            {tab === "start" && (
                <section aria-label={labels.start}>
                    <CliStart
                        base={page.base}
                        username={page.username}
                        platform={page.platform}
                        setPlatform={page.setPlatform}
                        signIns={page.signIns}
                        browserSignIn={page.browserSignIn}
                        tokensOn={page.tokensOn}
                        keyCount={page.keyCount}
                        tunnel={page.context.tunnel}
                        hasTunnels={page.loading || page.tunnels.length > 0}
                        onMoreExamples={() => go("examples")}
                    />
                </section>
            )}
            {tab === "examples" && (
                <section aria-label={labels.examples} className="space-y-4">
                    <p className="text-sm leading-relaxed text-muted-foreground">{t("cli.ex.description")}</p>
                    <CliExamples context={page.context} tunnels={page.tunnels} selected={page.selected} setTunnel={page.setTunnel} online={page.online} />
                </section>
            )}
            {tab === "commands" && (
                <section aria-label={labels.commands}>
                    <CliCommands />
                </section>
            )}
            {tab === "help" && (
                <section aria-label={labels.help} className="space-y-4">
                    <p className="text-sm leading-relaxed text-muted-foreground">{t("cli.env.description")}</p>
                    <CliEnvironment base={page.base} username={page.username} os={page.platform?.os ?? "macos"} />
                </section>
            )}
        </div>
    );
}

export default function CliPage() {
    // useSearchParams（`?tunnel=`）需要 Suspense 邊界。/ useSearchParams needs a Suspense boundary.
    return (
        <Suspense fallback={null}>
            <CliPageInner />
        </Suspense>
    );
}
