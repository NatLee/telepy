"use client";

/**
 * Tapi 版登入頁的外框（網站設定 → 登入 → Tapi）：整頁是一杯奶茶，像素粉圓從底下慢慢浮上來（滑鼠靠近會被攪開，點背景會冒出
 * 一把），Tapi 在旁邊陪你登入，頭上的對話框輪流打出句子（管理員寫的或內建的），下面是像素字標。Tapi 跟著表單反應：
 * 打帳號時開心地盯著看（每打一個字跳一下）、輸入密碼時轉過身「我不看」、按了顯示密碼會嚇一跳、送出時想一下、
 * 失敗驚訝、成功開心跳；滑鼠停在身上會揮手、戳它會開心，太久沒人理會睡著。一般登入頁、OAuth / CLI 登入頁與設定頁的預覽共用。
 * 粉圓畫在一張 canvas（數學在 lib/tapiStage.ts）；Tapi 與字標是 SVG 像素圖；動作在 tapi.css。
 * The Tapi sign-in frame (Site settings → Sign-in → Tapi): the page is a cup of milk tea with pixel tapioca pearls
 * rising through it (a mouse stirs them aside, a click on the background releases a handful), Tapi keeps you company
 * with a speech bubble typing the lines (the admin's or the built-in ones), and a pixel wordmark sits below. Tapi
 * follows the form: happily watching while you type the username (a hop per character), turned around while you type
 * the password, startled when the password is shown, thinking while signing in, surprised on a failure and jumping on
 * success; it waves when the pointer rests on it, beams when poked and falls asleep when left alone. Shared by the
 * sign-in page, the OAuth / CLI sign-in page and the settings preview. The pearls are one canvas (maths in
 * lib/tapiStage.ts); Tapi and the wordmark are SVG pixel art; the moves live in tapi.css.
 */
import "./discreet.css";
import "./tapi.css";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthPrefs } from "@/components/auth/AuthShell";
import { useMeasuringPreview } from "@/components/ui/preview-frame";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTapi } from "@/hooks/useTapi";
import { useTypewriter } from "@/hooks/useTypewriter";
import { useI18n } from "@/lib/i18n";
import { dressTapi, pixelRuns, spriteSize } from "@/lib/mascot";
import { onSignIn } from "@/lib/signInSignal";
import { messageLines } from "@/lib/signinLook";
import {
    FLASH_MS,
    MOOD_MOTION,
    PEARL_LAYERS,
    PEARL_PALETTE,
    PEARL_SPRITE,
    SLEEP_AFTER_SECS,
    WORD_PALETTE,
    makePearls,
    moodFor,
    moodLine,
    moodSprite,
    pearlAt,
    pearlCount,
    pixelWord,
    type TapiFlash,
    type TapiFocus,
    type TapiMood,
} from "@/lib/tapiStage";
import type { TranslationKey } from "@/locales/en";

const LINES: TranslationKey[] = ["discreet.line1", "discreet.line2", "discreet.line3"];
const MOOD_TEXT: Record<Exclude<TapiMood, "idle" | "sleepy">, TranslationKey> = {
    watching: "tapiLook.watching",
    shy: "tapiLook.shy",
    peek: "tapiLook.peek",
    thinking: "tapiLook.thinking",
    oops: "tapiLook.oops",
    yay: "tapiLook.yay",
    mfa: "tapiLook.mfa",
    wave: "tapiLook.wave",
    poke: "tapiLook.poke",
};
const PLOP_EVENT = "tapi-plop";
const WORD = pixelWord("Telepy");

type CSSVars = React.CSSProperties & Record<`--${string}`, string | number>;

/* ── 粉圓 / The pearls ───────────────────────────────────────── */

