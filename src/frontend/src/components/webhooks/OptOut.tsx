"use client";

/**
 * 全站 webhook 的「退出」：隧道的 owner / Admin 把自己的隧道退出一個「預設」的全站 webhook（強制的不行）。
 * `OptOutDialog` = 勾選要送 / 不送的隧道；`OptOutInfoDialog` = 資訊圖：你的隧道的事件 ─ 全站 webhook（強制 / 預設）
 * ─ 退出（誰退的）─ 管理員的頻道，挑一個 webhook 與一條隧道，看事件會不會送出、哪一層決定的。
 * Opting out of site-wide webhooks: a tunnel's owner / Admins switch their tunnels off for a "default" site webhook
 * (enforced ones can't be). `OptOutDialog` = the per-tunnel switches; `OptOutInfoDialog` = the live diagram: your
 * tunnel's event ─ site webhook (enforced / default) ─ opt-out (by whom) ─ the admins' channel, for a picked webhook
 * and tunnel, lit to show whether the event goes out and which layer decided.
 */
import React, { useMemo, useState } from "react";
import { Activity, Lock, MessagesSquare, RadioTower, Undo2 } from "lucide-react";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/Modal";
import { NativeSelect } from "@/components/ui/native-select";
import { Chip } from "@/components/ui/section";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { FORMAT_SHORT, hookMode, optOutChoices, optOutPath, type OptOutLayer } from "@/lib/webhooks";
import type { TranslationKey } from "@/locales/en";
import type { SiteWebhookSummary } from "@/types/webhooks";

/** 名稱：沒取名的用服務名稱。/ The name; unnamed ones go by their service. */
export function siteHookName(h: Pick<SiteWebhookSummary, "name" | "service">): string {
    return h.name ?? (h.service ? FORMAT_SHORT[h.service] : "Webhook");
}

interface DialogProps {
    hook: SiteWebhookSummary | null;
    onClose: () => void;
    onSave: (hookId: number, tunnelIds: number[]) => Promise<boolean>;
}

export function OptOutDialog({ hook, onClose, onSave }: DialogProps) {
    // 每次打開重新從伺服器的狀態開始。/ Every open starts from the server's state.
    return hook ? <OptOutForm key={hook.id} hook={hook} onClose={onClose} onSave={onSave} /> : null;
}

function OptOutForm({ hook, onClose, onSave }: { hook: SiteWebhookSummary; onClose: () => void; onSave: DialogProps["onSave"] }) {
    const { t } = useI18n();
    const { user } = useAuth();
    const choices = optOutChoices(hook);
    const [out, setOut] = useState<number[]>(() => hook.my_optout ?? []);
    const [saving, setSaving] = useState(false);
    const name = siteHookName(hook);

    const save = async () => {
        setSaving(true);
        const ok = await onSave(hook.id, out);
        setSaving(false);
        if (ok) onClose();
    };

    return (
        <Modal
            isOpen
            onClose={onClose}
            size="lg"
            icon={<Undo2 />}
            title={t("webhooks.optout.title", { name })}
            description={t("webhooks.optout.description")}
            footer={
                <>
                    <Button variant="outline" onClick={onClose}>
                        {t("common.cancel")}
                    </Button>
                    <Button onClick={() => void save()} disabled={saving}>
                        {t("common.save")}
                    </Button>
                </>
            }
        >
            <ul className="divide-y divide-border rounded-lg border border-border">
                {choices.map((c) => {
                    const sending = !out.includes(c.id);
                    // 別人退的（我不能替他改）。/ Opted out by someone else (not mine to change).
                    const others = c.by.filter((b) => b !== user?.username);
                    return (
                        <li key={c.id} className="space-y-1 px-3 py-2.5">
                            <div className="flex items-center justify-between gap-3">
                                <span className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">{c.name}</span>
                                <Switch
                                    size="sm"
                                    checked={sending}
                                    onCheckedChange={(v) => setOut((cur) => (v ? cur.filter((x) => x !== c.id) : [...cur, c.id]))}
                                    aria-label={t("webhooks.optout.toggle", { name: c.name })}
                                >
                                    <span className={sending ? "text-xs text-foreground" : "text-xs text-muted-foreground"}>{sending ? t("webhooks.optout.sending") : t("webhooks.optout.optedOut")}</span>
                                </Switch>
                            </div>
                            {others.length > 0 && <p className="text-xs text-warning">{t("webhooks.optout.alsoBy", { names: others.join(", ") })}</p>}
                        </li>
                    );
                })}
            </ul>
        </Modal>
    );
}

const LAYER_KEY: Record<OptOutLayer, TranslationKey> = {
    locked: "webhooks.optout.layer.locked",
    optedOut: "webhooks.optout.layer.optedOut",
    followsDefault: "webhooks.optout.layer.followsDefault",
    notCovered: "webhooks.optout.layer.notCovered",
    off: "webhooks.optout.layer.off",
};

const VERDICT_KEY: Record<OptOutLayer, TranslationKey> = {
    locked: "webhooks.optout.verdict.locked",
    optedOut: "webhooks.optout.verdict.optedOut",
    followsDefault: "webhooks.optout.verdict.followsDefault",
    notCovered: "webhooks.optout.verdict.notCovered",
    off: "webhooks.optout.verdict.off",
};

