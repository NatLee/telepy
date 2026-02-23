import { useState, useEffect, useCallback, useMemo } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

interface LogEntry {
    id: number;
    time: string;
    message: string;
    originalTime?: string;
    parsedAt?: Date | null;
}

export function useLogsPage() {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const { showError } = useToast();

    const fetchLogs = useCallback(async () => {
        setLoading(true);
        try {
            const res = await apiFetch("/api/log/ssh");
            if (res.ok) {
                let raw = await res.text();
                // DRF Response() wraps the string in JSON quotes — try to unwrap
                try {
                    const parsed = JSON.parse(raw);
                    if (typeof parsed === 'string') raw = parsed;
                } catch (_) { /* not JSON, use raw text as-is */ }
                const lines = raw.split("\n").filter(l => l.trim() !== "");
                const parsedLogs = lines.map((line, idx) => {
                    let time = "";
                    let message = line;
                    let parsedAt: Date | null = null;

                    const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)(?:\s+(.*))?/);
                    if (dateMatch) {
                        time = dateMatch[1].split('.')[0];
                        message = dateMatch[2] || "";
                        parsedAt = new Date(time.replace(' ', 'T') + 'Z');
                    } else {
                        const altMatch = line.match(/^([A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2})(?:\s+(.*))?/);
                        if (altMatch) {
                            time = altMatch[1];
                            message = altMatch[2] || "";
                        } else {
                            const parts = line.split(" ");
                            if (parts.length > 2 && (parts[0].includes("-") || parts[0].includes("/"))) {
                                time = parts[0] + " " + parts[1];
                                message = parts.slice(2).join(" ");
                                const potentialDate = new Date(time.replace(' ', 'T') + 'Z');
                                if (!isNaN(potentialDate.getTime())) {
                                    parsedAt = potentialDate;
                                }
                            }
                        }
                    }

                    let timeText = time;
                    if (parsedAt && !isNaN(parsedAt.getTime())) {
                        timeText = new Intl.DateTimeFormat('en-US', {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            hour12: false
                        }).format(parsedAt);
                    }

                    return { id: idx, time: timeText, originalTime: time, message, parsedAt };
                });

                setLogs(parsedLogs.reverse());
            } else {
                showError("Failed to fetch logs");
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || "Failed to fetch logs");
        } finally {
            setLoading(false);
        }
    }, [showError]);

    useEffect(() => {
        fetchLogs();
    }, [fetchLogs]);

    const filteredLogs = useMemo(() => {
        return logs.filter(log =>
            log.message.toLowerCase().includes(search.toLowerCase()) ||
            log.time.toLowerCase().includes(search.toLowerCase()) ||
            (log.originalTime && log.originalTime.toLowerCase().includes(search.toLowerCase()))
        );
    }, [logs, search]);

    return {
        state: {
            logs,
            filteredLogs,
            loading,
            search, setSearch
        },
        actions: {
            fetchLogs
        }
    };
}
