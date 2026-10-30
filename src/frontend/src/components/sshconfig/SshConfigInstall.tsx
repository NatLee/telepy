"use client";

/**
 * 把 Host 區塊放進 ~/.ssh/config 的兩種方式：一行指令（macOS / Linux 的 sh，或 Windows 的 PowerShell）或手動貼上。
 * 指令會備份、替換之前加過的 Telepy 區塊、再附加（lib/sshConfig.ts）；手動模式顯示逐行註解的區塊。
 * 作業系統的選擇記在 localStorage（telepy.sshConfigShell），預設依瀏覽器猜。
 * Two ways to get the Host stanzas into ~/.ssh/config: one command (sh on macOS / Linux, or PowerShell on Windows)
 * or pasting by hand. The command backs up, replaces Telepy blocks it added before, then appends (lib/sshConfig.ts);
 * the manual mode shows the stanzas with a note on every line. The OS choice is kept in localStorage
 * (telepy.sshConfigShell) and guessed from the browser at first.
 */
import React, { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronDown, ClipboardPaste, Copy, Info, Layers, Rows3, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Segmented } from "@/components/ui/segmented";
import { MiniCommand } from "@/components/cheatsheet/CommandView";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { adaptForShell, compactMarked, guessShell, installCommand, markedBlocks, openEditorCommand, parseStanzas, removeCommand, KNOWN_HOSTS_PATH, type ConfigShell, type ConfigStanza, type WsClient } from "@/lib/sshConfig";
import { useStoredChoice } from "@/hooks/useStoredChoice";
import { TidyInfoDialog } from "./TidyInfoDialog";
import { ConfigStanzaCard } from "./ConfigStanzaCard";
import { AliasPrefix, type AliasPrefixControl } from "./AliasPrefix";
import type { ConfigPart } from "./ConfigRouteMap";

const SHELL_STORAGE_KEY = "telepy.sshConfigShell";
/** 多台時預覽先列幾個裝置區塊。/ Device stanzas previewed before "and N more". */
const BULK_PREVIEW = 2;

function readShell(): ConfigShell {
    try {
        const saved = localStorage.getItem(SHELL_STORAGE_KEY);
        if (saved === "posix" || saved === "powershell") return saved;
    } catch { /* localStorage 不可用 / unavailable */ }
    return guessShell();
}

