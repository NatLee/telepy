"use client";

/**
 * 「網路上的人看得到什麼」：裝置連到 Telepy 的兩種方式（SSH port / 只有網頁 port）各讓監看網路的人看到什麼。
 * 建立精靈的連線步驟與一行指令加入共用；目前選的那欄會標出來。Telepy 走 http 時，網頁 port 也沒有 TLS，直接提醒。
 * What someone watching the network sees for each way the device reaches Telepy (SSH port / web port only).
 * Shared by the wizard's Connect step and the one-command join; the chosen column is marked. Over plain http the
 * web port has no TLS either, so that is said up front.
 */
import React, { useSyncExternalStore } from "react";
import { Eye, Lock } from "lucide-react";
import { Callout } from "@/components/ui/callout";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import { Disclosure } from "./CreateWizardSteps/parts";

export type Transport = "ssh" | "websocket";

const COLUMNS: { id: Transport; label: TranslationKey }[] = [
    { id: "ssh", label: "wizard.connect.transportSsh" },
    { id: "websocket", label: "wizard.connect.transportWeb" },
];

const ROWS: { label: TranslationKey; ssh: TranslationKey; websocket: TranslationKey }[] = [
    { label: "wizard.seen.where", ssh: "wizard.seen.whereSsh", websocket: "wizard.seen.whereWeb" },
    { label: "wizard.seen.name", ssh: "wizard.seen.nameSsh", websocket: "wizard.seen.nameWeb" },
    { label: "wizard.seen.looks", ssh: "wizard.seen.looksSsh", websocket: "wizard.seen.looksWeb" },
    { label: "wizard.seen.inspect", ssh: "wizard.seen.inspectSsh", websocket: "wizard.seen.inspectWeb" },
];

const subscribe = () => () => {};

/** 這個 Telepy 是否走 https（SSR 時先當作是，免得閃一下警告）。/ Whether Telepy is served over https (assumed during SSR). */
function useHttps(): boolean {
    return useSyncExternalStore(subscribe, () => window.location.protocol === "https:", () => true);
}

export function TransportVisibility({ selected }: { selected: Transport }) {
    const { t } = useI18n();
    const https = useHttps();
    return (
        <>
            {selected === "websocket" && !https && <Callout tone="warning">{t("wizard.seen.http")}</Callout>}
            <Disclosure title={t("wizard.seen.title")} icon={<Eye size={15} />}>
                {/* 窄的時候（手機）每列的標題獨佔一行、兩個選項並排在下面；夠寬才是三欄表格。表格元素改了 display，
                    所以明寫 role 保住表格語意。/ Narrow (phones): each row's label gets its own line with the two options
                    side by side below; three columns only when there is room. Explicit roles keep the table semantics. */}
                <div className="@container space-y-3 text-xs leading-relaxed">
                    <table role="table" className="block w-full border-collapse @md:table">
                        <thead role="rowgroup" className="block @md:table-header-group">
                            <tr role="row" className="grid grid-cols-2 @md:table-row">
                                <td className="hidden w-[30%] @md:table-cell" />
                                {COLUMNS.map(({ id, label }) => (
                                    <th key={id} role="columnheader" scope="col" className={cn("px-2 py-1.5 text-left align-bottom font-normal @md:pt-0", id === selected ? "bg-primary/[0.06] text-foreground" : "text-muted-foreground")}>
                                        {t(label)}
                                        {id === selected && <span className="sr-only"> ({t("wizard.seen.chosen")})</span>}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody role="rowgroup" className="block @md:table-row-group">
                            {ROWS.map((row) => (
                                <tr key={row.label} role="row" className="grid grid-cols-2 border-t border-border @md:table-row">
                                    <th role="rowheader" scope="row" className="col-span-2 pt-2 pr-2 text-left align-top font-normal text-muted-foreground @md:py-2">{t(row.label)}</th>
                                    {COLUMNS.map(({ id }) => (
                                        <td key={id} role="cell" className={cn("px-2 py-2 align-top text-foreground/85", id === selected && "bg-primary/[0.06]")}>
                                            {t(row[id])}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className="flex items-start gap-2 text-foreground/85">
                        <Lock size={13} className="mt-0.5 shrink-0 text-success" aria-hidden />
                        <span>{t("wizard.seen.never")}</span>
                    </p>
                    <p className="text-muted-foreground">{t("wizard.seen.note")}</p>
                </div>
            </Disclosure>
        </>
    );
}
