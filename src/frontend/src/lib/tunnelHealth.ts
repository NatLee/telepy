/**
 * 即時健康狀態：列表抓下來的 `health` 加上 WebSocket 推來的線上 / 離線（portsMap）。線上時保留「降級」，
 * 離線時保留「從沒連過」；其他情況以 portsMap 為準（後端在狀態改變後會被靜默重抓，所以兩者很快一致）。
 * Live health: the fetched `health` combined with the WebSocket-driven online flag. Keeps "degraded" while online
 * and "never" while offline; otherwise the live flag wins (the list is quietly refetched after status changes).
 */
import type { Tunnel, TunnelHealth } from "@/types/tunnel";

export function liveHealth(tunnel: Pick<Tunnel, "health">, online: boolean): TunnelHealth {
    if (online) return tunnel.health === "degraded" ? "degraded" : "online";
    return tunnel.health === "never" ? "never" : "offline";
}