/** 一顆粉圓先畫在小 canvas 上（每層、每個主題、每個解析度一張）。/ A pearl pre-drawn per layer, theme and resolution. */
function pearlImage(doc: Document, unit: number, ratio: number, palette: Record<string, string>): HTMLCanvasElement {
    const c = doc.createElement("canvas");
    const px = Math.max(1, Math.round(unit * ratio));
    c.width = c.height = px * 8;
    const g = c.getContext("2d")!;
    PEARL_SPRITE.forEach((row, y) =>
        [...row].forEach((ch, x) => {
            const fill = palette[ch];
            if (!fill) return;
            g.fillStyle = fill;
            g.fillRect(x * px, y * px, px, px);
        }),
    );
    return c;
}

interface Plop {
    x: number;
    y: number;
    vx: number;
    vy: number;
    born: number;
    layer: 1 | 2;
}

/**
 * 背景的繪圖迴圈：一張 canvas 鋪滿整頁，每幀把粉圓畫在對齊像素的位置；看不到就停（捲走、分頁在背景），減少動態 = 畫一張靜止的。
 * 滑鼠（能 hover 的裝置）：附近的粉圓被推開；點背景：從那裡冒出一把往上浮的粉圓。
 * The background loop: one canvas over the page, pearls drawn on pixel-aligned spots every frame; it stops while out
 * of sight (scrolled away, hidden tab) and reduced motion draws a single still frame. A mouse (hover devices) pushes
 * nearby pearls aside; a click on the background releases a handful that float up from there.
 */
