/**
 * 連線紀錄的一列要顯示哪個位址：gateway 看到的是公網位址就是它；看到的是內部位址（埠轉發、Docker、代理把來源換掉了）時，
 * 用裝置在那次連線自己回報的公網 IP，旁邊註明 gateway 看到什麼；兩個都沒有就標成內部位址。純函式。
 * Which address a connection-history row shows: the gateway's peer when it is public; behind an internal peer (a port
 * forward, Docker or a proxy replaced the source) the public IP the device reported during that connection, noting
 * what the gateway saw; neither = marked as an internal address. Pure.
 */
import { isNonPublic, type IpGeo } from "./geo.ts";

export interface SessionAddress {
    ip: string | null;
    geo?: IpGeo | null;
    public_ip?: string | null;
    public_source?: string | null;
    public_geo?: IpGeo | null;
}

export type ConnectionAddress =
    /** gateway 看到的就是公網位址（或舊後端沒給範圍）。/ The gateway's peer is public (or an older backend gave no scope). */
    | { kind: "direct"; ip: string; geo: IpGeo | null }
    /** 裝置回報的公網 IP；`saw` = gateway 看到的內部位址。/ The device-reported public IP; `saw` = the internal peer. */
    | { kind: "reported"; ip: string; geo: IpGeo | null; saw: string; source: string | null }
    /** 只有內部位址。/ Only an internal address. */
    | { kind: "internal"; saw: string }
    /** 看不到 IP（沒有權限）。/ No IP for this viewer. */
    | { kind: "hidden" };

export function connectionAddress(s: SessionAddress): ConnectionAddress {
    if (!s.ip) return { kind: "hidden" };
    if (!isNonPublic(s.geo)) return { kind: "direct", ip: s.ip, geo: s.geo ?? null };
    if (s.public_ip) return { kind: "reported", ip: s.public_ip, geo: s.public_geo ?? null, saw: s.ip, source: s.public_source ?? null };
    return { kind: "internal", saw: s.ip };
}

/** 這些連線裡有沒有 gateway 只看到內部位址的（要不要放「為什麼」的說明）。/ Whether any row had an internal peer. */
export function anyInternal(rows: SessionAddress[]): boolean {
    return rows.some((s) => {
        const a = connectionAddress(s);
        return a.kind === "reported" || a.kind === "internal";
    });
}

/** 說明圖要放的例子：最近一次內部位址的連線。/ The example for the diagram: the latest row with an internal peer. */
export function internalExample(rows: SessionAddress[]): { saw: string; reported: string | null } | null {
    for (const s of rows) {
        const a = connectionAddress(s);
        if (a.kind === "reported") return { saw: a.saw, reported: a.ip };
        if (a.kind === "internal") return { saw: a.saw, reported: null };
    }
    return null;
}
