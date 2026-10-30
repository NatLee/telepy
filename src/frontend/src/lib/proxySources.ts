/**
 * 「PROXY protocol 來源」的選項（`GET /api/site/address-sources`）：gateway 從啟動以來看到的來源位址、送過 PROXY
 * header 的次數、現在是不是來源，加上預設清單；以及編輯那串「IP / CIDR，逗號或空白分隔」的小工具。純函式，有測試。
 * Options for "PROXY protocol sources" (`GET /api/site/address-sources`): the addresses the gateway has seen since
 * it started, how often each sent a PROXY header, whether it is a source now, the presets; and helpers to edit the
 * comma / space separated IP / CIDR list. Pure, tested.
 */

/** 後端的長度上限。/ The backend's length limit. */
export const SOURCES_MAX = 512;

export interface GatewayPeer {
    ip: string;
    scope: string;
    connections: number;
    proxyHeaders: number;
    firstAt: string;
    lastAt: string;
    lastHeaderAt: string | null;
    listed: boolean;
}

export type PresetId = "loopback" | "private" | "cloudflare";

export interface SourcesPreset {
    id: PresetId;
    cidrs: string[];
}

export interface AddressSources {
    since: string;
    peers: GatewayPeer[];
    otherPublic: number;
    presets: SourcesPreset[];
}

const PRESET_IDS: PresetId[] = ["loopback", "private", "cloudflare"];
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** 後端 JSON → 型別；形狀不對回 null。/ Backend JSON → typed; null when the shape is wrong. */
export function parseAddressSources(raw: unknown): AddressSources | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (!Array.isArray(r.peers)) return null;
    const peers = r.peers.flatMap((p): GatewayPeer[] => {
        const o = (p ?? {}) as Record<string, unknown>;
        const ip = str(o.ip);
        if (!ip) return [];
        return [{
            ip,
            scope: str(o.scope) || "reserved",
            connections: num(o.connections),
            proxyHeaders: num(o.proxy_headers),
            firstAt: str(o.first_at),
            lastAt: str(o.last_at),
            lastHeaderAt: typeof o.last_header_at === "string" ? o.last_header_at : null,
            listed: o.listed === true,
        }];
    });
    const presets = (Array.isArray(r.presets) ? r.presets : []).flatMap((p): SourcesPreset[] => {
        const o = (p ?? {}) as Record<string, unknown>;
        const id = PRESET_IDS.find((x) => x === o.id);
        const cidrs = Array.isArray(o.cidrs) ? o.cidrs.filter((c): c is string => typeof c === "string" && !!c) : [];
        return id && cidrs.length ? [{ id, cidrs }] : [];
    });
    return { since: str(r.since), peers, otherPublic: num(r.other_public), presets };
}

/** 清單裡的每一項（逗號或空白分隔）。/ The list's items (comma or space separated). */
export function splitSources(spec: string): string[] {
    return spec.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

const norm = (s: string) => s.trim().toLowerCase();

/** 已經在清單裡（字面相同，不算 CIDR 涵蓋）。/ Already in the list (literally; CIDR coverage is the server's job). */
export function hasSource(spec: string, item: string): boolean {
    return splitSources(spec).some((s) => norm(s) === norm(item));
}

/** 加進清單，重複的略過；回傳存檔用的寫法。/ Append, skipping duplicates; returns the form to save. */
export function addSources(spec: string, items: readonly string[]): string {
    const out = splitSources(spec);
    for (const item of items.flatMap(splitSources)) if (!out.some((s) => norm(s) === norm(item))) out.push(item);
    return out.join(", ");
}

export function removeSource(spec: string, item: string): string {
    return splitSources(spec).filter((s) => norm(s) !== norm(item)).join(", ");
}

/** 預設的每一項都已經在清單裡。/ Every item of a preset is already listed. */
export const presetAdded = (spec: string, preset: SourcesPreset) => preset.cidrs.every((c) => hasSource(spec, c));

export const fitsLimit = (spec: string) => spec.length <= SOURCES_MAX;

/**
 * 對這個位址的建議：
 * - `add`：送了 PROXY header 但不是來源 → header 沒被讀，它後面的裝置都顯示成它；是你的代理就加進來。
 * - `trusted`：是來源，header 有在讀。
 * - `idle`：是來源，但啟動以來沒送過 header（代理還沒開 PROXY protocol？還是列錯了？）。
 * - `internal`：內部位址、沒送 header：可能是 Docker 的連接埠轉發或沒開 PROXY protocol 的代理；它送 header 之前加了也沒用。
 * The advice for one address: `add` = it sent PROXY headers but is not a source (they were ignored and its devices
 * show this address); `trusted` = a source whose headers are read; `idle` = a source with no header since start;
 * `internal` = an internal address without headers (Docker port publishing, or a proxy without PROXY protocol).
 */
export type PeerAdvice = "add" | "trusted" | "idle" | "internal";

export function peerAdvice(p: GatewayPeer): PeerAdvice {
    if (p.proxyHeaders > 0) return p.listed ? "trusted" : "add";
    return p.listed ? "idle" : "internal";
}

const ADVICE_ORDER: PeerAdvice[] = ["add", "trusted", "idle", "internal"];

/** 要處理的在前，再依連線數。/ What needs action first, then by connections. */
export function sortPeers(peers: readonly GatewayPeer[]): GatewayPeer[] {
    return [...peers].sort((a, b) => ADVICE_ORDER.indexOf(peerAdvice(a)) - ADVICE_ORDER.indexOf(peerAdvice(b)) || b.connections - a.connections || a.ip.localeCompare(b.ip));
}
