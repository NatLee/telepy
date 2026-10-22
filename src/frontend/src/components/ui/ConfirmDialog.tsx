"use client";

/**
 * 確認對話框:圖示 + 標題 + 說明 + 兩顆按鈕的精簡版 Modal。危險動作用紅色調。
 * Confirmation dialog: a compact Modal with an icon, title, message and two buttons; destructive
 * actions get the red tone.
 */
import React from "react";
import { CircleHelp, TriangleAlert } from "lucide-react";
import { Modal } from "./Modal";
import { Button } from "./button";
import { useI18n } from "@/lib/i18n";

interface ConfirmDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string | React.ReactNode;
    confirmText?: string;
    cancelText?: string;
    isDestructive?: boolean;
}

export function ConfirmDialog({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmText,
    cancelText,
    isDestructive = false,
}: ConfirmDialogProps) {
    const { t } = useI18n();
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={title}
            description={message}
            icon={isDestructive ? <TriangleAlert /> : <CircleHelp />}
            tone={isDestructive ? "danger" : "default"}
            size="md"
            footer={
                <>
                    <Button variant="outline" onClick={onClose}>
                        {cancelText ?? t("common.cancel")}
                    </Button>
                    <Button
                        variant={isDestructive ? "destructive" : "default"}
                        onClick={() => {
                            onConfirm();
                            onClose();
                        }}
                    >
                        {confirmText ?? t("common.confirm")}
                    </Button>
                </>
            }
        />
    );
}
