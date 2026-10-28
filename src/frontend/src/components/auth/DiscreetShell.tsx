"use client";

/**
 * 低調登入頁的外框（網站設定 → 登入 → 登入頁的樣子 = 低調）：只有「Telepy」、輪流打出來的句子和動態背景，旁邊是登入表單。
 * 不提任何遠端連線相關的字，路過的人只看得到一個叫 Telepy 的登入畫面。一般登入頁、OAuth 登入頁與設定頁的預覽共用。
 * 背景是一張 canvas（數學在 lib/discreetField.ts）：向日葵點陣（費馬螺旋）上由「Telepy」往外擴散的漣漪、兩條慢慢轉的軌道；
 * 字母浮出、句子的打字游標在 discreet.css。滑鼠（只有能 hover 的裝置、沒有要求減少動態時）：靠近的點被推開並亮起來、
 * 背景跟著滑鼠微微視差、字母被指到時跳起來，碰到「Telepy」時從字往外送出一圈波。
 * The discreet sign-in frame (Site settings → Sign-in → look = discreet): only "Telepy", lines typed in turn and a
 * moving background next to the form, with nothing about remote access, so a passer-by sees a sign-in page called
 * Telepy. Shared by the sign-in page, the OAuth sign-in page and the settings preview. The background is one canvas
 * (maths in lib/discreetField.ts): a ripple spreading from the word across a sunflower dot field and two slow orbits;
 * the rising letters and the typing caret live in discreet.css. With a mouse (hover-capable devices, no reduced
 * motion): nearby dots are pushed aside and light up, the background shifts slightly with the pointer, letters hop
 * when pointed at, and touching the word sends a ring out.
 */
import "./discreet.css";
import React, { useEffect, useRef } from "react";
import { AuthPrefs } from "@/components/auth/AuthShell";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTypewriter } from "@/hooks/useTypewriter";
import { useI18n } from "@/lib/i18n";
import {
    ALPHA_STEPS,
    BURST_SECS,
    DEPTH,
    FIELD_HALF,
    FIELD_RADIUS,
    ORBITS,
    PARALLAX_TAU,
    PUSH_TAU,
    alphaStep,
    approach,
    backingRatio,
    burst,
    dotTarget,
    fieldDots,
    orbitPoint,
    pulse,
    spinAngle,
    toField,
    wave,
} from "@/lib/discreetField";
import { messageLines } from "@/lib/signinLook";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";

const WORD = "Telepy";
const LINES: TranslationKey[] = ["discreet.line1", "discreet.line2", "discreet.line3"];
const BURST_EVENT = "dsc-burst";
const DOTS = fieldDots();

type CSSVars = React.CSSProperties & Record<`--${string}`, string | number>;

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
const TAU = Math.PI * 2;

/** 從設計 token 讀顏色（主題一換就重讀）。/ Colours from the design tokens (re-read when the theme changes). */
function readColors(doc: Document) {
    const probe = doc.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;color:var(--primary);background-color:var(--foreground)";
    doc.body.appendChild(probe);
    const cs = doc.defaultView!.getComputedStyle(probe);
    const colors = { primary: cs.color, foreground: cs.backgroundColor };
    probe.remove();
    return colors;
}

/** 外層 iframe 各自的縮放（設定頁的預覽框）。/ The scale of each enclosing iframe (the settings preview frames). */
function frameScales(win: Window): number[] {
    const out: number[] = [];
    try {
        let w: Window | null = win;
        while (w?.frameElement) {
            const f = w.frameElement as HTMLElement;
            if (f.offsetWidth) out.push(f.getBoundingClientRect().width / f.offsetWidth);
            w = f.ownerDocument.defaultView;
        }
    } catch {
        // 跨來源就不管。/ Cross-origin: ignore.
    }
    return out;
}

/**
 * 背景的繪圖迴圈：一張 canvas，每幀清掉重畫（點、閃光、波前、軌道、碰到字送出的波）。照螢幕實際像素畫（含預覽框的縮放），
 * 看不到時（捲走、分頁在背景）就停；減少動態 = 只畫一張靜止的。滑鼠：推開並點亮附近的點、視差，都用指數緩動跟上。
 * The background's draw loop: one canvas cleared and redrawn every frame (dots, flashes, wavefront, orbits, rings from
 * the word), at real screen pixels (the preview's scale included); it stops while out of sight (scrolled away, hidden
 * tab), and reduced motion draws one still frame. Pointer push / light and parallax follow with exponential easing.
 */
