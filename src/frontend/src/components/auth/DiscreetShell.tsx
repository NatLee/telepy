"use client";

/**
 * 低調登入頁的外框（網站設定 → 登入 → 登入頁的樣子 = 低調）：只有「Telepy」、輪流打出來的句子和動態背景，旁邊是登入表單。
 * 不提任何遠端連線相關的字，路過的人只看得到一個叫 Telepy 的登入畫面。一般登入頁、OAuth 登入頁與設定頁的預覽共用。
 * 動畫在 discreet.css：向日葵點陣（費馬螺旋）上由「Telepy」往外擴散的漣漪、兩條慢慢轉的軌道、字母浮出、句子的打字游標。
 * 滑鼠（只有能 hover 的裝置、沒有要求減少動態時）：靠近的點被推開並亮起來、背景跟著滑鼠微微視差、字母被指到時跳起來，
 * 碰到「Telepy」時從字往外送出一圈波。
 * The discreet sign-in frame (Site settings → Sign-in → look = discreet): only "Telepy", lines typed in turn and a
 * moving background next to the form, with nothing about remote access, so a passer-by sees a sign-in page called
 * Telepy. Shared by the sign-in page, the OAuth sign-in page and the settings preview. The motion lives in
 * discreet.css: a ripple spreading from the word across a sunflower dot field, two slow orbits, rising letters and the
 * typing caret. With a mouse (hover-capable devices, no reduced motion): nearby dots are pushed aside and light up, the
 * background shifts slightly with the pointer, letters hop when pointed at, and touching the word sends a ring out.
 */
import "./discreet.css";
import React, { useEffect, useMemo, useRef } from "react";
import { AuthPrefs } from "@/components/auth/AuthShell";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTypewriter } from "@/hooks/useTypewriter";
import { useI18n } from "@/lib/i18n";
import { messageLines, sunflower, type SunflowerDot } from "@/lib/signinLook";
import type { TranslationKey } from "@/locales/en";

const WORD = "Telepy";
const FIELD_RADIUS = 380;
const FIELD_DOTS = 420;
/** 漣漪走完半徑的時間（秒），跟 discreet.css 的波前一致。/ Seconds for the ripple to cross the radius (matches the wavefront). */
const RIPPLE_SECS = 2.4;
const LINES: TranslationKey[] = ["discreet.line1", "discreet.line2", "discreet.line3"];
/** 滑鼠推開點的範圍與力道（px）。/ How far from the pointer dots are pushed, and how hard (px). */
const PUSH_RADIUS = 120;
const PUSH = 26;
/** 碰到「Telepy」送出的那圈波：多久走完、多寬、把點往外推多少（跟 discreet.css 的 .dsc-burst 一致）。/ The ring sent from the word. */
const BURST_MS = 2200;
const BURST_BAND = 34;
const BURST_PUSH = 9;
const BURST_EVENT = "dsc-burst";
/** 視差：點陣、內外兩條軌道跟滑鼠反方向各移多少（px）。/ Parallax per layer, against the pointer (px). */
const DEPTH = { field: 10, inner: 7, outer: 15 };

type CSSVars = React.CSSProperties & Record<`--${string}`, string | number>;

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
/** 跟 CSS 的 cubic-bezier(0.33, 1, 0.68, 1)（easeOutCubic）一樣。/ Matches the ring's CSS easing. */
const easeOut = (p: number) => 1 - (1 - p) ** 3;

/**
 * 滑鼠互動：推開並點亮附近的點（點陣在慢慢轉，所以把滑鼠位置轉回點陣自己的座標）、視差、碰到字時的那圈波。
 * 只在有滑鼠移動、有點被推開或波還在走時才逐格更新；滑鼠停著不動時改成每 150 ms 一次（點陣轉得很慢）。
 * Pointer effects: push and light nearby dots (the field turns, so the pointer is rotated into its frame), parallax,
 * and the ring from the word. Frames run only while the pointer moves, dots are pushed or a ring travels; a resting
 * pointer updates every 150 ms (the field turns slowly).
 */
