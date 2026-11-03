/**
 * IP 地圖（純函式）：把一台裝置掃過的網段切成一塊塊 /24（每塊 16 × 16 格，一格一個位址），算出每一格是什麼——網段外、
 * 網路位址、廣播位址、裝置自己、閘道、已知的主機、這次沒看到的主機、空著的——以及每塊的統計與方向鍵怎麼移。沒有掃描紀錄
 * 時，從主機的位址推出它們所在的 /24。
 * The IP map (pure): a device's scanned networks cut into /24 blocks (16 × 16 cells, one per address), what each cell
 * is — outside the network, network address, broadcast, the device itself, the gateway, a known host, a host not seen
 * this time, free — plus each block's counts and how the arrow keys move. Without a scan record the /24s come from the
 * hosts' addresses.
 */

export const COLS = 16;
export const CELLS = 256;
/** 最多畫幾塊 /24（/22 = 4 塊，再多就太長了）。/ At most this many /24 blocks. */
export const MAX_BLOCKS = 8;

export function ipToInt(ip: string): number | null {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
    if (!m) return null;
    const parts = m.slice(1).map(Number);
    if (parts.some((p) => p > 255)) return null;
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function intToIp(n: number): string {
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function parseCidr(cidr: string): { base: number; prefix: number } | null {
    const [ip, p] = cidr.trim().split("/");
    const addr = ipToInt(ip ?? "");
    const prefix = p === undefined ? 32 : Number(p);
    if (addr === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return { base: (addr & mask) >>> 0, prefix };
}

export interface MapBlock {
    /** 這塊 /24 的起點（.0）。/ The /24's first address (.0). */
    base: number;
    /** 這塊裡屬於掃描網段的那一段（0–255，含頭尾）。/ The part inside a scanned network (0–255, inclusive). */
    from: number;
    to: number;
    /** 畫在標題上的網段。/ The network shown in the heading. */
    label: string;
    /** 從主機位址推出來的（沒有掃描紀錄）。/ Derived from host addresses (no scan record). */
    derived: boolean;
    /** 掃描網段的網路位址與廣播位址（/31、/32 沒有）。/ The scanned network's network and broadcast addresses. */
    edges: number[];
}

/**
 * 要畫的 /24：掃描記下的網段（大於 /24 的切開，小於 /24 的只畫它那一段）；沒有就用主機位址所在的 /24。同一塊合併，
 * 依位址排序，最多 `MAX_BLOCKS` 塊。
 * The /24s to draw: the scanned networks (bigger ones split, smaller ones only their part); without any, the /24s of
 * the hosts' addresses. Merged per block, sorted, at most `MAX_BLOCKS`.
 */
export function mapBlocks(networks: string[], hostIps: string[]): MapBlock[] {
    const byBase = new Map<number, MapBlock>();
    const add = (base: number, from: number, to: number, label: string, derived: boolean, edges: number[]) => {
        const b = byBase.get(base);
        if (b) {
            b.from = Math.min(b.from, from);
            b.to = Math.max(b.to, to);
            b.edges.push(...edges);
        } else byBase.set(base, { base, from, to, label, derived, edges: [...edges] });
    };
    for (const c of networks) {
        const n = parseCidr(c);
        if (!n) continue;
        const size = 2 ** (32 - n.prefix);
        const last = n.base + size - 1;
        const edges = n.prefix <= 30 ? [n.base, last] : [];
        for (let start = n.base; start <= last && byBase.size < MAX_BLOCKS; start += 256) {
            const base = (start & 0xffffff00) >>> 0;
            const end = Math.min(last, base + 255);
            add(base, start - base, end - base, n.prefix >= 24 ? c : `${intToIp(base)}/24`, false, edges.filter((e) => e >= base && e <= base + 255));
        }
    }
    if (byBase.size === 0) {
        for (const ip of hostIps) {
            const n = ipToInt(ip);
            if (n === null || byBase.size >= MAX_BLOCKS) continue;
            const base = (n & 0xffffff00) >>> 0;
            if (!byBase.has(base)) add(base, 0, 255, `${intToIp(base)}/24`, true, []);
        }
    }
    return [...byBase.values()].sort((a, b) => a.base - b.base).slice(0, MAX_BLOCKS);
}

export type CellKind = "outside" | "edge" | "device" | "gateway" | "host" | "missing" | "free";

type HostLike = { address: string; gateway?: boolean; missing?: boolean; own?: boolean; source?: string };

/** 一格是什麼。/ What a cell is. */
export function cellKind<H extends HostLike>(block: MapBlock, offset: number, hosts: Map<number, H>, deviceIps: Set<number>): CellKind {
    if (offset < block.from || offset > block.to) return "outside";
    const ip = block.base + offset;
    if (deviceIps.has(ip)) return "device";
    const h = hosts.get(ip);
    if (h) return h.gateway ? "gateway" : h.missing ? "missing" : "host";
    if (block.edges.includes(ip)) return "edge";
    return "free";
}

/** 位址 → 主機（只有 IPv4，裝置自己那一列不算）。/ Address → host (IPv4 only, the device's own row excluded). */
export function hostsByIp<H extends HostLike>(hosts: H[]): Map<number, H> {
    const out = new Map<number, H>();
    for (const h of hosts) {
        if (h.own || h.source === "self") continue;
        const n = ipToInt(h.address);
        if (n !== null) out.set(n, h);
    }
    return out;
}

export type BlockCounts = Record<"used" | "gateway" | "missing" | "device" | "free", number>;

export function blockCounts<H extends HostLike>(block: MapBlock, hosts: Map<number, H>, deviceIps: Set<number>): BlockCounts {
    const out: BlockCounts = { used: 0, gateway: 0, missing: 0, device: 0, free: 0 };
    for (let i = 0; i < CELLS; i++) {
        const k = cellKind(block, i, hosts, deviceIps);
        if (k === "host" || k === "gateway" || k === "missing") out.used++;
        if (k === "gateway") out.gateway++;
        if (k === "missing") out.missing++;
        if (k === "device") out.device++;
        if (k === "free") out.free++;
    }
    return out;
}

/**
 * 方向鍵在格子裡移動（↑↓ 一列 `cols` 格：寬的時候 16、手機上 8；Home / End 到這一列頭尾），跳過網段外的格子；出界就停在原地。
 * Arrow keys in the grid (↑↓ a row of `cols`: 16 when wide, 8 on phones; Home / End to the row's ends), skipping cells
 * outside the network; stays put at an edge.
 */
export function gridStep(index: number, key: string, inside: (i: number) => boolean, cols = COLS): number {
    const row = Math.floor(index / cols);
    const delta: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
    if (key === "Home" || key === "End") {
        const cells = Array.from({ length: cols }, (_, c) => row * cols + c).filter(inside);
        return cells.length ? (key === "Home" ? cells[0] : cells[cells.length - 1]) : index;
    }
    const d = delta[key];
    if (!d) return index;
    for (let i = index + d; i >= 0 && i < CELLS; i += d) {
        if (Math.abs(d) === 1 && Math.floor(i / cols) !== row) return index;
        if (inside(i)) return i;
    }
    return index;
}
