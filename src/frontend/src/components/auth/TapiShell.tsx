"use client";

/**
 * Tapi 版的外框（網站設定 → 登入 → Tapi）。每一頁照它做的事換場景（lib/tapiStage `sceneFor`）：
 * - 登入（tea）= 一杯奶茶，像素粉圓往上浮；
 * - 應用程式連接（mail）= 紙飛機把應用程式的請求送進來，Tapi 拿著信；
 * - CLI 登入與登入完成頁（terminal）= 終端機，字元往上飄，對話框是一行提示字元；
 * - 授權（desk）= 格子紙上的審核櫃台，印章一個個蓋下來，Tapi 戴著墨鏡。
 * 背景是一張 canvas（畫法在 tapiScenes.ts）：滑鼠靠近會把東西推開，點背景（或戳 Tapi）有小驚喜。Tapi 頭上的對話框輪流打出
 * 句子（管理員寫的，沒寫就是這個場景自己的三句），下面是像素字標。Tapi 跟著頁面反應：登入表單（盯著帳號、打密碼時轉身、
 * 顯示密碼嚇一跳、失敗驚訝、成功開心）；授權頁（勾到會改東西的權限時提醒、按允許就蓋章、按拒絕就揮手）；滑鼠停在身上揮手、
 * 戳它會笑、太久沒人理會睡著。CLI 登入完成頁給固定的心情（`fixedMood`）。登入頁、OAuth / CLI 登入頁、授權頁、CLI 完成頁
 * 與設定頁的預覽共用。
 * The Tapi frame (Site settings → Sign-in → Tapi). Each page gets a scene matching what it does (lib/tapiStage
 * `sceneFor`): sign-in (tea) = a cup of milk tea with pixel pearls rising; app connection (mail) = paper planes
 * bringing the app's request, Tapi holding the letter; CLI sign-in and its done page (terminal) = a terminal with
 * characters drifting up and a prompt line for a speech bubble; approval (desk) = a counter on grid paper where stamps
 * land and Tapi wears sunglasses. The background is one canvas (painters in tapiScenes.ts): a mouse pushes things
 * aside and a click on the background (or a poke) brings a small surprise. The bubble types the lines (the admin's,
 * else the scene's own three) and a pixel wordmark sits below. Tapi reacts to the page: the sign-in form (watching the
 * username, turned around for the password, startled when it is shown, surprised on a failure, happy on success) and
 * the approval page (a warning when a scope that can change things is ticked, a stamp on approve, a wave on deny); it
 * waves when the pointer rests on it, giggles when poked and falls asleep when left alone. The CLI done page passes a
 * fixed mood (`fixedMood`). Shared by every sign-in page, the approval page, the CLI done page and the settings preview.
 */
import "./discreet.css";
import "./tapi.css";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthPrefs } from "@/components/auth/AuthShell";
import { painterFor, type SceneEnv } from "@/components/auth/tapiScenes";
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
    SCENE_LINES,
    SLEEP_AFTER_SECS,
    STAMP_OK,
    WORD_PALETTE,
    moodFor,
    moodLine,
    pixelWord,
    sceneSprite,
    type TapiFlash,
    type TapiFocus,
    type TapiMood,
    type TapiScene,
} from "@/lib/tapiStage";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";

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
    careful: "tapiLook.careful",
    stamp: "tapiLook.stamp",
    bye: "tapiLook.bye",
    done: "tapiLook.done",
};
/** 這個場景可能說的反應（對話框的大小照它們算）。/ The reactions a scene may say (the bubble is sized for them). */
const SCENE_MOODS: Record<TapiScene, Exclude<TapiMood, "idle" | "sleepy">[]> = {
    tea: ["watching", "shy", "peek", "thinking", "oops", "yay", "mfa", "wave", "poke"],
    mail: ["watching", "shy", "peek", "thinking", "oops", "yay", "mfa", "wave", "poke"],
    terminal: ["watching", "shy", "peek", "thinking", "oops", "yay", "mfa", "wave", "poke", "bye", "done"],
    desk: ["careful", "stamp", "bye", "wave", "poke"],
};
const PLOP_EVENT = "tapi-plop";
const WORD = pixelWord("Telepy");

type CSSVars = React.CSSProperties & Record<`--${string}`, string | number>;

