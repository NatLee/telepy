"use client";

/**
 * 404：這條隧道通往虛無。Tapi 嚇一跳地從傳送門飄出來（減少動態時不飄），指到它或點它會揮手。
 * 404: this tunnel leads nowhere. A startled Tapi floats out of a portal (still with reduced motion) and waves
 * when pointed at or tapped.
 */
import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/section";
import { Tapi } from "@/components/brand/Tapi";
import { useI18n } from "@/lib/i18n";

// 傳送門（跟關於頁的珍珠同一組青綠色）：Tapi 就是從這裡飄出來的。/ The portal Tapi floats out of (the pearls' teal).
const PORTAL = [
    "........DDDDDDDDDDDDDDDD........",
    "....DDDDMMMMMMMMMMMMMMMMDDDD....",
    "..DDMLMIIIIIIIIJIIIIIIIIIMMMDD..",
    "DDMMIIIIIIJJIIIIIIIIIIIIIIIIMMDD",
    "DMMIIIIIIIIIJKKIIKKJIIIIIIIIIMMD",
    "DDMMIIIIIIIIIIIIIIIIJJIIIIIIMMDD",
    "..DDMMMIIIIIIIIIJIIIIIIIIMLMDD..",
    "....DDDDMMMMMMMMMMMMMMMMDDDD....",
    "........DDDDDDDDDDDDDDDD........",
];
const PORTAL_FILL: Record<string, string> = { D: "#0c3a35", M: "#2b9c86", L: "#8de6cf", I: "#1d2a52", J: "#3b4f99", K: "#6a5acd" };

function Portal() {
    return (
        <svg viewBox="0 0 32 9" shapeRendering="crispEdges" className="w-[8rem]" aria-hidden>
            {PORTAL.flatMap((row, y) =>
                [...row].map((c, x) => (PORTAL_FILL[c] ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={PORTAL_FILL[c]} /> : null)),
            )}
        </svg>
    );
}

export default function NotFound() {
    const { t, tn } = useI18n();
    const path = usePathname();
    const [waving, setWaving] = useState(false);
    return (
        <main className="grid min-h-dvh place-items-center bg-background px-4 py-16">
            <div className="flex w-full max-w-md flex-col items-center text-center">
                <div
                    className="relative h-[10rem] w-[12rem] cursor-default select-none"
                    onMouseEnter={() => setWaving(true)}
                    onMouseLeave={() => setWaving(false)}
                    onClick={() => setWaving((w) => !w)}
                >
                    {/* 小幽靈從傳送門飄出來。/ The little ghost floats out of a portal. */}
                    <div className="absolute bottom-0 left-1/2 -translate-x-1/2">
                        <Portal />
                    </div>
                    <div className="absolute bottom-[2.6rem] left-1/2 -ml-[3.5rem] animate-fade-in-up">
                        <div className="animate-tapi-bob">
                            <Tapi pose={waving ? "wave" : "surprised"} size="7rem" label={t("eggs.tapiLabel")} />
                        </div>
                    </div>
                </div>
                <Chip mono className="mt-6">404</Chip>
                <h1 className="mt-3 text-2xl tracking-tight text-foreground">{t("notFound.title")}</h1>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t("notFound.body")}</p>
                {path && (
                    <p className="mt-3 max-w-full break-all text-xs text-muted-foreground">
                        {tn("notFound.path", { path: <code className="font-mono text-foreground">{path}</code> })}
                    </p>
                )}
                <Button asChild className="mt-6">
                    <Link href="/">{t("notFound.home")}</Link>
                </Button>
            </div>
        </main>
    );
}