function runField(canvas: HTMLCanvasElement, host: HTMLElement, reduced: boolean): () => void {
    const doc = canvas.ownerDocument;
    const win = doc.defaultView;
    const ctx = canvas.getContext("2d");
    if (!win || !ctx) return () => {};

    const n = DOTS.length;
    /** 每點目前被推開多少、多亮（緩動中）。/ Each dot's current push and heat (eased). */
    const cur = new Float32Array(n * 3);
    const lit = new Uint8Array(n);
    const parallax = { fx: 0, fy: 0, layers: ORBITS.map(() => ({ x: 0, y: 0 })) };
    const bursts: number[] = [];
    let colors = readColors(doc);
    let ratio = 0;
    let pointer: { x: number; y: number } | null = null;
    let visible = true;
    let frame = 0;
    let frames = 0;
    const start = win.performance.now();
    let last = start;
    const size = FIELD_HALF * 2;

    const resize = () => {
        const r = backingRatio(win.devicePixelRatio, frameScales(win));
        if (Math.abs(r - ratio) < 0.01) return;
        ratio = r;
        canvas.width = Math.max(1, Math.round(size * r));
        canvas.height = canvas.width;
    };

    const circle = (path: Path2D, x: number, y: number, r: number) => {
        path.moveTo(x + r, y);
        path.arc(x, y, r, 0, TAU);
    };

    const draw = (now: number) => {
        const t = reduced ? 0 : (now - start) / 1000;
        const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
        last = now;
        if (++frames % 30 === 1) resize();

        // 視差與滑鼠在點陣裡的位置。/ Parallax and the pointer in the field's frame.
        let mx = 0;
        let my = 0;
        if (pointer) {
            const box = host.getBoundingClientRect();
            mx = clamp1(((pointer.x - box.left) / box.width) * 2 - 1);
            my = clamp1(((pointer.y - box.top) / box.height) * 2 - 1);
        }
        parallax.fx = approach(parallax.fx, -mx * DEPTH.field, dt, PARALLAX_TAU);
        parallax.fy = approach(parallax.fy, -my * DEPTH.field, dt, PARALLAX_TAU);
        ORBITS.forEach((o, i) => {
            const p = parallax.layers[i];
            p.x = approach(p.x, -mx * o.depth, dt, PARALLAX_TAU);
            p.y = approach(p.y, -my * o.depth, dt, PARALLAX_TAU);
        });
        const angle = spinAngle(t);
        let local: { x: number; y: number } | null = null;
        if (pointer) {
            const c = canvas.getBoundingClientRect();
            const scale = c.width / size || 1;
            local = toField((pointer.x - c.left) / scale - FIELD_HALF - parallax.fx, (pointer.y - c.top) / scale - FIELD_HALF - parallax.fy, angle);
        }
        while (bursts.length && (now - bursts[0]) / 1000 >= BURST_SECS) bursts.shift();
        const rings = bursts.flatMap((at) => {
            const b = burst((now - at) / 1000);
            return b ? [{ ...b, r: b.r * FIELD_RADIUS }] : [];
        });

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(ratio, 0, 0, ratio, (FIELD_HALF + parallax.fx) * ratio, (FIELD_HALF + parallax.fy) * ratio);

        // 點：同樣不透明度的一起畫。/ Dots, drawn together per opacity step.
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const base: (Path2D | undefined)[] = [];
        const flash: (Path2D | undefined)[] = [];
        const heated: number[] = [];
        for (let i = 0; i < n; i++) {
            const d = DOTS[i];
            const k = i * 3;
            if (pointer || rings.length || lit[i]) {
                const goal = dotTarget(d, local, rings);
                cur[k] = approach(cur[k], goal.x, dt, PUSH_TAU);
                cur[k + 1] = approach(cur[k + 1], goal.y, dt, PUSH_TAU);
                cur[k + 2] = approach(cur[k + 2], goal.heat, dt, PUSH_TAU);
                const settled = goal.heat === 0 && cur[k + 2] < 0.004 && Math.abs(cur[k]) < 0.05 && Math.abs(cur[k + 1]) < 0.05;
                if (settled) cur[k] = cur[k + 1] = cur[k + 2] = 0;
                lit[i] = settled ? 0 : 1;
            }
            const px = d.x + cur[k];
            const py = d.y + cur[k + 1];
            const x = px * cos - py * sin;
            const y = px * sin + py * cos;
            const h = cur[k + 2];
            const a = Math.max(d.o, h);
            const grow = 1 + h * 1.2;
            if (h > 0.01) heated.push(i);
            const step = alphaStep(0.24 * a * (1 - h));
            if (step) circle((base[step] ??= new Path2D()), x, y, 1.5 * grow);
            if (!reduced) {
                const p = pulse(t, d.delay);
                const fs = alphaStep(p.alpha * a);
                if (fs) circle((flash[fs] ??= new Path2D()), x, y, 2 * p.scale * grow);
            }
        }
        ctx.fillStyle = colors.foreground;
        base.forEach((path, step) => {
            if (!path) return;
            ctx.globalAlpha = step / ALPHA_STEPS;
            ctx.fill(path);
        });
        // 被滑鼠或波點亮的點：疊上主色（跟原本的 color-mix 一樣，越熱越橘）。/ Lit dots: primary on top, more with heat.
        ctx.fillStyle = colors.primary;
        for (const i of heated) {
            const d = DOTS[i];
            const k = i * 3;
            const h = cur[k + 2];
            const px = d.x + cur[k];
            const py = d.y + cur[k + 1];
            ctx.globalAlpha = Math.min(1, h * Math.max(d.o, h));
            ctx.beginPath();
            ctx.arc(px * cos - py * sin, px * sin + py * cos, 1.5 * (1 + h * 1.2), 0, TAU);
            ctx.fill();
        }
        flash.forEach((path, step) => {
            if (!path) return;
            ctx.globalAlpha = step / ALPHA_STEPS;
            ctx.fill(path);
        });

        // 波前。/ The wavefront.
        const w = reduced ? null : wave(t);
        ctx.strokeStyle = colors.primary;
        if (w) {
            ctx.globalAlpha = w.alpha * 0.6;
            ctx.lineWidth = Math.max(0.2, w.r);
            ctx.beginPath();
            ctx.arc(0, 0, w.r * FIELD_RADIUS, 0, TAU);
            ctx.stroke();
        }

        // 兩條軌道。/ The orbits.
        ORBITS.forEach((o, i) => {
            const p = parallax.layers[i];
            const at = orbitPoint(o.r, o.period, t);
            ctx.globalAlpha = 0.1;
            ctx.strokeStyle = colors.foreground;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(p.x, p.y, o.r, 0, TAU);
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.fillStyle = o.color === "primary" ? colors.primary : colors.foreground;
            ctx.beginPath();
            ctx.arc(p.x + at.x, p.y + at.y, o.dot, 0, TAU);
            ctx.fill();
        });

        // 碰到字送出的波。/ Rings sent from the word.
        ctx.strokeStyle = colors.primary;
        for (const ring of rings) {
            ctx.globalAlpha = ring.alpha;
            ctx.lineWidth = Math.max(0.2, 1.5 * (ring.r / FIELD_RADIUS));
            ctx.beginPath();
            ctx.arc(0, 0, ring.r, 0, TAU);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    };

    const loop = (now: number) => {
        frame = 0;
        draw(now);
        if (!reduced && visible) frame = win.requestAnimationFrame(loop);
    };
    const kick = () => {
        if (!frame) frame = win.requestAnimationFrame(loop);
    };

    resize();
    kick();

    // 看不到就停（設定頁捲走、預覽框在畫面外）。/ Stop while out of sight (settings scrolled away, frame off screen).
    const io = new win.IntersectionObserver((entries) => {
        visible = entries.some((e) => e.isIntersecting);
        if (visible) {
            last = win.performance.now();
            kick();
        } else if (frame) {
            win.cancelAnimationFrame(frame);
            frame = 0;
        }
    });
    io.observe(canvas);
    // 換主題（含預覽框同步過去的 class）：重讀顏色。/ Theme changes (also mirrored into preview frames): re-read colours.
    const mo = new win.MutationObserver(() => {
        colors = readColors(doc);
        kick();
    });
    mo.observe(doc.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    const onResize = () => {
        resize();
        kick();
    };
    win.addEventListener("resize", onResize);

    // 滑鼠互動：只有能 hover 的裝置、沒有要求減少動態時。/ Pointer effects: hover-capable devices, no reduced motion.
    const hover = !reduced && win.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const onMove = (e: PointerEvent) => {
        if (e.pointerType !== "touch") pointer = { x: e.clientX, y: e.clientY };
    };
    const onLeave = () => {
        pointer = null;
    };
    const onBurst = () => {
        bursts.push(win.performance.now());
    };
    if (hover) {
        host.addEventListener("pointermove", onMove);
        host.addEventListener("pointerleave", onLeave);
        host.addEventListener(BURST_EVENT, onBurst);
    }

    return () => {
        win.cancelAnimationFrame(frame);
        frame = 0;
        io.disconnect();
        mo.disconnect();
        win.removeEventListener("resize", onResize);
        host.removeEventListener("pointermove", onMove);
        host.removeEventListener("pointerleave", onLeave);
        host.removeEventListener(BURST_EVENT, onBurst);
    };
}

/** 背景：一張 canvas（只是裝飾）。/ The background: one canvas (decoration only). */
function DiscreetArt({ host }: { host: React.RefObject<HTMLDivElement | null> }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const reduced = useReducedMotion();
    useEffect(() => {
        if (!host.current || !canvas.current) return;
        return runField(canvas.current, host.current, reduced);
    }, [host, reduced]);
    return <canvas ref={canvas} className="dsc-canvas" style={{ "--half": `${FIELD_HALF}px` } as CSSVars} aria-hidden />;
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

export function DiscreetShell({
    message,
    pin = null,
    wide = false,
    children,
}: {
    message: string;
    /** 預覽正在看哪一句。/ The line the preview shows. */
    pin?: number | null;
    /** 內容多的頁面（授權頁）用寬一點的卡片。/ A wider card for content-heavy pages (the approval page). */
    wide?: boolean;
    children: React.ReactNode;
}) {
    const root = useRef<HTMLDivElement>(null);
    // overflow-clip（不是 hidden）：裁掉超出的背景，但不變成捲動容器，授權頁黏在底部的決定列才會跟著視窗。
    // overflow-clip, not hidden: clips the background without becoming a scroll container, so the approval page's
    // sticky decision bar follows the viewport.
    return (
        <div ref={root} className="relative flex min-h-screen flex-col overflow-clip bg-background text-foreground">
            {/* 頁首在版面裡（不是浮在上面）：表單再高也不會壓到語言 / 主題切換。/ In the flow, so a tall form never covers it. */}
            <header className="relative z-10 flex justify-end p-4 sm:p-6">
                <AuthPrefs />
            </header>

            <div
                className={cn(
                    "relative mx-auto grid w-full max-w-6xl flex-1 grid-cols-[minmax(0,1fr)] content-center items-center gap-10 px-4 pb-12 pt-6 sm:px-8 lg:gap-16 lg:px-12 lg:pb-14 lg:pt-2",
                    wide ? "lg:grid-cols-[minmax(0,1fr)_32rem]" : "lg:grid-cols-[minmax(0,1fr)_24rem]",
                )}
            >
                <section className="dsc-hero flex flex-col items-center gap-5 text-center lg:items-start lg:text-left">
                    <div className="relative">
                        <DiscreetArt host={root} />
                        <Wordmark />
                    </div>
                    <span className="dsc-rule" aria-hidden />
                    <Tagline message={message} pin={pin} />
                </section>

                <div
                    className={cn(
                        "relative w-full justify-self-center animate-fade-in-up rounded-xl border border-border bg-card p-6 shadow-card sm:p-8 lg:justify-self-end",
                        wide ? "max-w-lg" : "max-w-sm",
                    )}
                >
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