/** 可收合的小段落（標題是按鈕）。/ A small collapsible section with a button heading. */
function Disclosure({ title, open, onToggle, children }: { title: React.ReactNode; open: boolean; onToggle: () => void; children: React.ReactNode }) {
    return (
        <div className="rounded-lg border border-border">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-foreground outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/60"
            >
                <ChevronDown size={15} className={cn("shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} aria-hidden />
                {title}
            </button>
            {open && <div className="space-y-3 border-t border-border px-3 py-3">{children}</div>}
        </div>
    );
}

interface Props {
    serverStanza: ConfigStanza | null;
    deviceStanzas: ConfigStanza[];
    /** 後端給的 known_hosts 行（Telepy 的主機金鑰）；沒有就不釘。/ The backend's known_hosts lines (Telepy's host key); none = not pinned. */
    knownHosts?: string | null;
    /** SSH over WebSocket：伺服器區塊的 ProxyCommand 要用的小程式。/ The carrier the server stanza's ProxyCommand runs. */
    wsClient?: WsClient | null;
    /** 舊版共用的伺服器別名（後端的 `server.legacy_alias`）：確定是這台、沒人用時清掉。/ The old shared alias, cleaned up when safe. */
    legacyAlias?: string | null;
    /** 這台 Telepy 的裝置別名前綴（同一台電腦有好幾台 Telepy 時）；沒給就不顯示。/ This server's device alias prefix. */
    aliasPrefix?: AliasPrefixControl;
    active: ConfigPart | null;
    onActive: (part: ConfigPart | null) => void;
    /**
     * 多台一次：預覽只列前幾個裝置區塊，手動貼上改成一整段（帶標記，之後跑指令還認得出來）。
     * Several devices: the preview lists a few device stanzas, and pasting by hand is one block with the markers
     * (so the command can replace it later).
     */
    bulk?: boolean;
}

export function SshConfigInstall({ serverStanza, deviceStanzas, knownHosts, wsClient, legacyAlias, aliasPrefix, active, onActive, bulk = false }: Props) {
    const { t, tn } = useI18n();
    // 只在對話框打開後才掛載，直接讀 localStorage 不會有 hydration 不一致。/ Mounted only inside an open dialog.
    const [shell, setShellState] = useState<ConfigShell>(readShell);
    const [method, setMethod] = useState<"command" | "manual">("command");
    const [preview, setPreview] = useState(false);
    const [removeOpen, setRemoveOpen] = useState(false);
    const [commandOpen, setCommandOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    // 多台時可以寫簡化版（共用的行寫一次）；選擇記在 localStorage。/ Several devices: the compact form, remembered.
    const [layout, setLayout] = useStoredChoice("telepy.sshConfigLayout", ["compact", "full"] as const, "compact");
    const [howOpen, setHowOpen] = useState(false);

    const setShell = (s: ConfigShell) => {
        setShellState(s);
        try {
            localStorage.setItem(SHELL_STORAGE_KEY, s);
        } catch { /* 忽略 / ignore */ }
    };

    const all = [...(serverStanza ? [serverStanza] : []), ...deviceStanzas];
    const legacy = legacyAlias && serverStanza && legacyAlias !== serverStanza.alias ? { alias: legacyAlias, me: serverStanza.alias } : null;
    const server = serverStanza?.alias ?? null;
    // 簡化版跟一般版的區塊（只在多台時算）。/ The compact and the plain blocks (bulk only).
    const plainText = markedBlocks(adaptForShell(all, shell));
    // 簡化要逐一驗證，幾百台時不便宜：只在區塊文字變了才重算。/ Verified per name, not free for hundreds: only when the text changes.
    const compactText = useMemo(() => (bulk ? compactMarked(plainText) : plainText), [bulk, plainText]);
    const lineCount = (text: string) => text.replace(/\n$/, "").split("\n").length;
    const shorter = bulk && compactText !== plainText;
    const compact = bulk && layout === "compact" && shorter;
    const command = installCommand(shell, all, knownHosts, wsClient, legacy, { compact, server, blocks: compact ? compactText : undefined });
    // 卡片照目前選的作業系統顯示（Windows 的 ProxyCommand 寫法不同）。/ Cards follow the chosen OS (Windows ProxyCommand differs).
    const shownServer = serverStanza ? adaptForShell([serverStanza], shell)[0] : null;
    const code = (s: string) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{s}</code>;
    // 帳號看原本的區塊：簡化版裡它可能在共用區塊。/ The account from the original block (compact may share it).
    const user = (s: ConfigStanza) => (deviceStanzas.find((d) => d.alias === s.alias) ?? s).options.find((o) => o.key.toLowerCase() === "user")?.value ?? "";

    // 簡化版的預覽：裝置區塊照舊列前幾個，再加上共用區塊。/ Compact preview: the first device blocks plus the shared ones.
    const compactStanzas = compact ? parseStanzas(compactText) : null;
    const shownDevices = compactStanzas ? compactStanzas.filter((s) => deviceStanzas.some((d) => d.alias === s.alias)) : deviceStanzas;
    const sharedStanzas = compactStanzas ? compactStanzas.filter((s) => s.alias !== server && !deviceStanzas.some((d) => d.alias === s.alias)) : [];
    const cards = (
        <div className="space-y-3">
            {shownServer && (
                <ConfigStanzaCard
                    n={1}
                    part="server"
                    title={t("config.block.server")}
                    hint={t("config.block.serverHint")}
                    stanza={shownServer}
                    active={active}
                    onActive={onActive}
                />
            )}
            {(bulk ? shownDevices.slice(0, BULK_PREVIEW) : shownDevices).map((s) => (
                <ConfigStanzaCard
                    key={s.alias}
                    n={2}
                    part="device"
                    title={t("config.block.device")}
                    hint={t("config.block.deviceHint", { alias: s.alias, user: user(s) })}
                    stanza={s}
                    active={active}
                    onActive={onActive}
                />
            ))}
            {bulk && deviceStanzas.length > BULK_PREVIEW && (
                <p className="text-sm text-muted-foreground">{t("config.bulk.previewMore", { count: deviceStanzas.length - BULK_PREVIEW })}</p>
            )}
            {sharedStanzas.map((s) => (
                <ConfigStanzaCard
                    key={s.alias}
                    n={2}
                    part="device"
                    shared
                    title={t("config.block.shared")}
                    hint={t("config.block.sharedHint", { count: s.alias.split(" ").length })}
                    stanza={s}
                    active={active}
                    onActive={onActive}
                />
            ))}
        </div>
    );

    const layoutRow = bulk && (
        <div className="space-y-2 rounded-lg bg-surface px-3 py-2.5 ring-1 ring-inset ring-border/70">
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                <div className="flex items-center gap-1.5 text-sm text-foreground">
                    {t("tidy.layout")}
                    <button type="button" onClick={() => setHowOpen(true)} className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60" aria-label={t("tidy.compactHow")} title={t("tidy.compactHow")}>
                        <Info size={15} />
                    </button>
                </div>
                <div className="w-full sm:w-auto">
                    <Segmented
                        size="sm"
                        fullWidth
                        aria-label={t("tidy.layout")}
                        value={compact ? "compact" : "full"}
                        onChange={setLayout}
                        options={[
                            { value: "compact", label: t("tidy.layoutCompact"), icon: <Layers size={14} />, title: t("tidy.layoutCompactHint"), disabled: !shorter },
                            { value: "full", label: t("tidy.layoutFull"), icon: <Rows3 size={14} />, title: t("tidy.layoutFullHint") },
                        ]}
                    />
                </div>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
                {!shorter
                    ? t("tidy.compactNone")
                    : compact
                        ? t("tidy.compactSummary", { after: lineCount(compactText), before: lineCount(plainText) })
                        : t("tidy.fullSummary", { after: lineCount(compactText), before: lineCount(plainText) })}
            </p>
            <TidyInfoDialog isOpen={howOpen} onClose={() => setHowOpen(false)} before={plainText} after={compactText} names={deviceStanzas.map((d) => d.alias)} />
        </div>
    );

    return (
        <div className="space-y-3">
            {layoutRow}
            {/* 手機上兩個切換各佔一行（放大顯示時並排會撐出對話框）。/ Phones: one toggle per row, full width. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                <div className="w-full sm:w-auto">
                    <Segmented
                        kind="tabs"
                        size="sm"
                        fullWidth
                        aria-label={t("config.method.aria")}
                        value={method}
                        onChange={setMethod}
                        options={[
                            { value: "command", label: t("config.method.command"), icon: <SquareTerminal size={14} /> },
                            { value: "manual", label: t("config.method.manual"), icon: <ClipboardPaste size={14} /> },
                        ]}
                    />
                </div>
                <div className="w-full sm:w-auto">
                    <Segmented
                        size="sm"
                        fullWidth
                        aria-label={t("config.shell.aria")}
                        value={shell}
                        onChange={setShell}
                        options={[
                            { value: "posix", label: "macOS / Linux" },
                            { value: "powershell", label: "Windows" },
                        ]}
                    />
                </div>
            </div>

            {method === "command" ? (
                <>
                    <p className="text-muted-foreground">{t(shell === "posix" ? "config.cmd.introPosix" : "config.cmd.introPowershell")}</p>
                    {bulk ? (
                        // 多台時指令有上百行：先給複製鈕與摘要，整段收在下面。/ Hundreds of lines: copy + summary first.
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg bg-surface px-3 py-2.5 ring-1 ring-inset ring-border/70">
                            <span className="min-w-0 text-foreground">{t("config.bulk.cmdSummary", { blocks: compact ? (compactText.match(/^Host /gm)?.length ?? all.length) : all.length, lines: command.split("\n").length - 1 })}</span>
                            <Button
                                size="sm"
                                onClick={() =>
                                    navigator.clipboard.writeText(command).then(() => {
                                        setCopied(true);
                                        setTimeout(() => setCopied(false), 2000);
                                    })
                                }
                            >
                                {copied ? <Check size={15} /> : <Copy size={15} />}
                                {copied ? t("common.copied") : t("config.bulk.copyCommand")}
                            </Button>
                        </div>
                    ) : (
                        <CodeBlock language={shell === "posix" ? "bash" : "powershell"} value={command} />
                    )}
                    <ul className="space-y-1 text-xs text-muted-foreground">
                        {[
                            ...(wsClient ? [tn("config.cmd.wsClient", { path: code(shell === "posix" ? wsClient.path : "%USERPROFILE%\\.ssh\\telepy-ws.py") })] : []),
                            ...(knownHosts?.trim() ? [tn("config.cmd.knownHosts", { path: code(KNOWN_HOSTS_PATH) })] : []),
                            tn("config.cmd.backup", { path: code(shell === "posix" ? "~/.ssh/config.bak" : "config.bak") }),
                            t("config.cmd.rerun"),
                            ...(legacy ? [tn("config.cmd.legacy", { alias: code(legacy.alias) }), t("config.cmd.sameName")] : []),
                            t("config.cmd.untouched"),
                        ].map((line, i) => (
                            <li key={i} className="flex items-start gap-2">
                                <Check size={13} className="mt-0.5 shrink-0 text-success" aria-hidden />
                                <span>{line}</span>
                            </li>
                        ))}
                        <li className="pl-5">{t("config.cmd.handPasted")}</li>
                    </ul>
                    {bulk && (
                        <Disclosure title={t("config.bulk.showCommand")} open={commandOpen} onToggle={() => setCommandOpen((v) => !v)}>
                            <CodeBlock language={shell === "posix" ? "bash" : "powershell"} value={command} />
                        </Disclosure>
                    )}
                    <Disclosure title={t("config.cmd.preview")} open={preview} onToggle={() => setPreview((v) => !v)}>
                        {cards}
                    </Disclosure>
                    {deviceStanzas.length > 0 && (
                        <Disclosure title={t("config.remove.title")} open={removeOpen} onToggle={() => setRemoveOpen((v) => !v)}>
                            <p className="text-muted-foreground">{t("config.remove.body")}</p>
                            <CodeBlock language={shell === "posix" ? "bash" : "powershell"} value={removeCommand(shell, deviceStanzas.map((s) => s.alias), server)} />
                        </Disclosure>
                    )}
                </>
            ) : (
                <>
                    <ol className="list-none space-y-3 text-muted-foreground">
                        <li className="space-y-1.5">
                            <p><span className="text-foreground">1.</span> {t("config.manual.open")}</p>
                            <MiniCommand command={openEditorCommand(shell)} />
                            {shell === "powershell" && <p className="text-xs">{tn("config.manual.notepad", { name: code("config") })}</p>}
                        </li>
                        <li><span className="text-foreground">2.</span> {t(bulk ? "config.bulk.manualPaste" : "config.manual.paste")}</li>
                    </ol>
                    {bulk ? <CodeBlock language="text" value={compact ? compactText : plainText} /> : cards}
                    {knownHosts?.trim() && (
                        <div className="space-y-1.5 text-muted-foreground">
                            <p><span className="text-foreground">3.</span> {tn("config.manual.knownHosts", { path: code(KNOWN_HOSTS_PATH) })}</p>
                            <CodeBlock language="text" value={knownHosts.trim() + "\n"} />
                        </div>
                    )}
                    {wsClient && (
                        <div className="space-y-1.5 text-muted-foreground">
                            <p><span className="text-foreground">{knownHosts?.trim() ? "4." : "3."}</span> {tn("config.manual.wsClient", { path: code(wsClient.path) })}</p>
                            <MiniCommand command={shell === "posix" ? `curl -fsSL '${wsClient.url}' -o ${wsClient.path} && chmod 700 ${wsClient.path}` : `Invoke-WebRequest -UseBasicParsing '${wsClient.url}' -OutFile "$HOME\\.ssh\\telepy-ws.py"`} />
                        </div>
                    )}
                </>
            )}
            {aliasPrefix && <AliasPrefix key={aliasPrefix.value} control={aliasPrefix} />}
            {bulk && (
                <Link href="/tunnels/ssh-config" prefetch={false} className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline">
                    {t("tidy.openTool")}
                    <ArrowRight size={14} aria-hidden />
                </Link>
            )}
        </div>
    );
}
