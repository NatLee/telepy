"use client";

/** 看別人終端機的說明（觀看頁與即時 session 頁的 info 按鈕）。/ The dialog behind the watch / live sessions info button. */
import React from "react";
import { Eye } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { WatchFlow, type WatchFlowContext } from "./WatchFlow";

export function WatchInfoDialog({ isOpen, onClose, ctx }: { isOpen: boolean; onClose: () => void; ctx: WatchFlowContext }) {
    const { t } = useI18n();
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("watch.flow.title")}
            description={t("watch.flow.description")}
            icon={<Eye />}
            size="5xl"
            footer={<Button onClick={onClose}>{t("common.close")}</Button>}
        >
            <WatchFlow ctx={ctx} />
        </Modal>
    );
}
