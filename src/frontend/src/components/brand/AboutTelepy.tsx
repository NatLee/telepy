"use client";

/**
 * 偏好設定 → 一般 最下面的「關於 Telepy」：授權、原始碼、字型、使用聲明（Disclaimer）。兩個彩蛋：點字型名稱「粉圓」會灑出一把像素珍珠
 * （致敬終界珍珠；減少動態時不灑），「片尾名單」用錄影播放器播一段 asciicast（lib/credits），Tapi 在下面揮手。
 * "About Telepy" at the bottom of Preferences → General: licence, source, typeface, the disclaimer. Two easter eggs: clicking the
 * typeface name 粉圓 ("tapioca pearls") throws a handful of pixel pearls (a nod to ender pearls; not with reduced
 * motion), and "Credits" plays an
 * asciicast in the recording player (lib/credits) while Tapi waves below it.
 */
import React, { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Clapperboard, ExternalLink, Gift } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/section";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/Toast";
import { DisclaimerButton } from "@/components/brand/Disclaimer";
import { Tapi } from "@/components/brand/Tapi";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { SOURCE_URL } from "@/components/brand/ConsoleHello";
import { CastPlayer } from "@/components/recordings/CastPlayer";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTapi } from "@/hooks/useTapi";
import { parseCast } from "@/lib/asciicast";
import { CREDIT_ART, CREDIT_LINES, creditsCast, shadowArt, tapiArt, tapiFinale, type CreditSectionKey, type FinaleKind } from "@/lib/credits";
import { useI18n } from "@/lib/i18n";
import { CLIP_COLORS, DAILY, MASCOT_PALETTE, type ClipColor } from "@/lib/mascot";
import type { TranslationKey } from "@/locales/en";

interface Pearl {
    id: number;
    x: number;
    y: number;
    size: number;
    style: React.CSSProperties;
}

const PEARL_LIFE_MS = 2600;

// 致敬 Minecraft 的終界珍珠（丟出去就傳送，跟 Telepy 同一個哏）：自己畫的 8×8 像素珠，青綠色、中心亮。
// A nod to Minecraft's ender pearl (throw it and you teleport — Telepy's joke too): our own 8×8 pixel orb in teal,
// lighter in the middle. D 外圈 / rim, B 身體 / body, M 中間 / mid, L 中心 / centre.
const PEARL = ["..DDDD..", ".DBBBBD.", "DBBMMBBD", "DBMLLMBD", "DBMLLMBD", "DBBMMBBD", ".DBBBBD.", "..DDDD.."];
const PEARL_FILL: Record<string, string> = { D: "#0c3a35", B: "#17675b", M: "#2b9c86", L: "#8de6cf" };
const PEARL_RECTS = PEARL.flatMap((row, y) =>
    [...row].map((c, x) => (PEARL_FILL[c] ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={PEARL_FILL[c]} /> : null)),
);
let pearlSeq = 0;

/** 一把粉圓，從 (x, y) 往上彈再掉出畫面。/ A handful of pearls that hop up from (x, y) and fall off screen. */
function handful(x: number, y: number): Pearl[] {
    return Array.from({ length: 18 }, () => {
        // 8 的倍數，像素才整齊。/ Multiples of 8 keep the pixels square.
        const size = Math.random() < 0.35 ? 24 : 16;
        return {
            id: ++pearlSeq,
            x,
            y,
            size,
            style: {
                "--dx": `${Math.round((Math.random() - 0.5) * 320)}px`,
                "--rise": `${-30 - Math.round(Math.random() * 70)}px`,
                // 像素圖不轉，轉了會歪成菱形。/ Pixel art does not spin (it would smear into diamonds).
                "--spin": "0deg",
                "--pearl-dur": `${(1.2 + Math.random() * 0.8).toFixed(2)}s`,
                animationDelay: `${Math.round(Math.random() * 140)}ms`,
            } as React.CSSProperties,
        };
    });
}

const SECTION_TITLE: Record<CreditSectionKey, TranslationKey> = {
    contributors: "about.creditsContributors",
    typefaces: "about.creditsTypefaces",
    browser: "about.creditsBrowser",
    server: "about.creditsServer",
    alongside: "about.creditsAlongside",
    data: "about.creditsData",
    mascot: "about.creditsMascot",
};

/**
 * 片尾名單。謝幕依看的人而定（打開時決定，播完存設定也不會重播）：還沒找到 Tapi = 只看得到影子，結尾提示去
 * 哪裡找，獎勵（每天換色）先存著；有 Tapi、還沒解鎖 = 髮夾輪流換六種顏色，看完解鎖；都有了 = 戴自己的顏色。
 * The credits. The finale depends on the viewer (decided on open, so saving at the end never restarts it): no
 * Tapi yet = only a shadow, the ending says where to look, and the reward (the daily colour) is kept for later;
 * Tapi but not unlocked = the clips cycle through every colour and finishing unlocks it; both = Tapi's own colour.
 */
