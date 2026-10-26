/**
 * 遠端桌面的三種連法（純資料＋純函式，無 React），給「比較連線方式」對話框用：
 * - guacd：RDP / VNC 經 Telepy 隧道，Telepy（guacd）把畫面轉成圖片
 * - rustdeskTunnel：RustDesk 經 Telepy 隧道（Direct IP），瀏覽器裡的 RustDesk 引擎解碼影像
 * - rustdeskServer：Telepy 當 RustDesk 伺服器，沒有隧道，端對端加密
 * 路徑圖的欄位對齊（你的瀏覽器 ─ Telepy ─ 裝置 ─ 桌面），三列上下對照；每列下面是「誰加密哪一段」的標尺。
 * The three ways to reach a desktop, as data for the comparison dialog: aligned path rows (browser ─ Telepy ─
 * device ─ desktop) with an encryption ruler under each, plus the fact rows of the comparison table.
 */
import type { TranslationKey } from "@/locales/en";

export type WayId = "guacd" | "rustdeskTunnel" | "rustdeskServer";
export const WAY_IDS: readonly WayId[] = ["guacd", "rustdeskTunnel", "rustdeskServer"];

export type NodeIcon = "browser" | "telepy" | "device" | "desktop";
/** 路徑上的一個點。`col` = 0..3（瀏覽器、Telepy、裝置、桌面），三列對齊用。/ A node; `col` aligns the rows. */
export interface WayNode {
    col: 0 | 1 | 2 | 3;
    icon: NodeIcon;
    label: TranslationKey;
    sub: TranslationKey;
    /** 畫面在這裡被畫出來。/ The picture is drawn here. */
    draws?: boolean;
}
export type LinkKind = "wss" | "tunnel" | "dialOut" | "local";
/** 兩點之間的線：`from` 欄到下一個點。/ The link from a column to the next node. */
export interface WayLink {
    from: 0 | 1 | 2;
    to: 1 | 2 | 3;
    kind: LinkKind;
    label: TranslationKey;
}
export type LayerTone = "e2e" | "transport" | "plain";
/** 加密標尺的一段：`from`..`to` 欄（含）。/ One span of the encryption ruler, columns inclusive. */
export interface WayLayer {
    from: 0 | 1 | 2;
    to: 1 | 2 | 3;
    tone: LayerTone;
    label: TranslationKey;
}
export interface Way {
    id: WayId;
    title: TranslationKey;
    when: TranslationKey;
    nodes: WayNode[];
    links: WayLink[];
    layers: WayLayer[];
}