function runTea(canvas: HTMLCanvasElement, host: HTMLElement, reduced: boolean): () => void {
    const doc = canvas.ownerDocument;
    const win = doc.defaultView;
    const ctx = canvas.getContext("2d");
    if (!win || !ctx) return () => {};

    let width = 0;
    let height = 0;
    let ratio = 1;
    let pearls = makePearls(0);
    let push = new Float32Array(0);
    let dark = doc.documentElement.classList.contains("dark");
    let images: HTMLCanvasElement[] = [];
    let pointer: { x: number; y: number } | null = null;
    const plops: Plop[] = [];
    let visible = true;
    let frame = 0;
    const start = win.performance.now();
    let last = start;

    const paint = () => {
        const palette = PEARL_PALETTE[dark ? "dark" : "light"];
        images = PEARL_LAYERS.map((l) => pearlImage(doc, l.unit, ratio, palette));
    };
    const resize = () => {
        const w = host.clientWidth;
        const h = host.clientHeight;
        const r = Math.min(2, Math.max(1, win.devicePixelRatio || 1));
        if (w === width && h === height && r === ratio && images.length) return;
        const recount = w !== width || h !== height;
        width = w;
        height = h;
        if (r !== ratio || !images.length) {
            ratio = r;
            paint();
        }
        canvas.width = Math.max(1, Math.round(w * ratio));
        canvas.height = Math.max(1, Math.round(h * ratio));
        if (recount) {
            pearls = makePearls(pearlCount(w, h));
            push = new Float32Array(pearls.length * 2);
        }
    };

    const draw = (now: number) => {
        const t = reduced ? 30 : (now - start) / 1000;
        const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
        last = now;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = false;
        const box = host.getBoundingClientRect();
        const local = pointer ? { x: pointer.x - box.left, y: pointer.y - box.top } : null;
        const ease = 1 - Math.exp(-dt / 0.25);
        // 後面的先畫。/ Back layers first.
        for (const layer of [0, 1, 2] as const) {
            const l = PEARL_LAYERS[layer];
            const img = images[layer];
            ctx.globalAlpha = l.alpha;
            pearls.forEach((p, i) => {
                if (p.layer !== layer) return;
                const at = pearlAt(p, t, width, height);
                let gx = 0;
                let gy = 0;
                if (local) {
                    const cx = at.x + at.size / 2 - local.x;
                    const cy = at.y + at.size / 2 - local.y;
                    const d = Math.hypot(cx, cy);
                    const reach = 130;
                    if (d < reach && d > 0.01) {
                        const k = ((reach - d) / reach) * 46 * (0.5 + layer * 0.35);
                        gx = (cx / d) * k;
                        gy = (cy / d) * k;
                    }
                }
                push[i * 2] += (gx - push[i * 2]) * ease;
                push[i * 2 + 1] += (gy - push[i * 2 + 1]) * ease;
                const x = Math.round((at.x + push[i * 2]) / l.unit) * l.unit;
                const y = Math.round((at.y + push[i * 2 + 1]) / l.unit) * l.unit;
                ctx.drawImage(img, Math.round(x * ratio), Math.round(y * ratio));
            });
        }
        // 點出來的那把：往上浮、慢慢淡掉。/ The released handful: floating up and fading.
        for (let i = plops.length - 1; i >= 0; i--) {
            const p = plops[i];
            const age = (now - p.born) / 1000;
            if (age > 2.4) {
                plops.splice(i, 1);
                continue;
            }
            p.vy -= 60 * dt;
            p.vx *= 1 - dt * 1.5;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            const l = PEARL_LAYERS[p.layer];
            ctx.globalAlpha = Math.max(0, Math.min(1, 1.4 - age / 1.7)) * l.alpha;
            const x = Math.round(p.x / l.unit) * l.unit;
            const y = Math.round(p.y / l.unit) * l.unit;
            ctx.drawImage(images[p.layer], Math.round(x * ratio), Math.round(y * ratio));
        }
        ctx.globalAlpha = 1;
    };

    const loop = (now: number) => {
        frame = 0;
        draw(now);
        if ((!reduced || plops.length) && visible) frame = win.requestAnimationFrame(loop);
    };
    const kick = () => {
        if (!frame) frame = win.requestAnimationFrame(loop);
    };

    resize();
    kick();

    const ro = new win.ResizeObserver(() => {
        resize();
        kick();
    });
    ro.observe(host);
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
    // 換主題（含預覽框同步過去的 class）：重畫粉圓的顏色。/ Theme changes (preview frames too): repaint the pearls.
    const mo = new win.MutationObserver(() => {
        const next = doc.documentElement.classList.contains("dark");
        if (next === dark) return;
        dark = next;
        paint();
        kick();
    });
    mo.observe(doc.documentElement, { attributes: true, attributeFilter: ["class"] });

    const hover = !reduced && win.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const onMove = (e: PointerEvent) => {
        if (e.pointerType !== "touch") pointer = { x: e.clientX, y: e.clientY };
    };
    const onLeave = () => {
        pointer = null;
    };
    const onPlop = (e: Event) => {
        if (reduced) return;
        const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail;
        const box = host.getBoundingClientRect();
        const now = win.performance.now();
        for (let k = 0; k < 9; k++) {
            const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
            const speed = 90 + Math.random() * 120;
            plops.push({ x: x - box.left - 16, y: y - box.top - 16, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, born: now, layer: Math.random() < 0.5 ? 1 : 2 });
        }
        if (plops.length > 60) plops.splice(0, plops.length - 60);
        kick();
    };
    if (hover) {
        host.addEventListener("pointermove", onMove);
        host.addEventListener("pointerleave", onLeave);
    }
    host.addEventListener(PLOP_EVENT, onPlop);

    return () => {
        win.cancelAnimationFrame(frame);
        frame = 0;
        ro.disconnect();
        io.disconnect();
        mo.disconnect();
        host.removeEventListener("pointermove", onMove);
        host.removeEventListener("pointerleave", onLeave);
        host.removeEventListener(PLOP_EVENT, onPlop);
    };
}

function Tea({ host }: { host: React.RefObject<HTMLDivElement | null> }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const reduced = useReducedMotion();
    const measuring = useMeasuringPreview();
    useEffect(() => {
        if (!host.current || !canvas.current) return;
        return runTea(canvas.current, host.current, reduced);
    }, [host, reduced]);
    if (measuring) return null;
    return <canvas ref={canvas} className="tapi-tea" aria-hidden />;
}

/** 從某個點冒出一把粉圓（Tea 在聽）。/ Release a handful of pearls from a point (Tea listens). */
function plop(from: Element, x: number, y: number) {
    from.dispatchEvent(new CustomEvent(PLOP_EVENT, { bubbles: true, detail: { x, y } }));
}

/* ── Tapi 的心情 / Tapi's mood ───────────────────────────────── */

