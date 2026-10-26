/**
 * AI 活動頁的小工具：工具分類（指令 / 檔案 / 工作階段 / 隧道與網路）、篩選與數量、哪些內容是指令或路徑、時間與大小格式。
 * 純函式，`aiActivity.test.ts` 有測試。
 * AI activity helpers: tool categories (commands / files / sessions / tunnels & network), filtering and counts,
 * which details are commands or paths, and duration / size formatting.
 */
export type ToolCategory = "exec" | "files" | "browser" | "session" | "read";
export type ToolFilter = "all" | ToolCategory;
export const TOOL_FILTERS: ToolFilter[] = ["all", "exec", "files", "browser", "session", "read"];

const CATEGORIES: Record<string, ToolCategory> = {
    ssh_exec: "exec",
    shell_send: "exec",
    shell_read: "exec",
    shell_resize: "exec",
    shell_open: "session",
    shell_close: "session",
    browser_open: "browser",
    browser_navigate: "browser",
    browser_read: "browser",
    browser_screenshot: "browser",
    browser_click: "browser",
    browser_type: "browser",
    browser_close: "browser",
    sftp_list: "files",
    sftp_read: "files",
    sftp_write: "files",
    ssh_session_open: "session",
    ssh_session_close: "session",
    list_tunnels: "read",
    tunnel_status: "read",
    lan_hosts: "read",
    lan_scan: "read",
};

export function toolCategory(tool: string): ToolCategory | null {
    return CATEGORIES[tool] ?? null;
}

/** 內容是指令、路徑或網址（用等寬的程式碼區塊、可複製），其他是一般說明文字。/ Commands, paths and URLs get a code block. */
export function isCodeDetail(tool: string): boolean {
    const c = toolCategory(tool);
    return c === "exec" || c === "files" || tool === "browser_navigate";
}

/** 會改動裝置（或替使用者在網頁上動手）的工具（標籤用強調色）。/ Tools that change things (emphasised badge). */
export function isWriteTool(tool: string): boolean {
    return ["ssh_exec", "sftp_write", "shell_send", "browser_click", "browser_type"].includes(tool);
}

/** 篩選需要的欄位（AiActivityRow 是它的超集）。/ The fields the filters read (AiActivityRow is a superset). */
export interface CallLike {
    tool: string;
    ok: boolean;
    detail: string | null;
    error: string | null;
    target_username: string | null;
    client_name: string | null;
    ip?: string | null;
    user: { username: string | null };
    tunnel: { name: string | null } | null;
}

export interface CallFilter {
    query: string;
    tool: ToolFilter;
    failedOnly: boolean;
    /** 工具名稱的顯示文字（翻譯後的也能搜）。/ Tool display text, so translated names match too. */
    label?: (tool: string) => string;
}

function matchesQuery(c: CallLike, q: string, label?: (tool: string) => string): boolean {
    if (!q) return true;
    const fields = [c.detail, c.error, c.tool, label?.(c.tool), c.target_username, c.client_name, c.ip, c.user.username, c.tunnel?.name];
    return fields.some((f) => !!f && f.toLowerCase().includes(q));
}

export function filterCalls<T extends CallLike>(calls: T[], f: CallFilter): T[] {
    const q = f.query.trim().toLowerCase();
    return calls.filter((c) => (f.tool === "all" || toolCategory(c.tool) === f.tool) && (!f.failedOnly || !c.ok) && matchesQuery(c, q, f.label));
}

export interface CallCounts {
    tools: Record<ToolFilter, number>;
    /** 目前工具分類下失敗的筆數。/ Failed calls within the current tool category. */
    failed: number;
}

/** 分類鈕與「失敗」鈕上的數字：都已套用搜尋；失敗數再套用目前的分類。/ Numbers on the filters, after the search. */
export function countCalls<T extends CallLike>(calls: T[], query: string, tool: ToolFilter, label?: (tool: string) => string): CallCounts {
    const q = query.trim().toLowerCase();
    const tools: Record<ToolFilter, number> = { all: 0, exec: 0, files: 0, browser: 0, session: 0, read: 0 };
    let failed = 0;
    for (const c of calls) {
        if (!matchesQuery(c, q, label)) continue;
        tools.all += 1;
        const cat = toolCategory(c.tool);
        if (cat) tools[cat] += 1;
        if (!c.ok && (tool === "all" || cat === tool)) failed += 1;
    }
    return { tools, failed };
}

/** 125 ms、7.8 s、2m 05s。/ 125 ms, 7.8 s, 2m 05s. */
export function formatDuration(ms: number | null | undefined): string {
    if (ms === null || ms === undefined) return "";
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function formatBytes(n: number | null | undefined): string {
    if (n === null || n === undefined) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
