"use client";

import React, { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/lib/auth";
import { Settings, ShieldAlert, Info } from "lucide-react";
import { WebSocketStatusBadge } from "@/components/ui/WebSocketStatusBadge";

// Human-readable labels for known settings keys
const SETTING_LABELS: Record<string, string> = {
    allow_registration: "Allow User Registration",
};

export default function SettingsPage() {
    const [settingsObj, setSettingsObj] = useState<Record<string, any>>({});
    const [loading, setLoading] = useState(true);
    const { showSuccess, showError } = useToast();
    const { user } = useAuth();

    const fetchSettings = async () => {
        setLoading(true);
        try {
            const res = await apiFetch("/api/site/settings");
            if (res.ok) {
                const data = await res.json();
                // API returns a single object like { allow_registration: true }
                setSettingsObj(typeof data === "object" && data !== null ? data : {});
            } else {
                showError("Failed to fetch settings");
            }
        } catch (e: any) {
            showError(e.message || "Failed to fetch settings");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchSettings();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleToggle = async (keyName: string, currentValue: any) => {
        const newValue = !currentValue;
        // Optimistic update
        setSettingsObj(prev => ({ ...prev, [keyName]: newValue }));

        try {
            const res = await apiFetch("/api/site/settings", {
                method: "POST",
                body: JSON.stringify({ [keyName]: newValue }),
            });
            if (res.ok) {
                showSuccess("Setting updated");
            } else {
                // Revert on failure
                setSettingsObj(prev => ({ ...prev, [keyName]: currentValue }));
                const err = await res.json();
                showError(err.error || "Failed to update setting");
            }
        } catch (e: any) {
            setSettingsObj(prev => ({ ...prev, [keyName]: currentValue }));
            showError(e.message || "Failed to update setting");
        }
    };

    const entries = Object.entries(settingsObj);

    return (
        <div className="animate-fade-in-up space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
                    <Settings className="text-primary animate-float" />
                    {user?.is_superuser ? "Admin Settings" : "User Settings"}
                    <WebSocketStatusBadge />
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                    Configure site-wide preferences and integrations. Toggle switches apply immediately.
                </p>
            </div>

            <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4 flex items-start gap-3 text-sm text-blue-800 dark:text-blue-200 mb-6">
                <Info size={18} className="mt-0.5 shrink-0" />
                <span>{user?.is_superuser ? "Manage server-wide settings that affect all users. Changes take effect immediately across the platform." : "View your current settings. Contact an administrator to change site-wide configurations."}</span>
            </div>

            {!user?.is_superuser && (
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
                            const isBoolean = typeof value === "boolean";
                            return (
                                <li key={key} className="p-4 sm:p-6 hover:bg-muted/50 transition-colors">
                                    <div className="flex items-center justify-between">
                                        <div className="flex-1 pr-6">
                                            <h4 className="text-sm font-medium text-foreground">
                                                {SETTING_LABELS[key] ?? key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
                                            </h4>
                                            <p className="mt-1 text-xs text-muted-foreground font-mono bg-muted inline-block px-1 rounded border border-border">
                                                {key}
                                            </p>
                                        </div>
                                        <div>
                                            {isBoolean ? (
                                                <button
                                                    type="button"
                                                    onClick={() => handleToggle(key, value)}
                                                    className={`${value ? "bg-primary" : "bg-muted"
                                                        } relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2`}
                                                    role="switch"
                                                    aria-checked={value}
                                                >
                                                    <span
                                                        aria-hidden="true"
                                                        className={`${value ? "translate-x-5" : "translate-x-0"
                                                            } pointer-events-none inline-block h-5 w-5 transform rounded-full bg-primary-foreground shadow ring-0 transition duration-200 ease-in-out`}
                                                    />
                                                </button>
                                            ) : (
                                                <div className="text-sm font-medium text-foreground bg-muted px-3 py-1 rounded border border-border">
                                                    {String(value)}
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
