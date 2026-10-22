"use client";

/**
 * 手動加一台區網主機（掃描找不到的、或還沒掃）。/ Add a LAN host by hand.
 */
import React, { useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";
import { isValidLogin } from "@/lib/lanConnect";
import type { FormErrors, HostInput } from "@/hooks/useNetworkPage";
import type { TopologyTunnel } from "@/types/lan";

const EMPTY = { address: "", label: "", username: "", ssh_port: "22" };

interface Props {
    tunnel: TopologyTunnel | null;
    onClose: () => void;
    addHost: (tn: TopologyTunnel, input: HostInput) => Promise<FormErrors | null>;
}

/** 每條隧道一份新表單（key 重設狀態）。/ A fresh form per tunnel (the key resets the state). */
export function AddHostDialog({ tunnel, ...rest }: Props) {
    return tunnel ? <AddHostForm key={tunnel.id} tunnel={tunnel} {...rest} /> : null;
}

function AddHostForm({ tunnel, onClose, addHost }: Props & { tunnel: TopologyTunnel }) {
    const { t } = useI18n();
    const [form, setForm] = useState(EMPTY);
    const [errors, setErrors] = useState<FormErrors>({});
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        const port = Number(form.ssh_port || "22");
        const next: FormErrors = {};
        if (!form.address.trim()) next.address = t("network.form.addressRequired");
        if (!Number.isInteger(port) || port < 1 || port > 65535) next.ssh_port = t("network.form.portInvalid");
        if (form.username.trim() && !isValidLogin(form.username.trim())) next.username = t("network.form.loginInvalid");
        if (Object.keys(next).length) {
            setErrors(next);
            return;
        }
        setBusy(true);
        const res = await addHost(tunnel, {
            address: form.address.trim(),
            label: form.label.trim() || null,
            username: form.username.trim() || null,
            ssh_port: port,
        });
        setBusy(false);
        if (res) setErrors(res);
        else onClose();
    };

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={t("network.addTitle", { name: tunnel.name })}
            description={t("network.addDescription")}
            icon={<Plus />}
            size="md"
            footer={
                <>
                    <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
                    <Button onClick={submit} disabled={busy}>
                        {busy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} {t("network.addHost")}
                    </Button>
                </>
            }
        >
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                <div className="space-y-1.5">
                    <Label htmlFor="add-address">{t("network.field.address")}</Label>
                    <Input id="add-address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="192.168.1.20" spellCheck={false} className="font-mono" autoFocus />
                    {errors.address ? <p className="text-xs text-destructive">{errors.address}</p> : <p className="text-xs text-muted-foreground">{t("network.form.addressHint")}</p>}
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor="add-label">{t("network.field.label")}</Label>
                    <Input id="add-label" value={form.label} maxLength={100} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={t("network.form.labelPlaceholder")} />
                    {errors.label && <p className="text-xs text-destructive">{errors.label}</p>}
                </div>
                <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
                    <div className="space-y-1.5">
                        <Label htmlFor="add-user">{t("network.field.username")}</Label>
                        <Input id="add-user" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="admin" autoComplete="off" spellCheck={false} className="font-mono" />
                        {errors.username && <p className="text-xs text-destructive">{errors.username}</p>}
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="add-port">{t("network.field.sshPort")}</Label>
                        <Input id="add-port" inputMode="numeric" value={form.ssh_port} onChange={(e) => setForm({ ...form, ssh_port: e.target.value })} placeholder="22" className="font-mono" />
                        {errors.ssh_port && <p className="text-xs text-destructive">{errors.ssh_port}</p>}
                    </div>
                </div>
                {errors._ && <p className="text-sm text-destructive">{errors._}</p>}
                <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
            </form>
        </Modal>
    );
}
