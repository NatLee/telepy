"use client";

/**
 * SSH 金鑰頁：我的金鑰（指紋 / 類型 / 最後使用 / 在哪些裝置上）、「裝置金鑰清單」的運作說明、
 * 我的金鑰 × 我能用的裝置矩陣（勾選即由 Telepy 裝進裝置的 authorized_keys），以及單台裝置的管理視窗
 * （`?device=<id>`，隧道選單會連過來）。
 * SSH keys page: my keys (fingerprint, type, last use, where they are installed), the explainer for device
 * key lists, the keys × devices matrix (a tick makes Telepy install the key on the device) and the per-device
 * panel (`?device=<id>`, linked from the tunnel menu).
 */
import React, { Suspense, useMemo, useState } from "react";
import { CircleHelp, Key as KeyIcon, Plus, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AddKeyModal } from "@/components/keys/AddKeyModal";
import { DeviceKeysModal } from "@/components/keys/DeviceKeysModal";
import { DeviceMatrix } from "@/components/keys/DeviceMatrix";
import { KeyCard } from "@/components/keys/KeyCard";
import { KeyDetailsModal } from "@/components/keys/KeyDetailsModal";
import { KeyListExplainer } from "@/components/keys/KeyListExplainer";
import { useKeysPage } from "@/hooks/useKeysPage";
import { useI18n } from "@/lib/i18n";
import type { UserKey } from "@/types/keys";

const EXPLAINER_KEY = "telepy.keysExplainer";

function SectionHeader({ title, count, description }: { title: string; count?: number; description?: string }) {
    return (
        <div className="mb-3">
            <h2 className="flex items-center gap-2 text-lg text-foreground">
                {title}
                {count !== undefined && <span className="rounded-full bg-muted px-2 py-px font-mono text-xs text-muted-foreground">{count}</span>}
            </h2>
            {description && <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">{description}</p>}
        </div>
    );
}

function UserKeysPage() {
    const { t } = useI18n();
    const page = useKeysPage();
    // 頁面在 Suspense 裡只在瀏覽器端算繪，直接讀 localStorage 不會造成 hydration 不一致。
    // The page renders client-side inside Suspense, so reading localStorage up front is safe.
    const [explainer, setExplainer] = useState(() => {
        try {
            return localStorage.getItem(EXPLAINER_KEY) !== "hidden";
        } catch {
            return true;
        }
    });
    const [addOpen, setAddOpen] = useState(false);
    const [detailsId, setDetailsId] = useState<number | null>(null);
    const [deleting, setDeleting] = useState<UserKey | null>(null);
    const showExplainer = (show: boolean) => {
        setExplainer(show);
        try {
            localStorage.setItem(EXPLAINER_KEY, show ? "shown" : "hidden");
        } catch {
            /* ignore */
        }
    };

    const details = useMemo(() => page.keys.find((k) => k.id === detailsId) ?? null, [page.keys, detailsId]);
    const deletingOn = deleting ? (page.placements.get(deleting.id) ?? []).length : 0;

    return (
        <div className="animate-fade-in-up space-y-8">
            <PageHeader
                icon={<KeyIcon />}
                title={t("keys.title")}
                description={t("keys.subtitle")}
                actions={
                    <>
                        {!explainer && (
                            <Button variant="ghost" onClick={() => showExplainer(true)}>
                                <CircleHelp size={16} /> {t("keys.how.show")}
                            </Button>
                        )}
                        <Button variant="outline" onClick={page.refresh} disabled={page.loading} aria-label={t("keys.refreshAria")}>
                            <RefreshCw size={16} className={page.loading ? "animate-spin" : ""} />
                            {t("common.refresh")}
                        </Button>
                        <Button onClick={() => setAddOpen(true)}>
                            <Plus size={16} />
                            {t("keys.addKey")}
                        </Button>
                    </>
                }
            />

            {explainer && <KeyListExplainer onHide={() => showExplainer(false)} />}

            <section aria-labelledby="keys-mine">
                <div id="keys-mine">
                    <SectionHeader title={t("keys.mine")} count={page.loading ? undefined : page.keys.length} description={t("keys.mineDescription")} />
                </div>
                {page.loading && page.keys.length === 0 ? (
                    <div className="flex justify-center py-12 text-muted-foreground">
                        <div className="mr-3 h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                        {t("keys.loading")}
                    </div>
                ) : page.keys.length === 0 ? (
                    <div className="flex flex-col items-center rounded-xl border-2 border-dashed border-border bg-card px-6 py-14 text-center">
                        <KeyIcon size={44} className="mb-4 text-muted-foreground/50" />
                        <h3 className="text-lg text-foreground">{t("keys.emptyTitle")}</h3>
                        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{t("keys.emptyBody")}</p>
                        <Button className="mt-6" onClick={() => setAddOpen(true)}>
                            <Plus size={16} /> {t("keys.addKey")}
                        </Button>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {page.keys.map((k) => (
                            <KeyCard
                                key={k.id}
                                keyItem={k}
                                placements={page.placements.get(k.id) ?? []}
                                onDetails={() => setDetailsId(k.id)}
                                onDelete={() => setDeleting(k)}
                            />
                        ))}
                    </div>
                )}
            </section>

            {page.keys.length > 0 && (
                <section aria-labelledby="keys-devices">
                    <div id="keys-devices">
                        <SectionHeader title={t("keys.devices")} count={page.devices.length} description={t("keys.devicesDescription")} />
                    </div>
                    <DeviceMatrix
                        devices={page.devices}
                        keys={page.keys}
                        pending={page.pending}
                        syncing={page.syncing}
                        onToggle={page.toggle}
                        onSync={page.syncDevice}
                        onManage={(d) => page.openDevice(d.tunnel_id)}
                    />
                </section>
            )}

            <AddKeyModal isOpen={addOpen} onClose={() => setAddOpen(false)} devices={page.devices} onSubmit={page.addKey} />

            <KeyDetailsModal
                keyItem={details}
                devices={page.devices}
                pending={page.pending}
                onToggle={page.toggle}
                onClose={() => setDetailsId(null)}
                onSave={page.updateKey}
                onManageDevice={(d) => {
                    setDetailsId(null);
                    page.openDevice(d.tunnel_id);
                }}
            />

            <DeviceKeysModal tunnelId={page.openDeviceId} onClose={() => page.openDevice(null)} onChanged={page.fetchDevices} />

            <ConfirmDialog
                isOpen={!!deleting}
                onClose={() => setDeleting(null)}
                onConfirm={async () => {
                    if (deleting) await page.deleteKey(deleting);
                    setDeleting(null);
                }}
                title={t("keys.deleteTitle")}
                message={
                    deletingOn > 0
                        ? t("keys.deleteMessageDevices", { name: deleting?.host_friendly_name ?? "", count: deletingOn })
                        : t("keys.deleteMessage", { name: deleting?.host_friendly_name ?? "" })
                }
                confirmText={t("common.delete")}
                isDestructive
            />
        </div>
    );
}

export default function UserKeysPageRoute() {
    // useSearchParams（?device=）需要 Suspense 邊界，否則靜態產生會整頁退回 client render。
    // useSearchParams (?device=) needs a Suspense boundary or static generation bails out for the whole page.
    return (
        <Suspense fallback={null}>
            <UserKeysPage />
        </Suspense>
    );
}
