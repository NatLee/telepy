/**
 * 「這台跑什麼系統」（純函式）：顯示的名字、信心的色調、線索排序、說明圖每條線索的狀態、能不能按。
 * 線索與後端 `lan::os` 一致：ping 的 TTL、上次掃描的 HTTP 標頭與 MAC 廠商、SSH 問候、SMB 的 NTLM 資訊、nmap。
 * "Which OS this host runs" (pure): the shown name, the confidence tone, clue order, each clue lane's state in the info
 * diagram, and whether the button may be pressed. The clues match the backend's `lan::os`.
 */
import type { TranslationKey } from "@/locales/en";
import type { LanHost, LanOsCheck, LanOsEvidence } from "@/types/lan";

export const OS_FAMILIES = ["windows", "linux", "macos", "bsd", "network", "unix"] as const;

/** 說明圖的線索，照弱到強。/ The clue lanes, weakest first (as the backend weighs them). */
export const OS_CLUES = ["ttl", "http", "vendor", "ssh", "smb", "nmap"] as const;
export type OsClue = (typeof OS_CLUES)[number];

export function familyKey(family: string | null | undefined): TranslationKey | null {
    return family && (OS_FAMILIES as readonly string[]).includes(family) ? (`network.os.family.${family}` as TranslationKey) : null;
}

export type OsTone = "success" | "warning" | "muted";

export function confidenceTone(c: LanOsCheck["confidence"]): OsTone {
    return c === "high" ? "success" : c === "medium" ? "warning" : "muted";
}

/** 重的線索在前（同重照原順序）；說明用的（weight 0）排最後。/ Heavier clues first; notes (weight 0) last. */
export function sortedEvidence(check: LanOsCheck): LanOsEvidence[] {
    return check.evidence.map((e, i) => ({ e, i })).sort((a, b) => b.e.weight - a.e.weight || a.i - b.i).map((x) => x.e);
}

/** 只能檢查私有 IPv4（跟後端一樣）。/ Only private IPv4 hosts (as the backend). */
export function privateIpv4(address: string): boolean {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if ([m[1], m[2], m[3], m[4]].some((x) => Number(x) > 255)) return false;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** 一條線索的句子：翻譯 key + 變數（沒有 data = null，用後端的英文 `text`）。/ A clue as a translatable sentence. */
export function evidenceSentence(e: LanOsEvidence): { key: TranslationKey; vars: Record<string, string | number> } | null {
    const d = e.data;
    if (!d) return null;
    const str = (k: string) => (d[k] === null || d[k] === undefined ? "" : String(d[k]));
    switch (e.source) {
        case "ttl": {
            const start = Number(d.start);
            const what: TranslationKey = start === 128 ? "network.os.family.windows" : start === 255 ? "network.os.family.network" : "network.os.family.unix";
            return { key: "network.os.ev.ttl", vars: { ttl: str("ttl"), start: str("start"), hops: str("hops"), what } };
        }
        case "ssh":
            return { key: d.tagged ? "network.os.ev.ssh" : "network.os.ev.sshPlain", vars: { line: str("line") } };
        case "http":
            return { key: "network.os.ev.http", vars: { port: str("port"), server: str("server") } };
        case "vendor":
            return { key: "network.os.ev.vendor", vars: { vendor: str("vendor") } };
        case "nmap":
            return { key: "network.os.ev.nmap", vars: { line: str("line") } };
        case "smb": {
            const base = d.samba ? "network.os.ev.smbSamba" : "network.os.ev.smb";
            const who = str("computer") && str("domain") ? "Both" : str("computer") ? "Named" : str("domain") ? "In" : "";
            return { key: `${base}${who}` as TranslationKey, vars: { port: str("port"), version: `${str("major")}.${str("minor")}`, build: str("build"), name: str("computer"), domain: str("domain") } };
        }
        default:
            return null;
    }
}

export type OsBlock = "address" | "permission" | "offline" | "own" | null;

/** 為什麼不能按（null = 可以）。/ Why the button is off (null = it isn't). */
export function osBlock(host: Pick<LanHost, "address" | "own" | "source">, canScan: boolean, online: boolean): OsBlock {
    if (host.own || host.source === "self") return "own";
    if (!privateIpv4(host.address)) return "address";
    if (!canScan) return "permission";
    if (!online) return "offline";
    return null;
}

/** 說明圖上一條線索：用上了 / 只是說明 / 問了沒結果 / 這台用不上 / 還沒問。/ One clue lane's state. */
export type ClueState = "used" | "note" | "nothing" | "skipped" | "unknown";

/**
 * 每條線索的狀態。沒檢查過 = 全部 unknown（但 http / vendor 看掃描資料就知道有沒有）；SMB 沒開 445 = skipped；
 * nmap 照後端說的（absent / unprivileged = skipped，windows 裝置 = skipped）。
 * Each lane's state. Not checked = unknown (http / vendor follow the scan data); SMB without 445 = skipped; nmap per the backend.
 */
export function clueStates(host: Pick<LanHost, "open_ports" | "services" | "vendor" | "os_check">): Record<OsClue, ClueState> {
    const check = host.os_check ?? null;
    const out = {} as Record<OsClue, ClueState>;
    for (const c of OS_CLUES) {
        const ev = check?.evidence.filter((e) => e.source === c) ?? [];
        if (ev.some((e) => e.weight > 0)) out[c] = "used";
        else if (ev.length > 0) out[c] = "note";
        else if (!check) out[c] = "unknown";
        else out[c] = "nothing";
    }
    // 網頁伺服器與網路卡看的是上次掃描：有資料但說不出系統 = 讀到了；沒資料 = 這台用不上。
    // The web server and network card come from the last scan: data that names no OS = read; no data = not for it.
    for (const c of ["http", "vendor"] as const) {
        if (out[c] === "used" || out[c] === "note") continue;
        const has = c === "http" ? (host.services ?? []).some((s) => s.server) : !!host.vendor;
        out[c] = !has ? "skipped" : check ? "note" : "unknown";
    }
    if (out.smb !== "used" && out.smb !== "note" && !(host.open_ports ?? []).includes(445)) out.smb = "skipped";
    if (check && out.nmap === "nothing" && check.nmap !== "ran") out.nmap = "skipped";
    return out;
}
