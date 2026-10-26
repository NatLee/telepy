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
    { scope: "ssh:exec", label: "oauth.scope.sshExec", description: "oauth.scope.sshExecDescription", tools: ["ssh_session_open", "ssh_exec", "shell_open", "shell_send", "shell_read", "shell_resize", "shell_close"] },
    { scope: "ssh:files", label: "oauth.scope.sshFiles", description: "oauth.scope.sshFilesDescription", tools: ["ssh_session_open", "sftp_list", "sftp_read", "sftp_write"] },
    { scope: "network:scan", label: "oauth.scope.networkScan", description: "oauth.scope.networkScanDescription", tools: ["lan_scan"] },
    {
        scope: "browser:use",
        label: "oauth.scope.browserUse",
        description: "oauth.scope.browserUseDescription",
        tools: ["browser_open", "browser_navigate", "browser_read", "browser_screenshot", "browser_click", "browser_type", "browser_close"],
    },
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
    shell_open: "activity.tool.shell_open",
    shell_send: "activity.tool.shell_send",
    shell_read: "activity.tool.shell_read",
    shell_resize: "activity.tool.shell_resize",
    shell_close: "activity.tool.shell_close",
    browser_open: "activity.tool.browser_open",
    browser_navigate: "activity.tool.browser_navigate",
    browser_read: "activity.tool.browser_read",
    browser_screenshot: "activity.tool.browser_screenshot",
    browser_click: "activity.tool.browser_click",
    browser_type: "activity.tool.browser_type",
    browser_close: "activity.tool.browser_close",
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
    if (tool === "browser_close") {
        // `reason: <r>[; by: <who>]; actions: N`
        const m = detail.match(/^reason:\s*([a-z_]+);(?:\s*by:\s*([^;]+);)?\s*actions:\s*(\d+)/);
        if (m) {
            const key = REASON_LABELS[m[1]];
            const reason = m[2] ? t("activity.endedBy", { user: m[2].trim() }) : key ? t(key) : m[1];
            return t("activity.browserCloseDetail", { reason, count: Number(m[3]) });
        }
    }
    return detail;
}

/** agent 能碰到的地方（MCP 頁的示意圖）。/ The places an agent can reach (the MCP page diagram). */
export type ReachBranch = "tunnels" | "exec" | "shell" | "files" | "scan" | "browser";

export const REACH_BRANCHES: { id: ReachBranch; scope: string; tools: string[]; label: TranslationKey; detail: TranslationKey }[] = [
    { id: "tunnels", scope: "tunnels:read", tools: ["list_tunnels", "tunnel_status", "lan_hosts"], label: "mcp.reach.tunnels", detail: "mcp.reach.tunnelsDetail" },
    { id: "exec", scope: "ssh:exec", tools: ["ssh_exec"], label: "mcp.reach.exec", detail: "mcp.reach.execDetail" },
    { id: "shell", scope: "ssh:exec", tools: ["shell_open", "shell_send", "shell_read"], label: "mcp.reach.shell", detail: "mcp.reach.shellDetail" },
    { id: "files", scope: "ssh:files", tools: ["sftp_list", "sftp_read", "sftp_write"], label: "mcp.reach.files", detail: "mcp.reach.filesDetail" },
    { id: "scan", scope: "network:scan", tools: ["lan_scan"], label: "mcp.reach.scan", detail: "mcp.reach.scanDetail" },
    { id: "browser", scope: "browser:use", tools: ["browser_open", "browser_navigate", "browser_read", "browser_click", "browser_type", "browser_screenshot"], label: "mcp.reach.browser", detail: "mcp.reach.browserDetail" },
];

export interface Reach {
    /** 每條分支有沒有開。/ Whether each branch is open. */
    branches: Record<ReachBranch, boolean>;
    /** 會登入裝置（指令、檔案、掃描、瀏覽器都經裝置的 sshd）。/ Logs in to the device at all. */
    device: boolean;
    /** 經裝置上網 / 進區網（遠端瀏覽器、區網掃描）。/ Goes beyond the device (browser, LAN scan). */
    beyond: boolean;
    /** 經遠端瀏覽器上網。/ Browses the web through the device. */
    web: boolean;
}

/**
 * 一組 scope 讓 agent 碰得到哪裡；`null` = 還沒選 app，全部顯示成「可能」。
 * What a set of scopes lets an agent reach; `null` (no app picked) shows everything that is possible.
 */
export function reachFor(scopes: readonly string[] | null): Reach {
    const has = (s: string) => scopes === null || scopes.includes(s);
    const branches = Object.fromEntries(REACH_BRANCHES.map((b) => [b.id, has(b.scope)])) as Record<ReachBranch, boolean>;
    const device = branches.exec || branches.shell || branches.files || branches.scan || branches.browser;
    return { branches, device, beyond: branches.scan || branches.browser, web: branches.browser };
}
