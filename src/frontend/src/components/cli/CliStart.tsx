"use client";

/**
 * CLI 頁的「開始使用」：安裝 → 登入 → 試試看，一次只看一步。上面的步驟列同時是一張路徑圖——
 * 你的電腦（裝 telepy）─HTTPS + 你的登入─ Telepy ─隧道─ 你的裝置，做完的那段變綠；打開時在第一個沒打勾的那一步。
 * 安裝指令依平台（從瀏覽器猜、可以換）；登入用這台伺服器的網址；看過 CLI 的登入就列出是哪幾台電腦。
 * 登入的輸出照 CLI 原樣，旁邊是揮手的 Tapi——真的 `telepy login` 在終端機裡就是這樣畫的（`TELEPY_NO_MASCOT` 可以關）。
 * The CLI page's "get started": install → sign in → try it, one step at a time. The step bar doubles as a path —
 * your computer (telepy) ─HTTPS + your sign-in─ Telepy ─tunnel─ your device, green where done; it opens on the
 * first unticked step. The install command follows the platform (guessed from the browser, switchable); the
 * sign-in uses this server's URL; once the CLI has signed in, the computers it signed in from are listed. The
 * sign-in output is the CLI's own, with Tapi waving beside it — exactly what `telepy login` draws in a terminal.
 */
import React, { useId, useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, ExternalLink, HardDrive, KeyRound, Laptop, Ticket } from "lucide-react";
import { Tapi } from "@/components/brand/Tapi";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { Button } from "@/components/ui/button";
import { StepPanel, StepPath, type PathStep } from "@/components/ui/step-path";
import { CliTerminal, CommandLine } from "@/components/cli/CliBlocks";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import { firstOpenStep } from "@/lib/stepTabs";
import { CARGO_INSTALL, CLI_RELEASES_URL, CLI_START_STEPS, LOGIN_SCOPES, PLACEHOLDER, archesFor, installCommand, shq, signInSample, startSteps, verifyCommand, type CliArch, type CliOs, type CliPlatform, type CliStartStep } from "@/lib/cliGuide";
import type { CliSignIn, DetectedPlatform } from "@/hooks/useCliPage";

const OS_LABEL: Record<CliOs, string> = { macos: "macOS", linux: "Linux", windows: "Windows" };

interface Props {
    base: string;
    username: string;
    platform: DetectedPlatform | null;
    setPlatform: (p: CliPlatform) => void;
    signIns: CliSignIn[] | null;
    browserSignIn: boolean;
    tokensOn: boolean;
    keyCount: number | null;
    tunnel: string | null;
    hasTunnels: boolean;
    /** 「更多範例」：換到範例分頁。/ "More examples": switch to the examples tab. */
    onMoreExamples: () => void;
}

/** 網址只留主機（含埠）。/ Just the host (and port) of a URL. */
function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

