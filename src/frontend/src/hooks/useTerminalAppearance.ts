"use client";

/**
 * 某條隧道(裝置)的終端機外觀:個人預設 + 這台裝置的覆寫(`/api/reverse/server/{id}/terminal-profile`,
 * 只影響自己),合成出終端機實際要用的字型 / 字級 / 配色 / 粗體畫法 / 連字。自訂配色(useTerminalSchemes)也在
 * 這裡併進查表,所以每個用 `resolved` 的地方都認得 custom-… 的 id。
 * - 覆寫在本機有一份快取(localStorage `telepy.terminalProfile.<id>`),以 useSyncExternalStore 讀:終端機一開
 *   就是對的字型,別的分頁改了也會跟著變,SSR 時是 null(不會 hydration 不一致)。後端回來後覆蓋快取。
 *   `ready` = 有快取或後端回來了(失敗也算),終端機頁等它才開第一個 shell,避免先用預設字型再換一次。
 * - 改覆寫:本機立即套用,寫回後端延遲 400 ms 合併(拖滑桿只送一次);整列 PUT,全 null = DELETE。
 * Terminal appearance for one tunnel: personal defaults + this device's own override (only affects the
 * caller), resolved to the font / size / colour scheme the terminal uses. The override is cached in
 * localStorage and read with useSyncExternalStore (right font on open, cross-tab updates, null during SSR);
 * the backend refreshes it. `ready` gates the first shell. Changes apply locally at once and reach the
 * backend 400 ms later as one PUT (or a DELETE when everything follows the default).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api";
import {
    EMPTY_TERMINAL_PROFILE,
    hasProfileOverride,
    parseTerminalProfile,
    resolveTerminalAppearance,
    terminalFontFamily,
    terminalFontPrimary,
    xtermBoldOptions,
    type ResolvedTerminalAppearance,
    type TerminalScheme,
    type TerminalDefaults,
    type TerminalProfile,
} from "@/lib/terminalAppearance";
import { useTerminalDefaults } from "@/hooks/useTerminalDefaults";
import { useCustomSchemes } from "@/hooks/useTerminalSchemes";
import { applyLigatures, loadTerminalFont, resolveCssVar, waitForFont } from "@/lib/xterm";
import { ensureMeasured, markIfHidden } from "@/lib/xtermMeasure";

const KEY_PREFIX = "telepy.terminalProfile.";
const PROFILE_EVENT = "telepy:terminal-profile";

// localStorage 不能用(無痕模式等)時退回記憶體,這一頁的變更仍然有效。/ In-memory fallback when storage is unavailable.
const memory = new Map<string, string>();

function readRaw(id: string): string | null {
    try {
        const v = localStorage.getItem(KEY_PREFIX + id);
        if (v !== null) return v;
    } catch { /* 退回記憶體 / fall back to memory */ }
    return memory.get(id) ?? null;
}

/** 寫快取並通知訂閱者。沒有覆寫也記一筆,下次開就不用等後端。/ Write and notify; "no override" is cached too. */
function writeProfile(id: string, profile: TerminalProfile) {
    const raw = JSON.stringify(hasProfileOverride(profile) ? profile : EMPTY_TERMINAL_PROFILE);
    memory.set(id, raw);
    try { localStorage.setItem(KEY_PREFIX + id, raw); } catch { /* 記憶體裡有 / memory has it */ }
    window.dispatchEvent(new Event(PROFILE_EVENT));
}

function subscribe(onChange: () => void) {
    window.addEventListener(PROFILE_EVENT, onChange);
    const onStorage = (e: StorageEvent) => {
        if (e.key?.startsWith(KEY_PREFIX)) onChange();
    };
    window.addEventListener("storage", onStorage);
    return () => {
        window.removeEventListener(PROFILE_EVENT, onChange);
        window.removeEventListener("storage", onStorage);
    };
}

// 同一份 JSON 回同一個物件(useSyncExternalStore 的要求)。/ Same JSON → same object, as useSyncExternalStore requires.
const snapshots = new Map<string, { raw: string | null; value: TerminalProfile | null }>();
function snapshotFor(id: string): TerminalProfile | null {
    const raw = readRaw(id);
    const prev = snapshots.get(id);
    if (prev && prev.raw === raw) return prev.value;
    let value: TerminalProfile | null = null;
    if (raw) {
        try { value = parseTerminalProfile(JSON.parse(raw)); } catch { value = null; }
    }
    snapshots.set(id, { raw, value });
    return value;
}

