/**
 * 建立精靈內檢視/複製金鑰的彈窗。
 * Key view/copy modal used inside create wizard.
 */
import React from "react";
import { Copy } from "lucide-react";

export interface KeyViewModalProps {
    isOpen: boolean;
    title: string;
    content: string;
    onClose: () => void;
    onCopySuccess: () => void;
}

export function KeyViewModal({ isOpen, title, content, onClose, onCopySuccess }: KeyViewModalProps) {
    if (!isOpen) return null;

    const handleCopy = () => {
        navigator.clipboard.writeText(content);
        onCopySuccess();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="fixed inset-0 bg-black/50" onClick={onClose} aria-hidden />
            <div className="relative bg-white rounded-xl shadow-2xl max-w-xl w-full p-6 z-10">
                <h3 className="text-lg font-bold text-gray-900 mb-1">{title}</h3>
                <p className="text-xs text-gray-500 mb-4">
                    Copy this key and append it to <code className="bg-gray-100 px-1 rounded">~/.ssh/authorized_keys</code> on your target server.
                </p>
                <textarea
                    readOnly
                    value={content}
                    rows={6}
                    className="w-full border border-gray-300 rounded-lg px-4 py-3 text-xs font-mono bg-gray-50 resize-none focus:outline-none"
                />
                <div className="mt-4 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={handleCopy}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
                    >
                        <Copy size={14} /> Copy
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
