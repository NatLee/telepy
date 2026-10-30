"use client";

/**
 * 「.env、這一頁、內建預設，誰說了算」：伺服器分頁的 info 按鈕與每個「由 .env 設定」標籤打開它。選一個設定，圖上
 * .env ─ 這一頁 ─ 內建預設 ─▶ 生效的值 排成直線，決定的那層亮起，其他層標「沒設」/「被蓋過」，每格放實際的值。
 * 下面是每個可用 .env 設定的值現在由誰決定（按一列就換到它），以及只能寫在 .env 的變數與原因。
 * "Who decides: .env, this page or the built-in default". Opened by the Server tab's info button and every
 * "Set by .env" chip. Pick a setting: .env ─ this page ─ built-in default ─▶ in effect on a straight path, the
 * deciding layer lit, the others marked "not set" / "overridden", each box with its actual value. Below: every
 * env-backed setting with its current source (click to pick it), and the variables that stay in .env, and why.
 */
import React, { useState } from "react";
import { FileCode2, Info, Lock, Package, SlidersHorizontal } from "lucide-react";
import { FlowLink, FlowNode, FlowNow, FlowPath } from "@/components/flow/PathFlow";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Chip, SectionHeading } from "@/components/ui/section";
import type { SettingMeta } from "@/hooks/useSettingsPage";
import type { SpotState } from "@/lib/flow";
import { useI18n } from "@/lib/i18n";
import {
    ENV_ONLY,
    envBackedKeys,
    initialKey,
    layerStates,
    settingSource,
    type EnvMap,
    type EnvOnlyReason,
    type LayerState,
    type SettingLayer,
} from "@/lib/settingSource";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import { defaultOf, kindOf, useSettingText } from "./SettingRow";

const LAYER_NAME: Record<SettingLayer, TranslationKey> = {
    env: "settingsEnv.layer.env",
    page: "settingsEnv.layer.page",
    default: "settingsEnv.layer.default",
};

const STATE_TEXT: Record<LayerState, TranslationKey> = {
    decides: "settingsEnv.state.decides",
    notSet: "settingsEnv.state.notSet",
    overridden: "settingsEnv.state.overridden",
};

const REASON_TEXT: Record<EnvOnlyReason, TranslationKey> = {
    beforeStart: "settingsEnv.reason.beforeStart",
    compose: "settingsEnv.reason.compose",
    shared: "settingsEnv.reason.shared",
    secret: "settingsEnv.reason.secret",
};

/** 只能寫在 .env 的每一組一行說明（跟 ENV_ONLY 同順序）。/ One line per ENV_ONLY entry, same order. */
const ENV_ONLY_LINE: TranslationKey[] = [
    "settingsEnv.only.secretKey",
    "settingsEnv.only.internalToken",
    "settingsEnv.only.ports",
    "settingsEnv.only.domain",
    "settingsEnv.only.project",
    "settingsEnv.only.dirs",
];

const toSpot = (s: LayerState): SpotState => (s === "decides" ? "ok" : "waiting");

