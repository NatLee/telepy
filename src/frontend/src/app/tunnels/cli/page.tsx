"use client";

/**
 * CLI 頁（`/tunnels/cli`，側欄「開發者」區的 CLI，在 API 上面）：`telepy` 命令列的說明，放在網頁裡而不是文件裡，
 * 因為這裡知道你是誰——安裝指令依你的電腦、登入用這台伺服器的網址、範例用你自己的隧道 / 帳號 / 標籤 / 群組 / 片段，
 * 看得到 CLI 從哪幾台電腦登入過、你有沒有個人 SSH 金鑰。資訊按鈕 = 兩條路的即時圖。`?tunnel=` 選範例用哪條隧道。
 * The CLI page: the `telepy` guide inside the web rather than the docs, because here it knows who you are — the
 * install command for your computer, this server's URL, examples with your own tunnels / accounts / labels /
 * groups / snippets, which computers the CLI signed in from, and whether you have a personal SSH key. The info
 * button is the live two-lane diagram; `?tunnel=` picks the tunnel the examples use.
 */
import React, { Suspense, useState } from "react";
import { ExternalLink, Info, Terminal } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Section } from "@/components/ui/section";
import { CliStart } from "@/components/cli/CliStart";
import { CliExamples } from "@/components/cli/CliExamples";
import { CliCommands, CliEnvironment } from "@/components/cli/CliReference";
import { CliFlowDialog } from "@/components/cli/CliFlowDialog";
import { useCliPage } from "@/hooks/useCliPage";
import { useI18n } from "@/lib/i18n";
import { CLI_RELEASES_URL } from "@/lib/cliGuide";

function CliPageInner() {
    const { t } = useI18n();
    const page = useCliPage();
    const [howOpen, setHowOpen] = useState(false);
    const signedIn = (page.signIns?.length ?? 0) > 0;

    return (
        <div className="animate-fade-in-up space-y-8">
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

            <Section as="h2" title={t("cli.start.title")} description={t("cli.start.description")}>
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
                />
            </Section>

            <Section as="h2" title={t("cli.ex.title")} description={t("cli.ex.description")}>
                <CliExamples context={page.context} tunnels={page.tunnels} selected={page.selected} setTunnel={page.setTunnel} online={page.online} />
            </Section>

            <Section as="h2" title={t("cli.cmds.title")}>
                <CliCommands />
            </Section>

            <Section as="h2" title={t("cli.env.title")} description={t("cli.env.description")}>
                <CliEnvironment base={page.base} username={page.username} os={page.platform?.os ?? "macos"} />
            </Section>
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
