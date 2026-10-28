"use client";

/**
 * 隧道詳細資訊 → 工作階段 → 「Shell 歷史」：只影響自己。跟隨我的預設 / 照常寫 / 不寫（`/api/reverse/server/{id}/shell-history`）。
 * The tunnel details' "Shell history": just for you — follow my default / save / keep out.
 */
import React, { useEffect, useState } from "react";
import { FileClock, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Section } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/Toast";
import { apiFetch, readJson } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { MODE_LABEL, effectiveHistory, isHistoryMode, overrideBody, overrideChoice, type HistoryMode, type OverrideChoice } from "@/lib/shellHistory";
import { ShellHistoryInfoDialog } from "./ShellHistoryInfoDialog";

type Reply = { mode?: unknown; default?: unknown };

export function ShellHistorySetting({ tunnelId }: { tunnelId: number }) {
    const { t } = useI18n();
    const { showError } = useToast();
    const [choice, setChoice] = useState<OverrideChoice>("default");
    const [def, setDef] = useState<HistoryMode>("keep");
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [info, setInfo] = useState(false);

    const accept = (data: Reply | null) => {
        if (!data) return;
        setChoice(overrideChoice(data.mode));
        if (isHistoryMode(data.default)) setDef(data.default);
        setLoaded(true);
    };

    useEffect(() => {
        let alive = true;
        void apiFetch(`/api/reverse/server/${tunnelId}/shell-history`)
            .then(async (res) => (res.ok ? readJson<Reply>(res) : null))
            .then((data) => {
                if (alive) accept(data);
            })
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, [tunnelId]);

    const change = async (next: OverrideChoice) => {
        if (busy || next === choice) return;
        const before = choice;
        setChoice(next);
        setBusy(true);
        try {
            const res = await apiFetch(`/api/reverse/server/${tunnelId}/shell-history`, { method: "PUT", body: JSON.stringify(overrideBody(next)) });
            if (res.ok) accept(await readJson<Reply>(res));
            else {
                setChoice(before);
                showError(t("shellHistory.saveFailed"));
            }
        } catch {
            setChoice(before);
            showError(t("shellHistory.saveFailed"));
        } finally {
            setBusy(false);
        }
    };

    const { mode } = effectiveHistory(def, choice === "default" ? null : choice);
    return (
        <Section
            icon={<FileClock />}
            title={t("shellHistory.title")}
            description={t("shellHistory.tunnel.description")}
            action={
                <span className="flex items-center gap-1">
                    {loaded && <Chip tone={mode === "skip" ? "success" : "neutral"}>{t(MODE_LABEL[mode])}</Chip>}
                    <Button type="button" variant="ghost" size="icon" onClick={() => setInfo(true)} aria-label={t("shellHistory.info")} title={t("shellHistory.info")}>
                        <Info />
                    </Button>
                </span>
            }
        >
            <Segmented
                size="sm"
                fullWidth
                aria-label={t("shellHistory.title")}
                value={choice}
                onChange={(v) => void change(v)}
                options={[
                    { value: "default" as const, label: t("shellHistory.tunnel.followDefault", { value: t(MODE_LABEL[def]) }) },
                    { value: "keep" as const, label: t("shellHistory.tunnel.keep") },
                    { value: "skip" as const, label: t("shellHistory.tunnel.skip") },
                ]}
            />
            <ShellHistoryInfoDialog isOpen={info} onClose={() => setInfo(false)} mode={mode} />
        </Section>
    );
}
