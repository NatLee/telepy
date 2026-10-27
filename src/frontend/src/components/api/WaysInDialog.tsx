"use client";

/**
 * API 頁資訊按鈕的對話框：「進入 Telepy 的三條路」圖（WaysInDiagram）。
 * The API page's info dialog: the "three ways into Telepy" diagram.
 */
import React from "react";
import { Info } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useI18n } from "@/lib/i18n";
import { WaysInDiagram } from "./WaysInDiagram";

export function WaysInDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const { t } = useI18n();
    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("apiPage.overviewTitle")} description={t("apiPage.overviewHint")} icon={<Info />} size="4xl">
            <WaysInDiagram />
        </Modal>
    );
}
