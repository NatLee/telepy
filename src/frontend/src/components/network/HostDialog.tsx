"use client";

/**
 * 區網主機視窗：細節、連線（網頁終端機、免設定一行指令、ssh config 片段、指令速查頁）與編輯。
 * LAN host dialog: details, ways to connect (web terminal, no-config one-liner, ssh config stanza, command
 * sheet) and editing.
 */
import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Save, ScreenShare, SquareTerminal, Terminal, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Section } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { getTerminalPageUrl } from "@/lib/tunnelUrls";
import { desktopPorts } from "@/lib/desktop";
import type { ConnectTarget } from "@/lib/forwardRecipes";
import { cheatsheetJumpUrl, hasSsh, hostName, isValidLogin, lanAlias, lanOneLiner, lanSshConfig } from "@/lib/lanConnect";
import type { FormErrors, HostInput } from "@/hooks/useNetworkPage";
import type { LanHost, TopologyTunnel } from "@/types/lan";

type Tab = "connect" | "details" | "edit";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="grid grid-cols-[7rem_1fr] gap-3 py-1.5 text-sm">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words text-foreground">{children}</dd>
        </div>
    );
}

interface Props {
    host: LanHost | null;
    tunnel: TopologyTunnel | null;
    online: boolean;
    onClose: () => void;
    loadConnectTarget: (tn: TopologyTunnel, deviceUser: string | null) => Promise<ConnectTarget>;
    updateHost: (h: LanHost, input: HostInput) => Promise<FormErrors | null>;
    deleteHost: (h: LanHost) => Promise<boolean>;
}

/**
 * 每台主機一份新狀態（key = 主機 id）；同一台主機的資料更新（掃描 / 儲存）不會蓋掉正在輸入的內容。
 * Fresh state per host (keyed by id); updates to the same host don't clobber what is being typed.
 */
export function HostDialog({ host, tunnel, ...rest }: Props) {
    return host && tunnel ? <HostDialogBody key={host.id} host={host} tunnel={tunnel} {...rest} /> : null;
}

