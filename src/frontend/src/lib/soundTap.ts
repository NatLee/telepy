/**
 * 遠端桌面聲音的瀏覽器端：自動播放解鎖與「聽診器」。
 * - `primeAudio()`：在使用者點擊的那一刻（連線、開聲音、「點一下啟用聲音」）同步建立 / resume 一個共用的 AudioContext。
 *   瀏覽器（尤其 Safari）只讓「在使用者手勢裡」建立或 resume 的 AudioContext 出聲；guacd 的播放器與 RustDesk 核心
 *   都是在 WebSocket 訊息裡（沒有手勢）才建 context，所以先在點擊時建好交給它們：guacd 用
 *   `Guacamole.AudioContextFactory.singleton`，RustDesk 核心經 `installRustDeskTap` 拿到同一個。
 * - `SoundTap`：記下聲音通道開了沒、最近的資料與峰值、context 狀態，`snapshot()` 給 `lib/desktopSound` 判斷。
 *   guacd 這邊由 DesktopViewer 的 `onaudio` 餵；RustDesk 核心是個封閉的 bundle，`installRustDeskTap` 在它掛上的期間
 *   包住 `window.AudioContext` 與 `window.AudioDecoder`（解出來的每一塊量峰值），卸下時還原。
 * Browser side of remote desktop sound: autoplay unlock and a tap. `primeAudio()` creates / resumes one shared
 * AudioContext synchronously inside a click (browsers, Safari above all, only let a context created or resumed in a
 * user gesture play), and hands it to guacd's player and the RustDesk core, which would otherwise create theirs in a
 * WebSocket message. `SoundTap` records whether the channel opened, recent data and its peak, and the context state.
 */
import { LOUD_PEAK, RECENT_MS, type SoundSnapshot } from "@/lib/desktopSound";

type Ctor = typeof AudioContext;

/** 頁面原本的 AudioContext（包裝前）。/ The page's own AudioContext constructor, before any wrapping. */
function nativeContext(): Ctor | null {
    if (typeof window === "undefined") return null;
    const w = window as unknown as { __telepyNativeAudioContext?: Ctor; AudioContext?: Ctor; webkitAudioContext?: Ctor };
    return w.__telepyNativeAudioContext ?? w.AudioContext ?? w.webkitAudioContext ?? null;
}

let shared: AudioContext | null = null;

/**
 * 在點擊處理函式裡同步呼叫：沒有（或已關閉）就建一個，並 resume。回傳共用的 context（不支援 Web Audio = null）。
 * Call synchronously from a click handler: creates the shared context if needed and resumes it.
 */
export function primeAudio(): AudioContext | null {
    const C = nativeContext();
    if (!C) return null;
    try {
        if (!shared || shared.state === "closed") shared = new C({ latencyHint: "interactive" });
        if (shared.state !== "running") void shared.resume().catch(() => undefined);
    } catch {
        return null;
    }
    return shared;
}

/** 目前的共用 context（沒建或已關 = null），不建新的。/ The shared context if it exists and is open. */
export function sharedAudio(): AudioContext | null {
    return shared && shared.state !== "closed" ? shared : null;
}

export class SoundTap {
    opened = false;
    lastDataAt = 0;
    lastLoudAt = 0;
    context: AudioContext | null = null;

    /** 聲音通道開了（guacd 的 audio 串流 / RustDesk 的格式訊息）。/ The remote opened its sound channel. */
    open(): void {
        this.opened = true;
    }

    /** 一塊聲音資料與它的峰值（0..1）。/ One block of sound data with its peak. */
    data(peak: number, now = Date.now()): void {
        this.lastDataAt = now;
        if (peak > LOUD_PEAK) this.lastLoudAt = now;
    }

    snapshot(now = Date.now()): SoundSnapshot {
        return {
            opened: this.opened,
            receiving: now - this.lastDataAt < RECENT_MS,
            loud: now - this.lastLoudAt < RECENT_MS,
            context: this.context ? this.context.state : null,
        };
    }

    /** 點擊時呼叫：resume 這個 context 與共用的那個。/ From a click: resume this context and the shared one. */
    resume(): void {
        const s = primeAudio();
        if (this.context && this.context !== s && this.context.state !== "running" && this.context.state !== "closed") {
            void this.context.resume().catch(() => undefined);
        }
    }

    reset(): void {
        this.opened = false;
        this.lastDataAt = 0;
        this.lastLoudAt = 0;
        this.context = null;
    }
}

export function sameSnapshot(a: SoundSnapshot, b: SoundSnapshot): boolean {
    return a.opened === b.opened && a.receiving === b.receiving && a.loud === b.loud && a.context === b.context;
}

/** AudioData 第一聲道的峰值（每 4 個樣本看一個）。/ Peak of an AudioData's first channel. */
function audioDataPeak(d: AudioData): number {
    try {
        const n = d.numberOfFrames;
        if (!n) return 0;
        const buf = new Float32Array(n);
        d.copyTo(buf, { planeIndex: 0, format: "f32-planar" });
        let peak = 0;
        for (let i = 0; i < n; i += 4) {
            const v = Math.abs(buf[i]);
            if (v > peak) peak = v;
        }
        return peak;
    } catch {
        return 0;
    }
}

/**
 * RustDesk 核心掛著的期間包住 AudioContext 與 AudioDecoder：核心建 context 時拿到共用、點擊時解鎖過的那個（沒有才
 * 新建），解碼器的每一塊輸出先量峰值再交給核心。回傳還原函式。
 * While the RustDesk core is mounted: its `new AudioContext()` gets the shared, click-unlocked context (a fresh one
 * only when there is none) and every decoded block is measured before the core plays it. Returns the restore function.
 */
export function installRustDeskTap(tap: SoundTap): () => void {
    if (typeof window === "undefined") return () => undefined;
    const w = window as unknown as { AudioContext?: Ctor; AudioDecoder?: typeof AudioDecoder; __telepyNativeAudioContext?: Ctor };
    const NativeCtx = nativeContext();
    const NativeDecoder = w.AudioDecoder;
    const prevCtx = w.AudioContext;
    if (NativeCtx) {
        w.__telepyNativeAudioContext = NativeCtx;
        const Tapped = function TelepyAudioContext(options?: AudioContextOptions) {
            const ctx = sharedAudio() ?? new NativeCtx(options);
            tap.context = ctx;
            return ctx;
        } as unknown as Ctor;
        Tapped.prototype = NativeCtx.prototype;
        w.AudioContext = Tapped;
    }
    if (NativeDecoder) {
        class TappedDecoder extends NativeDecoder {
            constructor(init: AudioDecoderInit) {
                super({
                    ...init,
                    output: (d: AudioData) => {
                        tap.data(audioDataPeak(d));
                        init.output(d);
                    },
                });
                tap.open();
            }
        }
        w.AudioDecoder = TappedDecoder;
    }
    return () => {
        if (NativeCtx) w.AudioContext = prevCtx;
        if (NativeDecoder) w.AudioDecoder = NativeDecoder;
        delete w.__telepyNativeAudioContext;
    };
}