/** 一個 webhook 用來畫圖的隧道：我管的那些；沒有就用一條示範的。/ Tunnels to draw for a webhook: mine, or one example. */
function drawable(h: SiteWebhookSummary, example: string) {
    const mine = h.managed ?? [];
    return mine.length > 0 ? { tunnels: mine, example: false } : { tunnels: [{ id: -1, name: example, opted_out: false, by: [], mine: false }], example: true };
}

export function OptOutInfoDialog({ isOpen, onClose, hooks }: { isOpen: boolean; onClose: () => void; hooks: SiteWebhookSummary[] }) {
    const { t } = useI18n();
    // 先挑涵蓋我的隧道的 webhook。/ Start with a webhook that covers a tunnel of mine.
    const first = hooks.find((h) => (h.managed ?? []).length > 0) ?? hooks[0];
    const [hookId, setHookId] = useState<number | null>(null);
    const [tunnelId, setTunnelId] = useState<number | null>(null);
    const hook = hooks.find((h) => h.id === hookId) ?? first;
    const pick = useMemo(() => (hook ? drawable(hook, t("webhooks.optout.example")) : null), [hook, t]);
    const tunnel = pick?.tunnels.find((x) => x.id === tunnelId) ?? pick?.tunnels[0];
    const anyMine = hooks.some((h) => (h.managed ?? []).length > 0);

    const path = hook && tunnel ? optOutPath(pick?.example ? { ...hook, all_tunnels: true, managed: pick.tunnels } : hook, tunnel.id) : null;
    const names = path?.by.join(", ") ?? "";
    const layerText = path ? t(LAYER_KEY[path.layer], { names }) : "";

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="4xl" icon={<Undo2 />} title={t("webhooks.optout.infoTitle")} description={t("webhooks.optout.infoDescription")}>
            {!hook || !tunnel || !path ? (
                <p className="text-sm text-muted-foreground">{t("webhooks.siteSection.empty")}</p>
            ) : (
                <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label={t("webhooks.optout.pickHook")}>
                            <NativeSelect
                                value={hook.id}
                                onChange={(e) => {
                                    setHookId(Number(e.target.value));
                                    setTunnelId(null);
                                }}
                            >
                                {hooks.map((h) => (
                                    <option key={h.id} value={h.id}>
                                        {siteHookName(h)}
                                        {hookMode(h) === "enforced" ? ` (${t("webhooks.mode.enforced")})` : ""}
                                    </option>
                                ))}
                            </NativeSelect>
                        </Field>
                        <Field label={t("webhooks.optout.pickTunnel")}>
                            <NativeSelect value={tunnel.id} onChange={(e) => setTunnelId(Number(e.target.value))} disabled={pick?.example}>
                                {pick?.tunnels.map((x) => (
                                    <option key={x.id} value={x.id}>
                                        {x.name}
                                    </option>
                                ))}
                            </NativeSelect>
                        </Field>
                    </div>
                    {!anyMine && <Callout tone="info">{t("webhooks.optout.noTunnels")}</Callout>}

                    <FlowPath>
                        <FlowNode icon={Activity} title={t("webhooks.optout.node.event", { name: tunnel.name })} sub={t("webhooks.optout.node.eventSub")} state={path.spots.event} stateText={t("webhooks.optout.state.happened")} />
                        <FlowLink label={t("webhooks.optout.link.subscribed")} state={path.spots.hook} />
                        <FlowNode
                            icon={RadioTower}
                            title={siteHookName(hook)}
                            sub={t("webhooks.optout.pickHook")}
                            state={path.spots.hook}
                            stateText={path.layer === "off" || path.layer === "notCovered" ? layerText : hookMode(hook) === "enforced" ? t("webhooks.optout.layer.locked") : t("webhooks.mode.default")}
                        />
                        <FlowLink label={path.layer === "locked" ? t("webhooks.optout.state.skipped") : t("webhooks.optout.link.checked")} state={path.spots.optout === "failed" ? "ok" : path.spots.optout} />
                        <FlowNode
                            icon={path.layer === "locked" ? Lock : Undo2}
                            title={t("webhooks.optout.node.optout")}
                            sub={t("webhooks.optout.node.optoutSub")}
                            state={path.spots.optout}
                            stateText={path.layer === "locked" ? t("webhooks.optout.layer.locked") : path.layer === "optedOut" || path.layer === "followsDefault" ? layerText : t("webhooks.optout.state.skipped")}
                        />
                        <FlowLink label={t("webhooks.optout.link.delivered")} state={path.spots.channel} />
                        <FlowNode
                            icon={MessagesSquare}
                            title={t("webhooks.optout.node.channel")}
                            sub={hook.service ? FORMAT_SHORT[hook.service] : undefined}
                            state={path.spots.channel}
                            stateText={path.sends ? t("webhooks.optout.state.sent") : t("webhooks.optout.state.notSent")}
                        />
                    </FlowPath>

                    <Callout tone={path.sends ? "info" : "warning"}>
                        <span className="mr-2 inline-flex align-middle">
                            <Chip tone={path.sends ? "success" : "warning"}>
                                {path.layer === "locked" && <Lock aria-hidden />}
                                {layerText}
                            </Chip>
                        </span>
                        {t(VERDICT_KEY[path.layer], { names })}
                    </Callout>

                    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                        <li>{t("webhooks.optout.rule1")}</li>
                        <li>{t("webhooks.optout.rule2")}</li>
                        <li>{t("webhooks.optout.rule3")}</li>
                    </ul>
                </div>
            )}
        </Modal>
    );
}