/** 焦點在表單的哪裡（密碼欄旁邊的顯示按鈕也算密碼）。/ Where focus sits in the form (the show-password toggle counts as password). */
function focusOf(card: HTMLElement): { focus: TapiFocus; shown: boolean } {
    const el = card.ownerDocument.activeElement as HTMLElement | null;
    if (!el || !card.contains(el)) return { focus: null, shown: false };
    const pw = card.querySelector<HTMLInputElement>("#login-password");
    if (pw && (el === pw || el.parentElement === pw.parentElement)) return { focus: "password", shown: pw.type === "text" };
    if (el.id === "login-username") return { focus: "username", shown: false };
    if (el instanceof HTMLInputElement && el.autocomplete === "one-time-code") return { focus: "code", shown: false };
    return { focus: "other", shown: false };
}

/**
 * 跟著表單決定心情：焦點、密碼有沒有顯示、送出中、登入結果（lib/signInSignal）、滑鼠在不在 Tapi 身上、多久沒動。
 * Works out the mood from the form: focus, whether the password is shown, signing in, the result
 * (lib/signInSignal), the pointer on Tapi and how long nothing happened.
 */
function useTapiMood(card: React.RefObject<HTMLDivElement | null>, root: React.RefObject<HTMLDivElement | null>) {
    const [where, setWhere] = useState<{ focus: TapiFocus; shown: boolean }>({ focus: null, shown: false });
    const [submitting, setSubmitting] = useState(false);
    const [flash, setFlash] = useState<TapiFlash | null>(null);
    const [hovering, setHovering] = useState(false);
    // 只記睡著了沒（不是秒數），整頁才不會每 5 秒重畫一次。/ Only asleep or not (not seconds), so the page doesn't re-render every 5 s.
    const [asleep, setAsleep] = useState(false);
    const [hops, setHops] = useState(0);
    const lastActive = useRef(0);

    const touch = useCallback(() => {
        lastActive.current = Date.now();
        setAsleep(false);
    }, []);
    const react = useCallback((f: TapiFlash) => setFlash(f), []);

    useEffect(() => {
        if (!flash) return;
        const timer = setTimeout(() => setFlash(null), FLASH_MS[flash]);
        return () => clearTimeout(timer);
    }, [flash]);

    // 送出卡住（預覽的表單、沒有回應）就別一直想。/ Don't keep thinking when a submit never resolves (the preview's form).
    useEffect(() => {
        if (!submitting) return;
        const timer = setTimeout(() => setSubmitting(false), 12_000);
        return () => clearTimeout(timer);
    }, [submitting]);

    useEffect(() => {
        const el = card.current;
        const host = root.current;
        const win = el?.ownerDocument.defaultView;
        if (!el || !host || !win) return;
        lastActive.current = Date.now();
        const read = () => setWhere(focusOf(el));
        const later = () => win.requestAnimationFrame(read);
        const onInput = (e: Event) => {
            touch();
            if ((e.target as HTMLElement | null)?.id === "login-username") setHops((n) => n + 1);
        };
        const onSubmit = () => {
            touch();
            setSubmitting(true);
        };
        let lastMove = 0;
        const onMove = (e: PointerEvent) => {
            if (e.timeStamp - lastMove < 500) return;
            lastMove = e.timeStamp;
            touch();
        };
        el.addEventListener("focusin", later);
        el.addEventListener("focusout", later);
        el.addEventListener("click", later);
        el.addEventListener("input", onInput);
        el.addEventListener("submit", onSubmit);
        host.addEventListener("pointermove", onMove);
        host.addEventListener("keydown", touch);
        const off = onSignIn(win, (kind) => {
            touch();
            if (kind === "error") {
                setSubmitting(false);
                react("oops");
            } else if (kind === "success") {
                react("yay");
            } else {
                setSubmitting(false);
            }
        });
        const tick = win.setInterval(() => setAsleep(Date.now() - lastActive.current >= SLEEP_AFTER_SECS * 1000), 5000);
        read();
        return () => {
            el.removeEventListener("focusin", later);
            el.removeEventListener("focusout", later);
            el.removeEventListener("click", later);
            el.removeEventListener("input", onInput);
            el.removeEventListener("submit", onSubmit);
            host.removeEventListener("pointermove", onMove);
            host.removeEventListener("keydown", touch);
            off();
            win.clearInterval(tick);
        };
    }, [card, root, touch, react]);

    const mood = moodFor({ focus: where.focus, passwordShown: where.shown, submitting, flash, hovering, idleSecs: asleep ? SLEEP_AFTER_SECS : 0 });
    return { mood, hops, setHovering, react, touch };
}