export interface TerminalAppearanceState {
    /** 實際套用的外觀。/ What the terminal uses. */
    resolved: ResolvedTerminalAppearance;
    defaults: TerminalDefaults;
    setDefaults: (patch: Partial<TerminalDefaults>) => void;
    /** 這台裝置的覆寫(null = 還沒載入)。/ This device's override (null until loaded). */
    profile: TerminalProfile | null;
    /** 使用者自訂的配色(查表用;選擇器也列它們)。/ The user's custom schemes (for lookups; the picker lists them too). */
    customSchemes: TerminalScheme[];
    customized: boolean;
    setProfile: (patch: Partial<TerminalProfile>) => void;
    resetProfile: () => void;
    ready: boolean;
    /** 最近一次寫回後端失敗。/ The last backend write failed. */
    saveError: boolean;
}

export function useTerminalAppearance(tunnelId: string | null): TerminalAppearanceState {
    const [defaults, setDefaults] = useTerminalDefaults();
    const customSchemes = useCustomSchemes();
    const getSnapshot = useCallback(() => (tunnelId ? snapshotFor(tunnelId) : null), [tunnelId]);
    const profile = useSyncExternalStore(subscribe, getSnapshot, () => null);
    const [fetchedId, setFetchedId] = useState<string | null>(null);
    const [saveError, setSaveError] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const ready = tunnelId === null || profile !== null || fetchedId === tunnelId;

    // 向後端拿最新的覆寫(只在 callback 裡 setState)。/ Refresh from the backend (state set only in callbacks).
    useEffect(() => {
        if (!tunnelId) return;
        let cancelled = false;
        apiFetch(`/api/reverse/server/${tunnelId}/terminal-profile`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                if (cancelled) return;
                if (data) writeProfile(tunnelId, parseTerminalProfile(data));
                setFetchedId(tunnelId);
            })
            .catch(() => { if (!cancelled) setFetchedId(tunnelId); });
        return () => { cancelled = true; };
    }, [tunnelId]);

    useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

    const commit = useCallback((next: TerminalProfile) => {
        if (!tunnelId) return;
        writeProfile(tunnelId, next);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            const path = `/api/reverse/server/${tunnelId}/terminal-profile`;
            const request = hasProfileOverride(next)
                ? apiFetch(path, { method: "PUT", body: JSON.stringify(next) })
                : apiFetch(path, { method: "DELETE" });
            request.then((r) => setSaveError(!r.ok)).catch(() => setSaveError(true));
        }, 400);
    }, [tunnelId]);

    // 疊在快取的最新值上(連續兩次變更還沒重繪也對)。/ Stack on the latest cached value, even before a re-render.
    const setProfile = useCallback((patch: Partial<TerminalProfile>) => {
        if (!tunnelId) return;
        commit({ ...(snapshotFor(tunnelId) ?? EMPTY_TERMINAL_PROFILE), ...patch });
    }, [tunnelId, commit]);

    const resetProfile = useCallback(() => commit(EMPTY_TERMINAL_PROFILE), [commit]);

    const resolved = useMemo(() => resolveTerminalAppearance(defaults, profile, customSchemes), [defaults, profile, customSchemes]);

    return {
        resolved,
        defaults,
        setDefaults,
        profile,
        customSchemes,
        customized: hasProfileOverride(profile),
        setProfile,
        resetProfile,
        ready,
        saveError,
    };
}

/** 格子寬自我檢查的間隔。/ How often the cell-width self-check runs. */
const CELL_CHECK_MS = 4000;

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 把外觀變更即時套用到開著的 xterm(終端機頁的每個分頁、網路頁的內嵌終端機):配色、粗體畫法、連字立即換;
 * 字級換完 refit;字型等它載好(最多 1.5 s;粗體用真實字體時連 Bold 一起等)再換,之後才載好的強迫 xterm 重新量字寬
 * (xterm 只在值變了才量,所以先換成 monospace 再換回來),否則字距會照後備字型算而對不齊;斜體 / 粗斜體是用到才
 * 下載的,所以 document.fonts 的 loadingdone 也會觸發同樣的重新量寬。隱藏中的終端機(背景分頁、縮小的 dock)量不到,
 * 由 markIfHidden 記下,顯示後 fit 前 ensureMeasured 再量;其他原因造成的格子寬過期由定時的自我檢查補上(lib/xtermMeasure.ts)。
 * `forEachTerm` / `refit` 要是穩定的 callback。
 * Applies appearance changes to open xterms live: the scheme, bold style and ligatures at once, the size followed
 * by a refit, the font once loaded (1.5 s cap; the Bold face too when the bold style uses it). A late load forces a
 * re-measure (xterm only measures when the value changes, hence the monospace round trip); otherwise cells keep the
 * fallback font's width. Italic / bold-italic faces download on first use, so document.fonts' loadingdone triggers
 * the same re-measure. A hidden terminal (background tab, minimised dock) can't be measured, so markIfHidden records
 * it and ensureMeasured re-measures it once shown, before the fit; a cell width gone stale any other way is caught by a
 * periodic self-check (lib/xtermMeasure.ts). Pass stable callbacks.
 */
