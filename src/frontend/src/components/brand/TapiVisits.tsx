"use client";

/**
 * Tapi 偶爾來串門子（彩蛋；規則在 lib/tapiCameos.ts）：
 * - 探頭：在安靜的頁面待一陣子、沒在打字、沒開對話框時，從畫面底下探頭幾秒；點到它 =「抓到了」（還沒找到 Tapi 的人就此找到）。
 *   搜尋 `tapi` 會叫它馬上出來。
 * - 上上下下左右左右 BA：Tapi 從畫面左邊飄到右邊。
 * - 一條通道驗證成功（建立精靈 / 一行指令加入）：恭喜一次（一個瀏覽器一輩子一次，只給已經找到 Tapi 的人）。
 * 其他頁面用 lib/tapiCameos 的 `summonTapi()` 叫它；帳號設定 `tapi_visits` 關掉就不會自己來（自己叫的照樣來）。
 * Tapi drops by now and then (easter eggs; the rules live in lib/tapiCameos.ts):
 * - a peek: after a while on a calm page, with no typing and no dialog open, it peeks up from the bottom edge for a few
 *   seconds; clicking it "catches" it (and counts as finding Tapi for those who haven't). Searching `tapi` calls it.
 * - the Konami code: Tapi floats across the screen.
 * - a tunnel verified (create wizard / one-command join): one cheer (once per browser, only after Tapi was found).
 * Other pages call it with `summonTapi()` from lib/tapiCameos; the `tapi_visits` setting stops the unprompted visits (asked ones still come).
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { Tapi } from "@/components/brand/Tapi";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useFestival, useTapi } from "@/hooks/useTapi";
import { useI18n } from "@/lib/i18n";
import {
    PEEK_DELAY_MS,
    PEEK_MS,
    QUIET_MS,
    TAPI_EVENT,
    afterPeek,
    calmPage,
    dayKey,
    konamiDone,
    parseMemory,
    peekDue,
    peekSpot,
    rememberOnce,
    seenOnce,
    type CameoMemory,
    type TapiSummons,
} from "@/lib/tapiCameos";

const MEMORY_KEY = "telepy.tapiVisits";
const SALT_KEY = "telepy.tapiSalt";
const CARD_MS = 7000;

function readMemory(): CameoMemory {
    try {
        return parseMemory(localStorage.getItem(MEMORY_KEY));
    } catch {
        return parseMemory(null);
    }
}
function writeMemory(m: CameoMemory) {
    try {
        localStorage.setItem(MEMORY_KEY, JSON.stringify(m));
    } catch {
        // 存不了就算了（無痕視窗）。/ Nothing to do when storage is blocked.
    }
}
/** 這個瀏覽器自己的亂數（哪幾天輪到它）。/ This browser's own random value (which days are its lucky ones). */
function salt(): string {
    try {
        let s = localStorage.getItem(SALT_KEY);
        if (!s) {
            s = Math.random().toString(36).slice(2, 10);
            localStorage.setItem(SALT_KEY, s);
        }
        return s;
    } catch {
        return "telepy";
    }
}

const editable = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest(".xterm"));

type Visit = { kind: "peek"; id: number; left: number } | { kind: "fly"; id: number } | { kind: "cheer"; id: number };

/** 抓到 / 恭喜時的小卡（右下角）。/ The little card when caught / cheering (bottom right, or above the peek). */
function VisitCard({ title, body, extra, onClose, style }: { title: string; body: string; extra?: string; onClose: () => void; style?: React.CSSProperties }) {
    const { t } = useI18n();
    useEffect(() => {
        const timer = setTimeout(onClose, CARD_MS);
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => {
            clearTimeout(timer);
            window.removeEventListener("keydown", onKey);
        };
    }, [onClose]);
    return (
        <div role="status" className="fixed z-[60] flex w-64 items-end gap-3 rounded-xl border border-border bg-card p-3 shadow-pop animate-pop-in" style={style}>
            <Tapi pose="happy" size={52} className="shrink-0 animate-tapi-bob" />
            <div className="min-w-0 flex-1 pb-0.5">
                <p className="text-sm text-foreground">{title}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{body}</p>
                {extra && <p className="mt-1.5 text-xs leading-relaxed text-foreground">{extra}</p>}
            </div>
            <button type="button" onClick={onClose} aria-label={t("common.close")} className="absolute right-1.5 top-1.5 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                <X size={14} />
            </button>
        </div>
    );
}

/** Konami：側面的 Tapi 兩張圖交替，從左飄到右。/ Konami: the side view, two frames in turn, floating from left to right. */
function Fly({ onDone }: { onDone: () => void }) {
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        const tick = setInterval(() => setFrame((f) => 1 - f), 220);
        return () => clearInterval(tick);
    }, []);
    return (
        <div className="tapi-fly pointer-events-none fixed left-0 top-[38vh] z-[60]" onAnimationEnd={onDone} aria-hidden>
            <div className="tapi-fly-bob">
                <Tapi pose={frame ? "sideB" : "sideA"} size="4.5rem" flip />
            </div>
        </div>
    );
}

