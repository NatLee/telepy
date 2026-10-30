/**
 * 刪除隧道的六步（後端 `api/tunnels.rs` `DeleteSteps` 同一份順序）與純函式：事先的計畫（哪幾步會做、為什麼略過）、
 * 每一步做完的那一行結果、整件事的結論，以及圖上「裝置上的服務 / 金鑰」「Telepy」「連線」現在的樣子。
 * service = 找出並刪掉裝置上跑隧道的東西；keys = authorized_keys；stop = 停止服務、等裝置自己斷線；watch = 看它會不會回來；
 * telepy = 從 Telepy 刪掉（帳號、分享、AI session、錄影、授權）；disconnect = 斷開裝置。
 * The six steps of a tunnel delete (same order as the backend's `DeleteSteps`) and pure helpers: the plan (which steps
 * run, why the others are skipped), each step's one-line result, the verdict, and what the diagram's device service /
 * keys, Telepy and link look like now.
 */
import { stepViews, worstEnding, type PlannedStep, type RunPhase, type StepEvent, type StepState, type StepView } from "./progressSteps.ts";
import type { TranslationKey } from "@/locales/en";

export const DELETE_STEPS = ["service", "keys", "stop", "watch", "telepy", "disconnect"] as const;
export type DeleteStepId = (typeof DELETE_STEPS)[number];

/** `TUNNEL-DELETE-PROGRESS` / 回應的 `steps` 裡的一步。/ One step of the progress notification / the report's `steps`. */
export interface DeleteStepEvent extends StepEvent<DeleteStepId> {
    reason?: "off" | "offline" | "not_stopped" | "not_found" | "still_connected" | "came_back" | string;
    found?: number;
    errors?: number;
    removed?: number;
    failed?: number;
    service_key?: boolean;
    keys_left?: number;
    ai_sessions?: number;
    revoked?: number;
    detached?: number;
    was_connected?: boolean;
}

export type DeleteStepView = StepView<DeleteStepId> & { event?: DeleteStepEvent };

/**
 * 事先的計畫：裝置的三步（找服務、停、看）只有在線又選了移除服務才做；金鑰那步要在線；Telepy 與斷線一定做。
 * The plan: the three service steps need the device online and the option on; keys need it online; the rest always run.
 */
export function deletePlan(online: boolean, removeService: boolean): PlannedStep<DeleteStepId>[] {
    const service = online && removeService;
    const serviceReason = !online ? "offline" : "off";
    return [
        { id: "service", run: service, reason: service ? undefined : serviceReason },
        { id: "keys", run: online, reason: online ? undefined : "offline" },
        { id: "stop", run: service, reason: service ? undefined : serviceReason },
        { id: "watch", run: service, reason: service ? undefined : serviceReason },
        { id: "telepy", run: true },
        { id: "disconnect", run: true },
    ];
}

export function deleteSteps(online: boolean, removeService: boolean, events: readonly DeleteStepEvent[], phase: RunPhase): DeleteStepView[] {
    return stepViews(DELETE_STEPS, deletePlan(online, removeService), events, phase) as DeleteStepView[];
}

/** 翻譯鍵 + 變數。/ A translation key with its variables. */
export interface Text {
    key: TranslationKey;
    vars?: Record<string, string | number>;
}

/**
 * 一步的那一行：還沒做 = 會怎麼做（`plan`），略過 = 為什麼，做完 = 結果。
 * The step's line: before it runs what it will do, when skipped why, when finished the result.
 */
