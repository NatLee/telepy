/**
 * Tapi：Telepy 的吉祥物（像素畫，格子在 lib/mascot.ts，與 CLI / gateway 的終端機版同一份）。只出現在彩蛋裡。
 * 十字髮夾的顏色跟著帳號、節日會換裝（hooks/useTapi）；`look` 可以指定別的（選色時的預覽）。
 * 顏色固定、不跟主題走，跟 logo 方塊一樣是插圖；`crispEdges` 讓任何大小都是清楚的方格。
 * Tapi, Telepy's mascot, as pixel art (grids in lib/mascot.ts, shared with the CLI / gateway terminal version); it
 * only appears in easter eggs. The clips follow the account's colour and festivals dress it up (hooks/useTapi);
 * `look` overrides that (the colour picker's previews). Fixed colours like the logo tile; `crispEdges` keeps the
 * squares sharp at any size.
 */
"use client";

import React, { useMemo } from "react";
import { useTapi } from "@/hooks/useTapi";
import { dressTapi, MASCOT_POSES, mirrored, pixelRuns, spriteSize, type MascotPose, type TapiLook } from "@/lib/mascot";

export interface TapiProps {
    pose?: MascotPose;
    /** 寬（CSS 長度，數字 = px）；高依比例。/ Width (a number is px); height follows. */
    size?: number | string;
    /** 左右翻轉。/ Flip horizontally. */
    flip?: boolean;
    /** 指定外觀（不給 = 帳號的顏色 + 今天的節日）。/ A specific look (default: the account's colour + today's festival). */
    look?: TapiLook;
    /** 給螢幕閱讀器的名字；不給就當裝飾（aria-hidden）。/ Accessible name; without it the art is decorative. */
    label?: string;
    className?: string;
    style?: React.CSSProperties;
}

export function Tapi({ pose = "idle", size = 64, flip = false, look, label, className, style }: TapiProps) {
    const mine = useTapi();
    const clip = look?.clip ?? mine.clip;
    const festival = look ? look.festival : mine.festival;
    const { runs, w, h } = useMemo(() => {
        const dressed = dressTapi(MASCOT_POSES[pose], { clip, festival });
        const sprite = flip ? mirrored(dressed.sprite) : dressed.sprite;
        return { runs: pixelRuns(sprite, dressed.palette), ...spriteSize(sprite) };
    }, [pose, flip, clip, festival]);
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox={`0 0 ${w} ${h}`}
            shapeRendering="crispEdges"
            className={className}
            style={{ width: size, height: "auto", aspectRatio: `${w} / ${h}`, ...style }}
            role={label ? "img" : undefined}
            aria-label={label}
            aria-hidden={label ? undefined : true}
        >
            {runs.map((r) => (
                <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
            ))}
        </svg>
    );
}

/** 同一張圖的 SVG 字串（console 的 data URL 用）。/ The same art as an SVG string (for the console's data URL). */
export function tapiSvg(pose: MascotPose, look: TapiLook, scale = 6): string {
    const dressed = dressTapi(MASCOT_POSES[pose], look);
    const { w, h } = spriteSize(dressed.sprite);
    const rects = pixelRuns(dressed.sprite, dressed.palette)
        .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" fill="${r.fill}"/>`)
        .join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * scale}" height="${h * scale}" shape-rendering="crispEdges">${rects}</svg>`;
}