export const WAYS: readonly Way[] = [
    {
        id: "guacd",
        title: "desktop.ways.guacd.title",
        when: "desktop.ways.guacd.when",
        nodes: [
            { col: 0, icon: "browser", label: "desktop.ways.node.browser", sub: "desktop.ways.node.browserImages" },
            { col: 1, icon: "telepy", label: "desktop.ways.node.telepy", sub: "desktop.ways.node.telepyGuacd", draws: true },
            { col: 2, icon: "device", label: "desktop.ways.node.device", sub: "desktop.ways.node.deviceSshd" },
            { col: 3, icon: "desktop", label: "desktop.ways.node.desktop", sub: "desktop.ways.node.desktopRdpVnc" },
        ],
        links: [
            { from: 0, to: 1, kind: "wss", label: "desktop.ways.link.wss" },
            { from: 1, to: 2, kind: "tunnel", label: "desktop.ways.link.tunnel" },
            { from: 2, to: 3, kind: "local", label: "desktop.ways.link.rdpVnc" },
        ],
        layers: [
            { from: 0, to: 1, tone: "transport", label: "desktop.ways.layer.tls" },
            { from: 1, to: 2, tone: "transport", label: "desktop.ways.layer.ssh" },
            { from: 2, to: 3, tone: "plain", label: "desktop.ways.layer.protocolOwn" },
        ],
    },
    {
        id: "rustdeskTunnel",
        title: "desktop.ways.rustdeskTunnel.title",
        when: "desktop.ways.rustdeskTunnel.when",
        nodes: [
            { col: 0, icon: "browser", label: "desktop.ways.node.browser", sub: "desktop.ways.node.browserEngine", draws: true },
            { col: 1, icon: "telepy", label: "desktop.ways.node.telepy", sub: "desktop.ways.node.telepyRelay" },
            { col: 2, icon: "device", label: "desktop.ways.node.device", sub: "desktop.ways.node.deviceSshd" },
            { col: 3, icon: "desktop", label: "desktop.ways.node.rustdesk", sub: "desktop.ways.node.rustdeskDirectIp" },
        ],
        links: [
            { from: 0, to: 1, kind: "wss", label: "desktop.ways.link.wss" },
            { from: 1, to: 2, kind: "tunnel", label: "desktop.ways.link.tunnel" },
            { from: 2, to: 3, kind: "local", label: "desktop.ways.link.directIp" },
        ],
        layers: [
            { from: 0, to: 1, tone: "transport", label: "desktop.ways.layer.tls" },
            { from: 1, to: 2, tone: "transport", label: "desktop.ways.layer.ssh" },
            { from: 2, to: 3, tone: "plain", label: "desktop.ways.layer.directIp" },
        ],
    },
    {
        id: "rustdeskServer",
        title: "desktop.ways.rustdeskServer.title",
        when: "desktop.ways.rustdeskServer.when",
        nodes: [
            { col: 0, icon: "browser", label: "desktop.ways.node.browser", sub: "desktop.ways.node.browserEngine", draws: true },
            { col: 1, icon: "telepy", label: "desktop.ways.node.telepy", sub: "desktop.ways.node.telepyServer" },
            { col: 3, icon: "desktop", label: "desktop.ways.node.computer", sub: "desktop.ways.node.computerRustDesk" },
        ],
        links: [
            { from: 0, to: 1, kind: "wss", label: "desktop.ways.link.wss" },
            { from: 1, to: 3, kind: "dialOut", label: "desktop.ways.link.dialOut" },
        ],
        layers: [{ from: 0, to: 3, tone: "e2e", label: "desktop.ways.layer.e2e" }],
    },
];

export type CellTone = "good" | "bad" | "neutral";
export interface WayRow {
    label: TranslationKey;
    cells: Record<WayId, { text: TranslationKey; tone: CellTone }>;
}