/* ── 畫面 / The pieces ───────────────────────────────────────── */

/** Tapi 的像素圖（帳號的髮夾顏色、今天的節日；訪客 = 預設）。/ Tapi's pixel art (the account's clips and today's festival; visitors get the default). */
function TapiSprite({ mood }: { mood: TapiMood }) {
    const tapi = useTapi();
    const { runs, w, h } = useMemo(() => {
        const dressed = dressTapi(moodSprite(mood), { clip: tapi.clip, festival: tapi.festival });
        return { runs: pixelRuns(dressed.sprite, dressed.palette), ...spriteSize(dressed.sprite) };
    }, [mood, tapi.clip, tapi.festival]);
    return (
        <svg viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" className="block w-full" style={{ aspectRatio: `${w} / ${h}` }} aria-hidden>
            {runs.map((r) => (
                <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
            ))}
        </svg>
    );
}

function TapiActor({ mood, hops, onHover, onPoke }: { mood: TapiMood; hops: number; onHover: (on: boolean) => void; onPoke: (el: HTMLElement) => void }) {
    const { t } = useI18n();
    return (
        <button
            type="button"
            className="tapi-actor"
            data-motion={MOOD_MOTION[mood]}
            data-tapi-solid
            aria-label={t("eggs.tapiLabel")}
            onPointerEnter={(e) => e.pointerType !== "touch" && onHover(true)}
            onPointerLeave={() => onHover(false)}
            onClick={(e) => onPoke(e.currentTarget)}
        >
            <span className="tapi-body">
                <span className="tapi-sway block">
                    {/* 打帳號時每個字跳一下。/ A hop per typed character. */}
                    <span key={mood === "watching" ? hops : -1} className={mood === "watching" && hops > 0 ? "tapi-hop block" : "block"}>
                        <TapiSprite mood={mood} />
                    </span>
                </span>
            </span>
            <span className="tapi-shadow" aria-hidden />
            {mood === "sleepy" && (
                <span className="tapi-z" aria-hidden>
                    <span>z</span>
                    <span>z</span>
                    <span>Z</span>
                </span>
            )}
        </button>
    );
}

/**
 * 對話框：平常輪流打出句子（管理員寫的，或內建的三句），有反應時換成那個心情的話。所有可能的句子都疊在同一格裡
 * （看不見），所以對話框大小固定，Tapi 不會被擠上擠下。
 * The speech bubble: the typed lines (the admin's or the three built-in ones), replaced by the mood's own line while
 * Tapi reacts. Every possible text sits invisibly in the same cell, so the bubble keeps one size and Tapi never shifts.
 */
function Speech({ mood, message, pin }: { mood: TapiMood; message: string; pin: number | null }) {
    const { t } = useI18n();
    const reduced = useReducedMotion();
    const measuring = useMeasuringPreview();
    const own = messageLines(message);
    const lines = own.length ? own : LINES.map((key) => t(key));
    const { text, caret } = useTypewriter(lines, pin !== null && pin < lines.length ? pin : null, !reduced && !measuring);
    const said = moodLine(mood);
    const sizers = [...lines, ...Object.values(MOOD_TEXT).map((k) => t(k))];
    return (
        <div className="tapi-bubble text-base leading-relaxed sm:text-lg" data-tapi-solid>
            <p className="sr-only">{lines.join(" ")}</p>
            <p className="dsc-type text-center" aria-hidden>
                {sizers.map((line, i) => (
                    <span key={i} className="dsc-type-sizer">
                        {line}
                    </span>
                ))}
                {said ? (
                    <span key={said} className="tapi-say">
                        {t(MOOD_TEXT[said])}
                    </span>
                ) : mood === "sleepy" ? (
                    <span key="sleepy" className="tapi-say text-muted-foreground">
                        Zzz…
                    </span>
                ) : (
                    <span className="dsc-type-live">
                        {text}
                        {caret && <span className="dsc-caret" data-caret={caret} />}
                    </span>
                )}
            </p>
        </div>
    );
}

