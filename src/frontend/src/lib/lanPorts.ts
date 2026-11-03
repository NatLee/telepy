/**
 * 主機面板「這台機器上的服務」（純函式）：每個開著的 port 一列，配一個最直接的用法——SSH = 終端機、RDP / VNC / RustDesk =
 * 遠端桌面、網頁 = 遠端瀏覽器、其他 = 把它開到你電腦上（`telepy forward`）。名稱先用掃描看到的（網頁標題、banner），
 * 再用常見服務名。常見服務名由呼叫端給（`lanConnect.serviceName`），這裡保持 node 測得到。
 * The host panel's "services on this machine" (pure): one row per open port with its most direct use — SSH = a
 * terminal, RDP / VNC / RustDesk = remote desktop, a web page = the remote browser, anything else = bring it to your
 * computer (`telepy forward`). Names come from what the scan saw (page title, banner), then the usual service name
 * (passed in by the caller, `lanConnect.serviceName`, so this stays node-testable).
 */
import { webLinks, type WebLink } from "./lanWeb.ts";

export type DesktopProtocol = "rdp" | "vnc" | "rustdesk";

export type PortAction =
    | { kind: "ssh" }
    | { kind: "desktop"; protocol: DesktopProtocol }
    | { kind: "web"; link: WebLink }
    | { kind: "forward" };

export interface PortRow {
    port: number;
    action: PortAction;
    /** 主要的名字（網頁標題、banner、常見服務名）。/ The main name (page title, banner, usual service name). */
    name: string | null;
    /** 第二行（Server、協定）。/ The second line (Server, protocol). */
    detail: string | null;
}

type ServiceLike = { port: number; proto: string; title?: string; server?: string; banner?: string };
type HostLike = { address: string; open_ports: number[]; ssh_port: number; ssh_banner: string | null; web?: WebLink[]; services?: ServiceLike[] | null };

/** 這個 port 是哪種遠端桌面（不是 = null）。/ The remote-desktop protocol on a port (null = none). */
export function desktopProtocol(port: number, proto?: string): DesktopProtocol | null {
    if (proto === "vnc" || (port >= 5900 && port <= 5909)) return "vnc";
    if (port === 3389) return "rdp";
    if (port === 21118) return "rustdesk";
    return null;
}

export function portRows(h: HostLike, serviceName: (port: number) => string | null = () => null): PortRow[] {
    const services = h.services ?? [];
    const web = webLinks(h);
    const ports = [...new Set(h.open_ports)].sort((a, b) => a - b);
    return ports.map((port) => {
        const svc = services.find((s) => s.port === port);
        const link = web.find((w) => w.port === port);
        const ssh = port === h.ssh_port || svc?.proto === "ssh";
        const desktop = desktopProtocol(port, svc?.proto);
        const action: PortAction = ssh ? { kind: "ssh" } : desktop ? { kind: "desktop", protocol: desktop } : link ? { kind: "web", link } : { kind: "forward" };
        const name = svc?.title ?? (ssh ? (svc?.banner ?? h.ssh_banner) : svc?.banner) ?? serviceName(port) ?? null;
        const proto = svc && svc.proto !== "raw" ? svc.proto.toUpperCase() : null;
        const detail = [svc?.title ? svc.server : null, proto && name?.toUpperCase() !== proto ? proto : null].filter(Boolean).join(" · ") || null;
        return { port, action, name, detail };
    });
}

/** 遠端桌面頁的網址，帶協定與 port；`hostId` 是 null = 裝置自己。/ The remote desktop page URL with protocol and port; a null `hostId` = the device itself. */
export function desktopUrl(tunnelId: number, hostId: number | null, protocol: DesktopProtocol, port: number): string {
    const host = hostId === null ? "" : `&lanHost=${hostId}`;
    return `/tunnels/desktop?tunnel=${tunnelId}${host}&protocol=${protocol}&port=${port}`;
}
