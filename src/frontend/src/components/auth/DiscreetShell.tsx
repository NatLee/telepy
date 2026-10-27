"use client";

/**
 * 低調登入頁的外框（網站設定 → 登入 → 登入頁的樣子 = 低調）：只有「Telepy」、一句話和動態背景，旁邊是登入表單。
 * 不提任何遠端連線相關的字，路過的人只看得到一個叫 Telepy 的登入畫面。一般登入頁、OAuth 登入頁與設定頁的預覽共用。
 * 動畫在 discreet.css：向日葵點陣（費馬螺旋）上由「Telepy」往外擴散的漣漪、兩條慢慢轉的軌道、字母浮出。
 * The discreet sign-in frame (Site settings → Sign-in → look = discreet): only "Telepy", one line and a moving
 * background next to the form, with nothing about remote access, so a passer-by sees a sign-in page called Telepy.
 * Shared by the sign-in page, the OAuth sign-in page and the settings preview. The motion lives in discreet.css: a
 * ripple spreading from the word across a sunflower dot field, two slow orbits and rising letters.
 */
import "./discreet.css";
import React, { useMemo } from "react";
import { AuthPrefs } from "@/components/auth/AuthShell";
import { useI18n } from "@/lib/i18n";
import { sunflower } from "@/lib/signinLook";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";

const WORD = "Telepy";
const FIELD_RADIUS = 380;
const FIELD_DOTS = 420;
/** 漣漪走完半徑的時間（秒），跟 discreet.css 的波前一致。/ Seconds for the ripple to cross the radius (matches the wavefront). */
const RIPPLE_SECS = 2.4;
const LINES: TranslationKey[] = ["discreet.line1", "discreet.line2", "discreet.line3"];
const LINE_STEP_SECS = 4;

type CSSVars = React.CSSProperties & Record<`--${string}`, string | number>;

/** 背景：向日葵點陣 + 波前 + 兩條軌道（只是裝飾）。/ The background: sunflower dots, wavefront and two orbits. */
function DiscreetArt() {
    const dots = useMemo(() => sunflower(FIELD_DOTS, FIELD_RADIUS), []);
    return (
        <div className="dsc-field" aria-hidden>
            <div className="dsc-spin">
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
            <span className="dsc-orbit" style={{ "--r": "232px", "--period": "38s" } as CSSVars} />
            <span className="dsc-orbit" style={{ "--r": "318px", "--period": "64s", "--dir": "reverse", "--c": "var(--foreground)", "--size": "5px" } as CSSVars} />
        </div>
    );
}

/** 「Telepy」：每個字母各自浮出。/ The word, letter by letter. */
function Wordmark() {
    return (
        <h1 className="relative text-[clamp(3.75rem,15vw,8.5rem)] leading-none tracking-tight text-foreground" aria-label={WORD}>
            <span className="inline-flex" aria-hidden>
                {[...WORD].map((ch, i) => (
                    <span key={i} className="dsc-char">
                        <span style={{ "--i": i } as CSSVars}>{ch}</span>
                    </span>
                ))}
            </span>
        </h1>
    );
}

/** 那句話：管理員寫的（靜態），或輪播內建的三句。/ The admin's line (static) or the three built-in lines in turn. */
function Tagline({ message }: { message: string }) {
    const { t } = useI18n();
    const text = message.trim();
    const cls = "max-w-md text-lg leading-relaxed text-muted-foreground";
    if (text) return <p className={cn(cls, "dsc-still whitespace-pre-line break-words")}>{text}</p>;
    return (
        <>
            <p className="sr-only">{t(LINES[0])}</p>
            <p className={cn(cls, "dsc-lines")} style={{ "--cycle": `${LINES.length * LINE_STEP_SECS}s`, "--step": `${LINE_STEP_SECS}s` } as CSSVars} aria-hidden>
                {LINES.map((key, i) => (
                    <span key={key} style={{ "--i": i } as CSSVars}>
                        {t(key)}
                    </span>
                ))}
            </p>
        </>
    );
}

export function DiscreetShell({ message, children }: { message: string; children: React.ReactNode }) {
    return (
        <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
            <header className="absolute right-0 top-0 z-10 p-4 sm:p-6">
                <AuthPrefs />
            </header>

            <div className="relative mx-auto grid min-h-screen max-w-6xl content-center items-center gap-10 px-4 pb-12 pt-24 sm:px-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-16 lg:px-12 lg:py-16">
                <section className="flex flex-col items-center gap-5 text-center lg:items-start lg:text-left">
                    <div className="relative">
                        <DiscreetArt />
                        <Wordmark />
                    </div>
                    <span className="dsc-rule" aria-hidden />
                    <Tagline message={message} />
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
