"use client";

/**
 * RustDesk 裝置頁（`/tunnels/rustdesk`）：Telepy 當這些電腦的 RustDesk 伺服器，它們不需要 Telepy 隧道，自己經 HTTPS
 * 連進來。這裡新增（一次性登記指令）、改名、移除，以及「連線」→ 遠端桌面頁（`?rustdesk=<id>`）在瀏覽器裡開。
 * The RustDesk devices page: computers that use Telepy as their RustDesk server (no tunnel). Add them with a
 * one-time command, rename or remove them, and connect, which opens the remote desktop page for that device.
 */
import React, { useState } from "react";
import Link from "next/link";
import { Info, MonitorSmartphone, MoreHorizontal, Pencil, Plus, Route, ScreenShare, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/section";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { StatusDot, TunnelLastSeen } from "@/components/tunnels/TunnelStatus";
import { EnrolDialog } from "@/components/rustdesk/EnrolDialog";
import { ConnectionWaysDialog } from "@/components/desktop/ConnectionWays";
import { Disclosure } from "@/components/tunnels/CreateWizardSteps/parts";
import { useRustDeskDevices } from "@/hooks/useRustDeskDevices";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { deviceDetails, formatRustDeskId, serverProblemKey, type RustDeskDevice } from "@/lib/rustdeskDevices";

const CARD = "rounded-xl border border-border bg-card shadow-card";

function DeviceCard({ device, onRename, onRemove }: { device: RustDeskDevice; onRename: () => void; onRemove: () => void }) {
    const { t } = useI18n();
    const details = deviceDetails(device);
    return (
        <li className={`${CARD} flex flex-col gap-3 p-4`}>
            <div className="flex items-start gap-3">
                <span className={`grid size-10 shrink-0 place-items-center rounded-lg border ${device.online ? "border-success/25 bg-success/10 text-success" : "border-border bg-surface text-muted-foreground"}`} aria-hidden>
                    <MonitorSmartphone size={19} />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-base text-foreground" title={device.name}>{device.name}</p>
                    <p className="text-sm tabular-nums text-muted-foreground" title={t("rustdesk.card.id")}>{formatRustDeskId(device.rustdesk_id)}</p>
                </div>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label={t("rustdesk.card.actions", { name: device.name })}>
                            <MoreHorizontal size={16} />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={onRename}><Pencil size={14} /> {t("rustdesk.card.rename")}</DropdownMenuItem>
                        <DropdownMenuItem onSelect={onRemove} className="text-destructive focus:text-destructive"><Trash2 size={14} /> {t("rustdesk.card.remove")}</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            {details && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{details}</p>}
            <div className="mt-auto flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs text-foreground">
                    <StatusDot online={device.online} /> {device.online ? t("rustdesk.card.online") : t("rustdesk.card.offline")}
                </span>
                {!device.online && (device.last_seen_at ? <TunnelLastSeen at={device.last_seen_at} /> : <span className="text-xs text-muted-foreground">{t("rustdesk.card.neverSeen")}</span>)}
                {device.in_use > 0 && <Chip>{t("rustdesk.card.inUse", { n: device.in_use })}</Chip>}
                {!device.mine && device.owner.username && <Chip>{t("rustdesk.card.owner", { name: device.owner.username })}</Chip>}
                <span className="flex-1" />
                {device.online ? (
                    <Button asChild size="sm">
                        <Link href={`/tunnels/desktop?rustdesk=${device.id}`} prefetch={false}><ScreenShare size={15} /> {t("rustdesk.card.connect")}</Link>
                    </Button>
                ) : (
                    <Button size="sm" disabled><ScreenShare size={15} /> {t("rustdesk.card.connect")}</Button>
                )}
            </div>
        </li>
    );
}

export default function RustDeskDevicesPage() {
    const { t } = useI18n();
    const { user } = useAuth();
    const { showSuccess, showError } = useToast();
    const { devices, server, loaded, failed, rename, remove } = useRustDeskDevices();
    const [adding, setAdding] = useState(false);
    const [renaming, setRenaming] = useState<RustDeskDevice | null>(null);
    const [newName, setNewName] = useState("");
    const [renameError, setRenameError] = useState<string | null>(null);
    const [removing, setRemoving] = useState<RustDeskDevice | null>(null);
    const [waysOpen, setWaysOpen] = useState(false);

    const off = !!server && !server.enabled;
    const problem = server ? serverProblemKey(server.problem) : null;

    const saveName = async () => {
        if (!renaming) return;
        const err = await rename(renaming.id, newName);
        if (err === null) {
            showSuccess(t("rustdesk.renamed"));
            setRenaming(null);
        } else {
            setRenameError(err || t("api.unexpectedError"));
        }
    };

    return (
        <div className="animate-fade-in-up space-y-6">
            <PageHeader
                icon={<MonitorSmartphone />}
                title={t("rustdesk.title")}
                description={t("rustdesk.description")}
                actions={
                    <>
                        <Button variant="outline" onClick={() => setWaysOpen(true)}>
                            <Route size={16} /> {t("desktop.ways.button")}
                        </Button>
                        <Button onClick={() => setAdding(true)} disabled={off || !server}>
                            <Plus size={16} /> {t("rustdesk.add")}
                        </Button>
                    </>
                }
            />

            {off && (
                <Callout tone="warning">
                    {t("rustdesk.serverOff")}{" "}
                    {user?.is_superuser && <Link href="/tunnels/settings?tab=desktop" className="text-primary underline-offset-2 hover:underline">{t("rustdesk.openSettings")}</Link>}
                </Callout>
            )}
            {!off && problem && <Callout tone="warning" title={t("rustdesk.problem.title")}>{t(problem)}</Callout>}
            {failed && <Callout tone="danger">{t("rustdesk.loadFailed")}</Callout>}

            {/* 說明：還沒有裝置時攤開，有了就收起來（不擠到清單）。/ The explainer: open while empty, folded once there are devices. */}
            {loaded && devices.length > 0 ? (
                <Disclosure title={t("rustdesk.how.title")} icon={<Info size={15} />}>
                    <div className="space-y-1.5 text-sm leading-relaxed text-muted-foreground">
                        <p>{t("rustdesk.how.body")}</p>
                        <p>{t("rustdesk.how.public")}</p>
                        <p>{t("rustdesk.how.ssh")}</p>
                    </div>
                </Disclosure>
            ) : (
                <Callout tone="info" icon={<Info size={17} className="mt-0.5 shrink-0" aria-hidden />} title={t("rustdesk.how.title")}>
                    <p>{t("rustdesk.how.body")}</p>
                    <p className="mt-1.5">{t("rustdesk.how.public")}</p>
                    <p className="mt-1.5">{t("rustdesk.how.ssh")}</p>
                </Callout>
            )}

            {loaded && devices.length === 0 && !failed ? (
                <div className={`${CARD} flex flex-col items-center gap-3 px-6 py-10 text-center`}>
                    <MonitorSmartphone size={28} className="text-muted-foreground" aria-hidden />
                    <p className="text-base text-foreground">{t("rustdesk.empty.title")}</p>
                    <p className="max-w-md text-sm text-muted-foreground">{t("rustdesk.empty.body")}</p>
                    <Button onClick={() => setAdding(true)} disabled={off || !server}><Plus size={16} /> {t("rustdesk.add")}</Button>
                </div>
            ) : (
                <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {devices.map((d) => (
                        <DeviceCard
                            key={d.id}
                            device={d}
                            onRename={() => { setRenaming(d); setNewName(d.name); setRenameError(null); }}
                            onRemove={() => setRemoving(d)}
                        />
                    ))}
                </ul>
            )}

            {adding && <EnrolDialog onClose={() => setAdding(false)} />}
            <ConnectionWaysDialog isOpen={waysOpen} onClose={() => setWaysOpen(false)} current="rustdeskServer" />
            <Modal
                isOpen={!!renaming}
                onClose={() => setRenaming(null)}
                title={t("rustdesk.rename.title")}
                icon={<Pencil />}
                size="md"
                footer={
                    <>
                        <Button variant="outline" onClick={() => setRenaming(null)}>{t("common.cancel")}</Button>
                        <Button onClick={() => void saveName()} disabled={!newName.trim()}>{t("common.save")}</Button>
                    </>
                }
            >
                <form onSubmit={(e) => { e.preventDefault(); void saveName(); }}>
                    <Field label={t("rustdesk.rename.label")} error={renameError ?? undefined}>
                        <Input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={64} autoFocus autoComplete="off" />
                    </Field>
                </form>
            </Modal>
            <ConfirmDialog
                isOpen={!!removing}
                onClose={() => setRemoving(null)}
                onConfirm={async () => {
                    const d = removing;
                    setRemoving(null);
                    if (!d) return;
                    if (await remove(d.id)) showSuccess(t("rustdesk.removed", { name: d.name }));
                    else showError(t("api.unexpectedError"));
                }}
                title={removing ? t("rustdesk.remove.title", { name: removing.name }) : ""}
                message={t("rustdesk.remove.message")}
                confirmText={t("rustdesk.card.remove")}
                isDestructive
            />
        </div>
    );
}
