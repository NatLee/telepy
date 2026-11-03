/**
 * 區網提醒的句子（站內提示與桌面通知共用）：網段上的新機器、注意的主機不見了 / 回來了 / port 變了。`t` 由呼叫端給，這裡
 * 保持 node 測得到。
 * The LAN alerts' sentences (shared by toasts and desktop notifications): new machines on the network, a watched
 * host down / back / ports changed. The caller passes `t`, so this stays node-testable.
 */
import type { TranslationKey } from "../locales/en.ts";

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;
type Msg = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const nums = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);

/** `+443 −80`（開了 / 關了）。/ Opened and closed ports as `+443 −80`. */
export function portDeltaText(opened: number[], closed: number[]): string {
    return [...opened.map((p) => `+${p}`), ...closed.map((p) => `−${p}`)].join(" ");
}

/** 「名稱 (位址)」，名稱就是位址時只寫一次。/ "name (address)", once when they're the same. */
function who(name: string, address: string): string {
    return !name || name === address ? address : `${name} (${address})`;
}

export function lanNewHostsText(t: T, msg: Msg): string {
    const hosts = Array.isArray(msg.hosts) ? (msg.hosts as Msg[]) : [];
    const count = typeof msg.count === "number" ? msg.count : hosts.length;
    const list = hosts.slice(0, 3).map((h) => who(str(h.name), str(h.address))).join(", ");
    const more = count - Math.min(3, hosts.length);
    return t(more > 0 ? "network.alert.newHostsMore" : "network.alert.newHosts", { count, name: str(msg.tunnel_name), list, more });
}

export function lanWatchText(t: T, msg: Msg): string {
    const host = who(str(msg.host), str(msg.address));
    const name = str(msg.tunnel_name);
    switch (msg.state) {
        case "down":
            return t("network.alert.down", { host, name });
        case "up":
            return t("network.alert.up", { host, name });
        default:
            return t("network.alert.ports", { host, name, delta: portDeltaText(nums(msg.opened), nums(msg.closed)) });
    }
}
