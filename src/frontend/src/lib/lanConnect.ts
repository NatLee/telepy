/**
 * 區網主機的連線方式（純函式）：ssh config 片段（ProxyJump 經裝置）、免設定的一行指令、主機分類。
 * Pure helpers for reaching a LAN host: the ssh config stanza (ProxyJump through the device), the no-config
 * one-liner and a coarse host kind for the topology view.
 */
import { buildSegments, jumpServerSpec, LOCAL_PRESETS, shq, type ConnectMode, type ConnectTarget, type Segment, type Token } from "@/lib/forwardRecipes";
import type { LanHost, LanScan } from "@/types/lan";

// 主機種類搬到 lib/lanHosts.ts（node 測試得到）；這裡轉出去，舊的 import 照常可用。
// The host kind moved to lib/lanHosts.ts (node-testable); re-exported so existing imports keep working.
export { hasSsh, hostKind, type HostKind } from "@/lib/lanHosts";

/** 廠商名稱去掉公司字尾，放得進小標籤。/ Vendor name without company suffixes, for a small tag. */
export function shortVendor(vendor: string): string {
    const v = vendor
        .replace(/[,.]?\s+(Co\.,?\s*Ltd\.?|Co\.,?\s*Limited|Corporation|Corp\.?|Inc\.?|Incorporated|Ltd\.?|Limited|LLC|GmbH(\s*&\s*Co\.?\s*KG)?|AG|S\.?A\.?|B\.?V\.?|AB|Oy|Pty\.?\s*Ltd\.?|SE|K\.?K\.?)\.?$/i, "")
        .replace(/[,.]\s*$/, "")
        .trim();
    return v.length > 24 ? `${v.slice(0, 23)}…` : v;
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

const NO_OPTIONS = { background: false, keepAlive: false, exitOnFailure: false };

/** 登入這台主機的指令（`ssh -J …`），可選免設定（direct）或用 ssh config 別名（alias）。/ The login command. */
export function lanSshSegments(target: ConnectTarget, h: LanHost, login: string, mode: ConnectMode): Segment[] {
    const params = { lanUser: login || "USER", lanHost: h.address, lanPort: String(h.ssh_port) };
    return buildSegments("jump", params, { ...target, mode }, NO_OPTIONS);
}

/** 把這台主機的某個 port 開到你電腦上（`ssh -N -L 本機:主機:port 裝置`）；不需要它有 SSH。/ Forward one of its ports. */
export function lanForwardSegments(target: ConnectTarget, h: LanHost, port: number, localPort: number, mode: ConnectMode): Segment[] {
    const params = { lanHost: h.address, lanPort: String(port), localPort: String(localPort) };
    return buildSegments("lan", params, { ...target, mode }, NO_OPTIONS);
}

/** 常見服務的名稱（產品 / 協定名，不翻譯）。/ Well-known service names (protocol names, untranslated). */
const SERVICES: Record<number, string> = {
    21: "FTP", 22: "SSH", 23: "Telnet", 53: "DNS", 80: "HTTP", 139: "SMB", 443: "HTTPS", 445: "SMB", 548: "AFP",
    631: "IPP", 1883: "MQTT", 2049: "NFS", 3000: "HTTP", 3306: "MySQL", 3389: "RDP", 5000: "HTTP", 5432: "PostgreSQL",
    5900: "VNC", 6379: "Redis", 8000: "HTTP", 8006: "Proxmox", 8080: "HTTP", 8443: "HTTPS", 8888: "HTTP", 9000: "HTTP",
    9090: "HTTP", 9100: "Printer", 21118: "RustDesk", 27017: "MongoDB", 32400: "Plex",
};
const WEB_HTTPS = new Set([443, 8006, 8443]);
const WEB_HTTP = new Set([80, 3000, 5000, 8000, 8080, 8888, 9000, 9090, 32400]);

export function serviceName(port: number): string | null {
    return SERVICES[port] ?? null;
}

/** 轉發時本機用哪個 port：常見服務照速查表的預設，其他 < 1024 的加 10000（免管理員權限）。/ Local port for a forward. */
export function suggestLocalPort(port: number): number {
    const preset = LOCAL_PRESETS.find((p) => p.remotePort === String(port));
    if (preset) return Number(preset.localPort);
    return port < 1024 ? port + 10000 : port;
}

/** 轉發後在瀏覽器打開的網址（網頁服務才有）。/ The URL to open after forwarding (web services only). */
export function forwardUrl(port: number, localPort: number): string | null {
    if (WEB_HTTPS.has(port)) return `https://localhost:${localPort}`;
    if (WEB_HTTP.has(port)) return `http://localhost:${localPort}`;
    return null;
}

const tok = (text: string, kind: Token["kind"]): Token => ({ text, kind });

/**
 * 經裝置跳板複製檔案到 / 從這台主機（`scp -r -J … [-P port]`）。/ Copy files to or from the host through the device.
 */
export function lanCopySegments(target: ConnectTarget, h: LanHost, login: string, mode: ConnectMode, upload: boolean, localPath: string, remotePath: string): Segment[] {
    const user = login || "USER";
    const lp = localPath.trim() || "./file";
    const rp = remotePath.trim() || "~/";
    const hop: Segment = mode === "alias"
        ? { tokens: [tok("-J", "flag"), tok(target.alias, "value")], explain: { key: "sheet.explain.jumpDevice", vars: { alias: target.alias } } }
        : { tokens: [tok("-J", "flag"), tok(`${jumpServerSpec(target)},${target.username}@localhost:${target.reversePort}`, "value")], explain: { key: "sheet.explain.jumpChain", vars: { user: target.username } } };
    const out: Segment[] = [{ tokens: [tok("scp", "cmd"), tok("-r", "flag")], explain: { key: "sheet.explain.scp" } }, hop];
    if (h.ssh_port !== 22) out.push({ tokens: [tok("-P", "flag"), tok(String(h.ssh_port), "value")], explain: { key: "sheet.explain.lanPort", vars: { port: h.ssh_port } } });
    const local: Segment = { tokens: [tok(shq(lp), "arg")], explain: { key: upload ? "sheet.explain.copyFromLocal" : "sheet.explain.copyToLocal", vars: { path: lp } } };
    const remote: Segment = {
        tokens: [tok(`${shq(user)}@${h.address}:${shq(rp)}`, "target")],
        explain: { key: upload ? "sheet.explain.copyToLanHost" : "sheet.explain.copyFromLanHost", vars: { path: rp, host: h.address } },
    };
    return [...out, ...(upload ? [local, remote] : [remote, local])];
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