/* ── 背景 / The background ───────────────────────────────────── */

/**
 * 背景的繪圖迴圈：一張 canvas 鋪滿整頁，交給這個場景的畫法（tapiScenes.ts）。看不到就停（捲走、分頁在背景），減少動態 =
 * 畫一張靜止的（點出來的小驚喜動完為止）。滑鼠（能 hover 的裝置）推開附近的東西。
 * The background loop: one canvas over the page, painted by the scene's painter (tapiScenes.ts). It stops while out of
 * sight (scrolled away, hidden tab); reduced motion draws a still frame (plus a surprise until it settles). A mouse
 * (hover devices) pushes nearby things aside.
 */
function runScene(canvas: HTMLCanvasElement, host: HTMLElement, reduced: boolean, scene: TapiScene): () => void {
    const doc = canvas.ownerDocument;
    const win = doc.defaultView;
    const ctx = canvas.getContext("2d");
    if (!win || !ctx) return () => {};
    const painter = painterFor(scene);
    let width = 0;
    let height = 0;
    let ratio = 0;
    let dark = doc.documentElement.classList.contains("dark");
    let pointer: { x: number; y: number } | null = null;
    let visible = true;
    let frame = 0;
    let frames = 0;
    let busy = false;
    // 畫法共用這一份（setup 時給參考，之後改欄位就好）。/ One shared env (painters keep the reference).
    const env: SceneEnv = { doc, width: 0, height: 0, ratio: 1, dark, avoid: [] };
    // 卡片、Tapi、對話框、頁首的位置（相對畫面）。/ Where the solid parts are, relative to the page.
    const measure = () => {
        const box = host.getBoundingClientRect();
        env.avoid = [...host.querySelectorAll<HTMLElement>("[data-tapi-solid]")].map((el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top };
        });
    };
    const start = win.performance.now();
    let last = start;

    const resize = () => {
        const w = host.clientWidth;
        const h = host.clientHeight;
        const r = Math.min(2, Math.max(1, win.devicePixelRatio || 1));
        if (w === width && h === height && r === ratio) return;
        width = w;
        height = h;
        ratio = r;
        canvas.width = Math.max(1, Math.round(w * r));
        canvas.height = Math.max(1, Math.round(h * r));
        measure();
        Object.assign(env, { width, height, ratio, dark });
        painter.setup(env);
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
        // 版面會變（卡片長高、字型晚到）：每秒左右重量一次。/ The layout moves (a taller card, a late font): re-measure about once a second.
        if (++frames % 60 === 1) measure();
        busy = painter.draw(ctx, t, dt, local, now);
        ctx.globalAlpha = 1;
    };

    const loop = (now: number) => {
        frame = 0;
        draw(now);
        if ((!reduced || busy) && visible) frame = win.requestAnimationFrame(loop);
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
    // 換主題（含預覽框同步過去的 class）：重畫顏色。/ Theme changes (preview frames too): repaint the colours.
    const mo = new win.MutationObserver(() => {
        const next = doc.documentElement.classList.contains("dark");
        if (next === dark) return;
        dark = next;
        env.dark = dark;
        painter.setup(env);
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
        const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail;
        const box = host.getBoundingClientRect();
        painter.plop(x - box.left, y - box.top, win.performance.now());
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

function Backdrop({ host, scene }: { host: React.RefObject<HTMLDivElement | null>; scene: TapiScene }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const reduced = useReducedMotion();
    const measuring = useMeasuringPreview();
    useEffect(() => {
        if (!host.current || !canvas.current) return;
        return runScene(canvas.current, host.current, reduced, scene);
    }, [host, reduced, scene]);
    if (measuring) return null;
    return <canvas ref={canvas} className="tapi-tea" aria-hidden />;
}

/** 從某個點送出小驚喜（背景在聽）。/ Sends a small surprise from a point (the background listens). */
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
 * 跟著頁面決定心情：焦點、密碼有沒有顯示、送出中、登入結果（lib/signInSignal）、授權頁的權限與決定（`data-tapi-scope` /
 * `data-tapi-decision`）、滑鼠在不在 Tapi 身上、多久沒動。
 * Works out the mood from the page: focus, whether the password is shown, signing in, the result (lib/signInSignal),
 * the approval page's scopes and decision (`data-tapi-scope` / `data-tapi-decision`), the pointer on Tapi and how
 * long nothing happened.
 */
function useTapiMood(card: React.RefObject<HTMLDivElement | null>, root: React.RefObject<HTMLDivElement | null>, fixedMood: TapiMood | null) {
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
        // 授權頁：勾了會改東西的權限 = 提醒一下。/ Approval page: ticking a scope that can change things gets a warning.
        const onChange = (e: Event) => {
            const box = e.target as HTMLInputElement | null;
            if (box?.dataset.tapiScope === "changes" && box.checked) react("careful");
        };
        const onClick = (e: Event) => {
            later();
            const decision = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-tapi-decision]")?.dataset.tapiDecision;
            if (decision === "approve") react("stamp");
            else if (decision === "deny") react("bye");
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
        el.addEventListener("click", onClick);
        el.addEventListener("input", onInput);
        el.addEventListener("change", onChange);
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
            el.removeEventListener("click", onClick);
            el.removeEventListener("input", onInput);
            el.removeEventListener("change", onChange);
            el.removeEventListener("submit", onSubmit);
            host.removeEventListener("pointermove", onMove);
            host.removeEventListener("keydown", touch);
            off();
            win.clearInterval(tick);
        };
    }, [card, root, touch, react]);

    const mood = flash ?? fixedMood ?? moodFor({ focus: where.focus, passwordShown: where.shown, submitting, flash, hovering, idleSecs: asleep ? SLEEP_AFTER_SECS : 0 });
    return { mood, hops, setHovering, react, touch };
}

