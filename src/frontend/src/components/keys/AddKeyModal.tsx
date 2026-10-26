/**
 * 新增金鑰：貼上公鑰後即時顯示類型 / 位元數 / SHA256 指紋與強度警告；可同時勾選要裝到哪些裝置。
 * Add a key: pasting shows the type, size, SHA256 fingerprint and strength warnings right away; you can
 * also pick devices whose key list should get it.
 */
import React, { useEffect, useMemo, useState } from "react";
import { HardDrive, KeyRound, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Callout } from "@/components/ui/callout";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { fingerprint, keyProblem, parsePublicKey, type KeyProblem } from "@/lib/sshKeys";
import type { KeyDevice } from "@/types/keys";
import type { KeyGroup } from "@/types/groups";
import type { NewKey } from "@/hooks/useKeysPage";
import { KeyTypeBadge } from "./KeyCard";
import { OnlineDot } from "./DeviceMatrix";
import { DeviceFilterBar, DeviceFilterFooter, useDeviceFilter } from "./DeviceFilter";
import { ExpiryPicker } from "@/components/keys/ExpiryPicker";
import { expiryValue, type ExpiryPreset } from "@/lib/keyExpiry";

const PROBLEM: Record<KeyProblem, TranslationKey> = {
    invalid: "keys.problem.invalid",
    multiline: "keys.problem.multiline",
    dsa: "keys.problem.dsa",
    rsaShort: "keys.problem.rsaShort",
};