export function TapiVisits() {
    const { t } = useI18n();
    const pathname = usePathname() ?? "";
    const tapi = useTapi();
    const festival = useFestival();
    const reduced = useReducedMotion();
    const unlocked = tapi.unlocked;
    const [visit, setVisit] = useState<Visit | null>(null);
    const [card, setCard] = useState<null | { kind: "caught" | "cheer"; first: boolean; style?: React.CSSProperties }>(null);
    const lastKey = useRef(0);
    const keys = useRef<string[]>([]);
    const seq = useRef(0);

    /** 主內容區裡的一個位置（避開側欄）。/ A spot inside the main content (clear of the sidebar). */
    const peekLeft = useCallback((spot: number) => {
        const main = document.querySelector("main");
        const r = main?.getBoundingClientRect() ?? { left: 0, width: window.innerWidth };
        const size = 80;
        return Math.round(r.left + Math.max(0, r.width - size) * spot);
    }, []);

    const peek = useCallback(
        (spot: number) => {
            setCard(null);
            setVisit({ kind: "peek", id: ++seq.current, left: peekLeft(spot) });
        },
        [peekLeft],
    );

    // 鍵盤：記下最後一次打字；上上下下左右左右 BA = 飄過去。/ Keyboard: remember the last typing; the Konami code = a fly-by.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            lastKey.current = Date.now();
            if (editable(e.target) || e.metaKey || e.ctrlKey || e.altKey) {
                keys.current = [];
                return;
            }
            keys.current = [...keys.current, e.key].slice(-10);
            if (konamiDone(keys.current)) {
                keys.current = [];
                if (!reduced) setVisit({ kind: "fly", id: ++seq.current });
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [reduced]);

    // 被叫出來：探頭，或通道驗證成功的恭喜（一個瀏覽器一次、找到 Tapi 之後才有）。/ Summoned: a peek, or the cheer (once, after Tapi was found).
    useEffect(() => {
        const onSummon = (e: Event) => {
            const kind = (e as CustomEvent<TapiSummons>).detail;
            if (kind === "peek") {
                peek(Math.random() * 0.7 + 0.15);
                return;
            }
            const memory = readMemory();
            if (!unlocked || seenOnce(memory, "tunnelUp")) return;
            writeMemory(rememberOnce(memory, "tunnelUp"));
            setVisit(null);
            setCard({ kind: "cheer", first: false, style: { right: 16, bottom: 16 } });
        };
        window.addEventListener(TAPI_EVENT, onSummon);
        return () => window.removeEventListener(TAPI_EVENT, onSummon);
    }, [peek, unlocked]);

    // 自己來：安靜的頁面、今天輪到、等一下、沒在打字、沒開對話框、分頁看得到。/ On its own: a calm page, its day, a wait, no typing / dialog, tab visible.
    useEffect(() => {
        if (!calmPage(pathname)) return;
        const now = new Date();
        const s = salt();
        const fest = festival?.kind ?? null;
        if (!peekDue({ now, memory: readMemory(), salt: s, festival: fest, enabled: tapi.visits, reduced })) return;
        let timer = 0;
        const attempt = (tries: number) => {
            const busy = document.hidden || Date.now() - lastKey.current < QUIET_MS || !!document.querySelector('[role="dialog"]');
            if (busy) {
                if (tries > 0) timer = window.setTimeout(() => attempt(tries - 1), 20_000);
                return;
            }
            writeMemory(afterPeek(readMemory(), new Date(), fest));
            peek(peekSpot(dayKey(now), s));
        };
        timer = window.setTimeout(() => attempt(6), PEEK_DELAY_MS.min + Math.random() * (PEEK_DELAY_MS.max - PEEK_DELAY_MS.min));
        return () => window.clearTimeout(timer);
    }, [pathname, festival?.kind, tapi.visits, reduced, peek]);

    // 抓到：跳出來、開心；還沒找到 Tapi 的人就此找到（跟點 logo 一樣解鎖）。/ Caught: it pops up happy; counts as finding Tapi.
    const caught = (left: number) => {
        const first = !tapi.unlocked;
        if (first) void tapi.save({ tapi_color: "teal" });
        setVisit(null);
        setCard({ kind: "caught", first, style: { left: Math.max(8, Math.min(left - 90, window.innerWidth - 264)), bottom: 16 } });
    };
    const closeCard = useCallback(() => setCard(null), []);

    // 只在有東西要出來時才畫（伺服器端與平常都是空的）。/ Rendered only while something shows (empty on the server and most of the time).
    if (!visit && !card) return null;
    return createPortal(
        <>
            {visit?.kind === "peek" && (
                <button
                    key={visit.id}
                    type="button"
                    className="tapi-peek fixed bottom-0 z-[55]"
                    style={{ left: visit.left, animationDuration: `${PEEK_MS}ms` }}
                    onAnimationEnd={() => setVisit((v) => (v?.id === visit.id ? null : v))}
                    onClick={() => caught(visit.left)}
                    aria-label={t("eggs.peek.label")}
                    title={t("eggs.peek.label")}
                >
                    <Tapi pose="idle" size="5rem" />
                </button>
            )}
            {visit?.kind === "fly" && <Fly key={visit.id} onDone={() => setVisit(null)} />}
            {card && (
                <VisitCard
                    title={t(card.kind === "caught" ? "eggs.peek.caught" : "eggs.cheer.title")}
                    body={t(card.kind === "caught" ? "eggs.peek.body" : "eggs.cheer.body")}
                    extra={card.first ? t("eggs.found.unlocked") : undefined}
                    onClose={closeCard}
                    style={card.style}
                />
            )}
        </>,
        document.body,
    );
}
