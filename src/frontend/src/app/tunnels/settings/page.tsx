"use client";

/**
 * 設定頁：站台設定列表與開關,僅管理員可編輯。
 * 每項設定顯示 label + 說明(來自後端 model 的 help_text),讓管理員知道這是做什麼的。
 * Settings page: each setting shows a label + description (from the backend model help_text) so
 * admins know what it does. Only admins can edit.
 */
import React, { useState } from "react";
import { useAuth } from "@/lib/auth";
import { Settings, ShieldAlert, Info } from "lucide-react";
import { WebSocketStatusBadge } from "@/components/ui/WebSocketStatusBadge";
import { useSettingsPage, SettingMeta } from "@/hooks/useSettingsPage";

function titleize(key: string) {
    return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function SettingsPage() {
    const { user } = useAuth();
    const { state, actions } = useSettingsPage();
    const { settingsObj, meta, loading } = state;
    const { handleToggle, handleUpdate } = actions;
    const [editValues, setEditValues] = useState<Record<string, string>>({});
    const isAdmin = !!user?.is_superuser;
    const entries = Object.entries(settingsObj);

    // 依 meta.type(找不到就用值的型別)決定編輯器與存檔驗證。
    const typeOf = (key: string, value: unknown): SettingMeta["type"] =>
        meta[key]?.type ?? (typeof value === "boolean" ? "boolean" : typeof value === "number" ? "integer" : "string");

    const commit = (key: string, kind: SettingMeta["type"], value: unknown) => {
        const raw = editValues[key] ?? String(value ?? "");
        if (kind === "integer") {
            const num = parseInt(raw, 10);
            if (isNaN(num) || num < 0) return;   // 允許 0(例如 max_sessions=0 代表不限制)
            handleUpdate(key, num);
        } else {
            const s = raw.trim();
            if (!s) return;
            handleUpdate(key, s);
        }
    };

    return (
        <div className="animate-fade-in-up space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
                    <Settings className="text-primary animate-float" />
                    {isAdmin ? "Admin Settings" : "User Settings"}
                    <WebSocketStatusBadge />
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                    Configure site-wide preferences. Changes take effect the next time a proxy browser is opened
                    (toggles apply immediately).
                </p>
            </div>

            <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4 flex items-start gap-3 text-sm text-blue-800 dark:text-blue-200 mb-6">
                <Info size={18} className="mt-0.5 shrink-0" />
                <span>{isAdmin ? "Manage server-wide settings that affect all users. Read each setting's description before changing it." : "View your current settings. Contact an administrator to change site-wide configurations."}</span>
            </div>

            {!isAdmin && (
                <div className="bg-warning/10 border-l-4 border-warning p-4 mb-6 rounded-r-md flex items-start">
                    <ShieldAlert className="text-warning mr-3 shrink-0 mt-0.5" size={20} />
                    <p className="text-sm text-warning-foreground">
                        Some administrative settings are hidden because you do not have superuser privileges.
                    </p>
                </div>
            )}

            <div className="bg-card text-card-foreground shadow overflow-hidden sm:rounded-lg border border-border">
                <ul className="divide-y divide-border">
                    {loading ? (
                        <li className="p-8 text-center text-muted-foreground">
                            <div className="flex justify-center mb-2">
                                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                            </div>
                            Loading settings...
                        </li>
                    ) : entries.length === 0 ? (
                        <li className="p-8 text-center text-muted-foreground">
                            No settings found or you do not have permission to view them.
                        </li>
                    ) : (
                        entries.map(([key, value]) => {
                            const kind = typeOf(key, value);
                            const m = meta[key];
                            return (
                                <li key={key} className="p-4 sm:p-6 hover:bg-muted/50 transition-colors">
                                    <div className="flex items-start justify-between gap-4">
                                        <div className="flex-1 min-w-0">
                                            <h4 className="text-sm font-medium text-foreground">
                                                {m?.label ?? titleize(key)}
                                            </h4>
                                            {m?.description && (
                                                <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                                                    {m.description}
                                                </p>
                                            )}
                                            <p className="mt-1.5 text-[11px] text-muted-foreground/70 font-mono bg-muted inline-block px-1 rounded border border-border">
                                                {key}
                                            </p>
                                        </div>
                                        <div className="shrink-0 pt-0.5">
                                            {kind === "boolean" ? (
                                                <button
                                                    type="button"
                                                    onClick={() => isAdmin && handleToggle(key, value)}
                                                    disabled={!isAdmin}
                                                    className={`${value ? "bg-primary" : "bg-muted"} relative inline-flex h-6 w-11 shrink-0 ${isAdmin ? "cursor-pointer" : "cursor-not-allowed opacity-60"} rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2`}
                                                    role="switch"
                                                    aria-checked={!!value}
                                                >
                                                    <span aria-hidden="true" className={`${value ? "translate-x-5" : "translate-x-0"} pointer-events-none inline-block h-5 w-5 transform rounded-full bg-primary-foreground shadow ring-0 transition duration-200 ease-in-out`} />
                                                </button>
                                            ) : (
                                                <div className="flex items-center gap-2">
                                                    <input
                                                        type={kind === "integer" ? "number" : "text"}
                                                        className={`${kind === "integer" ? "w-24" : "w-56"} text-sm border border-border rounded px-2 py-1 bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring`}
                                                        value={editValues[key] ?? String(value ?? "")}
                                                        onChange={(e) => setEditValues((prev) => ({ ...prev, [key]: e.target.value }))}
                                                        onKeyDown={(e) => { if (e.key === "Enter") commit(key, kind, value); }}
                                                        min={kind === "integer" ? 0 : undefined}
                                                        disabled={!isAdmin}
                                                    />
                                                    {isAdmin && (
                                                        <button
                                                            type="button"
                                                            className="text-xs px-2 py-1 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
                                                            onClick={() => commit(key, kind, value)}
                                                        >
                                                            Save
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </li>
                            );
                        })
                    )}
                </ul>
            </div>
        </div>
    );
}