export function AddKeyModal({
    isOpen,
    onClose,
    devices,
    keyGroups = [],
    onSubmit,
}: {
    isOpen: boolean;
    onClose: () => void;
    devices: KeyDevice[];
    /** 我的金鑰群組（有的話可以直接放進去）。/ My key groups (the new key can go straight into one). */
    keyGroups?: KeyGroup[];
    onSubmit: (k: NewKey) => Promise<boolean>;
}) {
    const { t } = useI18n();
    const [key, setKey] = useState("");
    // null = 還沒改過，名稱跟著金鑰註解。/ null = untouched: the name follows the key comment.
    const [nameInput, setNameInput] = useState<string | null>(null);
    const [description, setDescription] = useState("");
    const [deviceIds, setDeviceIds] = useState<number[]>([]);
    const [groupId, setGroupId] = useState<number | null>(null);
    const [expiryPreset, setExpiryPreset] = useState<ExpiryPreset>("never");
    const [expiryDate, setExpiryDate] = useState("");
    const [computed, setComputed] = useState<{ key: string; fp: string } | null>(null);
    const [submitting, setSubmitting] = useState(false);

    const parsed = useMemo(() => parsePublicKey(key), [key]);
    const problem = key.trim() ? keyProblem(key) : null;
    const name = nameInput ?? parsed?.comment ?? "";
    const fp = computed?.key === key ? computed.fp : null;

    useEffect(() => {
        if (!parsed) return;
        let cancelled = false;
        fingerprint(parsed)
            .then((v) => !cancelled && setComputed({ key, fp: v }))
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [parsed, key]);

    const close = () => {
        setKey("");
        setNameInput(null);
        setDescription("");
        setDeviceIds([]);
        setGroupId(null);
        setExpiryPreset("never");
        setExpiryDate("");
        onClose();
    };

    // 裝置多時可搜尋；已勾的不會因為篩選而被取消。/ Searchable when there are many; ticks survive filtering.
    const filter = useDeviceFilter(devices, { device: (d) => d });

    const toggleDevice = (id: number) => setDeviceIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (problem || !name.trim()) return;
        setSubmitting(true);
        const ok = await onSubmit({ key, name, description, deviceIds, groupId, expiresAt: expiryValue(expiryPreset, expiryDate, "create") ?? undefined });
        setSubmitting(false);
        if (ok) close();
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={close}
            title={t("keys.addModalTitle")}
            description={t("keys.addModalDescription")}
            icon={<KeyRound />}
            size="2xl"
            footer={
                <>
                    <Button variant="outline" onClick={close} disabled={submitting}>{t("common.cancel")}</Button>
                    <Button type="submit" form="add-key-form" disabled={submitting || !!problem || !key.trim() || !name.trim()}>
                        {submitting ? <><Loader2 className="animate-spin" /> {t("keys.adding")}</> : deviceIds.length ? t("keys.addAndInstall", { count: deviceIds.length }) : t("keys.addModalTitle")}
                    </Button>
                </>
            }
        >
            <form id="add-key-form" onSubmit={submit} className="space-y-5">
                <div className="space-y-2">
                    <Label htmlFor="add-key-content">
                        {t("keys.sshPublicKey")} <span className="text-destructive">*</span>
                    </Label>
                    <Textarea
                        id="add-key-content"
                        required
                        autoFocus
                        rows={3}
                        value={key}
                        onChange={(e) => setKey(e.target.value)}
                        aria-invalid={!!problem}
                        className="font-mono text-xs leading-relaxed md:text-xs"
                        placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… you@laptop"
                    />
                    <p className="text-xs text-muted-foreground">{t("keys.pasteHint")}</p>
                    {parsed && !problem && (
                        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface px-2.5 py-2 ring-1 ring-border">
                            <KeyTypeBadge type={parsed.label} bits={parsed.bits} />
                            <span className="min-w-0 truncate font-mono text-[0.75rem] text-muted-foreground">{fp ?? "…"}</span>
                        </div>
                    )}
                    {problem && <Callout tone={problem === "invalid" || problem === "multiline" ? "danger" : "warning"}>{t(PROBLEM[problem])}</Callout>}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                        <Label htmlFor="add-key-name">
                            {t("keys.hostFriendlyName")} <span className="text-destructive">*</span>
                        </Label>
                        <Input
                            id="add-key-name"
                            required
                            value={name}
                            onChange={(e) => setNameInput(e.target.value)}
                            placeholder={t("keys.namePlaceholder")}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="add-key-description">
                            {t("common.description")} <span className="text-muted-foreground">{t("common.optional")}</span>
                        </Label>
                        <Input id="add-key-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("keys.descriptionPlaceholder")} />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="add-key-expiry">{t("keys.expiry.label")}</Label>
                        <ExpiryPicker id="add-key-expiry" preset={expiryPreset} customDate={expiryDate} onPreset={setExpiryPreset} onCustomDate={setExpiryDate} neverLabel={t("keys.expiry.siteDefault")} />
                        <p className="text-xs text-muted-foreground">{t("keys.expiry.hint")}</p>
                    </div>
                    {keyGroups.length > 0 && (
                        <div className="space-y-2">
                            <Label htmlFor="add-key-group">{t("groups.key.field")}</Label>
                            <NativeSelect id="add-key-group" value={groupId ?? ""} onChange={(e) => setGroupId(e.target.value ? Number(e.target.value) : null)}>
                                <option value="">{t("groups.key.fieldNone")}</option>
                                {keyGroups.map((g) => (
                                    <option key={g.id} value={g.id}>{g.name}</option>
                                ))}
                            </NativeSelect>
                            <p className="text-xs text-muted-foreground">{t("groups.key.fieldHint")}</p>
                        </div>
                    )}
                </div>
                {devices.length > 0 && (
                    <fieldset className="space-y-2">
                        <legend className="text-sm text-foreground">
                            {t("keys.installOn")}
                            {deviceIds.length > 0 && <span className="ml-2 text-xs text-muted-foreground">{t("keys.installOnSelected", { count: deviceIds.length })}</span>}
                        </legend>
                        <p className="text-xs text-muted-foreground">{t("keys.installOnHint")}</p>
                        <DeviceFilterBar filter={filter} modes={["all"]} />
                        <div className="grid gap-1.5 p-px sm:grid-cols-2">
                            {filter.visible.map((d) => (
                                <label
                                    key={d.tunnel_id}
                                    className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 ring-1 ring-border transition-colors hover:bg-muted/40 has-[:checked]:bg-primary/6 has-[:checked]:ring-primary/30"
                                >
                                    <input type="checkbox" checked={deviceIds.includes(d.tunnel_id)} onChange={() => toggleDevice(d.tunnel_id)} className="mt-0.5 size-4 accent-primary" />
                                    <span className="min-w-0">
                                        <span className="flex items-center gap-1.5 text-sm text-foreground">
                                            <HardDrive size={13} className="text-muted-foreground" aria-hidden />
                                            <span className="truncate">{d.host_friendly_name}</span>
                                        </span>
                                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[0.75rem] text-muted-foreground">
                                            <OnlineDot online={d.online} />
                                            <span className="font-mono">{d.accounts.length ? d.accounts.join(", ") : t("keys.status.noAccounts")}</span>
                                        </span>
                                    </span>
                                </label>
                            ))}
                        </div>
                        <DeviceFilterFooter filter={filter} />
                    </fieldset>
                )}
            </form>
        </Modal>
    );
}
