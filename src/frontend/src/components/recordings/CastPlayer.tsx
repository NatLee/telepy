"use client";

/**
 * 終端機錄影播放器：用同一套 xterm 與這台裝置的終端機外觀，照錄下來的大小重播（太寬就整個縮小，不另外捲動）。
 * 播放 / 暫停、拖曳進度、1× / 2× / 4× / 8×；空檔超過 2 秒會壓短（見 lib/asciicast）。
 * Terminal recording player: the same xterm and this device's terminal look, replayed at the recorded size (scaled
 * down to fit instead of scrolling). Play / pause, seek, 1× / 2× / 4× / 8×; pauses over 2 s are squeezed.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import "xterm/css/xterm.css";
import { Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { useTerminalAppearance } from "@/hooks/useTerminalAppearance";
import { clock, countUntil, parseSize, type Cast } from "@/lib/asciicast";
import { useI18n } from "@/lib/i18n";
import { applyLigatures, loadXtermDeps, waitForFont, xtermLookOptions } from "@/lib/xterm";

const SPEEDS = ["1", "2", "4", "8"] as const;

/** `tunnelId` = 用哪台裝置的終端機外觀（null = 我的預設，片尾名單用）；`autoPlay` 一準備好就播。 */
/** `tunnelId` picks the device's terminal look (null = my default, for the credits); `autoPlay` starts when ready. */
/** `onEnded`：播到最後時呼叫（片尾名單看完解鎖彩蛋）。/ `onEnded` runs when playback reaches the end (the credits' unlock). */
/** `pixelArt`：畫面裡有背景色像素圖（片尾名單），縮小時補掉列間的細縫（globals.css；原尺寸沒有縫）。/ The screen holds background-colour pixel art (the credits): fills the hairlines between rows when scaled (globals.css; full size has none). */
export function CastPlayer({
    cast,
    tunnelId,
    autoPlay = false,
    onEnded,
    pixelArt = false,
}: {
    cast: Cast;
    tunnelId: number | null;
    autoPlay?: boolean;
    onEnded?: () => void;
    pixelArt?: boolean;
}) {
    const endedRef = useRef(onEnded);
    useEffect(() => {
        endedRef.current = onEnded;
    }, [onEnded]);
    const { t } = useI18n();
    const { resolved } = useTerminalAppearance(tunnelId === null ? null : String(tunnelId));
    const hostRef = useRef<HTMLDivElement | null>(null);
    const frameRef = useRef<HTMLDivElement | null>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const termRef = useRef<any>(null);
    const appliedRef = useRef(0); // 已寫進 xterm 的事件數 / events already written
    const timeRef = useRef(0);
    const [time, setTime] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>("1");
    const [box, setBox] = useState({ scale: 1, height: 0 });
    const [ready, setReady] = useState(false);

    /** 把畫面推到時間 `target`（往回就從頭重放）。/ Bring the screen to `target` (rewinding replays from the start). */
    const applyUntil = useCallback(
        (target: number) => {
            const term = termRef.current;
            if (!term) return;
            if (countUntil(cast.events, target) < appliedRef.current) {
                term.reset();
                term.resize(cast.width, cast.height);
                appliedRef.current = 0;
            }
            const end = countUntil(cast.events, target);
            let chunk = "";
            for (let i = appliedRef.current; i < end; i++) {
                const e = cast.events[i];
                if (e.kind === "o") {
                    chunk += e.data;
                } else if (e.kind === "r") {
                    const size = parseSize(e.data);
                    if (chunk) term.write(chunk);
                    chunk = "";
                    if (size) term.resize(size.cols, size.rows);
                }
            }
            if (chunk) term.write(chunk);
            appliedRef.current = end;
        },
        [cast],
    );

    // 建 xterm（錄下來的大小、不接受輸入）。/ Build the xterm at the recorded size; no input.
    useEffect(() => {
        let disposed = false;
        let cleanup = () => {};
        (async () => {
            const [{ Terminal }] = await Promise.all([loadXtermDeps(), waitForFont(resolved.font, resolved.bold !== "bright")]);
            if (disposed || !hostRef.current) return;
            const term = new Terminal({
                cols: cast.width,
                rows: cast.height,
                disableStdin: true,
                cursorBlink: false,
                scrollback: 5000,
                ...xtermLookOptions(resolved),
            });
            term.open(hostRef.current);
            applyLigatures(term, resolved.ligatures);
            termRef.current = term;
            appliedRef.current = 0;
            setReady(true);
            if (autoPlay) setPlaying(true);
            cleanup = () => {
                try {
                    term.dispose();
                } catch {
                    /* noop */
                }
                termRef.current = null;
            };
        })();
        return () => {
            disposed = true;
            cleanup();
        };
        // 外觀只在建立時讀；換錄影時整個重建。/ The look is read once; a new recording rebuilds it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cast]);

    // 太寬就縮小整個畫面。/ Scale the whole screen down when it is too wide.
    useEffect(() => {
        const frame = frameRef.current;
        const host = hostRef.current;
        if (!frame || !host) return;
        const ro = new ResizeObserver(() => {
            const scale = Math.min(1, frame.clientWidth / (host.scrollWidth || 1));
            setBox({ scale, height: host.scrollHeight * scale });
        });
        ro.observe(frame);
        ro.observe(host);
        return () => ro.disconnect();
    }, [ready]);

    // 播放迴圈。/ The playback loop.
    useEffect(() => {
        if (!playing) return;
        let raf = 0;
        let last = performance.now();
        const tick = (now: number) => {
            const next = Math.min(cast.duration, timeRef.current + ((now - last) / 1000) * Number(speed));
            last = now;
            timeRef.current = next;
            applyUntil(next);
            setTime(next);
            if (next >= cast.duration) {
                setPlaying(false);
                endedRef.current?.();
                return;
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [playing, speed, cast.duration, applyUntil]);

    const seek = (to: number) => {
        timeRef.current = to;
        setTime(to);
        applyUntil(to);
    };
    const toggle = () => {
        if (!playing && timeRef.current >= cast.duration) seek(0);
        setPlaying((p) => !p);
    };

    return (
        <div className="space-y-3">
            <div ref={frameRef} className="overflow-hidden rounded-lg border border-border p-2" style={{ background: resolved.scheme.theme.background }}>
                <div style={{ transform: `scale(${box.scale})`, transformOrigin: "top left", height: box.scale < 1 ? box.height : undefined }}>
                    <div ref={hostRef} className={pixelArt && box.scale < 1 ? "cast-pixel-art inline-block" : "inline-block"} />
                </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" onClick={toggle} disabled={!ready || cast.events.length === 0} aria-label={playing ? t("recordings.pause") : t("recordings.play")}>
                    {playing ? <Pause /> : <Play />}
                    {playing ? t("recordings.pause") : t("recordings.play")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => seek(0)} disabled={!ready} aria-label={t("recordings.restart")} title={t("recordings.restart")}>
                    <RotateCcw />
                </Button>
                <input
                    type="range"
                    min={0}
                    max={cast.duration || 0}
                    step={0.1}
                    value={time}
                    onChange={(e) => seek(Number(e.target.value))}
                    disabled={!ready}
                    className="min-w-40 flex-1 accent-primary"
                    aria-label={t("recordings.seek")}
                />
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {clock(time)} / {clock(cast.duration)}
                </span>
                <Segmented size="sm" aria-label={t("recordings.speed")} value={speed} onChange={setSpeed} options={SPEEDS.map((s) => ({ value: s, label: `${s}×` }))} />
            </div>
        </div>
    );
}