export function SettingSourceDialog({
    isOpen,
    onClose,
    initial,
    env,
    values,
    meta,
}: {
    isOpen: boolean;
    onClose: () => void;
    initial: string | null;
    env: EnvMap;
    values: Record<string, unknown>;
    meta: Record<string, SettingMeta>;
}) {
    const { t, tn } = useI18n();
    const { labelOf } = useSettingText();
    const keys = envBackedKeys(env);
    const [picked, setPicked] = useState<string | null>(() => initialKey(env, initial));
    const code = (s: string) => <code className="rounded bg-muted px-1 font-mono text-[0.85em]">{s}</code>;

    /** 值的顯示：開關 = 開 / 關，空字串 = （空）。/ How a value reads: on / off, empty. */
    const show = (key: string, v: unknown): string => {
        if (kindOf(key, values[key], meta[key]) === "boolean" || typeof v === "boolean") return t(v === true || v === "true" ? "settingsEnv.on" : "settingsEnv.off");
        const s = String(v ?? "");
        if (s) return s;
        return key === "server_log_level" ? t("settingsEnv.emptyLogLevel") : t("settingsEnv.empty");
    };
    const sourceOf = (key: string) => settingSource(env[key], values[key], defaultOf(key, meta[key]));

    const diagram = (key: string) => {
        const entry = env[key];
        const src = sourceOf(key);
        const states = layerStates(src);
        const def = defaultOf(key, meta[key]);
        const order: SettingLayer[] = ["env", "page", "default"];
        const at = order.indexOf(src.layer);
        // 決定的那層之前沒設的段 = 往下一層走了（亮起）；之後的段沒走到。/ Links above the decider were followed; below it, not.
        const linkState = (i: number): SpotState => (i < at ? "ok" : "waiting");
        // 只寫值：變數名在上面的選單裡，塞進窄框會被拆成好幾段。/ Value only: the variable name is in the picker above; in the narrow box it broke mid-word.
        const envSub = entry.set ? <span className="font-mono [overflow-wrap:anywhere]">{entry.value ?? ""}</span> : <span>{t("settingsEnv.unset")}</span>;
        const valueSub = (v: unknown) => <span className="[overflow-wrap:anywhere]">{show(key, v)}</span>;
        return (
            <div className="space-y-3">
                <FlowNow failed={false}>
                    {tn("settingsEnv.now", {
                        setting: <span className="text-foreground">{labelOf(key, meta[key])}</span>,
                        layer: <strong>{t(LAYER_NAME[src.layer])}</strong>,
                        value: code(show(key, src.value)),
                    })}
                </FlowNow>
                <FlowPath>
                    <FlowNode compact icon={FileCode2} title={`1 · ${t(LAYER_NAME.env)}`} sub={envSub} state={toSpot(states.env)} stateText={t(STATE_TEXT[states.env])} />
                    <FlowLink compact label={t("settingsEnv.link.ifEmpty")} state={linkState(0)} />
                    <FlowNode compact icon={SlidersHorizontal} title={`2 · ${t(LAYER_NAME.page)}`} sub={valueSub(values[key])} state={toSpot(states.page)} stateText={t(STATE_TEXT[states.page])} />
                    <FlowLink compact label={t("settingsEnv.link.ifUnchanged")} state={linkState(1)} />
                    <FlowNode compact icon={Package} title={`3 · ${t(LAYER_NAME.default)}`} sub={valueSub(def)} state={toSpot(states.default)} stateText={t(STATE_TEXT[states.default])} />
                    <FlowLink compact label={t("settingsEnv.link.inEffect")} state="ok" />
                    <FlowNode
                        compact
                        brand
                        title={t("settingsEnv.inEffect")}
                        sub={valueSub(src.value)}
                        state="ok"
                        stateText={t("settingsEnv.fromLayer", { layer: t(LAYER_NAME[src.layer]) })}
                    />
                </FlowPath>
                {src.layer === "env" ? (
                    <Callout tone="info" icon={<Lock size={16} className="mt-0.5 shrink-0" aria-hidden />}>
                        {tn("settingsEnv.lockedNote", { var: code(entry.var), command: code("docker compose up -d backend") })}
                    </Callout>
                ) : (
                    <p className="text-xs leading-relaxed text-muted-foreground">{tn("settingsEnv.freeNote", { var: code(entry.var) })}</p>
                )}
            </div>
        );
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("settingsEnv.dialogTitle")}
            description={t("settingsEnv.dialogDescription")}
            icon={<Info />}
            size="4xl"
            footer={<Button type="button" onClick={onClose}>{t("common.close")}</Button>}
        >
            <div className="space-y-6">
                {keys.length === 0 || !picked ? (
                    <Callout tone="info">{t("settingsEnv.olderBackend")}</Callout>
                ) : (
                    <section className="space-y-3">
                        <Field label={t("settingsEnv.pick")}>
                            <NativeSelect value={picked} onChange={(e) => setPicked(e.target.value)} className="w-full sm:w-auto sm:min-w-80">
                                {keys.map((k) => (
                                    <option key={k} value={k}>
                                        {`${labelOf(k, meta[k])} — ${env[k].var}`}
                                    </option>
                                ))}
                            </NativeSelect>
                        </Field>
                        {diagram(picked)}
                    </section>
                )}

                {keys.length > 0 && (
                    <section className="space-y-2">
                        <SectionHeading wrapTitle title={t("settingsEnv.tableTitle")} description={t("settingsEnv.tableHint")} />
                        <ul className="@container divide-y divide-border/70 rounded-xl border border-border">
                            {keys.map((k) => {
                                const src = sourceOf(k);
                                return (
                                    <li key={k}>
                                        <button
                                            type="button"
                                            onClick={() => setPicked(k)}
                                            aria-pressed={k === picked}
                                            className={cn(
                                                "grid w-full grid-cols-1 gap-x-3 gap-y-1 px-3 py-2 text-left text-sm transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 @2xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto_minmax(0,1fr)] @2xl:items-center",
                                                k === picked && "bg-surface",
                                            )}
                                        >
                                            <span className="min-w-0 text-foreground">{labelOf(k, meta[k])}</span>
                                            <span className="min-w-0 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{env[k].var}</span>
                                            <span>
                                                <Chip tone={src.layer === "page" ? "primary" : "neutral"}>
                                                    {src.layer === "env" && <Lock aria-hidden />}
                                                    {t(LAYER_NAME[src.layer])}
                                                </Chip>
                                            </span>
                                            <span className="min-w-0 font-mono text-xs text-foreground [overflow-wrap:anywhere]">{show(k, src.value)}</span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                )}

                <section className="space-y-2">
                    <SectionHeading wrapTitle title={t("settingsEnv.onlyTitle")} description={t("settingsEnv.onlyHint")} />
                    <ul className="divide-y divide-border/70 rounded-xl border border-border">
                        {ENV_ONLY.map((item, i) => (
                            <li key={item.vars.join()} className="space-y-1 px-3 py-2 text-sm">
                                <div className="flex flex-wrap items-center gap-1.5">
                                    {item.vars.map((v) => (
                                        <code key={v} className="rounded-sm bg-muted px-1.5 py-px font-mono text-xs text-foreground">{v}</code>
                                    ))}
                                    {item.reasons.map((r) => (
                                        <Chip key={r}>{t(REASON_TEXT[r])}</Chip>
                                    ))}
                                </div>
                                <p className="text-xs leading-relaxed text-muted-foreground">{t(ENV_ONLY_LINE[i])}</p>
                            </li>
                        ))}
                    </ul>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                        {tn("settingsEnv.applyEnv", { command: code("docker compose up -d backend"), restart: code("docker compose restart") })}
                    </p>
                </section>
            </div>
        </Modal>
    );
}
