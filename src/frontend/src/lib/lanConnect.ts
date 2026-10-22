/**
 * 區網主機的連線方式（純函式）：ssh config 片段（ProxyJump 經裝置）、免設定的一行指令、主機分類。
 * Pure helpers for reaching a LAN host: the ssh config stanza (ProxyJump through the device), the no-config
 * one-liner and a coarse host kind for the topology view.
 */
import { buildSegments, segmentsToString, type ConnectTarget } from "@/lib/forwardRecipes";
import type { LanHost, LanScan } from "@/types/lan";

/** 這台主機的 SSH port 有沒有在最後一次掃描時開著（或看到 SSH banner）。/ SSH seen on this host. */
export function hasSsh(h: LanHost): boolean {
    return h.open_ports.includes(h.ssh_port) || !!h.ssh_banner;
}

export type HostKind = "ssh" | "desktop" | "files" | "web" | "other";

/** 依開著的 port 粗分（決定圖示）。/ Coarse kind from the open ports (picks the icon). */
export function hostKind(h: LanHost): HostKind {
    const p = new Set(h.open_ports);
    if (hasSsh(h)) return "ssh";
    if (p.has(3389) || p.has(5900)) return "desktop";
    if (p.has(445) || p.has(139) || p.has(548) || p.has(2049)) return "files";
    if (p.has(80) || p.has(443) || p.has(8080) || p.has(8443)) return "web";
    return "other";
}

/** 顯示名稱：標籤 > 主機名稱 > 位址。/ Display name: label, then hostname, then address. */
export function hostName(h: LanHost): string {
    return h.label || h.hostname || h.address;
}

function slug(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "host";
}

/** `~/.ssh/config` 裡這台主機的別名：`<裝置別名>-<名稱>`。/ The host's alias: `<device alias>-<name>`. */
export function lanAlias(deviceAlias: string, h: LanHost): string {
    return `${deviceAlias}-${slug(h.label || h.hostname || h.address.replace(/\./g, "-"))}`;
}

/** 接在 Telepy 產生的裝置區塊後面的 Host 區塊（ProxyJump = 裝置別名）。/ Stanza that jumps through the device alias. */
export function lanSshConfig(deviceAlias: string, h: LanHost, login: string): string {
    const lines = [`Host ${lanAlias(deviceAlias, h)}`, `    HostName ${h.address}`];
    if (h.ssh_port !== 22) lines.push(`    Port ${h.ssh_port}`);
    if (login) lines.push(`    User ${login}`);
    lines.push(`    ProxyJump ${deviceAlias}`);
    return lines.join("\n");
}

/** 不用任何 ssh config 的一行指令：`ssh -J telepy@伺服器,帳號@localhost:<反向埠> 使用者@主機`。/ The no-config one-liner. */
export function lanOneLiner(target: ConnectTarget, h: LanHost, login: string): string {
    const params = { lanUser: login || "USER", lanHost: h.address, lanPort: String(h.ssh_port) };
    const opts = { background: false, keepAlive: false, exitOnFailure: false };
    return segmentsToString(buildSegments("jump", params, { ...target, mode: "direct" }, opts));
}

/** 指令速查頁「跳到區網主機」並帶入這台主機。/ Command sheet deep link with the jump recipe prefilled. */
export function cheatsheetJumpUrl(tunnelId: number, h: LanHost, login: string): string {
    const q = new URLSearchParams({ tunnel: String(tunnelId), recipe: "jump", lanHost: h.address, lanPort: String(h.ssh_port) });
    if (login) q.set("lanUser", login);
    return `/tunnels/cheatsheet?${q.toString()}`;
}

export function scanRunning(s: LanScan | null | undefined): boolean {
    return !!s && s.phase !== "done" && s.phase !== "failed";
}

/** 進度百分比（0–100；還不知道總數時回 null）。/ Progress percentage, null while the total is unknown. */
export function scanPercent(s: LanScan): number | null {
    if (s.phase === "done") return 100;
    if (!s.total) return null;
    return Math.min(100, Math.round((s.probed / s.total) * 100));
}

/** 「22, 80 443」→ [22, 80, 443]；有非法值回 null。/ Parse a port list; null when any entry is invalid. */
export function parsePortList(text: string): number[] | null {
    const parts = text.split(/[\s,]+/).filter(Boolean);
    const out: number[] = [];
    for (const p of parts) {
        if (!/^\d{1,5}$/.test(p)) return null;
        const n = Number(p);
        if (n < 1 || n > 65535) return null;
        if (!out.includes(n)) out.push(n);
    }
    return out;
}

/** 與後端 `ssh::process::valid_login` 相同的規則。/ Same rule as the backend's `valid_login`. */
export function isValidLogin(value: string): boolean {
    return /^[A-Za-z0-9._-]{1,64}$/.test(value) && !value.startsWith("-");
}