/** 比較表（順序 = 顯示順序）。/ The comparison table, in display order. */
export const ROWS: readonly WayRow[] = [
    {
        label: "desktop.ways.row.tunnel",
        cells: {
            guacd: { text: "desktop.ways.cell.tunnelYes", tone: "neutral" },
            rustdeskTunnel: { text: "desktop.ways.cell.tunnelYes", tone: "neutral" },
            rustdeskServer: { text: "desktop.ways.cell.tunnelNo", tone: "good" },
        },
    },
    {
        label: "desktop.ways.row.target",
        cells: {
            guacd: { text: "desktop.ways.cell.targetRdpVnc", tone: "neutral" },
            rustdeskTunnel: { text: "desktop.ways.cell.targetDirectIp", tone: "neutral" },
            rustdeskServer: { text: "desktop.ways.cell.targetEnrolled", tone: "neutral" },
        },
    },
    {
        label: "desktop.ways.row.picture",
        cells: {
            guacd: { text: "desktop.ways.cell.pictureImages", tone: "neutral" },
            rustdeskTunnel: { text: "desktop.ways.cell.pictureVideo", tone: "good" },
            rustdeskServer: { text: "desktop.ways.cell.pictureVideo", tone: "good" },
        },
    },
    {
        label: "desktop.ways.row.motion",
        cells: {
            guacd: { text: "desktop.ways.cell.motionSlow", tone: "bad" },
            rustdeskTunnel: { text: "desktop.ways.cell.motionSmooth", tone: "good" },
            rustdeskServer: { text: "desktop.ways.cell.motionSmooth", tone: "good" },
        },
    },
    {
        label: "desktop.ways.row.encryption",
        cells: {
            guacd: { text: "desktop.ways.cell.encTransport", tone: "neutral" },
            rustdeskTunnel: { text: "desktop.ways.cell.encTransport", tone: "neutral" },
            rustdeskServer: { text: "desktop.ways.cell.encE2e", tone: "good" },
        },
    },
    {
        label: "desktop.ways.row.telepySees",
        cells: {
            guacd: { text: "desktop.ways.cell.seesDraws", tone: "bad" },
            rustdeskTunnel: { text: "desktop.ways.cell.seesCould", tone: "neutral" },
            rustdeskServer: { text: "desktop.ways.cell.seesNo", tone: "good" },
        },
    },
    {
        label: "desktop.ways.row.lan",
        cells: {
            guacd: { text: "desktop.ways.cell.lanYes", tone: "good" },
            rustdeskTunnel: { text: "desktop.ways.cell.lanYes", tone: "good" },
            rustdeskServer: { text: "desktop.ways.cell.lanNo", tone: "neutral" },
        },
    },
    {
        label: "desktop.ways.row.public",
        cells: {
            guacd: { text: "desktop.ways.cell.publicNa", tone: "neutral" },
            rustdeskTunnel: { text: "desktop.ways.cell.publicKept", tone: "good" },
            rustdeskServer: { text: "desktop.ways.cell.publicLeft", tone: "neutral" },
        },
    },
    {
        label: "desktop.ways.row.screens",
        cells: {
            guacd: { text: "desktop.ways.cell.screensCrop", tone: "neutral" },
            rustdeskTunnel: { text: "desktop.ways.cell.screensSwitch", tone: "good" },
            rustdeskServer: { text: "desktop.ways.cell.screensSwitch", tone: "good" },
        },
    },
    {
        label: "desktop.ways.row.login",
        cells: {
            guacd: { text: "desktop.ways.cell.loginDesktop", tone: "neutral" },
            rustdeskTunnel: { text: "desktop.ways.cell.loginRustDeskSaved", tone: "neutral" },
            rustdeskServer: { text: "desktop.ways.cell.loginRustDesk", tone: "neutral" },
        },
    },
];

/** 目前頁面上選的是哪一種。/ Which way the remote desktop page is on. */
export function wayFor(ctx: { protocol: "rdp" | "vnc" | "rustdesk"; idServer: boolean }): WayId {
    if (ctx.idServer) return "rustdeskServer";
    return ctx.protocol === "rustdesk" ? "rustdeskTunnel" : "guacd";
}

export type PathCell = ({ kind: "node"; node: WayNode } | { kind: "link"; link: WayLink; span: number } | { kind: "gap" }) & {
    /** 在 7 格裡從第幾格開始（1 起算）。/ The 1-based slot it starts at, out of seven. */
    start: number;
};

/** 路徑圖第 n 欄放什麼：點、往右的線，或空的；附起始格。/ What sits in each path slot: a node, a link or nothing, with its start. */
export function pathCells(way: Way): PathCell[] {
    const out: PathCell[] = [];
    let col = 0;
    let slot = 1;
    while (col <= 3) {
        const node = way.nodes.find((n) => n.col === col);
        out.push(node ? { kind: "node", node, start: slot } : { kind: "gap", start: slot });
        slot += 1;
        if (col === 3) break;
        const link = way.links.find((l) => l.from === col);
        if (link) {
            // 跨過沒有點的欄（例如 Telepy 直接到那台電腦）：線佔掉中間那幾格。/ A link may span empty columns.
            const span = (link.to - link.from) * 2 - 1;
            out.push({ kind: "link", link, span, start: slot });
            slot += span;
            col = link.to;
        } else {
            out.push({ kind: "gap", start: slot });
            slot += 1;
            col += 1;
        }
    }
    return out;
}
