"use client";

/**
 * 網站設定 → App →「App 名稱」：裝成 app 時叫什麼、通知的標題（Telepy / 網域 / 自訂）。Telepy 與網域點了就存；自訂名稱
 * 打好再按儲存（後端要求自訂時一定要有名字，所以兩個值一起送）。下面是主畫面與通知的預覽。
 * Site settings → App → "App name": what an installed app is called and its notifications' title (Telepy / the domain /
 * a custom name). Telepy and the domain save on click; a custom name saves with its button (the backend needs a name
 * with custom, so both values go together). Below: a home screen and a notification preview.
 */
import React, { useState } from "react";
import { AppWindow, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { SectionHeading } from "@/components/ui/section";
import { useToast } from "@/components/ui/Toast";
import { refreshAppName } from "@/hooks/useAppName";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { APP_NAME_MAX, HOME_LABEL_CHARS, appHost, appNameFor, appNameProblem, homeLabel, isAppNameMode, tidyAppName, type AppNameMode } from "@/lib/installApp";
import type { EnvMap } from "@/lib/settingSource";

/** 由這個面板編輯，一般的設定清單不列。/ Edited here, so the generic list leaves them out. */
export const APP_NAME_KEYS = ["app_name_mode", "app_name"];

export function AppNamePanel({ values, env, onSaved }: { values: Record<string, unknown>; env: EnvMap; onSaved: (values: unknown) => void }) {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const savedMode: AppNameMode = isAppNameMode(values.app_name_mode) ? values.app_name_mode : "telepy";
    const savedName = typeof values.app_name === "string" ? values.app_name : "";
    // 選了自訂、還沒存名字時，畫面先停在自訂。/ Custom picked but no name saved yet: the page stays on custom meanwhile.
    const [pickedCustom, setPickedCustom] = useState(false);
    const mode: AppNameMode = pickedCustom ? "custom" : savedMode;
    const [draft, setDraft] = useState<string | null>(null);
    const name = draft ?? savedName;
    const [busy, setBusy] = useState(false);

    // 網域選項用公開網址的主機（.env 優先），沒有就是現在這個網址。/ The domain: the public address's host (.env first), else this one.
    const publicUrl = env.server_public_url?.set ? env.server_public_url.value : typeof values.server_public_url === "string" ? values.server_public_url : "";
    const host = appHost(publicUrl, typeof window === "undefined" ? "" : window.location.hostname);
    const problem = appNameProblem(name);
    const shown = appNameFor(mode, name, host);

    const save = async (body: Record<string, string>) => {
        setBusy(true);
        try {
            const res = await apiFetch("/api/site/settings", { method: "POST", body: JSON.stringify(body) });
            const answer = await readJson<{ values?: unknown }>(res);
            if (!res.ok) {
                showError(responseError(res, answer, t("settings.updateFailed")));
                return false;
            }
            showSuccess(t("settings.updated"));
            setPickedCustom(false);
            setDraft(null);
            onSaved(answer?.values);
            void refreshAppName();
            return true;
        } finally {
            setBusy(false);
        }
    };

    const pick = (next: AppNameMode) => {
        if (next === "custom" && !savedName) {
            setPickedCustom(true);
            return;
        }
        setPickedCustom(false);
        if (next !== savedMode) void save({ app_name_mode: next });
    };

    const canSave = mode === "custom" && !problem && tidyAppName(name) !== "" && (tidyAppName(name) !== savedName || savedMode !== "custom");

    return (
        <section className="overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card">
            <div className="p-4 sm:px-6 sm:pt-5 sm:pb-4">
                <SectionHeading icon={<AppWindow />} title={t("appName.title")} description={t("appName.description")} />
            </div>

            <div className="space-y-5 border-t border-border/70 p-4 sm:px-6 sm:py-5">
                <Segmented
                    fullWidth
                    options={[
                        { value: "telepy" as const, label: t("appName.mode.telepy") },
                        { value: "domain" as const, label: t("appName.mode.domain") },
                        { value: "custom" as const, label: t("appName.mode.custom") },
                    ]}
                    value={mode}
                    onChange={pick}
                    aria-label={t("appName.title")}
                />

                {mode === "domain" && <p className="text-sm leading-relaxed text-muted-foreground">{t("appName.domainHint", { host: host ?? "—" })}</p>}
                {mode === "custom" && (
                    <form
                        className="space-y-3"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (canSave) void save({ app_name_mode: "custom", app_name: tidyAppName(name) });
                        }}
                    >
                        <Field
                            label={t("appName.customLabel")}
                            addon={<span className={[...tidyAppName(name)].length > APP_NAME_MAX ? "tabular-nums text-destructive" : "tabular-nums"}>{[...tidyAppName(name)].length} / {APP_NAME_MAX}</span>}
                            hint={[...tidyAppName(name)].length > HOME_LABEL_CHARS ? t("appName.longHint", { n: HOME_LABEL_CHARS }) : undefined}
                            error={problem ? t(problem === "tooLong" ? "appName.problem.tooLong" : "appName.problem.control", { max: APP_NAME_MAX }) : undefined}
                        >
                            <div className="flex gap-2">
                                <Input value={name} onChange={(e) => setDraft(e.target.value)} placeholder={t("appName.customPlaceholder")} autoComplete="off" />
                                <Button type="submit" disabled={!canSave || busy}>
                                    {t("common.save")}
                                </Button>
                            </div>
                        </Field>
                        {pickedCustom && !tidyAppName(name) && <p className="text-xs text-muted-foreground">{t("appName.problem.empty")}</p>}
                    </form>
                )}

                {/* 預覽：主畫面上的圖示與名字、一則通知。/ Preview: the home-screen icon and label, and a notification. */}
                <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
                    <figure className="flex flex-col items-center gap-1.5 rounded-xl bg-surface px-6 py-4 ring-1 ring-inset ring-border/80">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src="/icons/icon-192.png" alt="" width={56} height={56} className="size-14 rounded-[0.9rem]" />
                        <figcaption className="max-w-[6.5rem] truncate text-center text-xs text-foreground">{homeLabel(shown)}</figcaption>
                        <span className="text-[0.7rem] text-muted-foreground">{t("appName.previewHome")}</span>
                    </figure>
                    <figure className="flex min-w-0 items-start gap-3 self-start rounded-xl bg-surface p-3 ring-1 ring-inset ring-border/80">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src="/icons/icon-192.png" alt="" width={32} height={32} className="size-8 shrink-0 rounded-lg" />
                        <div className="min-w-0">
                            <p className="flex items-center gap-1.5 text-sm text-foreground">
                                <Bell size={12} className="shrink-0 text-muted-foreground" aria-hidden />
                                <span className="min-w-0 [overflow-wrap:anywhere]">{shown}</span>
                            </p>
                            <p className="text-sm leading-snug text-muted-foreground">{t("notify.offline", { name: "lab-pi" })}</p>
                            <p className="mt-1 text-[0.7rem] text-muted-foreground">{t("appName.previewNotify")}</p>
                        </div>
                    </figure>
                </div>

                <Callout tone="info">{t("appName.note")}</Callout>
            </div>
        </section>
    );
}
