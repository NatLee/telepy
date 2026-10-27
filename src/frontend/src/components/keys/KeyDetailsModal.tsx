/**
 * 金鑰詳情，分頁放在左側欄（跟偏好設定一樣），視窗固定高度、切頁不跳動：
 * 「概覽」= ID、類型、指紋、效期、建立 / 最後使用與它在幾台裝置上；「編輯」= 名稱、說明、群組、公鑰（不能和別把重複；
 * 換了內容，Telepy 會在每台有這把金鑰的裝置上換成新的）與效期；「裝置」= 它在每台裝置每個帳號上的狀態，勾選立即生效。
 * 有沒存的改動或要修正的欄位時，「編輯」分頁標一個點；「儲存」只在編輯頁或有改動時出現。
 * Key details with tabs in a side rail (like Preferences) and a fixed height: Overview (id, type, fingerprint,
 * expiry, created / last used, how many devices), Edit (name, description, group, public key — unique; new key
 * material is re-installed on every device that has it — and expiry) and Devices (its state on every device
 * account; ticks apply at once). Unsaved or invalid fields dot the Edit tab; Save shows there or while dirty.
 */
import React, { useEffect, useMemo, useState } from "react";
import { ArrowRight, HardDrive, Hash, Info, KeyRound, Layers, Loader2, Pencil, Save, Settings2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { NavTabLabel, NavTabs } from "@/components/ui/nav-tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Callout } from "@/components/ui/callout";
import { CopyButton } from "@/components/ui/CopyButton";
import { Chip, Property, PropertyList, Section } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import { fingerprint, keyProblem, parsePublicKey, shortFingerprint, type KeyProblem } from "@/lib/sshKeys";
import type { TranslationKey } from "@/locales/en";
import type { KeyDevice, KeyTarget, UserKey } from "@/types/keys";
import type { KeyGroup, KeyGroupSource } from "@/types/groups";
import type { KeyPatch, KeyPatchErrors } from "@/hooks/useKeysPage";
import { KeyTypeBadge } from "./KeyList";
import { OnlineDot, RoleBadge } from "./DeviceMatrix";
import { TargetChips } from "./TargetChips";
import { DeviceFilterBar, DeviceFilterFooter, needsAttention, useDeviceFilter } from "./DeviceFilter";
import { ExpiryPicker } from "@/components/keys/ExpiryPicker";
import { KeyExpiryText } from "@/components/keys/KeyList";
import { expiryState } from "@/lib/keyExpiry";
import { expiryValue, localDate, type ExpiryPreset } from "@/lib/keyExpiry";

const PROBLEM: Record<KeyProblem, TranslationKey> = {
    invalid: "keys.problem.invalid",
    multiline: "keys.problem.multiline",
    dsa: "keys.problem.dsa",
    rsaShort: "keys.problem.rsaShort",
};

interface DevicesProps {
    /** 我能用的每台裝置（含這把金鑰不在清單上的）。/ Every device I can use. */
    devices: KeyDevice[];
    /** 正在切換的 `${tunnelId}:${keyId}`。/ Cells being toggled. */
    pending: Set<string>;
    onToggle: (device: KeyDevice, key: UserKey, on: boolean) => void;
    onManageDevice: (device: KeyDevice) => void;
    /** 我的金鑰群組（選這把金鑰在哪一組）。/ My key groups (to pick this key's group). */
    keyGroups?: KeyGroup[];
}

export function KeyDetailsModal({
    keyItem,
    onClose,
    onSave,
    ...devices
}: {
    keyItem: UserKey | null;
    onClose: () => void;
    /** 回傳欄位錯誤;null = 成功。/ Returns field errors; null on success. */
    onSave: (key: UserKey, patch: KeyPatch) => Promise<KeyPatchErrors | null>;
} & DevicesProps) {
    // 每把金鑰一份新表單(key = 金鑰 id):換一把就重設。/ Fresh form per key (keyed by id).
    return keyItem ? <KeyDetailsBody key={keyItem.id} keyItem={keyItem} onClose={onClose} onSave={onSave} {...devices} /> : <Modal isOpen={false} onClose={onClose} title="" />;
}

/**
 * 這把金鑰在每台裝置上：在那裡（直接或經由金鑰群組）的才有 targets；`direct` = 直接在清單上（勾選框就是它）。
 * The key on every device: targets when it is there (directly or through key groups); `direct` = listed
 * directly (that is what the tick means).
 */
type Placement = { device: KeyDevice; targets: KeyTarget[] | null; direct: boolean; groups: KeyGroupSource[] };

/** 這把金鑰在幾台清單上、幾台全裝好、幾台要處理。/ Devices with this key listed, fully installed, needing attention. */
function deviceCounts(devices: KeyDevice[], keyId: number) {
    let on = 0;
    let installed = 0;
    let problems = 0;
    for (const device of devices) {
        const targets = device.keys.find((x) => x.user_key_id === keyId)?.targets;
        if (!targets) continue;
        on++;
        if (targets.length > 0 && targets.every((x) => x.status === "installed")) installed++;
        if (needsAttention(targets, device.online)) problems++;
    }
    return { on, installed, problems, total: devices.length };
}

type KeyDetailsTab = "overview" | "edit" | "devices";

function rank(p: Placement): number {
    if (p.targets && needsAttention(p.targets, p.device.online)) return 0;
    return p.targets ? 1 : 2;
}

/** 很多台也看得完：摘要、問題排前面、搜尋 / 篩選、勾選直接放上或拿掉。
 *  Scales to many devices: a summary, problems first, search / filter, and a tick per device. */
function KeyDevices({ keyItem, devices, pending, onToggle, onManageDevice }: { keyItem: UserKey } & DevicesProps) {
    const { t } = useI18n();
    const placements = useMemo<Placement[]>(
        () =>
            devices
                .map((device) => {
                    const k = device.keys.find((x) => x.user_key_id === keyItem.id);
                    return { device, targets: k?.targets ?? null, direct: !!k && k.direct !== false, groups: k?.groups ?? [] };
                })
                .sort((a, b) => rank(a) - rank(b) || a.device.host_friendly_name.localeCompare(b.device.host_friendly_name)),
        [devices, keyItem.id]
    );
    const onList = placements.filter((p) => p.targets);
    const { installed, problems } = deviceCounts(devices, keyItem.id);
    const filter = useDeviceFilter(placements, {
        device: (p) => p.device,
        isOn: (p) => !!p.targets,
        isProblem: (p) => !!p.targets && needsAttention(p.targets, p.device.online),
        initial: onList.length > 0 ? "on" : "all",
    });

    if (devices.length === 0) {
        return <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-sm leading-relaxed text-muted-foreground">{t("keys.matrix.emptyBody")}</p>;
    }
    return (
        <div className="space-y-3">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                <span>{t("keys.details.devicesSummary", { on: onList.length, total: devices.length })}</span>
                {installed > 0 && <Chip tone="success">{t("keys.details.installedCount", { count: installed })}</Chip>}
                {problems > 0 && <Chip tone="warning">{t("keys.details.problemCount", { count: problems })}</Chip>}
            </p>
            <DeviceFilterBar filter={filter} />
            <ul className="divide-y divide-border/70 rounded-xl ring-1 ring-inset ring-border/80">
                {filter.visible.map(({ device, targets, direct, groups }) => {
                    const busy = pending.has(`${device.tunnel_id}:${keyItem.id}`);
                    const id = `key-${keyItem.id}-dev-${device.tunnel_id}`;
                    return (
                        <li key={device.tunnel_id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                            <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5">
                                {busy ? (
                                    <Loader2 size={16} className="mt-0.5 animate-spin text-primary" aria-hidden />
                                ) : (
                                    <input id={id} type="checkbox" checked={direct} onChange={(e) => onToggle(device, keyItem, e.target.checked)} className="mt-0.5 size-4 accent-primary" />
                                )}
                                <span className="flex min-w-0 flex-col gap-1">
                                    <span className="flex flex-wrap items-center gap-2 text-sm">
                                        <span className="truncate text-foreground">{device.host_friendly_name}</span>
                                        <RoleBadge role={device.role} />
                                        <OnlineDot online={device.online} />
                                        {groups.map((g) => (
                                            <Chip key={g.id} title={t("groups.viaGroup", { name: g.name })}>
                                                <Layers aria-hidden /> {t("groups.viaGroupShort", { name: g.name })}
                                            </Chip>
                                        ))}
                                    </span>
                                    {targets ? (
                                        <TargetChips targets={targets} online={device.online} />
                                    ) : (
                                        <span className="text-xs text-muted-foreground">{t("keys.matrix.notInList")}</span>
                                    )}
                                </span>
                            </label>
                            <Button type="button" variant="ghost" size="xs" onClick={() => onManageDevice(device)} className="text-muted-foreground hover:text-foreground" title={t("keys.matrix.manage")}>
                                <Settings2 /> <span className="sr-only sm:not-sr-only">{t("keys.matrix.manage")}</span>
                            </Button>
                        </li>
                    );
                })}
            </ul>
            <DeviceFilterFooter filter={filter} />
        </div>
    );
}

function KeyDetailsBody({
    keyItem,
    onClose,
    onSave,
    keyGroups = [],
    ...devices
}: {
    keyItem: UserKey;
    onClose: () => void;
    onSave: (key: UserKey, patch: KeyPatch) => Promise<KeyPatchErrors | null>;
} & DevicesProps) {
    const { t, locale } = useI18n();
    const currentGroup = keyGroups.find((g) => g.key_ids.includes(keyItem.id))?.id ?? null;
    const [form, setForm] = useState({ host_friendly_name: keyItem.host_friendly_name, key: keyItem.key, description: keyItem.description ?? "" });
    const [groupId, setGroupId] = useState<number | null>(currentGroup);
    // 效期：null = 沒動。/ Expiry: null = untouched.
    const [expiryPreset, setExpiryPreset] = useState<ExpiryPreset | null>(null);
    const [expiryDate, setExpiryDate] = useState("");
    const [serverErrors, setServerErrors] = useState<KeyPatchErrors>({});
    const [saving, setSaving] = useState(false);
    const [tab, setTabState] = useState<KeyDetailsTab>("overview");
    const formRef = React.useRef<HTMLFormElement>(null);
    // 各頁共用同一個捲動區，切頁時回到頂端。/ The pages share one scroll area; start at the top.
    const setTab = (next: KeyDetailsTab) => {
        setTabState(next);
        const scroller = formRef.current?.parentElement;
        if (scroller) scroller.scrollTop = 0;
    };

    const setField = (name: keyof typeof form, value: string) => {
        setForm((f) => ({ ...f, [name]: value }));
        // 刪掉而不是設成 undefined:合併 {...live, ...server} 時 undefined 會蓋掉即時檢查的錯誤。
        // Delete rather than set undefined, which would shadow the live error when merging.
        setServerErrors((e) => {
            if (!(name in e)) return e;
            const next = { ...e };
            delete next[name];
            return next;
        });
    };

    const patch = useMemo(() => {
        const p: KeyPatch = {};
        if (form.host_friendly_name.trim() !== keyItem.host_friendly_name) p.host_friendly_name = form.host_friendly_name.trim();
        if (form.key.trim() !== keyItem.key.trim()) p.key = form.key.trim();
        if (form.description !== (keyItem.description ?? "")) p.description = form.description;
        if (groupId !== currentGroup) p.group_id = groupId;
        if (expiryPreset !== null) {
            const v = expiryValue(expiryPreset, expiryDate, "update");
            if (v !== undefined) p.expires_at = v;
        }
        return p;
    }, [form, keyItem, expiryPreset, expiryDate, groupId, currentGroup]);
    const dirty = Object.keys(patch).length > 0;
    const keyChanged = patch.key !== undefined;

    const liveErrors: KeyPatchErrors = {};
    if (!form.host_friendly_name.trim()) liveErrors.host_friendly_name = t("keys.nameRequired");
    if (keyChanged) {
        const problem = form.key.trim() ? keyProblem(form.key) : "invalid";
        if (problem) liveErrors.key = t(PROBLEM[problem]);
    }
    const errors = { ...liveErrors, ...serverErrors };
    const valid = Object.keys(liveErrors).length === 0;

    // 編輯中的公鑰即時預覽(與新增視窗相同)。/ Live preview of the edited key, as in the add dialog.
    const parsed = useMemo(() => parsePublicKey(form.key), [form.key]);
    const [computed, setComputed] = useState<{ key: string; fp: string } | null>(null);
    useEffect(() => {
        if (!parsed) return;
        let cancelled = false;
        fingerprint(parsed).then((v) => !cancelled && setComputed({ key: form.key, fp: v })).catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [parsed, form.key]);
    const previewFp = computed?.key === form.key ? computed.fp : null;

    const fmt = (iso: string) => new Date(iso).toLocaleString(locale);
    const counts = deviceCounts(devices.devices, keyItem.id);
    const hasErrors = Object.keys(errors).length > 0;
    const tabs = [
        { value: "overview" as const, label: t("keys.details.tabOverview"), hint: t("keys.details.tabOverviewHint"), icon: <Info /> },
        { value: "edit" as const, label: <NavTabLabel label={t("keys.details.tabEdit")} mark={hasErrors ? "error" : dirty ? "dirty" : null} />, hint: t("keys.details.tabEditHint"), icon: <Pencil /> },
        {
            value: "devices" as const,
            label: <NavTabLabel label={t("keys.details.tabDevices")} mark={counts.problems > 0 ? "error" : null} />,
            hint: t("keys.details.tabDevicesHint", { on: counts.on, total: counts.total }),
            icon: <HardDrive />,
        },
    ];
    const showSave = tab === "edit" || dirty;

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!dirty || !valid || saving) return;
        setSaving(true);
        const errs = await onSave(keyItem, patch);
        setSaving(false);
        if (errs) {
            setServerErrors(errs);
            setTab("edit");
        } else onClose();
    };

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={t("keys.detailsTitle")}
            description={
                <span className="flex flex-wrap items-center gap-1.5">
                    <Chip mono title={t("keys.keyId")}><Hash /> {keyItem.id}</Chip>
                    <KeyTypeBadge type={keyItem.key_type} bits={keyItem.bits} />
                </span>
            }
            icon={<KeyRound />}
            size="5xl"
            fixedHeight
            nav={
                <div className="space-y-4">
                    {/* 這把金鑰（桌面在側欄上方）。/ Which key: top of the rail on desktop. */}
                    <div className="hidden min-w-0 px-1.5 sm:block">
                        <span className="block break-all text-sm text-foreground">{keyItem.host_friendly_name}</span>
                        {keyItem.fingerprint && <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground" title={keyItem.fingerprint}>{shortFingerprint(keyItem.fingerprint)}</span>}
                    </div>
                    <NavTabs tabs={tabs} value={tab} onChange={setTab} aria-label={t("keys.detailsTitle")} />
                </div>
            }
            footer={
                <>
                    {dirty && tab !== "edit" && <span className="mr-auto text-sm text-muted-foreground">{t("ui.tabUnsaved")}</span>}
                    <Button variant="outline" onClick={onClose} disabled={saving}>{t("common.close")}</Button>
                    {showSave && (
                        <Button type="submit" form="key-details-form" disabled={saving || !dirty || !valid}>
                            {saving ? <Loader2 className="animate-spin" /> : <Save />} {t("common.saveChanges")}
                        </Button>
                    )}
                </>
            }
        >
            <form ref={formRef} id="key-details-form" onSubmit={submit}>
                <div role="tabpanel" hidden={tab !== "overview"} className="space-y-6">
                    <PropertyList>
                        <Property label={t("keys.keyId")} mono>#{keyItem.id}</Property>
                        <Property label={t("keys.fingerprint")}>
                            <span className="flex items-center gap-1">
                                <span className="min-w-0 break-all font-mono text-xs">{keyItem.fingerprint ?? t("keys.noFingerprint")}</span>
                                {keyItem.fingerprint && <CopyButton value={keyItem.fingerprint} />}
                            </span>
                        </Property>
                        {keyItem.comment && (
                            <Property label={t("keys.comment")} mono><span className="text-xs">{keyItem.comment}</span></Property>
                        )}
                        <Property label={t("keys.expiry.label")}>
                            <KeyExpiryText expiresAt={keyItem.expires_at} />
                        </Property>
                        <Property label={t("keys.created")}>{fmt(keyItem.created_at)}</Property>
                        <Property label={t("keys.lastUsed")}>
                            {keyItem.last_used_at ? (
                                <span title={fmt(keyItem.last_used_at)}>
                                    {formatRelativeTime(keyItem.last_used_at, locale)}
                                    {keyItem.last_used_ip && <span className="text-muted-foreground"> · {keyItem.last_used_ip}</span>}
                                </span>
                            ) : (
                                <span className="text-muted-foreground">{t("keys.neverUsed")}</span>
                            )}
                        </Property>
                    </PropertyList>
                    <Section icon={<HardDrive />} title={t("keys.onDevices")}>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
                            <span>{t("keys.details.devicesSummary", { on: counts.on, total: counts.total })}</span>
                            {counts.installed > 0 && <Chip tone="success">{t("keys.details.installedCount", { count: counts.installed })}</Chip>}
                            {counts.problems > 0 && <Chip tone="warning">{t("keys.details.problemCount", { count: counts.problems })}</Chip>}
                            <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => setTab("devices")}>
                                {t("keys.details.seeDevices")} <ArrowRight />
                            </Button>
                        </div>
                    </Section>
                </div>

                {/* 可編輯的部分 / The editable part */}
                <div role="tabpanel" hidden={tab !== "edit"}>
                    <Section icon={<Pencil />} title={t("keys.editSection")} description={t("keys.editSectionHint")}>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Field id="key-details-name" label={t("keys.hostFriendlyName")} required error={errors.host_friendly_name}>
                                <Input value={form.host_friendly_name} onChange={(e) => setField("host_friendly_name", e.target.value)} maxLength={100} placeholder={t("keys.namePlaceholder")} />
                            </Field>
                            <Field id="key-details-description" label={t("common.description")} addon={t("common.optional")} error={errors.description}>
                                <Input value={form.description} onChange={(e) => setField("description", e.target.value)} placeholder={t("keys.descriptionPlaceholder")} />
                            </Field>
                            {keyGroups.length > 0 && (
                                <Field id="key-details-group" label={t("groups.key.field")} hint={t("groups.key.fieldHint")}>
                                    <NativeSelect value={groupId ?? ""} onChange={(e) => setGroupId(e.target.value ? Number(e.target.value) : null)}>
                                        <option value="">{t("groups.key.fieldNone")}</option>
                                        {keyGroups.map((g) => (
                                            <option key={g.id} value={g.id}>{g.name}</option>
                                        ))}
                                    </NativeSelect>
                                </Field>
                            )}
                        </div>
                        <Field
                            id="key-details-key"
                            label={t("keys.publicKey")}
                            required
                            addon={form.key.trim() ? <CopyButton value={form.key.trim()} /> : undefined}
                            error={errors.key}
                            hint={!errors.key && !keyChanged ? t("keys.keyEditHint") : undefined}
                        >
                            <Textarea
                                value={form.key}
                                onChange={(e) => setField("key", e.target.value)}
                                rows={3}
                                spellCheck={false}
                                className="break-all font-mono text-xs leading-relaxed md:text-xs"
                                placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… you@laptop"
                            />
                        </Field>
                        {parsed && keyChanged && !errors.key && (
                            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface px-2.5 py-1.5 ring-1 ring-inset ring-border/80">
                                <KeyTypeBadge type={parsed.label} bits={parsed.bits} />
                                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{previewFp ?? "…"}</span>
                            </div>
                        )}
                        {keyChanged && !errors.key && <Callout tone="warning">{t("keys.keyChangedHint")}</Callout>}
                        <Field id="key-details-expiry" label={t("keys.expiry.change")} error={errors.expires_at} hint={!errors.expires_at ? t(expiryState(keyItem.expires_at) === "expired" ? "keys.expiry.changeHintExpired" : "keys.expiry.changeHint") : undefined}>
                            <ExpiryPicker
                                id="key-details-expiry"
                                preset={expiryPreset ?? (keyItem.expires_at ? "custom" : "never")}
                                customDate={expiryPreset === null && keyItem.expires_at ? localDate(new Date(keyItem.expires_at)) : expiryDate}
                                onPreset={(p) => {
                                    setExpiryPreset(p);
                                    if (p === "custom" && !expiryDate && keyItem.expires_at) setExpiryDate(localDate(new Date(keyItem.expires_at)));
                                }}
                                onCustomDate={(d) => {
                                    setExpiryPreset("custom");
                                    setExpiryDate(d);
                                }}
                            />
                        </Field>
                    </Section>
                </div>

                {/* 在哪些裝置上（勾選立即生效，與儲存無關）/ Devices (ticks apply right away, separate from Save) */}
                <div role="tabpanel" hidden={tab !== "devices"}>
                    <Section icon={<HardDrive />} title={t("keys.onDevices")} description={t("keys.details.devicesHint")}>
                        <KeyDevices keyItem={keyItem} {...devices} />
                    </Section>
                </div>
            </form>
        </Modal>
    );
}