export function useLiveTerminalLook(
    resolved: ResolvedTerminalAppearance,
    forEachTerm: (fn: (term: any) => void) => void,
    refit: () => void,
) {
    const each = useCallback((fn: (term: any) => void) => {
        forEachTerm((term) => {
            try { fn(term); } catch { /* 已 dispose / disposed */ }
        });
    }, [forEachTerm]);

    useEffect(() => {
        each((term) => { term.options.theme = resolved.scheme.theme; });
    }, [resolved.scheme, each]);

    useEffect(() => {
        each((term) => {
            term.options.fontSize = resolved.fontSize;
            markIfHidden(term);
        });
        refit();
    }, [resolved.fontSize, each, refit]);

    useEffect(() => {
        const { fontWeightBold, drawBoldTextInBrightColors } = xtermBoldOptions(resolved.bold);
        each((term) => {
            term.options.fontWeightBold = fontWeightBold;
            term.options.drawBoldTextInBrightColors = drawBoldTextInBrightColors;
        });
    }, [resolved.bold, each]);

    useEffect(() => {
        each((term) => applyLigatures(term, resolved.ligatures));
    }, [resolved.ligatures, each]);

    // 自我檢查:格子寬跟目前字型對不上(不管怎麼走到的)就重新量再 refit。看得到的分頁每隔幾秒、視窗取得焦點、
    // 分頁變回可見時各查一次;隱藏的終端機 ensureMeasured 直接略過(lib/xtermMeasure.ts)。
    // Self-check: a cell width that disagrees with the current font (however it got there) is re-measured and refitted.
    // Runs every few seconds while the tab is visible, on window focus and when the tab becomes visible; hidden
    // terminals are skipped by ensureMeasured (lib/xtermMeasure.ts).
    useEffect(() => {
        const check = () => {
            if (document.visibilityState !== "visible") return;
            let changed = false;
            each((term) => { if (ensureMeasured(term)) changed = true; });
            if (changed) refit();
        };
        const timer = setInterval(check, CELL_CHECK_MS);
        window.addEventListener("focus", check);
        document.addEventListener("visibilitychange", check);
        return () => {
            clearInterval(timer);
            window.removeEventListener("focus", check);
            document.removeEventListener("visibilitychange", check);
        };
    }, [each, refit]);

    const wantBoldFace = resolved.bold !== "bright";
    useEffect(() => {
        let cancelled = false;
        const font = resolved.font;
        const family = terminalFontFamily(font, resolveCssVar);
        const apply = (remeasure: boolean) => {
            each((term) => {
                if (remeasure) term.options.fontFamily = "monospace";
                term.options.fontFamily = family;
                markIfHidden(term);
            });
            refit();
        };
        void waitForFont(font, wantBoldFace).then(() => { if (!cancelled) apply(false); });
        void loadTerminalFont(font).then((ok) => { if (!cancelled && ok) apply(true); });
        if (wantBoldFace) void loadTerminalFont(font, true).then((ok) => { if (!cancelled && ok) apply(true); });
        // 之後才載好的同一家族字體(斜體等)也重新量寬。/ A later face of the same family (italic…) re-measures too.
        const primary = terminalFontPrimary(font, resolveCssVar).replace(/^"|"$/g, "");
        const onLoaded = (e: Event) => {
            const faces = (e as unknown as { fontfaces?: FontFace[] }).fontfaces ?? [];
            if (!cancelled && faces.some((f) => f.family.replace(/^"|"$/g, "") === primary)) apply(true);
        };
        document.fonts.addEventListener("loadingdone", onLoaded);
        return () => {
            cancelled = true;
            document.fonts.removeEventListener("loadingdone", onLoaded);
        };
    }, [resolved.font, wantBoldFace, each, refit]);
}