function HostDialogBody({ host, tunnel, online, onClose, loadConnectTarget, updateHost, deleteHost }: Props & { host: LanHost; tunnel: TopologyTunnel }) {
    const { t, tn, locale } = useI18n();
    const router = useRouter();
    const [tab, setTab] = useState<Tab>("connect");
    const [login, setLogin] = useState(host.username ?? "");
    const [deviceUser, setDeviceUser] = useState<string | null>(tunnel.default_username ?? tunnel.usernames[0] ?? null);
    // 載入結果帶著它是哪個帳號的，換帳號時舊的就不顯示。/ The loaded target remembers its account.
    const [loaded, setLoaded] = useState<{ user: string | null; target: ConnectTarget } | null>(null);
    const [form, setForm] = useState({ label: host.label ?? "", username: host.username ?? "", ssh_port: String(host.ssh_port) });
    const [errors, setErrors] = useState<FormErrors>({});
    const [saving, setSaving] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);

    useEffect(() => {
        let cancelled = false;
        loadConnectTarget(tunnel, deviceUser).then((x) => {
            if (!cancelled) setLoaded({ user: deviceUser, target: x });
        });
        return () => { cancelled = true; };
    }, [tunnel, deviceUser, loadConnectTarget]);
    const target = loaded && loaded.user === deviceUser ? loaded.target : null;

    const fmt = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }), [locale]);

    const name = hostName(host);
    const loginOk = isValidLogin(login.trim());
    const cleanLogin = login.trim();
    const noDeviceUser = tunnel.usernames.length === 0;
    const terminalUrl = getTerminalPageUrl(tunnel, { lanHost: host.id, lanUser: cleanLogin && cleanLogin !== host.username ? cleanLogin : undefined });
    const alias = target ? lanAlias(target.alias, host) : "";

    const save = async () => {
        const port = Number(form.ssh_port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            setErrors({ ssh_port: t("network.form.portInvalid") });
            return;
        }
        const username = form.username.trim();
        if (username && !isValidLogin(username)) {
            setErrors({ username: t("network.form.loginInvalid") });
            return;
        }
        setSaving(true);
        const res = await updateHost(host, { label: form.label.trim() || null, username: username || null, ssh_port: port });
        setSaving(false);
        if (res) setErrors(res);
        else {
            setErrors({});
            setLogin(username);
            setTab("connect");
        }
    };

    const tabs = [
        { value: "connect" as const, label: t("network.tab.connect") },
        { value: "details" as const, label: t("network.tab.details") },
        ...(tunnel.can_edit ? [{ value: "edit" as const, label: t("network.tab.edit") }] : []),
    ];

    return (
        <>
            <Modal
                isOpen
                onClose={onClose}
                title={name}
                description={t("network.hostOn", { address: host.ssh_port === 22 ? host.address : `${host.address}:${host.ssh_port}`, device: tunnel.name })}
                icon={<Terminal />}
                size="2xl"
                toolbar={<Segmented options={tabs} value={tab} onChange={setTab} kind="tabs" />}
            >

                {tab === "connect" && (
                    <div className="space-y-4">
                        {!hasSsh(host) && (
                            <Callout tone="warning">{t("network.noSshSeen", { port: host.ssh_port })}</Callout>
                        )}
                        {noDeviceUser && <Callout tone="warning">{t("network.noDeviceUser")}</Callout>}

                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-1.5">
                                <Label htmlFor="lan-login">{t("network.loginAs")}</Label>
                                <Input id="lan-login" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="admin" autoComplete="off" spellCheck={false} className="font-mono" />
                                {!loginOk && <p className="text-xs text-muted-foreground">{t("network.loginHint")}</p>}
                            </div>
                            {tunnel.usernames.length > 1 && (
                                <div className="space-y-1.5">
                                    <Label>{t("network.jumpAccount")}</Label>
                                    <Segmented
                                        options={tunnel.usernames.map((u) => ({ value: u, label: u }))}
                                        value={deviceUser ?? tunnel.usernames[0]}
                                        onChange={setDeviceUser}
                                        kind="toggle"
                                    />
                                </div>
                            )}
                        </div>

                        <div className="flex flex-wrap gap-2">
                            <Button onClick={() => router.push(terminalUrl)} disabled={!online || !loginOk || noDeviceUser} title={!online ? t("network.deviceOffline") : undefined}>
                                <Terminal size={16} /> {t("network.openTerminal")}
                            </Button>
                            <Button variant="outline" asChild>
                                <Link href={cheatsheetJumpUrl(tunnel.id, host, cleanLogin)} prefetch={false}>
                                    <SquareTerminal size={16} /> {t("network.openCheatsheet")}
                                </Link>
                            </Button>
                            <Button variant={desktopPorts(host.open_ports).length > 0 ? "secondary" : "outline"} asChild>
                                <Link href={`/tunnels/desktop?tunnel=${tunnel.id}&lanHost=${host.id}`} prefetch={false}>
                                    <ScreenShare size={16} /> {t("network.openDesktop")}
                                </Link>
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">{t("network.terminalHint")}</p>

                        <Section title={t("network.oneLinerTitle")} description={t("network.oneLinerHint")}>
                            {target ? <CodeBlock language="bash" value={lanOneLiner(target, host, cleanLogin)} /> : <Loader2 size={16} className="animate-spin text-muted-foreground" />}
                        </Section>

                        <Section title={t("network.configTitle")} description={tn("network.configHint", { alias: <code className="font-mono">{target?.alias ?? "…"}</code> })}>
                            {target && (
                                <>
                                    <CodeBlock language="ssh" value={lanSshConfig(target.alias, host, cleanLogin)} />
                                    <p className="text-xs text-muted-foreground">
                                        {tn("network.configThen", { command: <code className="font-mono">ssh {alias}</code> })}
                                    </p>
                                </>
                            )}
                        </Section>
                    </div>
                )}

                {tab === "details" && (
                    <dl className="divide-y divide-border">
                        <Row label={t("network.field.address")}><span className="font-mono">{host.address}</span></Row>
                        {host.hostname && <Row label={t("network.field.hostname")}><span className="font-mono">{host.hostname}</span></Row>}
                        {host.mac && <Row label={t("network.field.mac")}><span className="font-mono">{host.mac}</span></Row>}
                        <Row label={t("network.field.openPorts")}>
                            {host.open_ports.length ? (
                                <span className="flex flex-wrap gap-1">
                                    {host.open_ports.map((p) => <Badge key={p} variant="outline" className="font-mono text-[0.75rem]">{p}</Badge>)}
                                </span>
                            ) : t("network.noOpenPorts")}
                        </Row>
                        {host.ssh_banner && <Row label={t("network.field.banner")}><span className="font-mono text-xs">{host.ssh_banner}</span></Row>}
                        <Row label={t("network.field.source")}>{host.source === "scan" ? t("network.source.scan") : t("network.source.manual")}</Row>
                        {host.last_seen && <Row label={t("network.field.lastSeen")}>{fmt.format(new Date(host.last_seen))}</Row>}
                        {host.first_seen && <Row label={t("network.field.firstSeen")}>{fmt.format(new Date(host.first_seen))}</Row>}
                    </dl>
                )}

                {tab === "edit" && tunnel.can_edit && (
                    <div className="space-y-4">
                        <div className="space-y-1.5">
                            <Label htmlFor="lan-label">{t("network.field.label")}</Label>
                            <Input id="lan-label" value={form.label} maxLength={100} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={host.hostname ?? host.address} />
                            {errors.label && <p className="text-xs text-destructive">{errors.label}</p>}
                        </div>
                        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
                            <div className="space-y-1.5">
                                <Label htmlFor="lan-user">{t("network.field.username")}</Label>
                                <Input id="lan-user" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="admin" autoComplete="off" spellCheck={false} className="font-mono" />
                                {errors.username && <p className="text-xs text-destructive">{errors.username}</p>}
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="lan-port">{t("network.field.sshPort")}</Label>
                                <Input id="lan-port" inputMode="numeric" value={form.ssh_port} onChange={(e) => setForm({ ...form, ssh_port: e.target.value })} placeholder="22" className="font-mono" />
                                {errors.ssh_port && <p className="text-xs text-destructive">{errors.ssh_port}</p>}
                            </div>
                        </div>
                        {errors._ && <p className="text-sm text-destructive">{errors._}</p>}
                        <div className="flex flex-wrap justify-between gap-2">
                            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                                <Trash2 size={16} /> {t("network.deleteHost")}
                            </Button>
                            <Button onClick={save} disabled={saving}>
                                {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} {t("common.save")}
                            </Button>
                        </div>
                        {host.source === "scan" && <p className="text-xs text-muted-foreground">{t("network.deleteScannedHint")}</p>}
                    </div>
                )}
            </Modal>
            <ConfirmDialog
                isOpen={confirmDelete}
                onClose={() => setConfirmDelete(false)}
                onConfirm={async () => {
                    setConfirmDelete(false);
                    if (await deleteHost(host)) onClose();
                }}
                title={t("network.deleteHost")}
                message={t("network.deleteConfirm", { name })}
                confirmText={t("network.deleteHost")}
                isDestructive
            />
        </>
    );
}
