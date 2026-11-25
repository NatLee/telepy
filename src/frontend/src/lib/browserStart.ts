/**
 * 遠端瀏覽器開起來的三步：proxy（Telepy 經裝置的 SSH 開 SOCKS 代理；後端 `REMOTE-BROWSER-PROGRESS` 報）→ browser（瀏覽器
 * 容器開一個 Chromium；後端報）→ stream（這個分頁接上畫面；前端自己知道）。純函式：每一步的狀態與那一行字。
 * The three steps of starting a remote browser: proxy (the SOCKS proxy through the device's SSH; reported by the
 * backend) → browser (Chromium in the browser container; reported) → stream (this tab attaches to the picture; known in
 * the browser). Pure helpers: each step's state and its line.
 */
import { stepViews, type PlannedStep, type RunPhase, type StepEvent, type StepView } from "./progressSteps.ts";
import type { TranslationKey } from "@/locales/en";

export const BROWSER_STEPS = ["proxy", "browser", "stream"] as const;
export type BrowserStepId = (typeof BROWSER_STEPS)[number];

export interface BrowserStepEvent extends StepEvent<BrowserStepId> {
    attempt?: number;
    attempts?: number;
    /** proxy failed：offline / timeout。 */
    reason?: string;
}

const PLAN: PlannedStep<BrowserStepId>[] = BROWSER_STEPS.map((id) => ({ id, run: true }));

/**
 * 回應到了但後端沒報（舊後端、通知掉了）：前兩步補成做完。/ The start answered but some steps were never reported
 * (older backend, lost notification): the first two count as done.
 */
export function afterStart(events: readonly BrowserStepEvent[], at: number): BrowserStepEvent[] {
    const ended = (id: BrowserStepId) => events.some((e) => e.step === id && e.state !== "active");
    const filled = [...events];
    for (const id of ["proxy", "browser"] as const) if (!ended(id)) filled.push({ step: id, state: "done", at });
    filled.push({ step: "stream", state: "active", at });
    return filled;
}

export function browserSteps(events: readonly BrowserStepEvent[], phase: RunPhase): (StepView<BrowserStepId> & { event?: BrowserStepEvent })[] {
    return stepViews(BROWSER_STEPS, PLAN, events, phase);
}

/** 一步的那一行。/ A step's line. */
export function browserLine(view: StepView<BrowserStepId> & { event?: BrowserStepEvent }): { key: TranslationKey; vars?: Record<string, string | number> } {
    const e = view.event;
    if (view.state === "failed") {
        // 這一步沒有報失敗（請求自己失敗了，例如沒權限、人數上限）：原因在上面的訊息。/ No reported failure: the message above says why.
        if (!e || e.state !== "failed") return { key: "browser.step.stoppedHere" };
        if (view.id === "proxy") return e?.reason === "offline" ? { key: "browser.step.proxyOffline" } : { key: "browser.step.proxyTimeout", vars: { count: e?.attempts ?? 1 } };
        return { key: `browser.step.${view.id}Failed` as TranslationKey };
    }
    if (view.state === "active" && view.id === "proxy" && (e?.attempt ?? 1) > 1) return { key: "browser.step.proxyRetry", vars: { n: e?.attempt ?? 1, total: e?.attempts ?? 1 } };
    if (view.state === "done") return { key: `browser.step.${view.id}Done` as TranslationKey };
    return { key: `browser.step.${view.id}Plan` as TranslationKey };
}

/**
 * 路徑圖最左邊那格：這次要開的網頁。沒有網址 = 新分頁；裝置自己的 port（`localhost:<port>`）= 「:port」加上清單裡的名稱；
 * 其他（區網主機的網頁）= 去掉 scheme 的網址。
 * The path diagram's first node: the page this start opens. No URL = a new tab; one of the device's own ports
 * (`localhost:<port>`) = ":port" plus its name from the list; anything else (a LAN host's page) = the URL without its scheme.
 */
export function startTarget(url: string | null, nameOf: (port: number) => string | null): { kind: "newTab" } | { kind: "port"; port: number; name: string | null } | { kind: "url"; text: string } {
    if (!url) return { kind: "newTab" };
    let u: URL;
    try { u = new URL(url); } catch { return { kind: "url", text: url }; }
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
        if (u.pathname === "/" && !u.search) return { kind: "port", port, name: nameOf(port) };
    }
    return { kind: "url", text: url.replace(/^https?:\/\//, "").replace(/\/$/, "") };
}
