/**
 * 每個平台的小像素圖示（自己畫的，12 × 12 左右；縮到 16px 也認得出輪廓就好）。`.` = 透明，其他字元查 `palette`。
 * 顏色固定（畫在固定的淺色小磚上，深色主題也一樣），所以不用設計 token。
 * Tiny pixel icons per platform (original art, about 12 × 12 — the outline only has to read at 16px). `.` is
 * transparent, every other character is looked up in `palette`. Colours are fixed because the icons sit on a fixed
 * light tile in both themes.
 *
 * `platformArt.test.ts` 檢查每張圖是長方形、字元都有顏色。/ Tested: every grid is rectangular and fully coloured.
 */
import type { PlatformId } from "./devicePlatforms.ts";

export interface PixelArt {
    rows: string[];
    palette: Record<string, string>;
}

export const PLATFORM_ART: Record<PlatformId, PixelArt> = {
    // 企鵝 / A penguin
    linux: {
        rows: [
            "....kkkk....",
            "...kkkkkk...",
            "...kwkkwk...",
            "...kkyykk...",
            "..kkwwwwkk..",
            "..kwwwwwwk..",
            ".kkwwwwwwkk.",
            ".kkwwwwwwkk.",
            "..kwwwwwwk..",
            "..kkwwwwkk..",
            "..yyy..yyy..",
        ],
        palette: { k: "#26231f", w: "#ffffff", y: "#f2b01e" },
    },
    // 被咬一口的蘋果 / An apple with a bite
    macos: {
        rows: [
            ".......ll...",
            "......ll....",
            "......l.....",
            "..gggg.gggg.",
            ".gggggggggg.",
            "gggggggggg..",
            "ggggggggg...",
            "ggggggggg...",
            "gggggggggg..",
            ".gggggggggg.",
            "..gggggggg..",
            "...ggg.ggg..",
        ],
        palette: { g: "#5f5f66", l: "#5f5f66" },
    },
    // 一顆覆盆子 / A raspberry
    raspberrypi: {
        rows: [
            "..ll....ll..",
            "...llllll...",
            ".....ll.....",
            "...rrrrrr...",
            "..rprrrprr..",
            ".rrrrrrrrrr.",
            ".rprrprrprr.",
            ".rrrrrrrrrr.",
            "..rrprrprr..",
            "..rrrrrrrr..",
            "...rrprrr...",
            "....rrrr....",
        ],
        palette: { l: "#4c9a2a", r: "#c51a4a", p: "#ec6b8f" },
    },
    // 有兩支天線的路由器 / A router with two antennas
    openwrt: {
        rows: [
            ".k........k.",
            ".k........k.",
            ".k........k.",
            ".k........k.",
            ".k........k.",
            "kkkkkkkkkkkk",
            "kddddddddddk",
            "kdbdbdbddddk",
            "kddddddddddk",
            "kkkkkkkkkkkk",
            ".k........k.",
        ],
        palette: { k: "#34404a", d: "#5b6b78", b: "#22c3f0" },
    },
    // 四格窗 / Four window panes
    windows: {
        rows: [
            "rrrrr.ggggg",
            "rrrrr.ggggg",
            "rrrrr.ggggg",
            "rrrrr.ggggg",
            "rrrrr.ggggg",
            "...........",
            "bbbbb.yyyyy",
            "bbbbb.yyyyy",
            "bbbbb.yyyyy",
            "bbbbb.yyyyy",
            "bbbbb.yyyyy",
        ],
        palette: { r: "#f25022", g: "#7fba00", b: "#00a4ef", y: "#ffb900" },
    },
    // 背著貨櫃的鯨魚 / A whale carrying containers
    docker: {
        rows: [
            "....cc......",
            "..cc.cc.....",
            "..cc.cc.cc..",
            "bbbbbbbbbb.b",
            "bbbbbbbbbbbb",
            "bbbwbbbbbbb.",
            ".bbbbbbbbb..",
            "..bbbbbbb...",
        ],
        palette: { b: "#1d63ed", c: "#5b9bff", w: "#ffffff" },
    },
    // 一般的主機 / NAS：硬碟槽 + 綠燈 / A generic box with drive bays and a green light
    unix: {
        rows: [
            ".kkkkkkkkkk.",
            ".kddddddddk.",
            ".kdkkkkkkdk.",
            ".kddddddddk.",
            ".kdkkkkkkdk.",
            ".kddddddddk.",
            ".kdkkkkkkdk.",
            ".kddddddddk.",
            ".kgdddddddk.",
            ".kkkkkkkkkk.",
        ],
        palette: { k: "#3d3a35", d: "#9a958c", g: "#3fb950" },
    },
};

/** 同一列連續同色的像素合成一個矩形（SVG 元素少很多）。/ Merge horizontal runs of one colour into one rect. */
export function pixelRuns(art: PixelArt): { x: number; y: number; w: number; fill: string }[] {
    const out: { x: number; y: number; w: number; fill: string }[] = [];
    art.rows.forEach((row, y) => {
        let x = 0;
        while (x < row.length) {
            const ch = row[x];
            let w = 1;
            while (row[x + w] === ch) w += 1;
            if (ch !== ".") out.push({ x, y, w, fill: art.palette[ch] });
            x += w;
        }
    });
    return out;
}