function CreditsDialog({ onClose }: { onClose: () => void }) {
    const { t } = useI18n();
    const tapi = useTapi();
    const [kind] = useState<FinaleKind>(() => (!tapi.unlocked ? "shadow" : tapi.dailyUnlocked ? "owned" : "unlock"));
    const [look] = useState(() => ({ clip: tapi.clip, festival: tapi.festival }));
    const [ended, setEnded] = useState(false);
    const [justUnlocked, setJustUnlocked] = useState(false);
    // 看完片尾名單：解鎖「每天換一個」（還沒找到 Tapi 也先存著）。/ Watching to the end unlocks the daily colour (kept even before Tapi is found).
    const onEnded = useCallback(() => {
        setEnded(true);
        if (tapi.dailyUnlocked) return;
        void tapi.save({ tapi_daily: true }).then((ok) => ok && setJustUnlocked(true));
    }, [tapi]);
    const cast = useMemo(() => {
        const mascot = kind === "shadow" ? shadowArt(tapiArt("happy", look)) : tapiArt("happy", look);
        const sections = (Object.keys(CREDIT_LINES) as CreditSectionKey[]).map((k) => ({
            title: t(SECTION_TITLE[k]),
            // 還沒見過的吉祥物沒有名字。/ A mascot you have not met has no name yet.
            lines: k === "mascot" && kind === "shadow" ? ["???"] : [...CREDIT_LINES[k]],
            note: k === "contributors" ? t("about.creditsContributorsNote") : undefined,
            art: k === "mascot" ? mascot : CREDIT_ART[k],
        }));
        return parseCast(
            creditsCast(sections, {
                title: "Telepy",
                tagline: t("about.creditsTagline"),
                thanks: t("about.creditsThanks"),
                hint: kind === "shadow" ? t("about.creditsWhoIsThis") : undefined,
                finale: tapiFinale(kind, look),
            }),
        );
    }, [t, kind, look]);
    const shadow = kind === "shadow";
    const message = shadow && ended ? t("about.creditsFindTapi") : justUnlocked ? t("about.tapiDailyUnlocked") : t("about.creditsThanks");
    return (
        <Modal
            isOpen
            onClose={onClose}
            size="2xl"
            icon={<Clapperboard />}
            title={t("about.credits")}
            description={t("about.creditsDescription")}
            footer={
                <div className="flex w-full items-center gap-3">
                    {shadow ? (
                        ended && <Gift className="size-5 shrink-0 text-primary" aria-hidden />
                    ) : (
                        <Tapi pose="wave" size="2.75rem" className="shrink-0 animate-tapi-bob" />
                    )}
                    <span className={ended && (shadow || justUnlocked) ? "text-sm text-foreground" : "text-sm text-muted-foreground"} role={ended ? "status" : undefined}>
                        {message}
                    </span>
                </div>
            }
        >
            <CastPlayer cast={cast} tunnelId={null} autoPlay onEnded={onEnded} pixelArt />
        </Modal>
    );
}

// 色票：一個 5×5 的像素十字（跟 Tapi 耳朵上的一樣）；daily = 五格各一種顏色。
// A swatch is the 5×5 pixel cross from Tapi's ears; daily paints its five cells in different colours.
const CROSS = [".DDD.", "DD1DD", "D234D", "DD5DD", ".DDD."];
function CrossSwatch({ fills }: { fills: string[] }) {
    return (
        <svg viewBox="0 0 5 5" shapeRendering="crispEdges" className="size-6" aria-hidden>
            {CROSS.flatMap((row, y) =>
                [...row].map((c, x) => {
                    if (c === ".") return null;
                    const fill = c === "D" ? MASCOT_PALETTE.D : fills[(Number(c) - 1) % fills.length];
                    return <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} />;
                }),
            )}
        </svg>
    );
}

