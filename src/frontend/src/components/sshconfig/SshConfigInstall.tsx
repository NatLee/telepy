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
import React, { useState } from "react";
import { Check, ChevronDown, ClipboardPaste, SquareTerminal } from "lucide-react";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Segmented } from "@/components/ui/segmented";
import { MiniCommand } from "@/components/cheatsheet/CommandView";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { adaptForShell, guessShell, installCommand, openEditorCommand, removeCommand, KNOWN_HOSTS_PATH, type ConfigShell, type ConfigStanza, type WsClient } from "@/lib/sshConfig";
import { ConfigStanzaCard } from "./ConfigStanzaCard";
import type { ConfigPart } from "./ConfigRouteMap";

const SHELL_STORAGE_KEY = "telepy.sshConfigShell";

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
    active: ConfigPart | null;
    onActive: (part: ConfigPart | null) => void;
}

export function SshConfigInstall({ serverStanza, deviceStanzas, knownHosts, wsClient, active, onActive }: Props) {
    const { t, tn } = useI18n();
    // 只在對話框打開後才掛載，直接讀 localStorage 不會有 hydration 不一致。/ Mounted only inside an open dialog.
    const [shell, setShellState] = useState<ConfigShell>(readShell);
    const [method, setMethod] = useState<"command" | "manual">("command");
    const [preview, setPreview] = useState(false);
    const [removeOpen, setRemoveOpen] = useState(false);

    const setShell = (s: ConfigShell) => {
        setShellState(s);
        try {
            localStorage.setItem(SHELL_STORAGE_KEY, s);
        } catch { /* 忽略 / ignore */ }
    };

    const all = [...(serverStanza ? [serverStanza] : []), ...deviceStanzas];
    // 卡片照目前選的作業系統顯示（Windows 的 ProxyCommand 寫法不同）。/ Cards follow the chosen OS (Windows ProxyCommand differs).
    const shownServer = serverStanza ? adaptForShell([serverStanza], shell)[0] : null;
    const code = (s: string) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{s}</code>;
    const user = (s: ConfigStanza) => s.options.find((o) => o.key.toLowerCase() === "user")?.value ?? "";

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
            {deviceStanzas.map((s) => (
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
        </div>
    );

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <Segmented
                    kind="tabs"
                    size="sm"
                    aria-label={t("config.method.aria")}
                    value={method}
                    onChange={setMethod}
                    options={[
                        { value: "command", label: t("config.method.command"), icon: <SquareTerminal size={14} /> },
                        { value: "manual", label: t("config.method.manual"), icon: <ClipboardPaste size={14} /> },
                    ]}
                />
                <Segmented
                    size="sm"
                    aria-label={t("config.shell.aria")}
                    value={shell}
                    onChange={setShell}
                    options={[
                        { value: "posix", label: "macOS / Linux" },
                        { value: "powershell", label: "Windows" },
                    ]}
                />
            </div>

            {method === "command" ? (
                <>
                    <p className="text-muted-foreground">{t(shell === "posix" ? "config.cmd.introPosix" : "config.cmd.introPowershell")}</p>
                    <CodeBlock language={shell === "posix" ? "bash" : "powershell"} value={installCommand(shell, all, knownHosts, wsClient)} />
                    <ul className="space-y-1 text-xs text-muted-foreground">
                        {[
                            ...(wsClient ? [tn("config.cmd.wsClient", { path: code(shell === "posix" ? wsClient.path : "%USERPROFILE%\\.ssh\\telepy-ws.py") })] : []),
                            ...(knownHosts?.trim() ? [tn("config.cmd.knownHosts", { path: code(KNOWN_HOSTS_PATH) })] : []),
                            tn("config.cmd.backup", { path: code(shell === "posix" ? "~/.ssh/config.bak" : "config.bak") }),
                            t("config.cmd.rerun"),
                            t("config.cmd.untouched"),
                        ].map((line, i) => (
                            <li key={i} className="flex items-start gap-2">
                                <Check size={13} className="mt-0.5 shrink-0 text-success" aria-hidden />
                                <span>{line}</span>
                            </li>
                        ))}
                        <li className="pl-5">{t("config.cmd.handPasted")}</li>
                    </ul>
                    <Disclosure title={t("config.cmd.preview")} open={preview} onToggle={() => setPreview((v) => !v)}>
                        {cards}
                    </Disclosure>
                    {deviceStanzas.length > 0 && (
                        <Disclosure title={t("config.remove.title")} open={removeOpen} onToggle={() => setRemoveOpen((v) => !v)}>
                            <p className="text-muted-foreground">{t("config.remove.body")}</p>
                            <CodeBlock language={shell === "posix" ? "bash" : "powershell"} value={removeCommand(shell, deviceStanzas.map((s) => s.alias))} />
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
                        <li><span className="text-foreground">2.</span> {t("config.manual.paste")}</li>
                    </ol>
                    {cards}
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
        </div>
    );
}