/* ── 畫面 / The pieces ───────────────────────────────────────── */

/** Tapi 的像素圖（場景的配件、帳號的髮夾顏色、今天的節日；訪客 = 預設）。/ Tapi with the scene's props, the account's clips and today's festival. */
function TapiSprite({ mood, scene }: { mood: TapiMood; scene: TapiScene }) {
    const tapi = useTapi();
    const { runs, w, h } = useMemo(() => {
        const dressed = dressTapi(sceneSprite(mood, scene), { clip: tapi.clip, festival: tapi.festival });
        return { runs: pixelRuns(dressed.sprite, dressed.palette), ...spriteSize(dressed.sprite) };
    }, [mood, scene, tapi.clip, tapi.festival]);
    return (
        <svg viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" className="block w-full" style={{ aspectRatio: `${w} / ${h}` }} aria-hidden>
            {runs.map((r) => (
                <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
            ))}
        </svg>
    );
}

/** 授權頁按允許時蓋下去的大印章。/ The big stamp that lands when the approval page is approved. */
function BigStamp() {
    const runs = useMemo(() => pixelRuns(STAMP_OK, { B: "#e8433a" }), []);
    return (
        <span className="tapi-stamp" aria-hidden>
            <svg viewBox={`0 0 ${STAMP_OK[0].length} ${STAMP_OK.length}`} shapeRendering="crispEdges" className="block w-full">
                {runs.map((r) => (
                    <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
                ))}
            </svg>
        </span>
    );
}

