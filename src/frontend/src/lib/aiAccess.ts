/**
 * AI 存取(MCP)共用的對照表:scope 與它開放的工具、工具名稱與 session 關閉理由的翻譯 key。
 * MCP 頁、AI 活動頁與「已連接的應用程式」詳細資料都用這裡,三處的說法才會一致。
 * Shared AI-access (MCP) tables: scopes and the tools they unlock, translation keys for tool names and
 * session close reasons. Used by the MCP page, the AI activity page and the connected-app details.
 */
import type { TranslationKey } from "@/locales/en";

/** scope 與它開放的工具(與後端 mcp/ 的檢查一致)。/ Scopes and the tools they unlock (mirrors mcp/). */
export const SCOPES: { scope: string; label: TranslationKey; description: TranslationKey; tools: string[] }[] = [
    { scope: "tunnels:read", label: "oauth.scope.tunnelsRead", description: "oauth.scope.tunnelsReadDescription", tools: ["list_tunnels", "tunnel_status", "lan_hosts"] },
    { scope: "ssh:exec", label: "oauth.scope.sshExec", description: "oauth.scope.sshExecDescription", tools: ["ssh_session_open", "ssh_exec"] },
    { scope: "ssh:files", label: "oauth.scope.sshFiles", description: "oauth.scope.sshFilesDescription", tools: ["ssh_session_open", "sftp_list", "sftp_read", "sftp_write"] },
    { scope: "network:scan", label: "oauth.scope.networkScan", description: "oauth.scope.networkScanDescription", tools: ["lan_scan"] },
];

export const TOOL_LABELS: Record<string, TranslationKey> = {
    list_tunnels: "activity.tool.list_tunnels",
    tunnel_status: "activity.tool.tunnel_status",
    ssh_session_open: "activity.tool.ssh_session_open",
    ssh_exec: "activity.tool.ssh_exec",
    ssh_session_close: "activity.tool.ssh_session_close",
    sftp_list: "activity.tool.sftp_list",
    sftp_read: "activity.tool.sftp_read",
    sftp_write: "activity.tool.sftp_write",
    lan_hosts: "activity.tool.lan_hosts",
    lan_scan: "activity.tool.lan_scan",
};

export const REASON_LABELS: Record<string, TranslationKey> = {
    idle: "activity.reason.idle",
    max_lifetime: "activity.reason.max_lifetime",
    device_offline: "activity.reason.device_offline",
    disconnected: "activity.reason.disconnected",
    revoked: "activity.reason.revoked",
    permission_removed: "activity.reason.permission_removed",
    closed_by_user: "activity.reason.closed_by_user",
    closed_by_agent: "activity.reason.closed_by_agent",
    tunnel_deleted: "activity.reason.tunnel_deleted",
};

type Translate = (k: TranslationKey, v?: Record<string, string | number>) => string;

/** 工具名稱的翻譯;不認得的工具照原樣顯示。/ Localized tool name; unknown tools render verbatim. */
export function toolLabel(tool: string, t: Translate): string {
    const key = TOOL_LABELS[tool];
    return key ? t(key) : tool;
}

/** 關閉列的 detail 是 `reason: <r>; commands: N`,把 reason 換成翻譯。/ Translate the reason in close rows. */
export function describeDetail(tool: string, detail: string | null, t: Translate): string {
    if (!detail) return "";
    if (tool === "ssh_session_close") {
        const m = detail.match(/^reason:\s*([a-z_]+);\s*commands:\s*(\d+)/);
        if (m) {
            const key = REASON_LABELS[m[1]];
            return t("activity.closeDetail", { reason: key ? t(key) : m[1], count: Number(m[2]) });
        }
    }
    return detail;
}
