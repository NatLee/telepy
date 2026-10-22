/**
 * Telepy 的標誌圖形（與 app/icon.svg 同一個「折返」：裝置往外連、伺服器沿同一條連線連回來）。
 * 只畫白色線條（currentColor），漸層底由外層的 `bg-brand-gradient` 方塊提供；型別與 lucide 圖示相同，可直接替換。
 * The Telepy glyph from app/icon.svg (device dials out, the server reaches back along the same line). It draws only
 * the strokes in currentColor; the gradient tile comes from the surrounding `bg-brand-gradient`. Typed like a lucide
 * icon so it drops into any icon slot.
 */
import React, { forwardRef } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";

// icon.svg 是 64 格；圖形大約落在 9–54 × 9–52，取正方形讓它置中。/ The glyph's box inside the 64-unit favicon grid.
const VIEW_BOX = "7.5 6.5 48 48";

// 線寬固定（與 favicon 同比例），所以不吃 lucide 的 strokeWidth。/ Fixed stroke proportions, so strokeWidth is not used.
export const TelepyGlyph = forwardRef<SVGSVGElement, LucideProps>(function TelepyGlyph({ size = 24, className, color = "currentColor", style }, ref) {
    return (
        <svg ref={ref} xmlns="http://www.w3.org/2000/svg" viewBox={VIEW_BOX} width={size} height={size} className={className} style={style} aria-hidden>
            <g fill="none" stroke={color} strokeWidth={8} strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 16H38a12 12 0 0 1 0 24H20" />
                <path d="M26 32l-8 8 8 8" />
            </g>
            <circle cx={16} cy={16} r={7} fill={color} />
        </svg>
    );
}) as LucideIcon;