function TapiActor({ mood, scene, hops, onHover, onPoke }: { mood: TapiMood; scene: TapiScene; hops: number; onHover: (on: boolean) => void; onPoke: (el: HTMLElement) => void }) {
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
                        <TapiSprite mood={mood} scene={scene} />
                    </span>
                </span>
            </span>
            <span className="tapi-shadow" aria-hidden />
            {mood === "stamp" && <BigStamp />}
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
 * 對話框：平常輪流打出句子（管理員寫的，或這個場景的三句），有反應時換成那個心情的話。所有可能的句子都疊在同一格裡
 * （看不見），所以對話框大小固定，Tapi 不會被擠上擠下。終端機場景的對話框是一行提示字元。
 * The speech bubble: the typed lines (the admin's, or the scene's three), replaced by the mood's own line while Tapi
 * reacts. Every possible text sits invisibly in the same cell, so the bubble keeps one size and Tapi never shifts. In
 * the terminal scene the bubble is a prompt line.
 */
function Speech({ mood, scene, message, pin }: { mood: TapiMood; scene: TapiScene; message: string; pin: number | null }) {
    const { t } = useI18n();
    const reduced = useReducedMotion();
    const measuring = useMeasuringPreview();
    const own = messageLines(message);
    const lines = own.length ? own : SCENE_LINES[scene].map((key) => t(key as TranslationKey));
    const { text, caret } = useTypewriter(lines, pin !== null && pin < lines.length ? pin : null, !reduced && !measuring);
    const said = moodLine(mood);
    const sizers = [...lines, ...SCENE_MOODS[scene].map((m) => t(MOOD_TEXT[m]))];
    const term = scene === "terminal";
    return (
        <div className={cn("tapi-bubble leading-relaxed", term ? "tapi-bubble--term flex items-center gap-2 text-sm sm:text-base" : "text-base sm:text-lg")} data-tapi-solid>
            {term && (
                <span className="tapi-prompt shrink-0 self-start" aria-hidden>
                    tapi@telepy:~$
                </span>
            )}
            <p className="sr-only">{lines.join(" ")}</p>
            <p className={cn("dsc-type min-w-0 flex-1", term ? "text-left" : "text-center")} aria-hidden>
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
        <h1 className="tapi-word" aria-label="Telepy" data-tapi-solid style={{ "--tapi-gap": "0px" } as CSSVars}>
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
    scene,
    message,
    pin = null,
    wide = false,
    fixedMood = null,
    children,
}: {
    /** 這一頁的場景（lib/tapiStage `sceneFor`）。/ This page's scene (lib/tapiStage `sceneFor`). */
    scene: TapiScene;
    message: string;
    /** 預覽正在看哪一句。/ The line the preview shows. */
    pin?: number | null;
    /** 內容多的頁面（授權頁）用寬一點的卡片，Tapi 黏在上面。/ A wider card for content-heavy pages (approval); Tapi stays in view. */
    wide?: boolean;
    /** 固定的心情（CLI 登入完成頁）。/ A fixed mood (the CLI done page). */
    fixedMood?: TapiMood | null;
    children: React.ReactNode;
}) {
    const root = useRef<HTMLDivElement>(null);
    const card = useRef<HTMLDivElement>(null);
    const { mood, hops, setHovering, react, touch } = useTapiMood(card, root, fixedMood);

    const poke = (el: HTMLElement) => {
        touch();
        react("poke");
        const r = el.getBoundingClientRect();
        plop(el, r.left + r.width / 2, r.top + r.height * 0.35);
    };
    // 點背景（不是卡片、Tapi、對話框、頁首）：小驚喜。/ A click on the background: a small surprise.
    const onBackground = (e: React.MouseEvent<HTMLDivElement>) => {
        if ((e.target as HTMLElement).closest("[data-tapi-solid], a, button, input, label")) return;
        plop(e.currentTarget, e.clientX, e.clientY);
    };

    return (
        <div
            ref={root}
            onClick={onBackground}
            data-scene={scene}
            className="tapi-shell relative flex min-h-screen flex-col overflow-clip text-foreground"
            style={{ "--tapi-size": wide ? "clamp(8rem, 15vw, 12.5rem)" : "clamp(8.5rem, 19vw, 15rem)", "--tapi-unit": "clamp(0.13rem, 0.55vw, 0.21rem)" } as CSSVars}
        >
            <Backdrop host={root} scene={scene} />
            {/* 頁首在版面裡：表單再高也不會壓到語言 / 主題切換。/ In the flow, so a tall form never covers it. */}
            <header className="relative z-10 flex justify-end p-4 sm:p-6" data-tapi-solid>
                <AuthPrefs />
            </header>

            <div
                className={cn(
                    "relative mx-auto grid w-full max-w-6xl flex-1 grid-cols-[minmax(0,1fr)] content-center items-center gap-8 px-4 pb-12 pt-2 sm:px-8 lg:gap-16 lg:px-12 lg:pb-14",
                    wide ? "lg:grid-cols-[minmax(0,1fr)_32rem] lg:items-start" : "lg:grid-cols-[minmax(0,1fr)_24rem]",
                )}
            >
                <section className={cn("flex flex-col items-center gap-5 text-center lg:gap-6", wide && "lg:sticky lg:top-8")}>
                    <Speech mood={mood} scene={scene} message={message} pin={pin} />
                    <TapiActor mood={mood} scene={scene} hops={hops} onHover={setHovering} onPoke={poke} />
                    <Wordmark />
                </section>

                <div
                    ref={card}
                    data-tapi-solid
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
