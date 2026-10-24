/**
 * asciicast v2 的解析與播放輔助（終端機錄影）：一行 JSON 一個值，第一行是檔頭，其餘是 `[秒, 種類, 資料]`。
 * 太長的空檔壓成 `idleLimit` 秒（和 asciinema 的 idle_time_limit 一樣），看錄影不用乾等。純函式，`asciicast.test.ts` 有測試。
 * asciicast v2 parsing for terminal recordings: one JSON value per line, a header then `[seconds, kind, data]`.
 * Long pauses are squeezed to `idleLimit` seconds, like asciinema's idle_time_limit. Pure functions.
 */
export interface CastEvent {
    /** 播放時間（壓過空檔）。/ Playback time (pauses squeezed). */
    t: number;
    kind: string;
    data: string;
}

export interface Cast {
    width: number;
    height: number;
    title: string | null;
    events: CastEvent[];
    /** 播放總長（秒）。/ Playback length in seconds. */
    duration: number;
}

export function parseCast(text: string, idleLimit = 2): Cast {
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    let width = 80;
    let height = 24;
    let title: string | null = null;
    const events: CastEvent[] = [];
    let last = 0;
    let shifted = 0;
    lines.forEach((line, i) => {
        let v: unknown;
        try {
            v = JSON.parse(line);
        } catch {
            return; // 還在錄的檔最後一行可能寫一半。/ A live file's last line may be half written.
        }
        if (i === 0 && v && typeof v === "object" && !Array.isArray(v)) {
            const h = v as { width?: number; height?: number; title?: string };
            width = h.width ?? width;
            height = h.height ?? height;
            title = h.title ?? null;
            return;
        }
        if (!Array.isArray(v) || typeof v[0] !== "number" || typeof v[1] !== "string" || typeof v[2] !== "string") return;
        const raw = v[0];
        const gap = Math.max(0, raw - last);
        shifted += Math.min(gap, idleLimit);
        last = raw;
        events.push({ t: shifted, kind: v[1], data: v[2] });
    });
    return { width, height, title, events, duration: events.length ? events[events.length - 1].t : 0 };
}

/** 時間 `t` 以前（含）有幾個事件（二分搜尋）。/ How many events happen at or before `t` (binary search). */
export function countUntil(events: CastEvent[], t: number): number {
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (events[mid].t <= t) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** `r` 事件的 "COLSxROWS"。/ Parse a resize event's "COLSxROWS". */
export function parseSize(data: string): { cols: number; rows: number } | null {
    const m = /^(\d+)x(\d+)$/.exec(data);
    return m ? { cols: Number(m[1]), rows: Number(m[2]) } : null;
}

/** 「1:05」「1:02:03」。/ A clock string. */
export function clock(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
