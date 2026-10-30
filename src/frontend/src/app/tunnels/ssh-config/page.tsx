"use client";

/**
 * SSH config 簡化頁（`/tunnels/ssh-config`，側欄工作區「簡化 config」）：貼上一份 ~/.ssh/config，好幾個區塊共用的行寫一次、
 * ssh 讀不到的重複行拿掉，每個名稱逐一驗證讀起來跟原本一樣（lib/sshConfigTidy.ts）。整頁在瀏覽器裡算，貼上的內容不送出。
 * 資訊按鈕 = 選一個名稱、看 ssh 前後各怎麼讀（TidyInfoDialog）。
 * The SSH config simplifier: paste a ~/.ssh/config; lines several blocks share are written once, repeats ssh never
 * reads are dropped, and every name is checked to read exactly as before (lib/sshConfigTidy.ts). Everything runs in
 * the browser — the pasted text is never sent. The info button opens TidyInfoDialog for one name.
 */
import React, { useState } from "react";
import { ClipboardPaste, FileCode2, Info, Shield, Sparkles, X } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { TidyResultView } from "@/components/sshconfig/TidyResultView";
import { TidyInfoDialog } from "@/components/sshconfig/TidyInfoDialog";
import { useTidyPage } from "@/hooks/useTidyPage";
import { useI18n } from "@/lib/i18n";
import { TIDY_EXAMPLE, tidyConfig } from "@/lib/sshConfigTidy";

export default function SshConfigTidyPage() {
    const { t } = useI18n();
    const page = useTidyPage();
    const [howOpen, setHowOpen] = useState(false);
    const paste = () =>
        navigator.clipboard
            .readText()
            .then((s) => s && page.setText(s))
            .catch(() => { /* 不給讀剪貼簿：直接貼到框裡就好 / no clipboard access: paste into the box instead */ });
    // 還沒貼東西時，資訊視窗用例子示範。/ With nothing pasted, the info dialog shows the example.
    const demo = !page.result;
    const before = demo ? TIDY_EXAMPLE : page.input;
    const after = demo ? tidyConfig(TIDY_EXAMPLE).text : page.result!.text;

    return (
        <div className="animate-fade-in-up space-y-6">
            <PageHeader
                icon={<FileCode2 />}
                title={t("tidy.title")}
                description={t("tidy.subtitle")}
                actions={
                    <Button variant="outline" onClick={() => setHowOpen(true)}>
                        <Info size={16} /> {t("tidy.how")}
                    </Button>
                }
            />
            <TidyInfoDialog
                isOpen={howOpen}
                onClose={() => setHowOpen(false)}
                before={before}
                after={after}
                names={demo ? ["web-1", "db", "lab-pi", "bastion"] : page.names}
                initial={demo ? "web-1" : page.firstChanged}
            />

            <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <Shield size={15} className="mt-0.5 shrink-0" aria-hidden />
                {t("tidy.private")}
            </p>

            <section aria-label={t("tidy.input")} className="space-y-3">
                <div className="flex flex-wrap items-end justify-between gap-2">
                    <div>
                        <h2 className="text-foreground">{t("tidy.input")}</h2>
                        <p className="text-sm text-muted-foreground">{t("tidy.inputHint")}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button variant="outline" size="sm" onClick={paste}>
                            <ClipboardPaste size={15} /> {t("tidy.paste")}
                        </Button>
                        <Button variant="outline" size="sm" onClick={page.loadExample}>
                            <Sparkles size={15} /> {t("tidy.example")}
                        </Button>
                        {page.text && (
                            <Button variant="ghost" size="sm" onClick={() => page.setText("")}>
                                <X size={15} /> {t("tidy.clear")}
                            </Button>
                        )}
                    </div>
                </div>
                <Textarea
                    value={page.text}
                    onChange={(e) => page.setText(e.target.value)}
                    placeholder={t("tidy.placeholder")}
                    aria-label={t("tidy.input")}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    rows={page.text ? Math.min(24, Math.max(8, page.text.split("\n").length + 1)) : 8}
                    className="font-mono text-[0.8125rem] leading-relaxed"
                />
                <Switch checked={page.wildcards} onCheckedChange={page.setWildcards} size="sm">
                    <span className="text-sm text-foreground">{t("tidy.wildcards")}</span>
                </Switch>
                <p className="-mt-1 pl-11 text-xs leading-relaxed text-muted-foreground">{t("tidy.wildcardsHint")}</p>
            </section>

            {page.result ? (
                <TidyResultView input={page.input} result={page.result} stale={page.stale} onExplain={() => setHowOpen(true)} />
            ) : (
                <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{t("tidy.empty")}</p>
            )}
        </div>
    );
}