export function stepLine(view: DeleteStepView, ctx: { keys: number; lanHosts: number }): Text {
    const e = view.event;
    const s = view.state;
    if (s === "skipped") {
        const why = view.reason === "offline" ? "Offline" : view.reason === "not_stopped" ? "NotStopped" : "Off";
        if (view.id === "keys") return { key: "deleteTunnel.line.keysOffline", vars: { count: e?.keys_left ?? ctx.keys } };
        return { key: `deleteTunnel.line.${view.id}${why}` as TranslationKey };
    }
    if (s === "waiting" || s === "active" || !e || (s === "failed" && e.state !== "failed")) {
        // 還沒有結果（或請求失敗、這步沒回報）：說會怎麼做。/ No result yet: what it will do.
        if (view.id === "telepy") return { key: ctx.lanHosts > 0 ? "deleteTunnel.plan.telepyLan" : "deleteTunnel.plan.telepy", vars: { count: ctx.lanHosts } };
        return { key: `deleteTunnel.plan.${view.id}` as TranslationKey };
    }
    switch (view.id) {
        case "service":
            if (s === "failed") return { key: "deleteTunnel.line.serviceFailed" };
            if ((e.found ?? 0) === 0) return { key: "deleteTunnel.line.serviceNone" };
            return { key: (e.errors ?? 0) > 0 ? "deleteTunnel.line.serviceSome" : "deleteTunnel.line.serviceFound", vars: { count: e.found ?? 0, errors: e.errors ?? 0 } };
        case "keys":
            if (s === "done") return { key: e.service_key ? "deleteTunnel.line.keysDoneShared" : "deleteTunnel.line.keysDone", vars: { count: e.removed ?? 0 } };
            return { key: "deleteTunnel.line.keysFailed", vars: { failed: e.failed ?? 0, count: e.keys_left ?? 0 } };
        case "stop":
            if (s === "done") return { key: "deleteTunnel.line.stopDone" };
            return { key: e.reason === "not_found" ? "deleteTunnel.line.stopNothing" : "deleteTunnel.line.stopStill" };
        case "watch":
            return { key: s === "failed" ? "deleteTunnel.line.watchCameBack" : "deleteTunnel.line.watchDone" };
        case "telepy": {
            const parts = [e.ai_sessions ? "s" : "", e.revoked ? "r" : "", e.detached ? "d" : ""].filter(Boolean).length;
            return { key: parts > 0 ? "deleteTunnel.line.telepyMore" : "deleteTunnel.line.telepyDone", vars: { sessions: e.ai_sessions ?? 0, revoked: e.revoked ?? 0, detached: e.detached ?? 0 } };
        }
        case "disconnect":
            return { key: e.was_connected ? "deleteTunnel.line.disconnectDone" : "deleteTunnel.line.disconnectGone" };
    }
}

/**
 * 做完之後的一句結論：失敗 / 要注意的那步說了算，全部順利時看服務有沒有一起拿掉。
 * The verdict once finished: a failed / warning step decides; when everything went fine, whether the service went too.
 */
export function deleteVerdict(views: readonly DeleteStepView[]): { tone: "tip" | "warning" | "danger"; key: TranslationKey } {
    const worst = worstEnding(views);
    const by = (id: DeleteStepId) => views.find((v) => v.id === id);
    if (worst === "failed" || worst === "warn") {
        const watch = by("watch");
        if (watch?.state === "failed") return { tone: "danger", key: "deleteTunnel.verdict.cameBack" };
        if (by("keys")?.state === "failed" || by("keys")?.state === "warn") return { tone: "warning", key: "deleteTunnel.verdict.keysLeft" };
        return { tone: "warning", key: "deleteTunnel.verdict.serviceLeft" };
    }
    if (by("service")?.state === "done") return { tone: "tip", key: "deleteTunnel.verdict.clean" };
    if (by("keys")?.reason === "offline") return { tone: "warning", key: "deleteTunnel.verdict.offline" };
    return { tone: "warning", key: "deleteTunnel.verdict.serviceKept" };
}

/** 圖上的四樣東西。/ The diagram's four parts. */
export interface DeleteFlowStates {
    /** 裝置上跑隧道的服務。/ The tunnel service on the device. */
    service: StepState;
    /** authorized_keys。 */
    keys: StepState;
    telepy: StepState;
    /** Telepy ─ 裝置那條連線。/ The link between Telepy and the device. */
    link: StepState;
}

/**
 * 圖上每一樣東西的狀態。服務合併找 / 停 / 看三步：全略過 = 略過，有失敗 = 失敗，有進行中、或做完一部分還有沒做的 = 進行中，
 * 有要注意 = 要注意，還沒開始 = 待命，其餘做完。
 * Each diagram part's state. The service merges its three steps: all skipped = skipped, any failed = failed, any active
 * (or partly done with more to come) = active, any warn = warn, none started = waiting, else done.
 */
export function flowStates(views: readonly DeleteStepView[]): DeleteFlowStates {
    const by = (id: DeleteStepId): StepState => views.find((v) => v.id === id)?.state ?? "waiting";
    const ss = (["service", "stop", "watch"] as const).map(by).filter((s) => s !== "skipped");
    const service: StepState =
        ss.length === 0
            ? "skipped"
            : ss.includes("failed")
              ? "failed"
              : ss.includes("active") || (ss.includes("waiting") && ss.some((s) => s !== "waiting"))
                ? "active"
                : ss.includes("waiting")
                  ? "waiting"
                  : ss.includes("warn")
                    ? "warn"
                    : "done";
    return { service, keys: by("keys"), telepy: by("telepy"), link: by("disconnect") };
}
