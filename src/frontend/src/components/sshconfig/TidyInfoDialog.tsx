"use client";

/**
 * 「怎麼讀起來一樣」：選一個名稱，看 ssh 在簡化前後各走過哪些區塊、用了哪些值（TidyNameFlow），下面是簡化遵守的規則
 * （出自 OpenSSH 原始碼）。貼上頁的資訊按鈕和多台 SSH config 對話框的「簡化」都開它。
 * "How it reads the same": pick a name and see which blocks ssh walks and which values it uses, before and after
 * (TidyNameFlow); below it, the rules the simplification follows (from OpenSSH's source). Opened from the paste
 * page's info button and the bulk SSH config dialog's compact layout.
 */
import React, { useState } from "react";
import { Info } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Section } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { TidyNameFlow } from "./TidyNameFlow";

const RULES: TranslationKey[] = ["tidy.rule.first", "tidy.rule.stack", "tidy.rule.case", "tidy.rule.h", "tidy.rule.walls", "tidy.rule.check", "tidy.rule.telepy"];

interface Props {
    isOpen: boolean;
    onClose: () => void;
    before: string;
    after: string;
    /** 可以選的名稱（設定裡寫明的）。/ The names to pick from (those the config spells out). */
    names: string[];
    /** 先選哪個（例如第一個有變動的）。/ Which to start with (e.g. the first one that changed). */
    initial?: string;
}

export function TidyInfoDialog({ isOpen, onClose, before, after, names, initial }: Props) {
    const { t } = useI18n();
    const [picked, setPicked] = useState<string | null>(null);
    const name = picked && names.includes(picked) ? picked : (initial && names.includes(initial) ? initial : names[0]);
    return (
        <Modal isOpen={isOpen} onClose={onClose} size="5xl" icon={<Info />} title={t("tidy.info.title")} description={t("tidy.info.description")}>
            <div className="space-y-6">
                {name ? (
                    <>
                        <Field label={t("tidy.info.name")} className="max-w-sm">
                            <NativeSelect value={name} onChange={(e) => setPicked(e.target.value)}>
                                {names.map((n) => (
                                    <option key={n} value={n}>{n}</option>
                                ))}
                            </NativeSelect>
                        </Field>
                        <TidyNameFlow before={before} after={after} name={name} />
                    </>
                ) : (
                    <p className="text-sm text-muted-foreground">{t("tidy.info.noNames")}</p>
                )}
                <Section title={t("tidy.info.rules")}>
                    <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground marker:text-border">
                        {RULES.map((k) => (
                            <li key={k}>{t(k)}</li>
                        ))}
                    </ul>
                    <p className="mt-3 text-xs text-muted-foreground">{t("tidy.info.source")}</p>
                </Section>
            </div>
        </Modal>
    );
}