function attachPointer(root: HTMLElement, field: HTMLElement, spin: HTMLElement, layers: [HTMLElement | null, number][], dots: SunflowerDot[]) {
    const win = root.ownerDocument.defaultView;
    if (!win || !win.matchMedia("(hover: hover) and (pointer: fine)").matches) return () => {};
    const els = Array.from(spin.querySelectorAll<HTMLElement>(".dsc-dot"));
    const radius = dots.map((d) => Math.hypot(d.x, d.y));
    const written = new Map<number, string>();
    let pointer: { x: number; y: number } | null = null;
    let lastMove = 0;
    let bursts: number[] = [];
    let frame = 0;
    let timer = 0;

    const angle = () => {
        const tf = win.getComputedStyle(spin).transform;
        if (!tf || tf === "none") return 0;
        const m = new DOMMatrixReadOnly(tf);
        return Math.atan2(m.b, m.a);
    };
    const reset = (i: number) => {
        const s = els[i]?.style;
        s?.removeProperty("--px");
        s?.removeProperty("--py");
        s?.removeProperty("--h");
    };

    const draw = () => {
        frame = 0;
        const now = win.performance.now();
        const box = root.getBoundingClientRect();
        const mx = pointer ? clamp1(((pointer.x - box.left) / box.width) * 2 - 1) : 0;
        const my = pointer ? clamp1(((pointer.y - box.top) / box.height) * 2 - 1) : 0;
        for (const [el, depth] of layers) if (el) el.style.translate = `${(-mx * depth).toFixed(1)}px ${(-my * depth).toFixed(1)}px`;

        bursts = bursts.filter((t) => now - t < BURST_MS);
        const rings = bursts.map((t) => {
            const p = (now - t) / BURST_MS;
            return { r: easeOut(p) * FIELD_RADIUS, fade: 1 - p };
        });
        let local: { x: number; y: number } | null = null;
        if (pointer) {
            const c = field.getBoundingClientRect();
            const a = -angle();
            const dx = pointer.x - c.left;
            const dy = pointer.y - c.top;
            local = { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
        }

        const live = new Set<number>();
        dots.forEach((d, i) => {
            let px = 0;
            let py = 0;
            let heat = 0;
            if (local) {
                const ox = d.x - local.x;
                const oy = d.y - local.y;
                const dist = Math.hypot(ox, oy);
                if (dist < PUSH_RADIUS) {
                    const f = 1 - dist / PUSH_RADIUS;
                    const k = (PUSH * f * f) / Math.max(dist, 0.001);
                    px += ox * k;
                    py += oy * k;
                    heat = f;
                }
            }
            for (const ring of rings) {
                const g = Math.max(0, 1 - Math.abs(radius[i] - ring.r) / BURST_BAND) * ring.fade;
                if (g <= 0 || radius[i] < 1) continue;
                px += (d.x / radius[i]) * BURST_PUSH * g;
                py += (d.y / radius[i]) * BURST_PUSH * g;
                heat = Math.max(heat, g);
            }
            if (heat < 0.02) return;
            live.add(i);
            const value = `${px.toFixed(1)}|${py.toFixed(1)}|${heat.toFixed(2)}`;
            if (written.get(i) === value) return;
            written.set(i, value);
            const s = els[i].style;
            s.setProperty("--px", `${px.toFixed(1)}px`);
            s.setProperty("--py", `${py.toFixed(1)}px`);
            s.setProperty("--h", heat.toFixed(2));
        });
        for (const i of [...written.keys()]) {
            if (live.has(i)) continue;
            written.delete(i);
            reset(i);
        }

        if (bursts.length || now - lastMove < 300) frame = win.requestAnimationFrame(draw);
        else if (written.size) timer = win.setTimeout(schedule, 150);
    };
    function schedule() {
        win!.clearTimeout(timer);
        timer = 0;
        if (!frame) frame = win!.requestAnimationFrame(draw);
    }

    const onMove = (e: PointerEvent) => {
        if (e.pointerType === "touch") return;
        pointer = { x: e.clientX, y: e.clientY };
        lastMove = win.performance.now();
        schedule();
    };
    const onLeave = () => {
        pointer = null;
        schedule();
    };
    const onBurst = () => {
        bursts.push(win.performance.now());
        const ring = win.document.createElement("span");
        ring.className = "dsc-burst";
        ring.style.setProperty("--R", `${FIELD_RADIUS}px`);
        ring.addEventListener("animationend", () => ring.remove(), { once: true });
        field.appendChild(ring);
        schedule();
    };

    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener(BURST_EVENT, onBurst);
    return () => {
        root.removeEventListener("pointermove", onMove);
        root.removeEventListener("pointerleave", onLeave);
        root.removeEventListener(BURST_EVENT, onBurst);
        win.cancelAnimationFrame(frame);
        win.clearTimeout(timer);
        written.forEach((_, i) => reset(i));
        for (const [el] of layers) el?.style.removeProperty("translate");
        field.querySelectorAll(".dsc-burst").forEach((n) => n.remove());
    };
}

/** 背景：向日葵點陣 + 波前 + 兩條軌道（只是裝飾）。/ The background: sunflower dots, wavefront and two orbits. */
function DiscreetArt({ host }: { host: React.RefObject<HTMLDivElement | null> }) {
    const dots = useMemo(() => sunflower(FIELD_DOTS, FIELD_RADIUS), []);
    const field = useRef<HTMLDivElement>(null);
    const spin = useRef<HTMLDivElement>(null);
    const inner = useRef<HTMLSpanElement>(null);
    const outer = useRef<HTMLSpanElement>(null);
    const reduced = useReducedMotion();

    useEffect(() => {
        if (reduced || !host.current || !field.current || !spin.current) return;
        return attachPointer(
            host.current,
            field.current,
            spin.current,
            [
                [field.current, DEPTH.field],
                [inner.current, DEPTH.inner],
                [outer.current, DEPTH.outer],
            ],
            dots,
        );
    }, [host, dots, reduced]);

    return (
        <div ref={field} className="dsc-field" aria-hidden>
            <div ref={spin} className="dsc-spin">
                {dots.map((d, i) => (
                    <span
                        key={i}
                        className="dsc-dot"
                        style={
                            {
                                "--x": `${d.x}px`,
                                "--y": `${d.y}px`,
                                // 外圈淡出；中心那幾點被字蓋住，也淡一點。/ Fade toward the rim and under the word.
                                "--o": (d.t < 0.12 ? 0.35 : d.t > 0.6 ? Math.max(0, 1 - (d.t - 0.6) / 0.4) : 1).toFixed(2),
                                "--d": `${(d.t * RIPPLE_SECS).toFixed(2)}s`,
                            } as CSSVars
                        }
                    />
                ))}
            </div>
            <span className="dsc-wave" style={{ "--R": `${FIELD_RADIUS}px` } as CSSVars} />
            <span ref={inner} className="dsc-orbit" style={{ "--r": "232px", "--period": "38s" } as CSSVars} />
            <span ref={outer} className="dsc-orbit" style={{ "--r": "318px", "--period": "64s", "--dir": "reverse", "--c": "var(--foreground)", "--size": "5px" } as CSSVars} />
        </div>
    );
}

/**
 * 「Telepy」：每個字母各自浮出；滑鼠指到的字母跳起來（discreet.css），碰到字時通知背景送出一圈波（最多 1.2 秒一次）。
 * The word, letter by letter; the pointed-at letter hops (discreet.css), and touching the word asks the background
 * for a ring (at most every 1.2 s).
 */
function Wordmark() {
    const last = useRef(0);
    const onEnter = (e: React.PointerEvent<HTMLHeadingElement>) => {
        if (e.pointerType === "touch" || e.timeStamp - last.current < 1200) return;
        last.current = e.timeStamp;
        e.currentTarget.dispatchEvent(new Event(BURST_EVENT, { bubbles: true }));
    };
    return (
        <h1 className="dsc-word relative text-[clamp(3.75rem,15vw,8.5rem)] leading-none tracking-tight text-foreground" aria-label={WORD} onPointerEnter={onEnter}>
            <span className="inline-flex" aria-hidden>
                {[...WORD].map((ch, i) => (
                    <span key={i} className="dsc-char">
                        <span className="dsc-lift">
                            <span style={{ "--i": i } as CSSVars}>{ch}</span>
                        </span>
                    </span>
                ))}
            </span>
        </h1>
    );
}

/**
 * 句子：管理員寫的（一行一句），或內建的三句問候語（跟著訪客的語言）。兩句以上 = 打出來、停一下、刪掉、換下一句；
 * 一句 = 打完留著。每一句都疊在同一格裡（看不見），所以高度是最長那句，打字、換句時版面不會跳。
 * `pin` = 設定頁正在編輯的那句：預覽只打那一句，跟著改。
 * The lines: the admin's (one per line) or the three built-in greetings (in the visitor's language). Two or more are
 * typed, held, erased and replaced in turn; a single one is typed and kept. Every line sits invisibly in the same
 * cell, so the height is the longest line's and nothing shifts while typing or switching lines. `pin` = the line being
 * edited in the settings: the preview types only that one, following the edits.
 */
function Tagline({ message, pin }: { message: string; pin: number | null }) {
    const { t } = useI18n();
    const reduced = useReducedMotion();
    const own = messageLines(message);
    const lines = own.length ? own : LINES.map((key) => t(key));
    const { text, caret } = useTypewriter(lines, pin !== null && pin < lines.length ? pin : null, !reduced);
    return (
        <div className="max-w-md text-lg leading-relaxed text-muted-foreground">
            <p className="sr-only">{lines.join(" ")}</p>
            <p className="dsc-type" aria-hidden>
                {lines.map((line, i) => (
                    <span key={i} className="dsc-type-sizer">
                        {line}
                    </span>
                ))}
                <span className="dsc-type-live">
                    {text}
                    {caret && <span className="dsc-caret" data-caret={caret} />}
                </span>
            </p>
        </div>
    );
}

export function DiscreetShell({ message, pin = null, children }: { message: string; /** 預覽正在看哪一句。/ The line the preview shows. */ pin?: number | null; children: React.ReactNode }) {
    const root = useRef<HTMLDivElement>(null);
    return (
        <div ref={root} className="relative flex min-h-screen flex-col overflow-hidden bg-background text-foreground">
            {/* 頁首在版面裡（不是浮在上面）：表單再高也不會壓到語言 / 主題切換。/ In the flow, so a tall form never covers it. */}
            <header className="relative z-10 flex justify-end p-4 sm:p-6">
                <AuthPrefs />
            </header>

            <div className="relative mx-auto grid w-full max-w-6xl flex-1 grid-cols-[minmax(0,1fr)] content-center items-center gap-10 px-4 pb-12 pt-6 sm:px-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-16 lg:px-12 lg:pb-14 lg:pt-2">
                <section className="dsc-hero flex flex-col items-center gap-5 text-center lg:items-start lg:text-left">
                    <div className="relative">
                        <DiscreetArt host={root} />
                        <Wordmark />
                    </div>
                    <span className="dsc-rule" aria-hidden />
                    <Tagline message={message} pin={pin} />
                </section>

                <div className="relative w-full max-w-sm justify-self-center animate-fade-in-up rounded-xl border border-border bg-card p-6 shadow-card sm:p-8 lg:justify-self-end">
                    {children}
                </div>
            </div>
        </div>
    );
}

/**
 * 還不知道要畫哪個樣子時（第一次來、快取還沒有）：只有底色，超過半秒才出現小轉圈。靜態 HTML 就是這個畫面，
 * 兩種樣子都一樣，所以 HTML 裡不會有產品介紹。
 * While the look is unknown (first visit, nothing cached): just the surface, a small spinner after half a second.
 * This is what the static HTML holds for both looks, so the HTML never carries the product description.
 */
export function SignInPending() {
    return (
        <div className="grid min-h-screen place-items-center bg-background">
            <span className="dsc-pending" aria-hidden>
                <span className="block size-6 animate-spin rounded-full border-2 border-border border-t-primary" />
            </span>
        </div>
    );
}
