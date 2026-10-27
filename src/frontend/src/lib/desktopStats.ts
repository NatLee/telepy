/**
 * 遠端桌面的串流統計（純函式，無 React）：解析中繼每秒送來的 `telepy-stats`，算出延遲分級、速率文字、
 * 「卡在哪一段」與串流健康度。後端的對應在 `desktop/stats.rs`。
 * Pure helpers for the remote desktop stream statistics the relay sends once a second (`telepy-stats`):
 * parsing, latency tiers, rate formatting, which hop carries the delay, and the stream's health.
 */
import type { FlowSpot } from "@/lib/desktop";

export interface StreamStats {
    /** 這份統計涵蓋的毫秒數。/ Length of the window in ms. */
    windowMs: number;
    /** 畫面往返：guacd 的 sync → 瀏覽器畫完回音（含解碼繪製）。/ Frame round trip, rendering included. */
    frameMs: number | null;
    /** 網路往返：中繼 ping → 瀏覽器 pong。/ Network round trip, no rendering. */
    netMs: number | null;
    /** Telepy ↔ 裝置（monitor 的隧道延遲）。/ Telepy ↔ device. */
    tunnelMs: number | null;
    /** 這一秒的幀數。/ Frames in the window. */
    fps: number;
    /** 下行 / 上行 bytes per second。/ Bytes per second each way. */
    downBps: number;
    upBps: number;
    /** 送出但瀏覽器還沒畫完回音的幀。/ Frames sent but not yet acknowledged. */
    behind: number;
    /** guacd 一次 sync 併了幾個邏輯幀（> 1 = 瀏覽器跟不上）。/ Logical frames merged into one. */
    merged: number;
    /** 聲音串流每秒的量（guacd 開了聲音串流才有；null / 沒有 = 沒有聲音串流）。/ Sound bytes per second, null without a sound stream. */
    audioBps?: number | null;
    /** 收到的時間（Date.now()）。/ When it arrived. */
    at: number;
}

export const STATS_OPCODE = "telepy-stats";
export const PING_OPCODE = "telepy-ping";
export const PONG_OPCODE = "telepy-pong";

function num(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** `telepy-stats` 的 JSON → 統計；壞資料回 null。/ Parse the stats element; null on garbage. */
export function parseStats(json: string, at = Date.now()): StreamStats | null {
    let v: unknown;
    try {
        v = JSON.parse(json);
    } catch {
        return null;
    }
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const windowMs = Math.max(1, num(o.ms) ?? 1000);
    const perSecond = (bytes: number) => Math.round((bytes * 1000) / windowMs);
    return {
        windowMs,
        frameMs: num(o.frame_ms),
        netMs: num(o.net_ms),
        tunnelMs: num(o.tunnel_ms),
        fps: Math.round(((num(o.frames) ?? 0) * 1000) / windowMs),
        downBps: perSecond(num(o.down) ?? 0),
        upBps: perSecond(num(o.up) ?? 0),
        behind: num(o.behind) ?? 0,
        merged: num(o.merged) ?? 0,
        audioBps: num(o.audio) === null ? null : perSecond(num(o.audio) ?? 0),
        at,
    };
}

export type LatencyTone = "good" | "fair" | "poor" | "unknown";

/** 畫面往返的分級（含繪製，所以門檻比單純網路寬）。/ Tiers for the frame round trip (rendering included). */
export function latencyTone(ms: number | null): LatencyTone {
    if (ms === null) return "unknown";
    if (ms < 120) return "good";
    if (ms < 300) return "fair";
    return "poor";
}

/** `0 B/s` / `12 KB/s` / `1.2 MB/s`。 */
export function formatRate(bytesPerSecond: number): string {
    const n = Math.max(0, bytesPerSecond);
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB/s`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB/s`;
    return `${Math.round(n)} B/s`;
}

export function formatMs(ms: number | null): string {
    return ms === null ? "—" : `${Math.round(ms)} ms`;
}

/**
 * 延遲主要在哪一段：網路（瀏覽器 ↔ Telepy）、隧道（Telepy ↔ 裝置）或瀏覽器自己（畫面往返遠大於網路往返 =
 * 解碼繪製跟不上）。沒有夠多資料就 null。
 * Where most of the delay sits: the web hop, the tunnel, or the browser's own rendering (frame round trip
 * far above the network round trip). null when there is not enough data.
 */
export function laggingHop(s: StreamStats): Extract<FlowSpot, "web" | "tunnel" | "browser"> | null {
    const net = s.netMs;
    const tunnel = s.tunnelMs;
    const render = s.frameMs !== null && net !== null ? Math.max(0, s.frameMs - net) : null;
    const candidates: { hop: "web" | "tunnel" | "browser"; ms: number }[] = [];
    if (net !== null) candidates.push({ hop: "web", ms: net });
    if (tunnel !== null) candidates.push({ hop: "tunnel", ms: tunnel });
    if (render !== null) candidates.push({ hop: "browser", ms: render });
    if (candidates.length === 0) return null;
    const worst = candidates.reduce((a, b) => (b.ms > a.ms ? b : a));
    // 都很快就沒有「卡在哪」可說。/ Nothing to blame when everything is quick.
    return worst.ms >= 80 ? worst.hop : null;
}

export type StreamHealth = "live" | "slow" | "stalled" | "idle";

/**
 * 串流健康度：stalled = 統計本身沒來了（> 3 s）或 tunnel 不穩；slow = 落後幾幀或 guacd 在併幀或延遲差；
 * idle = 沒有新幀但一切正常；live = 有幀在流。
 * Stream health from the latest stats, the tunnel's unstable flag and how old the stats are.
 */
export function streamHealth(s: StreamStats | null, unstable: boolean, now = Date.now()): StreamHealth {
    if (!s || now - s.at > 3500 || unstable) return "stalled";
    if (s.behind >= 3 || s.merged > 1 || latencyTone(s.frameMs) === "poor") return "slow";
    if (s.fps === 0) return "idle";
    return "live";
}
