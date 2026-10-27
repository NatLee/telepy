/**
 * 遠端桌面的兩種連法（純資料＋純函式，無 React），給「比較連線方式」對話框用，兩種都經 Telepy 隧道：
 * - guacd：RDP / VNC，Telepy（guacd）把畫面轉成圖片
 * - rustdeskTunnel：RustDesk（Direct IP），瀏覽器裡的 RustDesk 引擎解碼影像
 * 路徑圖的欄位對齊（你的瀏覽器 ─ Telepy ─ 裝置 ─ 桌面），上下對照；每列下面是「誰加密哪一段」的標尺。
 * The two ways to reach a desktop, both through a Telepy tunnel, as data for the comparison dialog: aligned path
 * rows (browser ─ Telepy ─ device ─ desktop) with an encryption ruler under each, plus the comparison table rows.
 */
import type { TranslationKey } from "@/locales/en";

export type WayId = "guacd" | "rustdeskTunnel";
export const WAY_IDS: readonly WayId[] = ["guacd", "rustdeskTunnel"];

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
export type LinkKind = "wss" | "tunnel" | "local";
/** 兩點之間的線：`from` 欄到下一個點。/ The link from a column to the next node. */
export interface WayLink {
    from: 0 | 1 | 2;
    to: 1 | 2 | 3;
    kind: LinkKind;
    label: TranslationKey;
}
export type LayerTone = "transport" | "plain";
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
];

export type CellTone = "good" | "bad" | "neutral";
export interface WayRow {
    label: TranslationKey;
    cells: Record<WayId, { text: TranslationKey; tone: CellTone }>;
}

/** 比較表（順序 = 顯示順序）。/ The comparison table, in display order. */
export const ROWS: readonly WayRow[] = [
    {
        label: "desktop.ways.row.target",
        cells: {
            guacd: { text: "desktop.ways.cell.targetRdpVnc", tone: "neutral" },
            rustdeskTunnel: { text: "desktop.ways.cell.targetDirectIp", tone: "neutral" },
        },
    },
    {
        label: "desktop.ways.row.picture",
        cells: {
            guacd: { text: "desktop.ways.cell.pictureImages", tone: "neutral" },
            rustdeskTunnel: { text: "desktop.ways.cell.pictureVideo", tone: "good" },
        },
    },
    {
        label: "desktop.ways.row.motion",
        cells: {
            guacd: { text: "desktop.ways.cell.motionSlow", tone: "bad" },
            rustdeskTunnel: { text: "desktop.ways.cell.motionSmooth", tone: "good" },
        },
    },
    {
        label: "desktop.ways.row.encryption",
        cells: {
            guacd: { text: "desktop.ways.cell.encTransport", tone: "neutral" },
            rustdeskTunnel: { text: "desktop.ways.cell.encTransport", tone: "neutral" },
        },
    },
    {
        label: "desktop.ways.row.telepySees",
        cells: {
            guacd: { text: "desktop.ways.cell.seesDraws", tone: "bad" },
            rustdeskTunnel: { text: "desktop.ways.cell.seesCould", tone: "neutral" },
        },
    },
    {
        label: "desktop.ways.row.screens",
        cells: {
            guacd: { text: "desktop.ways.cell.screensCrop", tone: "neutral" },
            rustdeskTunnel: { text: "desktop.ways.cell.screensSwitch", tone: "good" },
        },
    },
    {
        label: "desktop.ways.row.sound",
        cells: {
            guacd: { text: "desktop.ways.cell.soundRdpOnly", tone: "neutral" },
            rustdeskTunnel: { text: "desktop.ways.cell.soundRd", tone: "good" },
        },
    },
    {
        label: "desktop.ways.row.files",
        cells: {
            guacd: { text: "desktop.ways.cell.filesNone", tone: "bad" },
            rustdeskTunnel: { text: "desktop.ways.cell.filesPanel", tone: "good" },
        },
    },
    {
        label: "desktop.ways.row.login",
        cells: {
            guacd: { text: "desktop.ways.cell.loginDesktop", tone: "neutral" },
            rustdeskTunnel: { text: "desktop.ways.cell.loginRustDeskSaved", tone: "neutral" },
        },
    },
];

/** 目前頁面上選的是哪一種。/ Which way the remote desktop page is on. */
export function wayFor(protocol: "rdp" | "vnc" | "rustdesk"): WayId {
    return protocol === "rustdesk" ? "rustdeskTunnel" : "guacd";
}

/**
 * 寬版格線：每個點佔兩個半欄（兩半中間 = 點的中心），每條線一欄，共 11 欄。加密尺的每一段從起點的中心畫到終點的中心，
 * 相鄰兩段剛好接上，也有足夠的寬度放下標籤。
 * Wide grid: a node takes two half columns (the line between them is its centre), a link one column — eleven in all.
 * A ruler span runs from centre to centre, so neighbours meet and the label has the whole hop's width.
 */
export const PATH_GRID_TEMPLATE = "repeat(3, minmax(0, 0.5fr) minmax(0, 0.5fr) minmax(4.5rem, 0.8fr)) minmax(0, 0.5fr) minmax(0, 0.5fr)";
/** 第 col 個點的第一欄（1 起算）。/ The first grid column of node `col`, 1-based. */
const nodeStart = (col: number) => col * 3 + 1;
/** 點的 grid-column。/ A node's grid-column. */
export function nodeColumns(col: number): string {
    return `${nodeStart(col)} / span 2`;
}
/** 線填滿兩個點之間（可跨過沒有點的欄）。/ A link fills the space between its two nodes. */
export function linkColumns(from: number, to: number): string {
    return `${nodeStart(from) + 2} / ${nodeStart(to)}`;
}
/** 加密尺的一段：起點中心到終點中心。/ A ruler span, centre to centre. */
export function layerColumns(from: number, to: number): string {
    return `${nodeStart(from) + 1} / ${nodeStart(to) + 1}`;
}

export type PathCell = { kind: "node"; node: WayNode } | { kind: "link"; link: WayLink };

/** 路徑上依序的點與線（沒有點的欄略過，線會跨過去）。/ The path's nodes and links in order. */
export function pathCells(way: Way): PathCell[] {
    const out: PathCell[] = [];
    for (let col = 0; col <= 3; col += 1) {
        const node = way.nodes.find((n) => n.col === col);
        if (node) out.push({ kind: "node", node });
        const link = way.links.find((l) => l.from === col);
        if (link) out.push({ kind: "link", link });
    }
    return out;
}
