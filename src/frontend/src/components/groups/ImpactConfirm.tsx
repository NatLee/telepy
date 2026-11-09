"use client";

/**
 * 改群組成員或刪群組之前先問後端「這會讓誰多 / 少哪些通道」，有影響才跳這個確認窗（誰多了、誰少了，
 * 名單長就分頁）；沒影響就直接存。刪除一律要確認。管理區的群組頁與分享視窗的個人群組共用。
 * Before saving members or deleting a group, ask the backend who would gain / lose which
 * tunnels; only when someone would, show this confirmation (gainers and losers, paged when long); otherwise save
 * straight away. Deleting always asks. Shared by the admin Groups page and the share dialog's personal groups.
 */
import React, { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Server, User } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip, Section } from "@/components/ui/section";
import { Pagination } from "@/components/ui/pagination";
import { usePagination } from "@/hooks/usePagination";
import { pageSlice } from "@/lib/pagination";
import { useI18n } from "@/lib/i18n";
import { impactEmpty, impactSummary, tunnelList, type Impact, type ImpactPerson } from "@/lib/peopleGroups";

export interface ImpactRequest {
    /** 問後端（失敗 = null，錯誤已顯示）；不給 = 不必問。/ Ask the backend (null on failure); omitted = nothing to ask. */
    preview?: () => Promise<Impact | null>;
    run: () => Promise<unknown>;
    title: string;
    confirmText: string;
    /** 沒有影響也要確認（刪除）時的說明。/ Ask even without an impact (deleting), with this message. */
    alwaysAsk?: string;
    destructive?: boolean;
}

/** 回傳 `ask`（送一個改變）、`checking`（正在問後端）與要放進畫面的 `dialog`。/ Returns `ask`, `checking` and the `dialog` to render. */
export function useImpactConfirm() {
    const [pending, setPending] = useState<(ImpactRequest & { impact: Impact | null }) | null>(null);
    const [checking, setChecking] = useState(false);
    const [running, setRunning] = useState(false);

    const ask = async (req: ImpactRequest) => {
        let impact: Impact | null = null;
        if (req.preview) {
            setChecking(true);
            try {
                impact = await req.preview();
            } finally {
                setChecking(false);
            }
            if (impact === null) return;
        }
        if ((impact === null || impactEmpty(impact)) && !req.alwaysAsk) {
            await req.run();
            return;
        }
        setPending({ ...req, impact });
    };

    const dialog = pending ? (
        <ImpactDialog
            request={pending}
            impact={pending.impact}
            busy={running}
            onClose={() => setPending(null)}
            onConfirm={async () => {
                setRunning(true);
                try {
                    await pending.run();
                } finally {
                    setRunning(false);
                    setPending(null);
                }
            }}
        />
    ) : null;

    return { ask, checking, dialog };
}

function ImpactDialog({ request, impact, busy, onClose, onConfirm }: { request: ImpactRequest; impact: Impact | null; busy: boolean; onClose: () => void; onConfirm: () => void }) {
    const { t } = useI18n();
    const sum = impact ? impactSummary(impact) : null;
    const nothing = !impact || impactEmpty(impact);
    return (
        <Modal
            isOpen
            onClose={onClose}
            title={request.title}
            tone={request.destructive ? "danger" : "default"}
            icon={<Server />}
            size="xl"
            isLoading={busy}
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="button" variant={request.destructive ? "destructive" : "default"} disabled={busy} onClick={onConfirm}>
                        {request.confirmText}
                    </Button>
                </>
            }
        >
            <div className="space-y-4">
                {request.alwaysAsk && <p className="text-sm leading-relaxed text-foreground">{request.alwaysAsk}</p>}
                {nothing ? (
                    <p className="text-sm text-muted-foreground">{t("impact.nothing")}</p>
                ) : (
                    sum && (
                        <Callout tone={sum.losePeople > 0 || sum.shares > 0 ? "warning" : "info"}>
                            {t("impact.summary", { gain: sum.gainPeople, lose: sum.losePeople, tunnels: sum.tunnels })}
                            {sum.shares > 0 && <> {t("impact.sharesEnd", { count: sum.shares })}</>}
                        </Callout>
                    )
                )}
                {impact && impact.lose.length > 0 && <PeopleList title={t("impact.lose")} people={impact.lose} kind="lose" />}
                {impact && impact.gain.length > 0 && <PeopleList title={t("impact.gain")} people={impact.gain} kind="gain" />}
                {!nothing && <p className="text-xs leading-relaxed text-muted-foreground">{t("impact.othersKeep")}</p>}
            </div>
        </Modal>
    );
}

function PeopleList({ title, people, kind }: { title: string; people: ImpactPerson[]; kind: "gain" | "lose" }) {
    const { t } = useI18n();
    const pager = usePagination(people.length, { storageKey: "telepy.impactPageSize" });
    const Icon = kind === "gain" ? ArrowUpRight : ArrowDownRight;
    return (
        <Section title={`${title} · ${people.length}`} icon={<Icon />}>
            <ul className="divide-y divide-border/70 rounded-lg ring-1 ring-inset ring-border/80">
                {pageSlice(people, pager.page, pager.size).map((p) => {
                    const list = tunnelList(p);
                    return (
                        <li key={p.user_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                            <span className="flex min-w-0 items-center gap-1.5 text-foreground">
                                <User size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                                <span className="truncate">{p.username}</span>
                            </span>
                            <span className="flex min-w-0 flex-wrap gap-1" title={p.tunnels.map((x) => x.name).join(", ")}>
                                {list.names.map((n) => (
                                    <Chip key={n} tone={kind === "gain" ? "success" : "warning"}>{n}</Chip>
                                ))}
                                {list.more > 0 && <Chip>{t("impact.more", { count: list.more })}</Chip>}
                            </span>
                        </li>
                    );
                })}
            </ul>
            <Pagination pager={pager} compact className="justify-center" />
        </Section>
    );
}
