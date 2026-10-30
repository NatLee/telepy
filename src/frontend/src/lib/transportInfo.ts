/**
 * 「連到 Telepy 的方式」說明的純函式：你的電腦 → Telepy（這裡選的）與裝置 → Telepy（建立通道時選的）是兩條各自的連線，
 * 在 Telepy 會合。這裡算裝置那一側的狀態（一台或多台）與兩條連線的對照表。不碰 React。
 * Pure helpers for the "how you reach Telepy" explainer: your computer → Telepy (chosen here) and device → Telepy
 * (chosen when the tunnel was created) are two separate connections that meet at Telepy. This works out the device
 * side's state (one device or many) and the comparison table. No React.
 */
import type { SpotState } from "./flow.ts";
import type { TranslationKey } from "../locales/en.ts";

/** 你的電腦到 Telepy 的方式（auto = SSH port 優先，不通走網頁 port）。/ How your computer reaches Telepy (auto = the SSH port first). */
export type LaptopTransport = "ssh" | "auto" | "websocket";

/** gateway 看到的裝置連線方式（連著時才有）。/ How the device's tunnel reached the gateway (only while connected). */
export type DeviceTransport = "tcp" | "websocket" | null | undefined;

export interface DeviceSide {
    online: boolean | null;
    transport: DeviceTransport;
}

export interface DeviceCounts {
    ssh: number;
    web: number;
    /** 在線，但看不到走哪種（沒有權限看連線來源）。/ Online but the transport isn't visible to you. */
    unknown: number;
    offline: number;
}

export function deviceCounts(devices: DeviceSide[]): DeviceCounts {
    const out: DeviceCounts = { ssh: 0, web: 0, unknown: 0, offline: 0 };
    for (const d of devices) {
        if (d.online === false || (d.online === null && !d.transport)) out.offline += 1;
        else if (d.transport === "tcp") out.ssh += 1;
        else if (d.transport === "websocket") out.web += 1;
        else out.unknown += 1;
    }
    return out;
}

/** 圖上「裝置的通道」那段線：有任何一台連著 = 通了，否則待命。/ The device link: up when any device is connected. */
export function deviceLinkState(c: DeviceCounts): SpotState {
    return c.ssh + c.web + c.unknown > 0 ? "ok" : "waiting";
}

/**
 * 裝置那段線的文字：一台時說它走哪種，多台時列出各有幾台（零的不列）。回傳 [key, vars] 的清單。
 * The device link's text: which way one device came in, or how many came in each way (zero counts left out).
 */
export function deviceLinkText(c: DeviceCounts): { key: TranslationKey; count: number }[] {
    const total = c.ssh + c.web + c.unknown + c.offline;
    if (total === 1) {
        const key: TranslationKey = c.ssh ? "config.ti.devSsh" : c.web ? "config.ti.devWeb" : c.unknown ? "config.ti.devOnline" : "config.ti.devOffline";
        return [{ key, count: 1 }];
    }
    const parts: { key: TranslationKey; count: number }[] = [
        { key: "config.ti.devManySsh", count: c.ssh },
        { key: "config.ti.devManyWeb", count: c.web },
        { key: "config.ti.devManyOnline", count: c.unknown },
        { key: "config.ti.devManyOffline", count: c.offline },
    ];
    return parts.filter((p) => p.count > 0);
}

/** 你的電腦連到哪裡（圖上與卡片上顯示的位址）。/ Where your computer connects (shown on the diagram and the cards). */
export function laptopAddress(choice: LaptopTransport, server: { host: string; port: string } | null, wsUrl: string | null): string {
    if (choice === "websocket") return wsUrl || "wss://…/ws/gateway/";
    const direct = !server ? "…" : server.port ? `${server.host}:${server.port}` : server.host;
    // 自動：先 SSH 的 port，不通才網頁的 port。/ Automatic: the SSH port, else the web port.
    return choice === "auto" ? `${direct} | ${wsUrl || "wss://…/ws/gateway/"}` : direct;
}

/** 兩條連線的對照表：①（你的，這裡設定）vs ②（裝置的通道，建立通道時設定）。/ Your connection vs the device's tunnel. */
export const COMPARE_ROWS: { label: TranslationKey; mine: TranslationKey; device: TranslationKey }[] = [
    { label: "config.ti.rowWho", mine: "config.ti.rowWhoMine", device: "config.ti.rowWhoDevice" },
    { label: "config.ti.rowKey", mine: "config.ti.rowKeyMine", device: "config.ti.rowKeyDevice" },
    { label: "config.ti.rowDoes", mine: "config.ti.rowDoesMine", device: "config.ti.rowDoesDevice" },
    { label: "config.ti.rowWhen", mine: "config.ti.rowWhenMine", device: "config.ti.rowWhenDevice" },
    { label: "config.ti.rowPort", mine: "config.ti.rowPortMine", device: "config.ti.rowPortDevice" },
    { label: "config.ti.rowWhere", mine: "config.ti.rowWhereMine", device: "config.ti.rowWhereDevice" },
];
