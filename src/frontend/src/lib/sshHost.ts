/**
 * SSH 主機（網站設定 → 伺服器）：裝置與筆電的 ssh 連這個名稱，瀏覽器連網頁的名稱。網頁放在 Cloudflare 這類只轉 HTTP(S)
 * 的代理後面時，同一個名稱連不到 gateway 的 port，所以 SSH 要另一個只走 DNS 的名稱。這裡是純函式：檢查主機名稱（跟
 * 後端 `server_settings::check_ssh_host` 同一條規則）、讀 `/api/site/ssh-host` 的回答、算說明圖上每一段的狀態。
 * The SSH host (Site settings → Server): devices' and laptops' ssh dial this name, browsers the web name. A web name
 * behind a proxy that only carries HTTP(S), such as Cloudflare's, cannot reach the gateway port, so SSH needs a
 * DNS-only name of its own. Pure helpers: the host rule (the backend's `check_ssh_host`), the check endpoint's
 * answer, and the state of each part of the explainer diagram.
 */
import type { SpotState } from "./flow.ts";

/** 跟後端一樣整理：去空白、去結尾的點、小寫。/ Tidied like the backend: trimmed, no trailing dot, lower case. */
export function tidyHost(v: string): string {
    return v.trim().replace(/\.+$/, "").toLowerCase();
}

/** 主機名稱或 IPv4，沒有 scheme / port / 路徑；空白 = 跟網頁同一個。回問題的種類或 null。
 *  A host name or IPv4 — no scheme, port or path; blank = the web's name. Returns what is wrong, or null. */
export function hostProblem(v: string): "chars" | "label" | null {
    const h = tidyHost(v);
    if (h === "") return null;
    if (h.length > 253 || !/^[a-z0-9.-]+$/.test(h)) return "chars";
    if (h.split(".").some((l) => l === "" || l.length > 63 || l.startsWith("-") || l.endsWith("-"))) return "label";
    return null;
}

export type SshHostVerdict = "local" | "unresolved" | "ssh_proxied" | "split" | "same" | "separate";
const VERDICTS: SshHostVerdict[] = ["local", "unresolved", "ssh_proxied", "split", "same", "separate"];

export interface NameLookup {
    host: string;
    addresses: string[];
    cloudflare: boolean;
    error: string | null;
}

export interface SshHostCheck {
    ssh: NameLookup & { port: string; source: "env" | "setting" | "web" };
    web: NameLookup & { from: "public_url" | "request"; viaCloudflare: boolean; proxied: boolean };
    same: boolean;
    verdict: SshHostVerdict;
}

function lookupOf(o: Record<string, unknown>): NameLookup {
    return {
        host: typeof o.host === "string" ? o.host : "",
        addresses: Array.isArray(o.addresses) ? o.addresses.filter((a): a is string => typeof a === "string") : [],
        cloudflare: o.cloudflare === true,
        error: typeof o.error === "string" ? o.error : null,
    };
}

/** `/api/site/ssh-host` 的回答；不像的就 null（舊後端）。/ The endpoint's answer; null when it does not look like one. */
export function parseSshHostCheck(raw: unknown): SshHostCheck | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (!r.ssh || typeof r.ssh !== "object" || !r.web || typeof r.web !== "object") return null;
    const ssh = r.ssh as Record<string, unknown>;
    const web = r.web as Record<string, unknown>;
    const verdict = VERDICTS.includes(r.verdict as SshHostVerdict) ? (r.verdict as SshHostVerdict) : "same";
    const source = ssh.source === "env" || ssh.source === "setting" ? ssh.source : "web";
    return {
        ssh: { ...lookupOf(ssh), port: typeof ssh.port === "string" ? ssh.port : String(ssh.port ?? ""), source },
        web: { ...lookupOf(web), from: web.from === "public_url" ? "public_url" : "request", viaCloudflare: web.via_cloudflare === true, proxied: web.proxied === true },
        same: r.same === true,
        verdict,
    };
}

/** 結論的語氣。/ The tone of a verdict. */
export function verdictTone(v: SshHostVerdict): "danger" | "warning" | "tip" | "info" {
    if (v === "ssh_proxied") return "danger";
    if (v === "unresolved") return "warning";
    if (v === "split") return "tip";
    return "info";
}

/** 說明圖：兩條路（網頁、SSH）各三段的狀態。`proxied` = 網頁名稱走代理；`separate` = SSH 有自己的名稱。
 *  The explainer's two lanes (web, SSH), three parts each. `proxied` = the web name is proxied; `separate` = SSH has its own name. */
export interface Lanes {
    web: { name: SpotState; hop: SpotState; port: SpotState };
    ssh: { name: SpotState; hop: SpotState; port: SpotState; viaProxy: boolean };
}

export function lanes(proxied: boolean, separate: boolean): Lanes {
    // SSH 用網頁的名稱又走代理：那個名稱解析到代理，代理不轉 gateway 的 port。
    // SSH on the web's proxied name: the name resolves to the proxy, which never forwards the gateway port.
    const blocked = proxied && !separate;
    return {
        web: { name: "ok", hop: "ok", port: "ok" },
        ssh: { name: blocked ? "failed" : "ok", hop: blocked ? "failed" : "ok", port: blocked ? "waiting" : "ok", viaProxy: blocked },
    };
}

/** 說明圖一開始畫哪一種：照現在的檢查結果。/ The explainer starts from the current check. */
export function initialScenario(check: SshHostCheck | null): { proxied: boolean; separate: boolean } {
    if (!check) return { proxied: true, separate: true };
    return { proxied: check.web.proxied || check.ssh.cloudflare, separate: !check.same };
}
