"use client";

/**
 * SSH 伺服器日誌頁：載入日誌、關鍵字篩選與關鍵字標籤。
 * SSH server logs page: load logs, keyword filter and keyword badges.
 */
import React from "react";
import { Search, FileText, AlertCircle, RefreshCw, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

import { useLogsPage } from "@/hooks/useLogsPage";

export default function LogsPage() {
    const { state, actions } = useLogsPage();
    const {
        logs,
        filteredLogs,
        loading,
        search, setSearch
    } = state;

    const { fetchLogs } = actions;

    const getKeywordBadge = (message: string) => {
        const keywords = [
            { text: "Server listening", variant: "default" as const },
            { text: "Connection closed", variant: "destructive" as const },
            { text: "Accepted publickey", variant: "default" as const },
            { text: "Disconnected", variant: "secondary" as const },
            { text: "error", variant: "destructive" as const },
            { text: "warning", variant: "outline" as const },
        ];

        for (const kw of keywords) {
            if (message.toLowerCase().includes(kw.text.toLowerCase())) {
                return <Badge variant={kw.variant} className="mr-2 text-[10px] leading-none py-0.5">{kw.text}</Badge>;
            }
        }
        return null;
    };

    return (
        <div className="flex flex-col h-[calc(100vh-8rem)] animate-fade-in-up">
            <div className="mb-6 shrink-0 sm:flex sm:items-center sm:justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
                        <FileText className="text-primary animate-float" />
                        SSH Server Logs
                    </h1>
                    <p className="mt-2 text-sm text-muted-foreground">
                        Monitor server activity, connection events, and authentication attempts. Use the search bar to filter by keyword, IP address, or date.
                    </p>
                </div>
                <div className="mt-4 sm:mt-0 flex gap-2">
                    <Button onClick={fetchLogs} variant="outline" className="gap-2">
                        <RefreshCw size={16} />
                        Refresh
                    </Button>
                </div>
            </div>

            <div className="mb-4 shrink-0 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4 flex items-start gap-3 text-sm text-blue-800 dark:text-blue-200">
                <Info size={18} className="mt-0.5 shrink-0" />
                <span>View real-time SSH server activity including connection events, authentication attempts, and session logs. Use search to filter by keyword, IP address, or date.</span>
            </div>

            <div className="mb-4 shrink-0 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Search size={18} className="text-muted-foreground" />
                </div>
                <Input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Filter logs by keyword, date, IP..."
                    className="pl-10"
                />
            </div>

            <div className="flex-1 bg-card text-card-foreground border border-border rounded-lg shadow-sm overflow-hidden flex flex-col min-h-0">
                {loading ? (
                    <div className="flex-1 flex justify-center items-center">
                        <div className="flex flex-col items-center">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mb-4"></div>
                            <p className="text-muted-foreground font-medium">Loading logs...</p>
                        </div>
                    </div>
                ) : logs.length === 0 ? (
                    <div className="flex-1 flex justify-center items-center">
                        <div className="text-center">
                            <AlertCircle size={48} className="mx-auto text-muted mb-4 opacity-50" />
                            <p className="text-muted-foreground font-medium text-lg">No logs available</p>
                        </div>
                    </div>
                ) : (
                    <div className="flex-1 overflow-auto bg-muted/10 font-mono text-sm">
                        <table className="min-w-full divide-y divide-border border-collapse">
                            <thead className="bg-muted/50 sticky top-0 border-b border-border shadow-sm z-10">
                                <tr>
                                    <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-muted-foreground tracking-wider w-48 border-r border-border/50">Time</th>
                                    <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-muted-foreground tracking-wider">Message</th>
                                </tr>
                            </thead>
                            <tbody className="bg-card divide-y divide-border">
                                {filteredLogs.map((log) => (
                                    <tr key={log.id} className="hover:bg-muted/50 transition-colors group">
                                        <td className="px-6 py-2 whitespace-nowrap text-xs text-muted-foreground border-r border-border/50 group-hover:bg-muted/30">
                                            {log.time}
                                        </td>
                                        <td className="px-6 py-2 text-xs text-foreground break-words group-hover:bg-muted/30">
                                            <div className="flex items-center flex-wrap gap-1">
                                                {getKeywordBadge(log.message)}
                                                <span className="leading-relaxed whitespace-pre-wrap break-all">{log.message}</span>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                                {filteredLogs.length === 0 && (
                                    <tr>
                                        <td colSpan={2} className="px-6 py-8 text-center text-sm text-muted-foreground">
                                            No logs matched your search filter.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}
