"use client";

import React from "react";
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
            size="sm"
            footer={
                <div className="flex items-center justify-end gap-2 w-full">
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
                </div>
            }
        >
            <div className="text-muted-foreground">{message}</div>
        </Modal>
    );
}
