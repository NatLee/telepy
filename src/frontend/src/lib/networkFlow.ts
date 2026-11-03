/**
 * 網路頁「怎麼運作」的路徑圖（純函式）：你的瀏覽器 ─ Telepy ─ 裝置 ─ 區網主機，以及到那台主機的五條路——終端機、遠端桌面、
 * 網頁、你自己的指令、掃描——各自現在能不能走、不能的話卡在哪。圖照這裡的結果點亮；選了主機就用那台的真實狀態。
 * The network page's "how it works" diagram (pure): your browser ─ Telepy ─ device ─ LAN host, plus the five ways to a
 * host — terminal, remote desktop, web page, your own commands, scanning — and whether each works right now or where
 * it stops. The diagram lights up from this; with a host picked it uses that host's real state.
 */
import type { SpotState } from "./flow.ts";

export const LANES = ["terminal", "desktop", "web", "commands", "scan"] as const;
export type Lane = (typeof LANES)[number];

/** 一條路的狀態與原因（翻譯鍵的尾巴）。/ One lane's state and why (a translation key suffix). */
export interface LaneState {
    state: SpotState;
    /** `ok` / `offline` / `noAccount` / `noSsh` / `noDesktop` / `noWeb` / `feature` / `notManager` / `scanOff` / `pick` */
    why: string;
}

export interface FlowInput {
    /** 選了哪台主機（null = 只看裝置）。/ The picked host (null = the device only). */
    host: { open_ports: number[]; ssh_port: number; ssh_banner: string | null; web?: { port: number }[] } | null;
    device: { online: boolean | null; usernames: string[]; can_scan: boolean } | null;
    /** 使用者有哪些功能。/ The person's features. */
    features: { terminal: boolean; remote_desktop: boolean; remote_browser: boolean; network: boolean };
}

const DESKTOP_PORTS = [3389, 5900, 5901, 21118];

export function laneStates(x: FlowInput): Record<Lane, LaneState> {
    const out = {} as Record<Lane, LaneState>;
    const dev = x.device;
    const reach: LaneState | null = !dev ? { state: "waiting", why: "pick" } : dev.online === false ? { state: "failed", why: "offline" } : dev.usernames.length === 0 ? { state: "failed", why: "noAccount" } : null;
    const h = x.host;
    const ssh = !!h && (h.open_ports.includes(h.ssh_port) || !!h.ssh_banner);
    const desktop = !!h && h.open_ports.some((p) => DESKTOP_PORTS.includes(p));
    const web = !!h && (h.web?.length ?? 0) > 0;
    const lane = (feature: boolean, has: boolean, missing: string): LaneState =>
        reach ?? (!feature ? { state: "failed", why: "feature" } : !h ? { state: "waiting", why: "pick" } : has ? { state: "ok", why: "ok" } : { state: "waiting", why: missing });
    out.terminal = lane(x.features.terminal, ssh, "noSsh");
    out.desktop = lane(x.features.remote_desktop, desktop, "noDesktop");
    out.web = lane(x.features.remote_browser, web, "noWeb");
    out.commands = reach ?? (!h ? { state: "waiting", why: "pick" } : { state: "ok", why: "ok" });
    out.scan = reach ?? (!dev?.can_scan ? { state: "waiting", why: "notManager" } : { state: "ok", why: "ok" });
    return out;
}

/** 整條路（瀏覽器 → Telepy → 裝置 → 主機）每一站的狀態。/ Each stop along the path. */
export function pathStates(x: FlowInput): { telepy: SpotState; tunnel: SpotState; device: SpotState; lan: SpotState; host: SpotState } {
    const online = x.device?.online;
    const dev: SpotState = !x.device ? "waiting" : online === false ? "failed" : online ? "ok" : "waiting";
    return {
        telepy: "ok",
        tunnel: dev,
        device: dev,
        lan: dev === "ok" && x.host ? "ok" : dev === "failed" ? "failed" : "waiting",
        host: x.host && dev === "ok" ? "ok" : "waiting",
    };
}