/** 「你的 Tapi」：找到 Tapi 後才出現；顏色存在帳號上。/ "Your Tapi": appears once Tapi is found; stored on the account. */
function YourTapi() {
    const { t } = useI18n();
    const { showError } = useToast();
    const tapi = useTapi();
    if (!tapi.unlocked) {
        // 片尾名單看完了、Tapi 還沒找到：留一句話，免得忘了禮物還在等。/ Credits watched, Tapi not found yet: a reminder that the present is waiting.
        if (!tapi.dailyUnlocked) return null;
        return (
            <p className="mt-3.5 flex items-center gap-2 border-t border-border pt-3.5 text-sm text-muted-foreground">
                <Gift className="size-4 shrink-0 text-primary" aria-hidden />
                {t("about.tapiWaiting")}
            </p>
        );
    }
    // 馬上換色（store 樂觀更新）；沒存到會自己退回，這裡只說一聲。/ Shows at once; a failed save reverts by itself, we just say so.
    const pick = (choice: string) => {
        if (choice === tapi.choice) return;
        void tapi.save({ tapi_color: choice }).then((ok) => !ok && showError(t("about.tapiSaveFailed")));
    };
    const swatch = "grid size-9 place-items-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
    return (
        <div className="mt-3.5 flex items-start gap-3.5 border-t border-border pt-3.5">
            {/* 換色時跳一下（key 換了就重播一次）。/ Hops once when the colour changes (a new key replays it). */}
            <Tapi key={tapi.choice} pose="wave" size="3rem" look={{ clip: tapi.clip, festival: null }} className="mt-0.5 shrink-0 animate-tapi-hop" label={t("eggs.tapiLabel")} />
            <div className="min-w-0 flex-1 space-y-2">
                <p className="text-foreground">{t("about.tapiTitle")}</p>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("about.tapiTitle")}>
                    {CLIP_COLORS.map(([name, hex]) => {
                        const on = tapi.choice === name;
                        const label = t(`about.tapiColor.${name as ClipColor}`);
                        return (
                            <button key={name} type="button" role="radio" aria-checked={on} aria-label={label} title={label} onClick={() => pick(name)} className={`${swatch} ${on ? "border-primary bg-surface" : "border-border hover:bg-muted"}`}>
                                <CrossSwatch fills={[hex]} />
                            </button>
                        );
                    })}
                    {tapi.dailyUnlocked ? (
                        <button
                            type="button"
                            role="radio"
                            aria-checked={tapi.choice === DAILY}
                            aria-label={t("about.tapiColor.daily")}
                            title={t("about.tapiColor.daily")}
                            onClick={() => pick(DAILY)}
                            className={`${swatch} ${tapi.choice === DAILY ? "border-primary bg-surface" : "border-border hover:bg-muted"}`}
                        >
                            <CrossSwatch fills={CLIP_COLORS.map(([, hex]) => hex)} />
                        </button>
                    ) : (
                        <span className={`${swatch} cursor-help border-dashed border-border text-sm text-muted-foreground`} title={t("about.tapiDailyLocked")} aria-label={t("about.tapiDailyLocked")} role="img">
                            ?
                        </span>
                    )}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                    {tapi.choice === DAILY ? t("about.tapiDailyHint") : t("about.tapiHint")}
                    {!tapi.dailyUnlocked && <span className="block">{t("about.tapiDailyLocked")}</span>}
                </p>
                {/* 讓 Tapi 偶爾自己來串門子（探頭、節日）；自己叫的（搜尋、Konami）照樣來。/ Unprompted visits; asked ones still come. */}
                <div className="space-y-1 pt-1">
                    <Switch
                        size="sm"
                        checked={tapi.visits}
                        onCheckedChange={(on) => void tapi.save({ tapi_visits: on }).then((ok) => !ok && showError(t("about.tapiSaveFailed")))}
                    >
                        <span className="text-sm text-foreground">{t("about.tapiVisits")}</span>
                    </Switch>
                    <p className="text-xs leading-relaxed text-muted-foreground">{t("about.tapiVisitsHint")}</p>
                </div>
            </div>
        </div>
    );
}

export function AboutTelepy() {
    const { t, tn } = useI18n();
    const reduced = useReducedMotion();
    const [pearls, setPearls] = useState<Pearl[]>([]);
    const [credits, setCredits] = useState(false);

    const drop = useCallback(
        (e: React.MouseEvent<HTMLButtonElement>) => {
            if (reduced) return;
            const r = e.currentTarget.getBoundingClientRect();
            const batch = handful(e.clientX || r.left + r.width / 2, e.clientY || r.top);
            setPearls((p) => [...p, ...batch]);
            const ids = new Set(batch.map((p) => p.id));
            setTimeout(() => setPearls((p) => p.filter((x) => !ids.has(x.id))), PEARL_LIFE_MS);
        },
        [reduced],
    );

    return (
        <div className="rounded-xl border border-border bg-surface p-3.5">
        <div className="flex items-start gap-3.5">
            <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-lg bg-brand-gradient" aria-hidden>
                <TelepyGlyph size={22} className="text-white" />
            </span>
            <div className="min-w-0 flex-1 space-y-1.5">
                <p className="flex flex-wrap items-center gap-2 text-foreground">
                    Telepy <Chip>AGPL-3.0</Chip>
                </p>
                <p className="text-sm text-muted-foreground">
                    {tn("about.typeface", {
                        font: (
                            <button type="button" onClick={drop} className="rounded-sm text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                jf-openhuninn (粉圓)
                            </button>
                        ),
                    })}
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                    <Button variant="outline" size="sm" asChild>
                        <a href={SOURCE_URL} target="_blank" rel="noreferrer">
                            <ExternalLink />
                            {t("about.source")}
                        </a>
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setCredits(true)}>
                        <Clapperboard />
                        {t("about.credits")}
                    </Button>
                    <DisclaimerButton />
                </div>
            </div>
        </div>
            <YourTapi />
            {pearls.length > 0 &&
                createPortal(
                    <div className="pointer-events-none fixed inset-0 z-[70] overflow-hidden" aria-hidden>
                        {pearls.map((p) => (
                            <svg
                                key={p.id}
                                viewBox="0 0 8 8"
                                shapeRendering="crispEdges"
                                className="absolute animate-pearl-fall"
                                style={{ left: p.x - p.size / 2, top: p.y - p.size / 2, width: p.size, height: p.size, ...p.style }}
                            >
                                {PEARL_RECTS}
                            </svg>
                        ))}
                    </div>,
                    document.body,
                )}
            {credits && <CreditsDialog onClose={() => setCredits(false)} />}
        </div>
    );
}