export function CliStart({ base, username, platform, setPlatform, signIns, browserSignIn, tokensOn, keyCount, tunnel, hasTunnels, onMoreExamples }: Props) {
    const { t, tn, locale } = useI18n();
    const ago = (iso: string) => formatRelativeTime(iso, locale);
    const [more, setMore] = useState(false);
    const states = startSteps(signIns?.length ?? 0);
    // 登入紀錄讀到之前先停在安裝；之後打開在第一個沒打勾的那一步，使用者點了就照他的。
    // Install until the sign-ins are known; then the first unticked step, until the person picks one.
    const [picked, setPicked] = useState<CliStartStep | null>(null);
    const opened = signIns === null ? "install" : (firstOpenStep(CLI_START_STEPS.map((value) => ({ value, state: states[value] }))) ?? "install");
    const step = picked ?? opened;
    const panelId = useId();
    const p: CliPlatform = platform ?? { os: "macos", arch: "arm64" };
    const install = installCommand(p);
    const verify = verifyCommand(p);
    const archLabel = (arch: CliArch) => (p.os === "macos" ? t(arch === "arm64" ? "cli.arch.appleSilicon" : "cli.arch.intel") : arch === "arm64" ? "ARM64" : "x86_64");
    const url = base || "https://telepy.example.com";
    const code = (s: string) => <code className="font-mono text-foreground [overflow-wrap:anywhere]">{s}</code>;

    const signedCount = signIns?.length ?? 0;
    const steps: PathStep<CliStartStep>[] = [
        { value: "install", title: t("cli.step.install"), icon: Laptop, state: states.install, sub: `${OS_LABEL[p.os]} · ${archLabel(p.arch)}` },
        {
            value: "signIn",
            title: t("cli.step.signIn"),
            brand: true,
            state: states.signIn,
            sub: signedCount > 0 ? t("cli.step.signedFrom", { count: signedCount }) : hostOf(url),
        },
        { value: "try", title: t("cli.step.try"), icon: HardDrive, state: states.try, sub: tunnel ?? t("cli.step.noTunnel") },
    ];
    const hints: Record<CliStartStep, string | undefined> = {
        install: t("cli.step.installHint"),
        signIn: browserSignIn ? t("cli.step.signInHint") : undefined,
        try: t("cli.step.tryHint"),
    };
    const title: Record<CliStartStep, string> = { install: t("cli.step.installTitle"), signIn: t("cli.step.signInTitle"), try: t("cli.step.tryTitle") };

    return (
        <div className="space-y-4">
            <StepPath steps={steps} value={step} onChange={setPicked} panelId={panelId} links={[t("cli.step.linkSignIn"), t("cli.flow.tunnel")]} aria-label={t("cli.start.title")} />
            <StepPanel
                id={panelId}
                steps={steps}
                value={step}
                onChange={setPicked}
                title={title[step]}
                description={hints[step]}
                final={
                    <Button onClick={onMoreExamples}>
                        {t("cli.try.moreExamples")}
                        <ArrowRight />
                    </Button>
                }
            >
                {step === "install" && (
                    <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                            {/* 手機（或放大顯示）上兩組切換各佔一整行、字可以換行。/ Full width and wrapping on phones. */}
                            <Segmented
                                size="sm"
                                fullWidth
                                className="w-full sm:inline-grid sm:w-auto"
                                aria-label={t("cli.install.os")}
                                value={p.os}
                                onChange={(os) => setPlatform({ os, arch: archesFor(os).includes(p.arch) ? p.arch : archesFor(os)[0] })}
                                options={(["macos", "linux", "windows"] as const).map((os) => ({ value: os, label: OS_LABEL[os] }))}
                            />
                            {archesFor(p.os).length > 1 && (
                                <Segmented size="sm" fullWidth className="w-full sm:inline-grid sm:w-auto" aria-label={t("cli.install.arch")} value={p.arch} onChange={(arch) => setPlatform({ os: p.os, arch })} options={archesFor(p.os).map((arch) => ({ value: arch, label: archLabel(arch) }))} />
                            )}
                            {platform && !platform.picked && <span className="text-xs text-muted-foreground">{t(platform.sure ? "cli.install.detected" : "cli.install.guessed")}</span>}
                        </div>
                        <CommandLine value={install.value} />
                        <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground marker:text-border">
                            <li>{t("cli.install.release")}</li>
                            {p.os === "windows" ? <li>{t("cli.install.windowsPath")}</li> : <li>{tn("cli.install.noSudo", { dir: code("~/.local/bin") })}</li>}
                            {p.os === "macos" && <li>{tn("cli.install.quarantine", { cmd: code("xattr -d com.apple.quarantine telepy") })}</li>}
                        </ul>
                        <div>
                            <button
                                type="button"
                                onClick={() => setMore((v) => !v)}
                                aria-expanded={more}
                                className="inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                            >
                                <ChevronDown size={15} className={more ? "rotate-180 transition-transform" : "transition-transform"} aria-hidden />
                                {t("cli.install.other")}
                            </button>
                            {more && (
                                <div className="mt-3 space-y-3 text-sm">
                                    <p className="text-muted-foreground">{t("cli.install.verify")}</p>
                                    <CommandLine value={verify.value} />
                                    <p className="text-muted-foreground">{t("cli.install.cargo")}</p>
                                    <CommandLine value={CARGO_INSTALL} />
                                    <p className="text-muted-foreground">
                                        {t("cli.install.allDownloads")}{" "}
                                        <a href={CLI_RELEASES_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline">
                                            {t("cli.downloads")}
                                            <ExternalLink size={12} className="opacity-60" aria-hidden />
                                        </a>
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                )}
                {step === "signIn" && (
                    <div className="space-y-3">
                        {browserSignIn ? (
                            <>
                                <CommandLine value={`telepy login ${url}`} />
                                <CliTerminal label={t("cli.signIn.sample")} lines={signInSample(url, username, p.os)} art={<Tapi pose="wave" size={52} label={t("eggs.tapiLabel")} />} />
                                <p className="text-sm leading-relaxed text-muted-foreground">
                                    {tn("cli.signIn.scopes", { scopes: code(LOGIN_SCOPES.join(" ")), flag: code("--scope") })} {tn("cli.signIn.stored", { file: code("~/.config/telepy/") })}
                                </p>
                                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                                    <span className="text-muted-foreground">{signIns && signIns.length > 0 ? t("cli.signIn.seen") : t("cli.signIn.seenNone")}</span>
                                    {(signIns ?? []).slice(0, 6).map((s) => (
                                        <Chip key={s.id} title={s.host || undefined} className="max-w-full whitespace-normal [overflow-wrap:anywhere]">
                                            <Laptop aria-hidden />
                                            <span className="min-w-0">{s.host || t("cli.signIn.unnamed")}</span>
                                            <span className="opacity-70">· {s.lastUsedAt ? t("cli.signIn.used", { when: ago(s.lastUsedAt) }) : t("cli.signIn.signedIn", { when: ago(s.createdAt) })}</span>
                                        </Chip>
                                    ))}
                                    {signIns && signIns.length > 6 && <Chip>+{signIns.length - 6}</Chip>}
                                </div>
                            </>
                        ) : (
                            <Callout tone="warning">{t("cli.signIn.browserOff")}</Callout>
                        )}
                        {tokensOn && (
                            <div className="space-y-2 rounded-lg border border-border p-3">
                                <p className="flex items-start gap-2 text-sm text-foreground">
                                    <Ticket size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                                    {t(browserSignIn ? "cli.signIn.noBrowser" : "cli.signIn.tokenOnly")}
                                </p>
                                <CommandLine value={`telepy login ${url} --with-token tpt_…`} />
                                <p className="text-sm text-muted-foreground">
                                    {tn("cli.signIn.ciEnv", { url: code("TELEPY_URL"), token: code("TELEPY_TOKEN") })}{" "}
                                    <Link href="/tunnels/api" className="text-foreground underline underline-offset-4">
                                        {t("cli.signIn.makeToken")}
                                    </Link>
                                </p>
                            </div>
                        )}
                    </div>
                )}
                {step === "try" && (
                    <div className="space-y-3">
                        <CommandLine value={["telepy ls", `telepy ssh ${tunnel ? shq(tunnel) : PLACEHOLDER.tunnel}`].join("\n")} />
                        {!hasTunnels && (
                            <Callout tone="info">
                                {t("cli.try.noTunnels")}{" "}
                                <Link href="/tunnels/create" className="text-foreground underline underline-offset-4">
                                    {t("cli.try.create")}
                                </Link>
                            </Callout>
                        )}
                        {keyCount === 0 ? (
                            <Callout tone="warning" icon={<KeyRound />}>
                                <span className="block">{t("cli.try.noKey")}</span>
                                <Button variant="outline" size="sm" asChild className="mt-2">
                                    <Link href="/tunnels/keys">{t("cli.try.addKey")}</Link>
                                </Button>
                            </Callout>
                        ) : keyCount !== null ? (
                            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                <KeyRound size={15} className="shrink-0" aria-hidden />
                                {t("cli.try.keys", { count: keyCount })}
                            </p>
                        ) : null}
                    </div>
                )}
            </StepPanel>
        </div>
    );
}
