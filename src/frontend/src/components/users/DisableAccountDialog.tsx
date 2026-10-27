"use client";

/**
 * 停用帳號前的確認：先問後端會切掉多少（`GET /api/user/users/{id}/disable-preview`），畫成
 * 帳號 ─ 瀏覽器 ─ 進行中的 session ─ API token ─ 已連接的 app ─ 裝置金鑰，每一站寫數量與下場（登出 / 結束 / 暫停 / 拿掉）。
 * The confirmation before disabling an account: ask the backend what would be cut and draw it as
 * account ─ browsers ─ live sessions ─ API tokens ─ connected apps ─ device keys, each with its count and outcome.
 */
import React, { useEffect, useState } from "react";
import { AppWindow, KeyRound, KeySquare, Monitor, Plug, UserX } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { apiFetch, readJson } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cutSpots, keysLine, nothingToCut, parseImpact, type CutId, type DisableImpact } from "@/lib/accountDisable";
import type { TranslationKey } from "@/locales/en";

const ICON: Record<CutId, typeof Monitor> = { browsers: Monitor, sessions: AppWindow, tokens: KeySquare, apps: Plug, keys: KeyRound };
const TITLE: Record<CutId, TranslationKey> = {
    browsers: "settings.disable.browsers",
    sessions: "settings.disable.sessions",
    tokens: "settings.disable.tokens",
    apps: "settings.disable.apps",
    keys: "settings.disable.keys",
};
const LINK: Record<CutId, TranslationKey> = {
    browsers: "settings.disable.link.signOut",
    sessions: "settings.disable.link.end",
    tokens: "settings.disable.link.pause",
    apps: "settings.disable.link.pause",
    keys: "settings.disable.link.remove",
};

/** 切掉什麼的圖（預估或結果）。/ The diagram of what is cut (preview or result). */
export function DisableImpactMap({ username, impact, done }: { username: string; impact: DisableImpact; done: boolean }) {
    const { t } = useI18n();
    const spots = cutSpots(impact, done);
    return (
        <FlowPath>
            <FlowNode icon={UserX} title={username} sub={t("settings.disable.accountSub")} state="failed" stateText={t(done ? "settings.disable.accountDone" : "settings.disable.accountWill")} />
            {spots.map((s) => (
                <React.Fragment key={s.id}>
                    <FlowLink label={t(LINK[s.id])} state={s.state} className="@3xl:w-12" />
                    <FlowNode
                        icon={ICON[s.id]}
                        title={t(TITLE[s.id])}
                        sub={
                            s.id === "keys"
                                ? t(impact.device_keys.offline_devices > 0 ? "settings.disable.keysSubOffline" : "settings.disable.keysSub", { count: s.count, offline: impact.device_keys.offline_devices })
                                : t(s.comesBack ? "settings.disable.countBack" : "settings.disable.count", { count: s.count })
                        }
                        state={s.state}
                        stateText={t(`settings.disable.${done ? "outcome" : "will"}.${s.outcome}` as TranslationKey)}
                    />
                </React.Fragment>
            ))}
        </FlowPath>
    );
}

export function DisableAccountDialog({ isOpen, user, onClose, onConfirm }: { isOpen: boolean; user: { id: number; username: string }; onClose: () => void; onConfirm: () => Promise<void> }) {
    const { t } = useI18n();
    const [impact, setImpact] = useState<DisableImpact | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!isOpen) return;
        let alive = true;
        setImpact(null);
        setFailed(false);
        (async () => {
            try {
                const res = await apiFetch(`/api/user/users/${user.id}/disable-preview`);
                const v = res.ok ? parseImpact(await readJson(res)) : null;
                if (!alive) return;
                if (v) setImpact(v);
                else setFailed(true);
            } catch {
                if (alive) setFailed(true);
            }
        })();
        return () => {
            alive = false;
        };
    }, [isOpen, user.id]);

    const confirm = async () => {
        setBusy(true);
        try {
            await onConfirm();
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("settings.disable.title", { user: user.username })}
            description={t("settings.disable.description")}
            icon={<UserX />}
            tone="danger"
            size="5xl"
            isLoading={!impact && !failed}
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                        {t("common.cancel")}
                    </Button>
                    <Button type="button" variant="destructive" onClick={confirm} disabled={busy || (!impact && !failed)}>
                        {t("settings.disable.confirm")}
                    </Button>
                </>
            }
        >
            <div className="space-y-4">
                {impact && (
                    <>
                        <p className="text-sm text-foreground">
                            {nothingToCut(impact)
                                ? t("settings.disable.nothing")
                                : t("settings.disable.summary", {
                                      browsers: impact.web_sessions,
                                      sessions: impact.live_sessions + impact.agent_sessions,
                                      tokens: impact.api_tokens,
                                      apps: impact.connected_apps,
                                  })}
                        </p>
                        {keysLine(impact) !== "none" && (
                            <p className="text-sm text-foreground">
                                {t(keysLine(impact) === "someOffline" ? "settings.disable.keysLineOffline" : "settings.disable.keysLine", {
                                    devices: impact.device_keys.devices,
                                    accounts: impact.device_keys.accounts,
                                    offline: impact.device_keys.offline_devices,
                                })}
                            </p>
                        )}
                        <DisableImpactMap username={user.username} impact={impact} done={false} />
                        <Callout tone="info">{t("settings.disable.comesBack")}</Callout>
                    </>
                )}
                {failed && <Callout tone="warning">{t("settings.disable.previewFailed")}</Callout>}
            </div>
        </Modal>
    );
}