/** 像素字標：每個字母各自一張，輪流輕輕跳；滑鼠指到的字母翹起來。/ The pixel wordmark: one image per letter, hopping in turn; a pointed-at letter tips up. */
function Wordmark() {
    return (
        <h1 className="tapi-word" aria-label="Telepy" style={{ "--tapi-gap": "0px" } as CSSVars}>
            {WORD.glyphs.map((g, i) => {
                const w = g.rows[0].length;
                const h = g.rows.length;
                return (
                    <span key={i} className="tapi-letter" style={{ "--i": i } as CSSVars} aria-hidden>
                        <svg viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" className="tapi-glyph block" style={{ width: `calc(var(--tapi-unit) * ${w})`, aspectRatio: `${w} / ${h}` }}>
                            {pixelRuns(g.rows, WORD_PALETTE).map((r) => (
                                <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
                            ))}
                        </svg>
                    </span>
                );
            })}
        </h1>
    );
}

export function TapiShell({
    message,
    pin = null,
    children,
}: {
    message: string;
    /** 預覽正在看哪一句。/ The line the preview shows. */
    pin?: number | null;
    children: React.ReactNode;
}) {
    const root = useRef<HTMLDivElement>(null);
    const card = useRef<HTMLDivElement>(null);
    const { mood, hops, setHovering, react, touch } = useTapiMood(card, root);

    const poke = (el: HTMLElement) => {
        touch();
        react("poke");
        const r = el.getBoundingClientRect();
        plop(el, r.left + r.width / 2, r.top + r.height * 0.35);
    };
    // 點背景（不是卡片、Tapi、對話框、頁首）：冒出一把粉圓。/ A click on the background releases a handful of pearls.
    const onBackground = (e: React.MouseEvent<HTMLDivElement>) => {
        if ((e.target as HTMLElement).closest("[data-tapi-solid], a, button, input, label")) return;
        plop(e.currentTarget, e.clientX, e.clientY);
    };

    return (
        <div
            ref={root}
            onClick={onBackground}
            className="tapi-shell relative flex min-h-screen flex-col overflow-clip text-foreground"
            style={{ "--tapi-size": "clamp(8.5rem, 19vw, 15rem)", "--tapi-unit": "clamp(0.13rem, 0.55vw, 0.21rem)" } as CSSVars}
        >
            <Tea host={root} />
            {/* 頁首在版面裡：表單再高也不會壓到語言 / 主題切換。/ In the flow, so a tall form never covers it. */}
            <header className="relative z-10 flex justify-end p-4 sm:p-6" data-tapi-solid>
                <AuthPrefs />
            </header>

            <div className="relative mx-auto grid w-full max-w-6xl flex-1 grid-cols-[minmax(0,1fr)] content-center items-center gap-8 px-4 pb-12 pt-2 sm:px-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-16 lg:px-12 lg:pb-14">
                <section className="flex flex-col items-center gap-5 text-center lg:gap-6">
                    <Speech mood={mood} message={message} pin={pin} />
                    <TapiActor mood={mood} hops={hops} onHover={setHovering} onPoke={poke} />
                    <Wordmark />
                </section>

                <div
                    ref={card}
                    data-tapi-solid
                    className="relative w-full max-w-sm justify-self-center animate-fade-in-up rounded-xl border border-border bg-card p-6 shadow-card sm:p-8 lg:justify-self-end"
                >
                    {children}
                </div>
            </div>
        </div>
    );
}
