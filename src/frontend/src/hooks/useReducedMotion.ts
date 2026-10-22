"use client";

/**
 * 使用者是否要求減少動態。globals.css 會把 CSS 動畫縮成一瞬間，但 SVG 的 SMIL（<animate> / <animateMotion>）
 * 不受影響，畫 SMIL 的元件要自己看這個值。
 * Whether the user asked for reduced motion. globals.css collapses CSS animations, but SVG SMIL
 * (<animate> / <animateMotion>) ignores that, so components drawing SMIL must check this themselves.
 */
import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
    const mql = window.matchMedia(QUERY);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
}

export function useReducedMotion(): boolean {
    return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
}
