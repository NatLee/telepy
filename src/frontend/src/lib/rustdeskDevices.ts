/**
 * Telepy 當 RustDesk 的 ID / 中繼伺服器時的裝置與登記指令（純函式，無 React）。後端：`api/rustdesk_devices.rs`。
 * RustDesk devices enrolled with Telepy's RustDesk server, and the one-time enrolment commands (pure helpers).
 */
import type { IpGeo } from "@/lib/geo";
import type { TranslationKey } from "@/locales/en";

export interface RustDeskServerSettings {
    enabled: boolean;
    /** RustDesk 的 `custom-rendezvous-server`。/ RustDesk's ID server option. */
    rendezvous: string;
    /** RustDesk 的 `api-server`。/ RustDesk's API server option. */
    api_server: string;
    relay_url: string;
    /** RustDesk 連不到這個位址的原因。/ Why RustDesk cannot reach this address. */
    problem: "hostname_port" | "ip_https" | "localhost" | "bad_port" | "bad_url" | null;
    key: string;
}

export interface RustDeskDevice {
    id: number;
    name: string;
    rustdesk_id: string;
    hostname: string;
    os: string;
    version: string;
    online: boolean;
    online_since: string | null;
    last_seen_at: string | null;
    created_at: string;
    owner: { id: number; username: string | null };
    mine: boolean;
    in_use: number;
    /** 最後一次被連（誰、何時）；沒連過是 null。/ The latest browser session, or null. */
    last_used: { username: string; at: string } | null;
}

/** 一次瀏覽器連線（`GET /api/rustdesk/devices/{id}/sessions`）。/ One browser session to the device. */
export interface RustDeskDeviceSession {
    id: number;
    user: { id: number; username: string };
    mine: boolean;
    ip: string | null;
    geo?: IpGeo | null;
    started_at: string;
    /** null = 還連著。/ null while it is open. */
    ended_at: string | null;
    seconds: number | null;
    /** 裝置 → 瀏覽器的位元組。/ Bytes device → browser. */
    to_browser: number;
    /** 瀏覽器 → 裝置。/ Bytes browser → device. */
    to_device: number;
    reason: string;
}

export type EnrolPhase = "waiting" | "enrolled" | "online";

export interface RustDeskEnrolment {
    id: string;
    name: string | null;
    phase: EnrolPhase;
    device_id: number | null;
    rustdesk_id: string | null;
    created_at: string;
    expires_at: string;
}

export interface RustDeskEnrolmentCreated extends RustDeskEnrolment {
    token: string;
    /** `unix` = Linux 與 macOS 共用（自己找 RustDesk、檢查每一步）。/ `unix` serves Linux and macOS alike. */
    commands: { unix: string; windows: string };
    server: RustDeskServerSettings;
}

export type DeviceOs = "unix" | "windows";

/** 純數字的 RustDesk ID 三位一組（和 RustDesk 畫面上一樣）；自訂 ID 原樣。/ Group a numeric ID in threes like RustDesk does. */
export function formatRustDeskId(id: string): string {
    if (!/^\d+$/.test(id)) return id;
    return id.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** 伺服器位址的問題 → 說明文字的 key。/ The explanation for an address RustDesk cannot use. */
export function serverProblemKey(problem: RustDeskServerSettings["problem"]): TranslationKey | null {
    switch (problem) {
        case "hostname_port":
            return "rustdesk.problem.hostnamePort";
        case "ip_https":
            return "rustdesk.problem.ipHttps";
        case "localhost":
            return "rustdesk.problem.localhost";
        case "bad_port":
        case "bad_url":
            return "rustdesk.problem.badUrl";
        default:
            return null;
    }
}

/** 卡片副標：主機名稱 · 系統 · RustDesk 版本（有的才列）。/ The card subtitle. */
export function deviceDetails(d: Pick<RustDeskDevice, "hostname" | "os" | "version" | "name">): string {
    const parts = [d.hostname && d.hostname !== d.name ? d.hostname : "", shortOs(d.os), d.version ? `RustDesk ${d.version}` : ""];
    return parts.filter(Boolean).join(" · ");
}

/** RustDesk 回報的系統字串（`debian / Linux 12 Debian GNU/Linux`）取前半。/ The readable half of RustDesk's OS string. */
export function shortOs(os: string): string {
    const s = os.trim();
    if (!s) return "";
    const slash = s.indexOf(" / ");
    if (slash < 0) return s;
    const head = s.slice(0, slash).trim();
    const tail = s.slice(slash + 3).trim();
    // `debian / Linux 12 …` → `Linux 12`；`Windows 11 / …` → `Windows 11`。/ Prefer the part with a version.
    const pick = /\d/.test(tail) && !/\d/.test(head) ? tail : head;
    return pick.split(/\s+/).slice(0, 2).join(" ");
}

/** 瀏覽器猜使用者的系統（新增裝置時預選那個分頁）。/ Guess the user's OS for the default command tab. */
export function guessOs(nav: { platform?: string; userAgent?: string } | undefined): DeviceOs {
    const s = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`.toLowerCase();
    return s.includes("win") ? "windows" : "unix";
}

/** 登記的三步各自的狀態。/ The state of each enrolment step. */
export function enrolSteps(phase: EnrolPhase, expired: boolean): ["done" | "active" | "todo", "done" | "active" | "todo", "done" | "active" | "todo"] {
    if (phase === "online") return ["done", "done", "done"];
    if (phase === "enrolled") return ["done", "done", "active"];
    return [expired ? "todo" : "active", "todo", "todo"];
}

/** 依名稱排序，在線的排前面。/ Online first, then by name. */
export function sortDevices(list: RustDeskDevice[]): RustDeskDevice[] {
    return [...list].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name) || a.id - b.id);
}

/** 連線怎麼結束的 → 說明文字的 key。/ How a session ended → its explanation. */
export function endReasonKey(reason: string): TranslationKey {
    switch (reason) {
        case "user":
            return "rustdesk.history.reason.user";
        case "device":
            return "rustdesk.history.reason.device";
        case "ended":
            return "rustdesk.history.reason.ended";
        case "stopped":
            return "rustdesk.history.reason.stopped";
        case "removed":
            return "rustdesk.history.reason.removed";
        case "revoked":
            return "rustdesk.history.reason.revoked";
        case "restart":
            return "rustdesk.history.reason.restart";
        default:
            return "rustdesk.history.reason.other";
    }
}
